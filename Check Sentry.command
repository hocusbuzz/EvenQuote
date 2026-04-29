#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# EvenQuote — Check Sentry  (PLACEHOLDER)
# Double-click to probe the error-monitoring backend.
#
# Status: Sentry is NOT wired up yet.
#
# See: `docs/DAILY_REPORT_2026-04-22.md` — Round 13 carry-forward #6.
# Summary: `lib/logger.ts` already has PII redaction + auto-fingerprint
# ready to feed Sentry (or any equivalent error tracker). The piece
# that's missing is the actual DSN + the `@sentry/nextjs` wiring.
#
# When this is wired, replace the body of this script with:
#
#   1. A curl against https://sentry.io/api/0/organizations/evenquote/
#      or the self-hosted instance's /api/0/health/ using
#      $SENTRY_AUTH_TOKEN from 1Password.
#   2. A count of the last 24h of events for the "evenquote" project —
#      a sudden zero is a misconfiguration signal (events stopped
#      flowing, i.e. the SDK broke on a deploy).
#
# Keeping this file as a contiguous pair to the other .command
# launchers so the dock / Finder view shows the full operations set.
# ─────────────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")"

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │   EvenQuote — Check Sentry  (PLACEHOLDER)       │"
echo "  └─────────────────────────────────────────────────┘"
echo ""
echo "  Sentry is not wired yet."
echo ""
echo "  See:  docs/DAILY_REPORT_2026-04-22.md  →  Round 13 carry-forward #6."
echo ""
echo "  When you configure it, replace this script's body with a curl"
echo "  against the Sentry health API + a 24h event count so you have"
echo "  a one-click way to confirm events are still flowing."
echo ""

read -n 1 -s -r -p "  Press any key to close…"
echo ""
