// /admin/requests/[id] — full operator view of one quote request.
//
// Shows:
//   • Request header (status, counters, location, contact, Stripe id)
//   • Original intake JSON (pretty-printed)
//   • Every calls row (outbound + inbound callback + SMS) with status,
//     duration, cost, transcript preview, recording link
//   • Every quotes row with price range, availability, contact, notes
//
// Admin-only via requireAdmin(). Uses service-role client to bypass
// RLS. Transcripts can contain PII (names, phone numbers) — this page
// is operator-only, same trust boundary as Supabase's Table Editor.

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { SiteNavbar } from '@/components/site/navbar';
import { ArchiveButton } from '@/components/admin/archive-button';
import { RetryUnreachedButton } from '@/components/admin/retry-unreached-button';
import { RerunExtractorButton } from '@/components/admin/rerun-extractor-button';

export const metadata: Metadata = {
  title: 'Request · Admin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const admin = createAdminClient();
  const { id } = await params;

  const { data: request } = await admin
    .from('quote_requests')
    .select(
      `id, status, city, state, zip_code,
       total_businesses_to_call, total_calls_completed, total_quotes_collected,
       stripe_payment_id, user_id, intake_data, archived_at,
       created_at, category_id,
       service_categories:category_id(name, slug)`
    )
    .eq('id', id)
    .maybeSingle();

  if (!request) notFound();

  // Parallel: calls + quotes + user profile.
  const [calls, quotes, profile] = await Promise.all([
    admin
      .from('calls')
      .select(
        `id, status, started_at, ended_at, duration_seconds,
         vapi_call_id, cost, retry_count, transcript, summary, recording_url,
         created_at, business:business_id(name, phone, email)`
      )
      .eq('quote_request_id', id)
      .order('created_at', { ascending: true }),
    admin
      .from('quotes')
      .select(
        `id, price_min, price_max, price_description, availability,
         includes, excludes, notes, contact_name, contact_phone, contact_email,
         requires_onsite_estimate, confidence_score, created_at,
         business:business_id(name)`
      )
      .eq('quote_request_id', id)
      .order('created_at', { ascending: true }),
    request.user_id
      ? admin
          .from('profiles')
          .select('email, full_name')
          .eq('id', request.user_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const sc = Array.isArray(request.service_categories)
    ? request.service_categories[0]
    : request.service_categories;
  const intake = (request.intake_data ?? {}) as Record<string, unknown>;

  return (
    <>
      <SiteNavbar />
      <main className="container py-10 sm:py-14">
        <p className="label-eyebrow mb-1">
          <Link href="/admin" className="hover:underline">Admin</Link> /{' '}
          <Link href="/admin/requests" className="hover:underline">Requests</Link>
        </p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              {sc?.name ?? 'Quote request'}
              {request.archived_at ? (
                <span className="ml-3 align-middle inline-block rounded-sm bg-foreground/10 px-2 py-0.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  archived
                </span>
              ) : null}
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-widest text-muted-foreground">
              {request.id}
            </p>
          </div>
          <ArchiveButton requestId={request.id} archived={!!request.archived_at} />
          <div className="flex flex-wrap gap-4 text-right font-mono text-xs uppercase tracking-widest">
            <div>
              <div className="text-muted-foreground">Status</div>
              <div className="text-foreground">{request.status}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Calls</div>
              <div className="text-foreground">
                {request.total_calls_completed ?? 0}/{request.total_businesses_to_call ?? 0}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Quotes</div>
              <div className="text-foreground">{request.total_quotes_collected ?? 0}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Stripe</div>
              <div className="text-foreground">
                {request.stripe_payment_id
                  ? request.stripe_payment_id.startsWith('dev_trigger')
                    ? 'dev trigger'
                    : 'paid'
                  : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Owner + geo */}
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <Box title="Location">
            <div>
              {request.city}, {request.state} {request.zip_code}
            </div>
          </Box>
          <Box title="Owner">
            {profile.data ? (
              <div>
                {profile.data.full_name ?? '—'}{' '}
                <span className="font-mono text-[11px] text-muted-foreground">
                  ({profile.data.email})
                </span>
              </div>
            ) : (
              <div className="text-muted-foreground">
                Guest (not yet claimed)
                {typeof intake.contact_email === 'string' ? (
                  <span className="ml-2 font-mono text-[11px]">
                    intake: {intake.contact_email as string}
                  </span>
                ) : null}
              </div>
            )}
          </Box>
        </div>

        {/* Intake JSON */}
        <section className="mt-10">
          <h2 className="mb-2 font-display text-xl font-bold tracking-tight">
            Intake
          </h2>
          <pre className="overflow-x-auto rounded-md border-2 border-foreground/80 bg-foreground/5 p-4 font-mono text-xs leading-relaxed">
            {JSON.stringify(intake, null, 2)}
          </pre>
        </section>

        {/* Calls */}
        <section className="mt-10">
          <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
            <h2 className="font-display text-xl font-bold tracking-tight">
              Calls ({calls.data?.length ?? 0})
            </h2>
            <div className="flex flex-wrap gap-2">
              <RerunExtractorButton requestId={request.id} />
              <RetryUnreachedButton requestId={request.id} />
            </div>
          </div>
          <div className="space-y-3">
            {(calls.data ?? []).map((c) => {
              const biz = Array.isArray(c.business) ? c.business[0] : c.business;
              const isSms = c.vapi_call_id?.startsWith('sms_') ?? false;
              return (
                <div
                  key={c.id}
                  className="rounded-md border-2 border-foreground/80 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-display text-base font-semibold">
                        {biz?.name ?? '(unknown)'}
                      </div>
                      <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                        {biz?.phone ?? ''} · {isSms ? 'SMS' : 'voice'}
                      </div>
                    </div>
                    <div className="text-right font-mono text-[11px] uppercase tracking-widest">
                      <div>
                        status: <span className="text-foreground">{c.status}</span>
                      </div>
                      <div>
                        duration:{' '}
                        <span className="text-foreground tabular-nums">
                          {c.duration_seconds ?? 0}s
                        </span>
                      </div>
                      {c.cost != null ? (
                        <div>
                          cost: <span className="text-foreground tabular-nums">${Number(c.cost).toFixed(4)}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {c.summary ? (
                    <p className="mt-3 text-sm italic text-muted-foreground">
                      {c.summary}
                    </p>
                  ) : null}

                  {c.transcript ? (
                    <details className="mt-3">
                      <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                        Transcript ({c.transcript.length.toLocaleString()} chars)
                      </summary>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-sm bg-foreground/5 p-3 font-mono text-[11px] leading-relaxed">
                        {c.transcript}
                      </pre>
                    </details>
                  ) : null}

                  {c.recording_url ? (
                    <a
                      href={c.recording_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-block font-mono text-[11px] uppercase tracking-widest underline"
                    >
                      ↗ recording
                    </a>
                  ) : null}
                </div>
              );
            })}
            {(!calls.data || calls.data.length === 0) && (
              <p className="text-muted-foreground">No calls yet.</p>
            )}
          </div>
        </section>

        {/* Quotes */}
        <section className="mt-10 mb-16">
          <h2 className="mb-2 font-display text-xl font-bold tracking-tight">
            Quotes ({quotes.data?.length ?? 0})
          </h2>
          <div className="space-y-3">
            {(quotes.data ?? []).map((q) => {
              const biz = Array.isArray(q.business) ? q.business[0] : q.business;
              return (
                <div
                  key={q.id}
                  className="rounded-md border-2 border-foreground/80 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="font-display text-base font-semibold">
                      {biz?.name ?? '(unknown)'}
                    </div>
                    <div className="font-display text-xl font-bold tabular-nums">
                      {formatPrice(q.price_min, q.price_max)}
                    </div>
                  </div>
                  {q.availability ? (
                    <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                      avail: {q.availability}
                    </div>
                  ) : null}
                  {Array.isArray(q.includes) && q.includes.length ? (
                    <p className="mt-2 text-sm">
                      <strong className="font-mono text-[10px] uppercase tracking-widest">
                        includes:
                      </strong>{' '}
                      {q.includes.join(', ')}
                    </p>
                  ) : null}
                  {Array.isArray(q.excludes) && q.excludes.length ? (
                    <p className="mt-1 text-sm">
                      <strong className="font-mono text-[10px] uppercase tracking-widest">
                        excludes:
                      </strong>{' '}
                      {q.excludes.join(', ')}
                    </p>
                  ) : null}
                  {q.notes ? (
                    <p className="mt-2 text-sm italic text-muted-foreground">
                      {q.notes}
                    </p>
                  ) : null}
                  {q.requires_onsite_estimate ? (
                    <span className="mt-2 inline-block rounded-sm bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest">
                      onsite estimate required
                    </span>
                  ) : null}
                </div>
              );
            })}
            {(!quotes.data || quotes.data.length === 0) && (
              <p className="text-muted-foreground">No quotes yet.</p>
            )}
          </div>
        </section>
      </main>
    </>
  );
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border-2 border-foreground/80 p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function formatPrice(min: number | null, max: number | null): string {
  if (min == null && max == null) return '—';
  if (min != null && max != null && min === max) return `$${min.toLocaleString()}`;
  if (min != null && max != null) return `$${min.toLocaleString()}–${max.toLocaleString()}`;
  if (min != null) return `from $${min.toLocaleString()}`;
  return `up to $${(max as number).toLocaleString()}`;
}
