#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# EvenQuote — Start Stripe Listener
# Double-click this file to forward Stripe test webhooks to your local
# preview at :3000/api/stripe/webhook.
#
# When you need this:
#   - Testing the paid checkout → success-page → cron flow.
#   - Anytime Stripe needs to call your local server (refunds, payment
#     events, etc.).
#
# When you DON'T need this:
#   - Just clicking around the public marketing pages or intake form.
#
# Run this in addition to (not instead of) Start Preview.command —
# both windows stay open.
#
# To stop: press Ctrl+C in this window, then close it.
# ─────────────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")"

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │   EvenQuote — Stripe Webhook Listener           │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

# ── 1. Stripe CLI installed? Auto-install via Homebrew if not. ──
# Make sure brew is on PATH for Apple-Silicon Homebrew installs (which
# install to /opt/homebrew, not always on the default Terminal PATH).
if [ -x "/opt/homebrew/bin/brew" ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x "/usr/local/bin/brew" ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

if ! command -v stripe >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "  ✗ Homebrew is not installed (or not on this Terminal's PATH)."
    echo ""
    echo "    Install Homebrew from https://brew.sh, then re-launch this file."
    echo ""
    read -n 1 -s -r -p "  Press any key to close…"
    exit 1
  fi
  echo "  → Installing the Stripe CLI via Homebrew (one-time, ~30s)…"
  brew install stripe/stripe-cli/stripe
  echo ""
fi
echo "  ✓ Stripe CLI $(stripe --version | head -n1)"

# ── 2. Logged in? ──
# `stripe config --list` prints a key/account block when authenticated.
if ! stripe config --list 2>/dev/null | grep -q "test_mode_api_key\|live_mode_api_key"; then
  echo ""
  echo "  → First-time setup: you need to log in to Stripe once."
  echo "    A browser tab will open — approve the connection there."
  echo ""
  read -n 1 -s -r -p "  Press any key to start login…"
  echo ""
  stripe login
  echo ""
fi
echo "  ✓ Stripe CLI authenticated"

# ── 3. Reminder about the signing secret. ──
echo ""
echo "  IMPORTANT — first time only:"
echo "  When the listener starts, copy the line that begins with"
echo "  'Your webhook signing secret is whsec_...' and paste it into"
echo "  .env.local as STRIPE_WEBHOOK_SECRET, then restart Start Preview."
echo ""
echo "  ─────────────────────────────────────────────────"
echo ""

# ── 4. Forward to the local preview. ──
exec stripe listen --forward-to localhost:3000/api/stripe/webhook
