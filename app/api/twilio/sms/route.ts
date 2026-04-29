// Twilio inbound-SMS webhook — a contractor texted our BYOT Twilio
// number with their availability + price after getting our voicemail
// recap.
//
// Flow:
//   1. Verify Twilio signature (HMAC-SHA1 of the full URL + sorted
//      form body, keyed by TWILIO_AUTH_TOKEN). We reject unverified
//      requests to keep the endpoint from being a free quote-
//      injection surface.
//   2. Parse From + Body from the form-urlencoded payload.
//   3. Match to a business + quote_request via match-inbound.
//   4. Run the per-vertical Claude extractor over the SMS text
//      (transcript stand-in: the raw message body).
//   5. Insert a synthetic `calls` row representing the SMS
//      conversation, tagged with a synthetic vapi_call_id so the row
//      is distinguishable from voice calls and the UNIQUE constraint
//      still gives us idempotency.
//   6. Insert the quotes row + bump the counter.
//   7. Respond with a TwiML <Response> that Twilio delivers back to
//      the sender: a short "Got it, thanks." so the contractor knows
//      we received their reply.
//
// Security notes:
//   • In dev (NODE_ENV!=='production') we accept the request without
//     a signature so `ngrok`-free local testing works. Prod hard-
//     fails on missing/invalid signature.
//   • TWILIO_AUTH_TOKEN must be set in prod or we reject. Same hard-
//     fail pattern as VAPI_WEBHOOK_SECRET in the outbound webhook.

import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { matchInboundToQuoteRequest } from '@/lib/calls/match-inbound';
import { extractQuoteFromCall } from '@/lib/calls/extract-quote';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('twilio/sms');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  // ─── 1. Signature verification ─────────────────────────────────
  //
  // Twilio computes: HMAC-SHA1(authToken, url + sortedKeys.join(k+v))
  // and sends it as `X-Twilio-Signature`. We reconstruct on our side
  // and compare timing-safely.
  const rawBody = await req.text();
  const providedSig = req.headers.get('x-twilio-signature') ?? '';

  if (!authToken) {
    if (process.env.NODE_ENV === 'production') {
      log.error('TWILIO_AUTH_TOKEN not set in production — refusing');
      return new Response('misconfigured', { status: 500 });
    }
    log.warn('TWILIO_AUTH_TOKEN not set — DEV MODE, accepting without verification');
  } else {
    const params = new URLSearchParams(rawBody);
    // Twilio's signature spec: sort param names, concatenate each
    // name+value, prepend the full request URL. We have to reconstruct
    // the URL Twilio used (including the https scheme, since we're
    // behind a tunnel that terminates TLS at the edge).
    const url = reconstructTwilioUrl(req);
    const sortedKeys = [...params.keys()].sort();
    const concat = sortedKeys.map((k) => k + (params.get(k) ?? '')).join('');
    const expected = crypto
      .createHmac('sha1', authToken)
      .update(url + concat)
      .digest('base64');

    const ok =
      providedSig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expected));
    if (!ok) {
      log.warn('invalid Twilio signature', { url });
      return new Response('invalid signature', { status: 401 });
    }
  }

  // ─── 2. Parse body ─────────────────────────────────────────────
  const params = new URLSearchParams(rawBody);
  const from = params.get('From') ?? '';
  const body = (params.get('Body') ?? '').trim();

  if (!from || !body) {
    return new Response('missing From or Body', { status: 400 });
  }

  // ─── 3. Process ─────────────────────────────────────────────────
  const admin = createAdminClient();
  try {
    await handleInboundSms(admin, from, body);
  } catch (err) {
    log.error('handler failed', { err });
    captureException(err, { tags: { route: 'twilio/sms' } });
    // Return TwiML with NO reply so the contractor doesn't get a
    // misleading "got it" — but still 200 so Twilio doesn't retry.
    return twimlResponse('');
  }

  // ─── 4. Acknowledge via TwiML reply ─────────────────────────────
  return twimlResponse(
    'Got it, thanks. EvenQuote will pass your quote along to the customer.'
  );
}

function reconstructTwilioUrl(req: Request): string {
  // Twilio signs the URL it POSTed to. Behind cloudflared / Vercel
  // the inbound `req.url` already reflects the public URL (the edge
  // rewrites Host/Proto before we see it), so we can use it directly.
  // If behind a layer that doesn't rewrite, prefer X-Forwarded-Proto +
  // X-Forwarded-Host. We try the explicit override first.
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const forwardedHost = req.headers.get('x-forwarded-host');
  if (forwardedProto && forwardedHost) {
    const u = new URL(req.url);
    return `${forwardedProto}://${forwardedHost}${u.pathname}${u.search}`;
  }
  return req.url;
}

function twimlResponse(message: string): Response {
  const xml = message
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?>\n<Response/>`;
  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function handleInboundSms(
  admin: SupabaseClient,
  from: string,
  body: string
) {
  const match = await matchInboundToQuoteRequest(admin, from);
  if (!match) {
    log.warn('inbound SMS: no match', {
      fromMasked: from.replace(/\d(?=\d{4})/g, '*'),
      bodyLen: body.length,
    });
    return;
  }

  // Synthetic vapi_call_id so the UNIQUE constraint on calls.vapi_call_id
  // still provides idempotency (Twilio doesn't send message-sids we'd
  // naturally use). Prefix + hash of (from + body + request_id) means
  // the same message retried by Twilio collapses into the same row.
  const synth = 'sms_' + crypto
    .createHash('sha256')
    .update(`${match.quoteRequestId}:${from}:${body}`)
    .digest('hex')
    .slice(0, 24);

  const { data: existing } = await admin
    .from('calls')
    .select('id')
    .eq('vapi_call_id', synth)
    .maybeSingle();
  if (existing) {
    log.info('inbound SMS already recorded — skipping', { callId: existing.id });
    return;
  }

  // Feed the SMS body to our extractor as a pseudo-transcript. The
  // category-tailored prompt already handles "short text with just a
  // price" well enough — if not, we'll see low confidence_score and
  // can route to a manual-review bucket later.
  const extraction = await extractQuoteFromCall({
    transcript: body,
    summary: null,
    categoryContext: match.categoryName
      ? {
          displayName: match.categoryName,
          extractionSchema: match.extractionSchema as
            | {
                domain_notes?: string;
                includes_examples?: string[];
                excludes_examples?: string[];
                price_anchors?: string;
                onsite_estimate_common?: boolean;
              }
            | null,
        }
      : undefined,
  });

  // Always create the calls row so we have an audit trail of the SMS
  // even when extraction returns ok:false.
  const { data: insertedCall, error: callErr } = await admin
    .from('calls')
    .insert({
      quote_request_id: match.quoteRequestId,
      business_id: match.businessId,
      vapi_call_id: synth,
      status: 'completed',
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_seconds: 0,
      transcript: body,
      summary: null,
      cost: 0,
    })
    .select('id')
    .single();

  if (callErr) {
    if ((callErr as { code?: string }).code === '23505') return;
    throw new Error(`inbound SMS calls insert: ${callErr.message}`);
  }

  if (!extraction.ok) {
    log.info('inbound SMS: no quote extracted', {
      callId: insertedCall.id,
      reason: extraction.reason,
    });
    return;
  }

  const { error: quoteErr } = await admin.from('quotes').insert({
    call_id: insertedCall.id,
    quote_request_id: match.quoteRequestId,
    business_id: match.businessId,
    price_min: extraction.quote.priceMin,
    price_max: extraction.quote.priceMax,
    price_description: extraction.quote.priceDescription,
    availability: extraction.quote.availability,
    includes: extraction.quote.includes,
    excludes: extraction.quote.excludes,
    notes: extraction.quote.notes,
    contact_name: extraction.quote.contactName,
    contact_phone: extraction.quote.contactPhone,
    contact_email: extraction.quote.contactEmail,
    requires_onsite_estimate: extraction.quote.requiresOnsiteEstimate,
    confidence_score: extraction.quote.confidenceScore,
  });

  if (quoteErr && (quoteErr as { code?: string }).code !== '23505') {
    throw new Error(`inbound SMS quotes insert: ${quoteErr.message}`);
  }

  const { error: bumpErr } = await admin.rpc('increment_quotes_collected', {
    p_request_id: match.quoteRequestId,
  });
  if (bumpErr) {
    log.warn('increment_quotes_collected failed (RPC may not exist)', {
      err: bumpErr.message,
      requestId: match.quoteRequestId,
    });
  }

  log.info('inbound SMS applied', {
    callId: insertedCall.id,
    requestId: match.quoteRequestId,
    businessId: match.businessId,
  });
}
