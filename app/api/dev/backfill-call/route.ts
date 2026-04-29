// Dev-only backfill — pull a completed call's transcript from Vapi's
// REST API and run it through the same end-of-call pipeline the webhook
// would have, had the tunnel been alive.
//
// Why this exists: during local testing the webhook URL points at a
// cloudflared trycloudflare tunnel. When the tunnel dies (machine sleeps,
// tunnel rotated, laptop closed), Vapi's end-of-call-report POSTs
// silently fail. The calls row is stuck in_progress forever, no quote
// row is ever inserted, and the parent quote_request never advances.
//
// Vapi keeps the call record — transcript, summary, recording, cost,
// analysis — server-side and retrievable via GET /call/{id}. This route
// fetches that, shapes it into our VapiEndOfCallReport type, and calls
// applyEndOfCall() — the same function the live webhook uses. Safe to
// re-run: applyEndOfCall short-circuits on terminal statuses.
//
// Usage (dev server on :3000):
//
//   GET http://localhost:3000/api/dev/backfill-call?vapi_call_id=<id>
//   GET http://localhost:3000/api/dev/backfill-call?quote_request_id=<uuid>
//   GET http://localhost:3000/api/dev/backfill-call?quote_request_id=<uuid>&all=1
//
// Defaults:
//   - With vapi_call_id: backfills that single call.
//   - With quote_request_id: backfills every call on that request that
//     is still in_progress (or in_progress + queued if ?all=1).
//
// Two-layer auth (NODE_ENV + optional DEV_TRIGGER_TOKEN) lives in
// lib/security/dev-token-auth.ts — edit the helper if you need the
// auth behavior to change, so the sibling trigger-call route stays
// in lockstep.
//
// To remove: delete this file. There are no other references.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  applyEndOfCall,
  type VapiEndOfCallReport,
} from '@/lib/calls/apply-end-of-call';
import { assertDevToken } from '@/lib/security/dev-token-auth';
import { assertRateLimit } from '@/lib/security/rate-limit-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Shape of what Vapi returns from GET /call/{id}. We only pick the
// fields we need; anything else is ignored. Types intentionally loose
// because Vapi has renamed fields in the past.
type VapiCallRecord = {
  id?: string;
  status?: string; // queued | ringing | in-progress | forwarding | ended
  endedReason?: string;
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
  cost?: number;
  // Vapi exposes duration in several shapes across its history:
  durationSeconds?: number;
  duration?: number;
  startedAt?: string;
  endedAt?: string;
  analysis?: {
    structuredData?: unknown;
    successEvaluation?: string | null;
    summary?: string;
  };
};

type BackfillOne = {
  vapi_call_id: string;
  internal_call_id?: string;
  ok: boolean;
  applied: boolean;
  status?: string;
  quote_inserted?: boolean;
  note?: string;
  error?: string;
};

export async function GET(req: Request) {
  // Centralized two-layer auth: NODE_ENV gate (404 in prod, no probe
  // signal) + optional DEV_TRIGGER_TOKEN (401 on mismatch, constant-
  // time compared). See lib/security/dev-token-auth.ts.
  const deny = assertDevToken(req);
  if (deny) return deny;

  // R48(h) — Defense-in-depth rate limit AFTER assertDevToken so the
  // no-probe-in-prod property holds. 30/60s — backfill is hand-driven
  // (one call id at a time); a script-spinning loop that's burning
  // Vapi quota is the precise failure mode this catches.
  const rateLimitDeny = assertRateLimit(req, {
    prefix: 'dev-backfill-call',
    limit: 30,
    windowMs: 60_000,
  });
  if (rateLimitDeny) return rateLimitDeny;

  const url = new URL(req.url);

  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: 'VAPI_API_KEY not set — nothing to fetch from' },
      { status: 500 }
    );
  }

  const admin = createAdminClient();

  // Resolve the target set of vapi_call_ids.
  const vapiCallId = url.searchParams.get('vapi_call_id')?.trim();
  const quoteRequestId = url.searchParams.get('quote_request_id')?.trim();
  const includeAll = url.searchParams.get('all') === '1';

  let targets: { vapi_call_id: string; internal_call_id: string }[] = [];

  if (vapiCallId) {
    const { data, error } = await admin
      .from('calls')
      .select('id, vapi_call_id')
      .eq('vapi_call_id', vapiCallId)
      .maybeSingle();
    if (error) {
      return NextResponse.json(
        { ok: false, error: `calls lookup failed: ${error.message}` },
        { status: 500 }
      );
    }
    if (data?.vapi_call_id) {
      targets.push({ vapi_call_id: data.vapi_call_id, internal_call_id: data.id });
    } else {
      // Caller might want to replay a Vapi call that was never stored
      // locally — allow explicit vapi_call_id even when there's no row.
      targets.push({ vapi_call_id: vapiCallId, internal_call_id: '' });
    }
  } else if (quoteRequestId) {
    // Backfill every non-terminal call on this request. By default that's
    // just in_progress (the most common "stuck via dead tunnel" state);
    // ?all=1 broadens to queued as well.
    const stuckStatuses = includeAll
      ? ['queued', 'in_progress']
      : ['in_progress'];
    const { data, error } = await admin
      .from('calls')
      .select('id, vapi_call_id, status')
      .eq('quote_request_id', quoteRequestId)
      .in('status', stuckStatuses);
    if (error) {
      return NextResponse.json(
        { ok: false, error: `calls lookup failed: ${error.message}` },
        { status: 500 }
      );
    }
    targets = (data ?? [])
      .filter((c) => !!c.vapi_call_id)
      .map((c) => ({ vapi_call_id: c.vapi_call_id as string, internal_call_id: c.id }));
  } else {
    return NextResponse.json(
      {
        ok: false,
        error: 'Provide ?vapi_call_id=<id> or ?quote_request_id=<uuid>',
      },
      { status: 400 }
    );
  }

  if (targets.length === 0) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      results: [],
      note: 'No matching calls to backfill',
    });
  }

  // Process each call. We do them sequentially to keep log output
  // readable and avoid hammering Vapi with parallel GETs.
  const results: BackfillOne[] = [];
  for (const t of targets) {
    try {
      const fetchRes = await fetch(`https://api.vapi.ai/call/${t.vapi_call_id}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!fetchRes.ok) {
        const body = await fetchRes.text();
        results.push({
          vapi_call_id: t.vapi_call_id,
          internal_call_id: t.internal_call_id || undefined,
          ok: false,
          applied: false,
          error: `Vapi GET /call ${fetchRes.status} ${fetchRes.statusText}: ${body.slice(0, 300)}`,
        });
        continue;
      }

      const rec = (await fetchRes.json()) as VapiCallRecord;

      // If Vapi itself says the call hasn't ended yet, don't apply —
      // we'd be writing a premature "completed" with empty transcript.
      if (rec.status && rec.status !== 'ended') {
        results.push({
          vapi_call_id: t.vapi_call_id,
          internal_call_id: t.internal_call_id || undefined,
          ok: true,
          applied: false,
          note: `Vapi status=${rec.status} — call not ended yet, skipped`,
        });
        continue;
      }

      // Shape Vapi's GET response into the same VapiEndOfCallReport the
      // webhook receives. Compute duration if Vapi only returned started/endedAt.
      const durationSeconds = computeDurationSeconds(rec);

      const report: VapiEndOfCallReport = {
        type: 'end-of-call-report',
        call: { id: t.vapi_call_id },
        callId: t.vapi_call_id,
        transcript: rec.transcript,
        summary: rec.summary ?? rec.analysis?.summary,
        recordingUrl: rec.recordingUrl,
        cost: rec.cost,
        durationSeconds,
        endedReason: rec.endedReason,
        analysis: rec.analysis
          ? {
              structuredData: rec.analysis.structuredData,
              successEvaluation: rec.analysis.successEvaluation ?? null,
            }
          : undefined,
      };

      const applyResult = await applyEndOfCall(admin, t.vapi_call_id, report);

      results.push({
        vapi_call_id: t.vapi_call_id,
        internal_call_id: t.internal_call_id || undefined,
        ok: true,
        applied: applyResult.applied,
        status: applyResult.status,
        quote_inserted: applyResult.quoteInserted,
        note: applyResult.note,
      });
    } catch (err) {
      results.push({
        vapi_call_id: t.vapi_call_id,
        internal_call_id: t.internal_call_id || undefined,
        ok: false,
        applied: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const applied = results.filter((r) => r.applied).length;
  const quotesInserted = results.filter((r) => r.quote_inserted).length;

  return NextResponse.json({
    ok: true,
    processed: results.length,
    applied,
    quotes_inserted: quotesInserted,
    results,
    next: quoteRequestId
      ? {
          supabase_calls_filter: `quote_request_id = '${quoteRequestId}'`,
          supabase_quotes_filter: `quote_request_id = '${quoteRequestId}'`,
        }
      : undefined,
  });
}

function computeDurationSeconds(rec: VapiCallRecord): number | undefined {
  if (typeof rec.durationSeconds === 'number') return rec.durationSeconds;
  if (typeof rec.duration === 'number') return rec.duration;
  if (rec.startedAt && rec.endedAt) {
    const start = Date.parse(rec.startedAt);
    const end = Date.parse(rec.endedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return Math.round((end - start) / 1000);
    }
  }
  return undefined;
}
