# evenquote.com — domain & email setup runbook

Everything you need to do on your registrar + Vercel + Google Workspace
(or alternative) to make the Phase 5 flow work end-to-end on a real
domain. Copy-paste-friendly. Run the verification dig commands at the
bottom after each change propagates.

> **Order matters only where noted.** Most records can be added in
> parallel. But DO wait for TLS to auto-issue before switching any
> production traffic over.

---

## 0. Pick an email host

The magic-link + support flow needs inbound email on `evenquote.com`.
Pick one — these are the three most reliable picks for a small team:

| Host                     | Cost           | Trade-off                                                                 |
|--------------------------|----------------|---------------------------------------------------------------------------|
| **Google Workspace**     | $7/user/mo     | Best deliverability, familiar UX. What most folks go with.                |
| **Fastmail**             | $5/user/mo     | Clean, no-ads, good filtering. Great for solo founders.                   |
| **Proton Mail (paid)**   | $7.99/user/mo  | E2EE. Overkill for transactional + support; only if you care about that.  |

You don't need separate mailboxes for each alias — set one mailbox
(e.g. `antonio@`) and use the host's alias feature to route the rest.

**Pick before continuing.** The MX records below differ per host.

---

## 1. Mailboxes / aliases to reserve

Reserve all of these on day one so nobody else can squat them and so
automated systems have a place to send to:

- `antonio@evenquote.com` — primary mailbox, receives forwarded aliases
- `support@evenquote.com` → alias to `antonio@` (customer replies)
- `noreply@evenquote.com` — sender-only, used by magic-link + receipts
- `dmarc@evenquote.com` → alias to `antonio@` (DMARC aggregate reports)
- `hello@evenquote.com` → alias to `antonio@` (press, partnership)
- `legal@evenquote.com` → alias to `antonio@` (privacy, DMCA, subpoenas)

---

## 2. DNS records

Log into your registrar's DNS editor. Add the following records.
Replace `VERCEL_IP`, `MX_HOST`, and `DKIM_...` values with the ones
your host gives you.

### 2a. Apex + www → Vercel

```
TYPE   HOST   VALUE                       TTL
A      @      76.76.21.21                 3600
CNAME  www    cname.vercel-dns.com.       3600
```

> Vercel's current apex IP is `76.76.21.21`. If their dashboard shows
> something different, use theirs. TLS auto-issues once the A record
> resolves and you've added `evenquote.com` in the Vercel project.

### 2b. MX (pick ONE block matching your host)

**Google Workspace:**
```
TYPE   HOST   PRIORITY   VALUE                           TTL
MX     @      1          smtp.google.com.                3600
```

**Fastmail:**
```
TYPE   HOST   PRIORITY   VALUE                           TTL
MX     @      10         in1-smtp.messagingengine.com.   3600
MX     @      20         in2-smtp.messagingengine.com.   3600
```

**Proton Mail:**
```
TYPE   HOST   PRIORITY   VALUE                           TTL
MX     @      10         mail.protonmail.ch.             3600
MX     @      20         mailsec.protonmail.ch.          3600
```

### 2c. SPF — ONE record, includes every sender

This is the single most common screw-up. **You may only have one SPF
record.** If you have two, BOTH are invalid. Merge into one:

```
TYPE   HOST   VALUE
TXT    @      v=spf1 include:_spf.google.com include:_spf.resend.com -all
```

- Swap `include:_spf.google.com` for your host (`spf.messagingengine.com`
  for Fastmail, `_spf.protonmail.ch` for Proton).
- Add an `include:` per additional sender (Stripe doesn't need one —
  they send from their own domain on your behalf).
- End with `-all` (hardfail) once you're confident. Start with `~all`
  (softfail) while testing.

### 2d. DKIM — per sender

Each sender (Workspace, Resend, SES, etc.) gives you a unique DKIM
public key to publish. These look like:

```
TYPE   HOST                                  VALUE
TXT    google._domainkey                     v=DKIM1; k=rsa; p=MIIB...<long base64>
TXT    resend._domainkey                     v=DKIM1; k=rsa; p=MIIB...
```

Add whichever your hosts hand you. **Never share DKIM selectors
between senders.**

### 2e. DMARC — start loose, tighten later

```
TYPE   HOST      VALUE
TXT    _dmarc    v=DMARC1; p=none; rua=mailto:dmarc@evenquote.com; ruf=mailto:dmarc@evenquote.com; fo=1; pct=100
```

Run this at `p=none` for 2 weeks, read the aggregate reports
(they'll land in `dmarc@`), confirm nothing legitimate is being
flagged, then bump to `p=quarantine`. Move to `p=reject` only after
another clean month.

---

## 3. Vercel project hookup

1. In the Vercel project → Settings → Domains → add `evenquote.com`
   and `www.evenquote.com`.
2. Vercel will tell you which record(s) it's waiting on — they should
   already be present from step 2a.
3. TLS cert should auto-issue within a minute of the A record
   resolving.
4. Set `NEXT_PUBLIC_APP_URL=https://evenquote.com` in production env.
5. Redeploy so the new env is picked up (server actions read this at
   request time, but the client-side bundle needs a rebuild).

---

## 4. Stripe webhook on production

Once deployed:

1. Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://evenquote.com/api/stripe/webhook`
3. Events to send: `checkout.session.completed` (that's all Phase 5
   cares about)
4. Copy the signing secret (`whsec_...`) into Vercel env as
   `STRIPE_WEBHOOK_SECRET`.
5. Redeploy, then fire a test event from the Stripe dashboard and
   confirm a 200 and a row in `payments`.

---

## 5. Supabase magic-link domain allowlist

Supabase project → Authentication → URL Configuration:

- **Site URL:** `https://evenquote.com`
- **Redirect URLs (allowlist):** add `https://evenquote.com/auth/callback`
  and `https://evenquote.com/get-quotes/claim`

Without this, magic-link emails will click through to an "unauthorized
redirect" error. It's the most common reason a newly-deployed flow
silently fails.

---

## 6. Verification commands

Run these from any terminal. Substitute your real DKIM selectors.

```sh
# Apex + www resolve to Vercel
dig +short evenquote.com A
dig +short www.evenquote.com CNAME

# MX points to your mail host
dig +short evenquote.com MX

# SPF — should return exactly ONE line
dig +short evenquote.com TXT | grep "v=spf1"

# DKIM — one per sender
dig +short google._domainkey.evenquote.com TXT
dig +short resend._domainkey.evenquote.com TXT

# DMARC
dig +short _dmarc.evenquote.com TXT

# TLS handshake works
curl -vI https://evenquote.com 2>&1 | grep -E "^(HTTP|<|>|\*)" | head -20
```

Additionally, send yourself a test message from the Supabase auth
screen (Trigger magic link) and confirm:

- The email lands in inbox (not spam).
- `Authentication-Results` header shows `spf=pass dkim=pass dmarc=pass`.
- Clicking the link lands on `/get-quotes/claim?request=...` and
  backfills `quote_requests.user_id`.

---

## 7. After everything passes

- Bump DMARC `p=none` → `p=quarantine` (after 2 clean weeks).
- Tighten SPF `~all` → `-all` (once you're sure every sender is
  `include:`-d).
- Add `evenquote.com` to Google Postmaster Tools and start watching
  your sender reputation.
- Set up a scheduled monthly check of `dmarc@` for unexpected senders.
