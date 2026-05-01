-- ══════════════════════════════════════════════════════════════════════
-- quote_requests.utm_*  — paid-traffic attribution columns
--
-- Marketing prep for the Day-8 paid Google Ads / Meta / Reddit launch.
-- Without these we can't tie a paid request back to the campaign that
-- produced it, which means we can't compute CAC by channel and every
-- ad dollar is unmeasurable.
--
-- Spec: marketing/INBOX_FOR_DEV_CHANNEL.md → "Wire analytics before any
-- paid spend".
--
-- Five standard UTM params, all nullable text. Captured from the
-- landing URL on the get-quotes pages by components/get-quotes/utm-
-- capture.tsx, persisted into a Zustand store, then merged into the
-- form payload at submit. The intake server actions read them off the
-- (Zod-validated) payload and persist here.
--
-- Why nullable:
--   • Pre-launch rows (cd9d6c7 and earlier) have no UTMs — backfill
--     is meaningless and we don't want bogus 'organic' guesses.
--   • Direct + organic traffic legitimately has no UTMs going forward.
--     NULL is the correct "no campaign attached" signal.
--
-- Why text not enum: utm_campaign / utm_content are user-defined per
-- ad. Enums would force a migration every time marketing spins up a
-- new campaign. Text + an admin-side allowlist (later) is the right
-- shape.
--
-- No index: we don't query by UTM in the hot path. Cohort / CAC
-- analysis runs on a materialized view (planned for backlog #5).
-- ══════════════════════════════════════════════════════════════════════

alter table public.quote_requests
  add column if not exists utm_source text;

alter table public.quote_requests
  add column if not exists utm_medium text;

alter table public.quote_requests
  add column if not exists utm_campaign text;

alter table public.quote_requests
  add column if not exists utm_content text;

alter table public.quote_requests
  add column if not exists utm_term text;

comment on column public.quote_requests.utm_source is
  'utm_source from the landing URL — the platform/site that sent the '
  'visitor (e.g., google, reddit, facebook, partner-leasing-office). '
  'NULL for direct + organic + pre-launch rows.';

comment on column public.quote_requests.utm_medium is
  'utm_medium — the channel type (cpc, paid-social, email, referral). '
  'NULL when no UTM was attached.';

comment on column public.quote_requests.utm_campaign is
  'utm_campaign — the named campaign (e.g., sd-moving-2026-05). User-'
  'defined per ad; no enum constraint.';

comment on column public.quote_requests.utm_content is
  'utm_content — ad variant or creative identifier. Used for A/B copy '
  'attribution within a campaign.';

comment on column public.quote_requests.utm_term is
  'utm_term — keyword or audience descriptor (Google Ads sets this '
  'automatically for some bid types).';
