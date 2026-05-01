# Email Sequences — Customer-Facing

Drop these into Resend templates. They match the EvenQuote brand voice (plain English, no corporate mush, treats the customer as a smart adult). All assume sender = `noreply@evenquote.com` with reply-to = `info@hocusbuzz.com`.

Preserve the `{{variable}}` syntax for Resend / your template engine — swap to your library's syntax as needed.

---

## 1. Confirmation (sent immediately on payment)

**Subject:** `We're calling movers for you now — your comparison hits in ~45 min`

(Swap "movers" for the right vertical noun.)

**Preview text:** `Quote request received. Here's exactly what happens next.`

**Body:**

```
Hi {{first_name}},

Got your request for {{vertical}} quotes in {{city}} — payment cleared, we're already dialing.

Here's what happens in the next hour:

1. Our system calls 5 local {{vertical_pros}} on your behalf.
2. We ask each one for a real quote based on what you told us.
3. We email you a one-page comparison the moment we have enough numbers (usually 30–60 min).

You don't need to do anything. Your phone stays quiet — no contractors will call you. If we can't reach enough pros to give you a useful comparison, we refund the $9.99 automatically and email you a heads-up.

Questions? Just reply to this email — it goes to a real human.

— Antonio
EvenQuote
```

---

## 2. Results delivered (sent when quotes are ready)

**Subject:** `Your {{vertical}} quote comparison is ready`

**Preview text:** `{{quote_count}} quotes back. Range: ${{quote_min}} to ${{quote_max}}.`

**Body:**

```
Hi {{first_name}},

Comparison's ready. Here are the {{quote_count}} {{vertical_pros}} we got real quotes from for your job in {{city}}:

[ATTACHMENT / EMBEDDED TABLE — your existing template]

A few things worth noting:

• These are the quotes the pros gave us based on the job you described. Final invoice can shift if the actual job is bigger/smaller than what we told them.
• We didn't share your phone number with any of them. To book, you contact whichever you pick directly using the number in the comparison.
• Quotes are typically valid for 7 days — sooner is better.

If you book one of these, would you reply with which one and how it went? It's the single best thing you can do to help us keep this service good (and cheap).

— Antonio
EvenQuote

P.S. The comparison is also available in your dashboard at https://evenquote.com/dashboard for the next 30 days.
```

---

## 3. No-result / refund issued (sent when not enough pros responded)

**Subject:** `We struck out — your $9.99 is on its way back`

**Preview text:** `Couldn't reach enough pros today. Refund issued + a backup plan.`

**Body:**

```
Hi {{first_name}},

Bad news first: we tried {{businesses_called}} {{vertical_pros}} in {{city}} for your job, and {{businesses_responded}} gave us a usable quote. That's not enough for a real comparison, so we refunded your $9.99 — should hit your card in 3-5 business days.

A few possible reasons this happens:

• Your area genuinely has thin coverage for this service right now.
• Friday afternoons / weekends — pros are out on jobs and don't pick up.
• Your job description was unusual enough that pros wanted to do an on-site walkthrough first.

What I'd suggest:

1. Try us again Monday or Tuesday morning — coverage is meaningfully better mid-week.
2. If the issue is on-site walkthroughs, we can flag the request as "no walkthrough required, ballpark OK" — reply and tell me the job and I'll personally re-run it.
3. If your area's just thin, sorry — that's a coverage problem on our end, not a you problem.

Either way, you're not out the $9.99. Thanks for trying us.

— Antonio
EvenQuote
```

---

## 4. Coverage-gap variant (when we couldn't even find enough pros to call)

**Subject:** `Your refund is in — couldn't find enough local pros to call`

(Use this version specifically when the issue is "we couldn't find any to call" rather than "we called but they didn't respond" — your `noQuoteCause = 'coverage_gap'` branch.)

**Body:**

```
Hi {{first_name}},

Quick heads-up: we couldn't find any {{vertical_pros}} in {{zip}} that fit your job criteria. Refund is on its way back to your card (3-5 business days).

This usually means one of two things:

• Your zip is at the edge of where we have coverage. (We're growing — the list of pros we know about is getting longer every week.)
• The job is specialized enough that the pros in our directory don't handle it.

If you want, reply with a quick description of the job and I'll personally look at whether we should expand our directory to cover it. We don't get better unless someone tells us where we're thin.

Either way — sorry we couldn't help today, and thanks for trying us.

— Antonio
EvenQuote
```

---

## 5. Win-back (sent 30 days after a successful quote)

**Subject:** `How'd the {{vertical}} go?`

**Preview text:** `Quick question — and a discount on your next quote.`

**Body:**

```
Hi {{first_name}},

It's been a month since we sent you {{vertical}} quotes for your job in {{city}}. Two quick asks:

1. Did you book one of the pros we found? If yes — which one, and how was it? (One sentence is fine. This is the single best signal we have for whether the comparison was actually useful.)

2. If you've got another quote to get — moving, cleaning, handyman, lawn care — drop the code WELCOMEBACK at checkout for $5 off. Code's good for the next 30 days.

Thanks for trying EvenQuote when we were brand new. Word of mouth is genuinely how we grow.

— Antonio
EvenQuote
```

---

## 6. Lead-magnet capture (move-out cleaning checklist — for `/get-quotes/cleaning` exit-intent)

**Subject:** `Your move-out cleaning checklist is here`

**Body:**

```
Hi {{first_name}},

Here's the checklist we promised: [PDF attached]

It's the same checklist most CA landlords use to decide whether to return a deposit. Work through it room by room, take photos, and you'll be in good shape whether you DIY or hire it out.

If you want a comparison of move-out cleaning quotes from local pros (anonymous, no spam), we'll do the calling for $9.99: https://evenquote.com/get-quotes/cleaning

Either way — good luck with the move.

— Antonio
EvenQuote
```

---

## A/B test plan

Run for 2 weeks each. Need >100 sends per arm to draw any conclusion.

| Email | Test variable | A | B |
|---|---|---|---|
| Confirmation | Subject | "We're calling movers for you now — comparison in ~45 min" | "Got your quote request — here's what happens next" |
| Results-delivered | Subject | "Your {{vertical}} comparison is ready" | "{{quote_count}} {{vertical}} quotes back: ${{min}}–${{max}}" |
| Win-back | CTA | $5 off ("WELCOMEBACK") | Free request ("FREE1") |

The "Free first request back" variant of the win-back is the riskier-but-juicier test. If it doubles repeat rate, your unit economics improve dramatically — repeat customers cost $0 to acquire.
