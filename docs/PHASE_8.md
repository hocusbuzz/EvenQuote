# Phase 8 — Opt-in contact release + DLQ admin

Phase 7 shipped reliability. Phase 8 closes the last big hole in the
customer experience: after a customer gets their report, they can
share their phone/email with a specific business of their choosing,
and _only_ that business. And the admin side gets the first bit of
DLQ visibility so dispatch-failed calls don't disappear into the
void once they exhaust retries.

## What shipped

### Schema (`supabase/migrations/0007_phase8_contact_release.sql`)

- **`quotes.contact_released_at`** (timestamptz, nullable) — null
  means "customer hasn't shared their contact with this business
  yet". Non-null means we've emailed the business with the
  customer's full contact details. Partial index
  `quotes_released_idx` keeps the dashboard query fast.
- **`quote_contact_releases`** — audit table, one row per release.
  `unique(quote_id)` enforces at-most-once-per-quote so retries
  don't spam the business. Stores `email_send_id` (Resend id or
  `sim_*` in dev), `email_simulated`, and `email_error` so ops can
  reconcile after failures.
- RLS: owners can read their own release rows; admins see all.
  Writes are service-role only — the server action is the only
  writer.

### Server action (`lib/actions/release-contact.ts`)

`releaseContactToBusiness(quoteId: string)` — single entry point.
Pipeline:

1. Cookie-bound client checks that the current user owns the
   quote (via the "quotes: owner read via request" RLS policy).
   An ownership miss returns a generic "couldn't find that quote"
   message without revealing whether it exists.
2. If already released, short-circuit with `alreadyReleased: true`.
   Idempotent.
3. Service-role client loads quote + request + business for
   composing the email. Customer contact info comes out of
   `quote_requests.intake_data` (`contact_name`, `contact_phone`,
   `contact_email` — shape is consistent across all intake forms).
4. Renders via `renderContactRelease` from `lib/email/templates.ts`
   and sends via `sendEmail` from `lib/email/resend.ts`.
   `reply_to` is set to the customer's email so a direct reply
   from the business reaches them.
5. Audit row is inserted _before_ the stamp, so a crash between
   the two still leaves a trail. The stamp update is the only
   place `contact_released_at` is set.

Error shapes:

- Send fails → audit row inserted with `email_error`, no stamp.
  Customer can retry from the UI.
- Audit insert fails after a successful send → loud log but no
  visible error (we'd rather risk a "Share" button that
  ambiguously looks successful than block the customer). The
  Resend dashboard is the backstop.

### UI

- **`/dashboard`** — upgraded from the Phase 2 stub. Lists the
  signed-in user's quote requests with category / location /
  status / quote count. Uses the cookie client (RLS scopes to
  owner automatically).
- **`/dashboard/requests/[id]`** — server component rendering a
  per-quote comparison view. Each quote card gets a
  `<ReleaseContactButton>` client component. On click it calls
  the server action with `useTransition` for a pending state,
  flips to "✓ Contact shared" on success, shows inline error
  text on failure.
- **`/admin/failed-calls`** — DLQ admin surface. Service-role
  query scoped to `status='failed' AND started_at IS NULL AND
  retry_count >= 3`. Read-only; the page footer documents the
  SQL to re-queue a row. `requireAdmin()` gates access via
  `profiles.role = 'admin'`; non-admins get bounced to `/`.

## How to test

### Contact release

1. Complete a real-or-simulated batch so you have quotes with
   `contact_released_at = null`.
2. Open `/dashboard/requests/<id>`. Each quote shows a "Share my
   contact" button.
3. Click one. With `RESEND_API_KEY` unset, the Resend client
   logs `[email] simulated send → <business email> …`. With it
   set, the business receives the real email.
4. Verify: `contact_released_at` is stamped on the quote row and
   one row exists in `quote_contact_releases` with
   `email_simulated = true|false` matching your Resend state.
5. Click again. The button is now "✓ Contact shared" and no
   second row is inserted.

### DLQ admin

1. Seed a DLQ row:

   ```sql
   update calls
      set status='failed', started_at=null, retry_count=3,
          last_retry_at=now() - interval '1 hour'
    where id = '<some-uuid>';
   ```

2. Promote yourself to admin: `update profiles set role='admin'
   where id = '<your-user-id>'`.
3. Visit `/admin/failed-calls`. You should see the row. Non-admins
   hitting the URL get redirected to `/`.

## Known gaps (Phase 10+)

- **No "withdraw share" flow.** Once released, the business has
  the customer's info. We could wire a "my mistake, please delete"
  button, but until we have a business-side surface to enforce
  deletions, it'd be theater.
- **Release button doesn't link to the business's own page.** It
  hides the business email by design (no customer should ever see
  it) but we could surface phone/address so the customer has
  context on who they're releasing to. Phase 10 dashboard redesign.
- **Admin page is read-only.** No one-click re-queue button yet.
  Intentional — Phase 11 builds a proper admin surface once we
  know what ops actually needs.
