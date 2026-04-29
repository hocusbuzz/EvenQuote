#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# EvenQuote — Check CSP
# Double-click to print the Content-Security-Policy header from each
# target. Useful when:
#   • You flipped CSP_NONCE_ENABLED=true in Vercel and want to confirm
#     the nonce middleware is actually emitting the richer header.
#   • You're starting the CSP Report-Only window and want to verify
#     Report-Only vs. enforced mode from outside the browser devtools.
#   • You pushed a change to `middleware.ts` or `next.config.mjs` and
#     want a 5-second check that the header is still on the response.
#
# What it checks, in order:
#   1. Production  — https://evenquote.com/
#   2. Local dev   — http://localhost:3000/  (only if responding)
#
# CSP flows from middleware, not from the route handler, so this probe
# works against the home page specifically (cheapest public GET that
# flows through the full middleware stack).
# ─────────────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")"

PROD_URL="https://evenquote.com/"
LOCAL_URL="http://localhost:3000/"

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │   EvenQuote — Check CSP                         │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

# Grab and print CSP + Report-Only variant; note other security headers
# while we're at it so drift (HSTS dropped, X-Frame-Options flipped)
# gets caught by the same launcher.
probe() {
  local label="$1"
  local url="$2"
  local timeout="$3"

  echo "  ── $label ──"
  echo "  URL: $url"
  echo ""

  local tmp
  tmp=$(mktemp /tmp/eq-csp-XXXXXX)
  local http
  http=$(curl -sS -D "$tmp" --max-time "$timeout" -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")

  if [ "$http" = "000" ]; then
    echo "  (no response — host unreachable or not running)"
    rm -f "$tmp"
    return 1
  fi

  echo "  HTTP $http"
  echo ""

  # Extract CSP + related security headers case-insensitively. grep -i
  # survives Node/Vercel's mixed-case header emission.
  for header in \
    "Content-Security-Policy" \
    "Content-Security-Policy-Report-Only" \
    "Strict-Transport-Security" \
    "X-Frame-Options" \
    "X-Content-Type-Options" \
    "Referrer-Policy" \
    "Permissions-Policy"
  do
    local line
    line=$(grep -i "^${header}:" "$tmp" | head -1 | tr -d '\r')
    if [ -n "$line" ]; then
      echo "  $line"
    else
      echo "  (no ${header})"
    fi
  done
  echo ""
  rm -f "$tmp"
}

# Production — always probe.
probe "Production" "$PROD_URL" 10 || true
echo ""

# Local — only if something's actually listening on :3000.
if lsof -ti tcp:3000 >/dev/null 2>&1; then
  probe "Local (localhost:3000)" "$LOCAL_URL" 3 || true
else
  echo "  ── Local (localhost:3000) ──"
  echo "  (skipped — nothing listening on :3000)"
  echo ""
fi

echo ""
echo "  Done. Close this window when you're finished reading."
echo ""

# Keep the Terminal window open on double-click.
read -n 1 -s -r -p "  Press any key to close…"
echo ""
