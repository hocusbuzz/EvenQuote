#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# EvenQuote — Start Preview
# Double-click this file to launch the local preview.
#
# What it does:
#   1. Moves to the project folder.
#   2. Installs dependencies if node_modules is missing.
#   3. Checks for .env.local (refuses to run without one).
#   4. Starts `npm run dev` in this Terminal window.
#   5. Waits for :3000 to come up, then opens it in your default browser.
#
# To stop the preview: press Ctrl+C in this Terminal window, then close it.
# ─────────────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")"

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │   EvenQuote — Preview Launcher                  │"
echo "  └─────────────────────────────────────────────────┘"
echo ""
echo "  Working in: $(pwd)"
echo ""

# ── 1. Node installed? ──
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ Node.js is not installed."
  echo ""
  echo "    Install it from https://nodejs.org (pick the LTS)."
  echo "    Then double-click this file again."
  echo ""
  read -n 1 -s -r -p "  Press any key to close…"
  exit 1
fi
echo "  ✓ Node $(node -v)"

# ── 2. .env.local present? Create + open it if not. ──
if [ ! -f ".env.local" ]; then
  echo ""
  echo "  → First-time setup: creating .env.local from .env.example."
  cp .env.example .env.local
  echo "  ✓ .env.local created."
  echo ""
  echo "  Opening it in TextEdit now. Fill in at least these three lines"
  echo "  (from Supabase dashboard → Project Settings → API), then SAVE and"
  echo "  CLOSE the TextEdit window:"
  echo ""
  echo "      NEXT_PUBLIC_SUPABASE_URL"
  echo "      NEXT_PUBLIC_SUPABASE_ANON_KEY"
  echo "      SUPABASE_SERVICE_ROLE_KEY"
  echo ""
  # -W = wait for the editor to quit before continuing.
  open -W -a TextEdit .env.local

  echo "  ✓ .env.local saved."
else
  echo "  ✓ .env.local found"
fi

# ── 2b. Sanity-check the three Supabase keys are actually filled in. ──
# Catches both the original placeholder (YOUR-PROJECT-REF) AND empty
# values (NEXT_PUBLIC_SUPABASE_URL=  with nothing after the equals).
check_env_var() {
  local var="$1"
  # Pull the raw value: line starts with VAR=, take everything after =,
  # strip surrounding quotes, strip trailing whitespace/comments.
  local val
  val=$(grep -E "^${var}=" .env.local | head -n1 | sed -E "s/^${var}=//; s/[[:space:]]*#.*$//; s/^['\"]//; s/['\"]$//; s/[[:space:]]+$//")
  if [ -z "$val" ] || echo "$val" | grep -qE "YOUR-PROJECT-REF|eyJhbGciOi\\.\\.\\."; then
    echo "  ✗ ${var} is empty or still a placeholder in .env.local."
    return 1
  fi
  return 0
}

env_problems=0
check_env_var "NEXT_PUBLIC_SUPABASE_URL"  || env_problems=$((env_problems+1))
check_env_var "NEXT_PUBLIC_SUPABASE_ANON_KEY"  || env_problems=$((env_problems+1))
check_env_var "SUPABASE_SERVICE_ROLE_KEY"  || env_problems=$((env_problems+1))

if [ "$env_problems" -gt 0 ]; then
  echo ""
  echo "  Get these values from your Supabase dashboard:"
  echo "    https://supabase.com/dashboard → Project Settings → API"
  echo ""
  echo "  Opening .env.local in TextEdit. Paste the values, save, close,"
  echo "  then double-click Start Preview.command again."
  echo ""
  open -a TextEdit .env.local
  read -n 1 -s -r -p "  Press any key to close this window…"
  exit 1
fi
echo "  ✓ Supabase keys present"

# ── 3. Dependencies installed AND clean? ──
# Detect the "partial install" symptom where @next/swc-* directories
# exist but are empty (no package.json). This causes the harmless-but-
# alarming "isn't a directory or doesn't contain a package.json" webpack
# warnings on every dev startup. Auto-heal by reinstalling.
needs_install=0
if [ ! -d "node_modules" ]; then
  needs_install=1
else
  for d in node_modules/@next/swc-*; do
    [ -d "$d" ] || continue
    if [ ! -f "$d/package.json" ]; then
      needs_install=1
      break
    fi
  done
fi

if [ "$needs_install" = "1" ]; then
  echo "  … installing dependencies (~1 min) …"
  rm -rf node_modules package-lock.json .next
  npm install
else
  echo "  ✓ Dependencies installed"
fi

# ── 4. Open browser once the server is ready. ──
# Runs in the background; polls :3000 until it responds, then opens it.
(
  for i in {1..60}; do
    if curl -sSf -o /dev/null "http://localhost:3000" 2>/dev/null; then
      sleep 1
      open "http://localhost:3000"
      exit 0
    fi
    sleep 1
  done
) &

# ── 5. Start the dev server in the foreground. ──
echo ""
echo "  Starting Next.js dev server…"
echo "  Browser will open automatically once it's ready."
echo ""
echo "  Heads up: lines starting with '<w>' are warnings, not errors —"
echo "  they're safe to ignore. The line that matters is 'Ready in …'."
echo ""
echo "  To stop: press Ctrl+C, then close this window."
echo ""
echo "  ─────────────────────────────────────────────────"
echo ""

npm run dev
