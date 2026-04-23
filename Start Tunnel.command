#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# EvenQuote — Start Tunnel
# Double-click to expose your local dev server (:3000) to Vapi via a
# cloudflared "trycloudflare" tunnel and auto-PATCH the Vapi assistant's
# server.url so post-call webhooks land on your laptop.
#
# Run order:
#   1. Double-click  Start Preview.command   (dev server on :3000)
#   2. Double-click  Start Tunnel.command    (this file)
#   3. Trigger a call from the app.
#
# What it does:
#   • Verifies :3000 is up.
#   • Installs cloudflared via Homebrew if missing (one-time).
#   • Starts `cloudflared tunnel --url http://localhost:3000`.
#   • Parses the ephemeral *.trycloudflare.com URL out of cloudflared's
#     log and PATCHes the Vapi assistant's server.url to
#     <tunnel>/api/vapi/webhook (and re-syncs server.secret).
#   • Tails the tunnel log in this window so you can see traffic.
#
# To stop: Ctrl+C in this Terminal window. The trycloudflare URL is
# ephemeral — every restart gets a new URL and the script re-PATCHes
# Vapi automatically. Vapi's server.url stays pointed at the dead URL
# after you Ctrl+C; restart this script (or re-deploy to prod) to fix.
# ─────────────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")"

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │   EvenQuote — Vapi Tunnel                       │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

# ── 1. .env.local present and has the Vapi keys ──
if [ ! -f ".env.local" ]; then
  echo "  ✗ .env.local not found. Run Start Preview.command first."
  read -n 1 -s -r -p "  Press any key to close…"
  exit 1
fi

# Pull values out of .env.local. Strip surrounding quotes/whitespace and
# trailing comments — same shape as Start Preview.command's parser.
read_env() {
  local var="$1"
  grep -E "^${var}=" .env.local | head -n1 \
    | sed -E "s/^${var}=//; s/[[:space:]]*#.*$//; s/^['\"]//; s/['\"]$//; s/[[:space:]]+$//"
}

VAPI_API_KEY=$(read_env VAPI_API_KEY)
VAPI_ASSISTANT_ID=$(read_env VAPI_ASSISTANT_ID)
VAPI_WEBHOOK_SECRET=$(read_env VAPI_WEBHOOK_SECRET)

if [ -z "$VAPI_API_KEY" ] || [ -z "$VAPI_ASSISTANT_ID" ] || [ -z "$VAPI_WEBHOOK_SECRET" ]; then
  echo "  ✗ One of VAPI_API_KEY / VAPI_ASSISTANT_ID / VAPI_WEBHOOK_SECRET is"
  echo "    empty in .env.local. Fill them in and re-run."
  read -n 1 -s -r -p "  Press any key to close…"
  exit 1
fi
echo "  ✓ Vapi keys present"

# ── 2. Dev server actually responding on :3000? ──
# A tunnel pointing at a dead origin will just 502 every webhook. Check
# now so the user can fix it before we PATCH Vapi.
if ! curl -sSf -o /dev/null --max-time 3 "http://localhost:3000" 2>/dev/null; then
  echo "  ✗ Nothing responding on http://localhost:3000."
  echo ""
  echo "    Open  Start Preview.command  in another window first, wait for"
  echo "    'Ready in …', then re-run this script."
  echo ""
  read -n 1 -s -r -p "  Press any key to close…"
  exit 1
fi
echo "  ✓ Dev server responding on :3000"

# ── 3. cloudflared installed (or installable via brew) ──
if ! command -v cloudflared >/dev/null 2>&1; then
  echo ""
  echo "  cloudflared isn't installed. Installing via Homebrew (one-time)…"
  if ! command -v brew >/dev/null 2>&1; then
    echo "  ✗ Homebrew isn't installed either."
    echo "    Install brew from https://brew.sh, then re-run this script."
    read -n 1 -s -r -p "  Press any key to close…"
    exit 1
  fi
  brew install cloudflared
fi
echo "  ✓ cloudflared $(cloudflared --version 2>&1 | head -n1)"

# ── 4. Start the tunnel and capture its log so we can parse the URL ──
LOG=$(mktemp -t eq_tunnel.XXXXXX)
echo ""
echo "  Starting cloudflared tunnel → http://localhost:3000 …"
cloudflared tunnel --no-autoupdate --url http://localhost:3000 > "$LOG" 2>&1 &
TUNNEL_PID=$!

# Make sure we kill the tunnel and clean up the log on exit (Ctrl+C, etc.)
cleanup() {
  echo ""
  echo "  Stopping tunnel (pid $TUNNEL_PID)…"
  kill $TUNNEL_PID 2>/dev/null || true
  rm -f "$LOG"
  echo "  ✓ Tunnel stopped. Vapi's server.url is still pointed at the"
  echo "    (now dead) tunnel URL — re-run this script to issue a new one."
  echo ""
}
trap cleanup EXIT

# Wait up to 30s for the trycloudflare URL to show up in the log.
TUNNEL_URL=""
for i in {1..30}; do
  TUNNEL_URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | head -n1 || true)
  [ -n "$TUNNEL_URL" ] && break
  # Bail early if cloudflared has already died.
  if ! kill -0 $TUNNEL_PID 2>/dev/null; then
    echo "  ✗ cloudflared exited before printing a URL. Logs:"
    sed 's/^/      /' "$LOG"
    read -n 1 -s -r -p "  Press any key to close…"
    exit 1
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "  ✗ Tunnel URL never appeared. Last log lines:"
  tail -n 20 "$LOG" | sed 's/^/      /'
  read -n 1 -s -r -p "  Press any key to close…"
  exit 1
fi

WEBHOOK_URL="${TUNNEL_URL}/api/vapi/webhook"
echo "  ✓ Tunnel URL: $TUNNEL_URL"
echo "    Webhook:    $WEBHOOK_URL"

# ── 5. PATCH Vapi assistant.server.url + .secret ──
echo ""
echo "  Updating Vapi assistant ($VAPI_ASSISTANT_ID)…"

# Build the JSON payload with Python (avoids quoting hell with curl +
# bash). Python ships with macOS so this is safe.
PAYLOAD=$(VAPI_WEBHOOK_URL="$WEBHOOK_URL" VAPI_WEBHOOK_SECRET="$VAPI_WEBHOOK_SECRET" \
  /usr/bin/python3 -c '
import json, os
print(json.dumps({"server": {
    "url": os.environ["VAPI_WEBHOOK_URL"],
    "secret": os.environ["VAPI_WEBHOOK_SECRET"],
}}))')

HTTP_STATUS=$(curl -sS -o /tmp/eq_vapi_patch.json -w "%{http_code}" \
  -X PATCH "https://api.vapi.ai/assistant/$VAPI_ASSISTANT_ID" \
  -H "Authorization: Bearer $VAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

if [ "$HTTP_STATUS" != "200" ]; then
  echo "  ✗ Vapi PATCH failed (HTTP $HTTP_STATUS):"
  sed 's/^/      /' /tmp/eq_vapi_patch.json
  echo ""
  echo "    Tunnel is still up. You can PATCH manually if needed."
else
  echo "  ✓ Vapi assistant.server.url is now → $WEBHOOK_URL"
fi
rm -f /tmp/eq_vapi_patch.json

# ── 6. Tail the tunnel log so the user sees inbound traffic ──
echo ""
echo "  ─────────────────────────────────────────────────"
echo "  Tunnel is live. Webhook events will appear below."
echo "  Press Ctrl+C to stop the tunnel and close."
echo "  ─────────────────────────────────────────────────"
echo ""

tail -f "$LOG"
