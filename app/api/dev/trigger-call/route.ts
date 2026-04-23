// Dev-only test trigger — bypass Stripe + the intake form, fire a real
// (or simulated) Vapi call against your seeded businesses.
//
// Lives under /api/dev/* on purpose: this route HARD-REFUSES outside
// development. The check is two-layered (NODE_ENV + the optional dev
// token below) so a misconfigured prod deploy still won't expose it.
//
// Usage (dev server running on :3000):
//
//   GET  http://localhost:3000/api/dev/trigger-call
//   GET  http://localhost:3000/api/dev/trigger-call?category=cleaning
//   GET  http://localhost:3000/api/dev/trigger-call?category=moving&zip=92008&city=Carlsbad
//
// Returns the runCallBatch result as JSON. With TEST_OVERRIDE_PHONE
// set, every dispatched call rings that number instead of the real
// business — see lib/calls/vapi.ts.
//
// Safety net: this file MUST stay under /api/dev/. Don't move it under
// /api/admin/ or anywhere a routing rewrite might expose it publicly.
//
// To remove: delete this file. There are no other references.
//
// Why GET (not POST)?
//   • You can hit it from the browser address bar, no curl required.
//   • In dev there's no CSRF surface to worry about.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runCallBatch } from '@/lib/calls/engine';

// Force Node runtime — runCallBatch + service-role client need Node, not edge.
export const runtime = 'nodejs';

// Don't let Next.js try to statically optimize this route.
export const dynamic = 'force-dynamic';

type Defaults = {
  city: string;
  state: string;
  zip: string;
  intake_data: Record<string, unknown>;
};

// Per-category defaults so the Vapi assistant has realistic-sounding
// {{variables}} to interpolate. North County SD coverage is what we
// just seeded, so the geo defaults match.
const DEFAULTS: Record<string, Defaults> = {
  moving: {
    city: 'Encinitas',
    state: 'CA',
    zip: '92024',
    intake_data: {
      contact_name: 'Antonio',
      origin_city: 'Encinitas, CA 92024',
      destination_city: 'Carlsbad, CA 92008',
      home_size: '2 bedroom',
      move_date: 'flexible weekday in the next two weeks',
      stairs: 'one flight at the origin, none at destination',
      heavy_items: 'piano, treadmill',
      packing_help: 'no — boxes will be packed',
    },
  },
  cleaning: {
    city: 'Encinitas',
    state: 'CA',
    zip: '92024',
    intake_data: {
      contact_name: 'Antonio',
      home_size: '1800 sq ft, 3BR / 2BA',
      cleaning_type: 'standard recurring',
      frequency: 'biweekly',
      pets: 'one cat',
      special_requests: 'inside the oven and inside the fridge for the first visit',
    },
  },
};

export async function GET(req: Request) {
  // ── Layer 1: NODE_ENV gate ──
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { ok: false, error: 'Dev trigger is disabled in production' },
      { status: 404 }
    );
  }

  // ── Layer 2: optional shared-secret gate ──
  // If DEV_TRIGGER_TOKEN is set in .env.local, require it as ?token=…
  // Useful when running the dev server on a network where someone else
  // could hit localhost (e.g. ngrok, cloudflared trycloudflare).
  const expectedToken = process.env.DEV_TRIGGER_TOKEN?.trim();
  const url = new URL(req.url);
  if (expectedToken) {
    const provided = url.searchParams.get('token') ?? '';
    if (provided !== expectedToken) {
      return NextResponse.json(
        { ok: false, error: 'Invalid or missing ?token= for DEV_TRIGGER_TOKEN' },
        { status: 401 }
      );
    }
  }

  const categorySlug = (url.searchParams.get('category') ?? 'moving').toLowerCase();
  const defaults = DEFAULTS[categorySlug];
  if (!defaults) {
    return NextResponse.json(
      {
        ok: false,
        error: `Unknown category "${categorySlug}". Supported: ${Object.keys(DEFAULTS).join(', ')}`,
      },
      { status: 400 }
    );
  }

  const city = url.searchParams.get('city') ?? defaults.city;
  const state = url.searchParams.get('state') ?? defaults.state;
  const zip = url.searchParams.get('zip') ?? defaults.zip;

  const admin = createAdminClient();

  // 1. Resolve category UUID.
  const { data: category, error: catErr } = await admin
    .from('service_categories')
    .select('id, name')
    .eq('slug', categorySlug)
    .maybeSingle();

  if (catErr || !category) {
    return NextResponse.json(
      { ok: false, error: `Category lookup failed: ${catErr?.message ?? 'not found'}` },
      { status: 500 }
    );
  }

  // 2. Insert a synthetic quote_request directly in 'paid' state with a
  //    null vapi_batch_started_at — exactly what runCallBatch's claim
  //    update is looking for. user_id stays null (guest row, allowed
  //    since migration 0002).
  const { data: inserted, error: insErr } = await admin
    .from('quote_requests')
    .insert({
      category_id: category.id,
      status: 'paid',
      city,
      state,
      zip_code: zip,
      intake_data: defaults.intake_data,
      stripe_payment_id: `dev_trigger_${Date.now()}`,
    })
    .select('id')
    .single();

  if (insErr || !inserted) {
    return NextResponse.json(
      { ok: false, error: `Insert failed: ${insErr?.message ?? 'unknown'}` },
      { status: 500 }
    );
  }

  // 3. Run the batch. This is the same code path Stripe → enqueueQuoteCalls
  //    uses in prod, so we're testing the real flow end-to-end.
  const result = await runCallBatch({ quoteRequestId: inserted.id });

  return NextResponse.json({
    ok: true,
    quote_request_id: inserted.id,
    category: category.name,
    target: { city, state, zip },
    test_override_phone_active: !!process.env.TEST_OVERRIDE_PHONE?.trim(),
    batch: result,
    next: {
      supabase_calls_filter: `quote_request_id = '${inserted.id}'`,
      supabase_quotes_filter: `quote_request_id = '${inserted.id}'`,
      tip: 'Watch the dev server logs for [vapi] lines and the tunnel window for the post-call webhook.',
    },
  });
}
