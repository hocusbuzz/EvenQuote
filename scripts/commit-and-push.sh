#!/usr/bin/env bash
# scripts/commit-and-push.sh
#
# One-shot commit + push + main-merge after a Cowork session edits files.
# Usage:
#   ./scripts/commit-and-push.sh "commit message"
#
# What it does:
#   1. Removes any stale git lock files left over from cross-process
#      writes (the Cowork sandbox writes to the working tree but git
#      sometimes leaves stale .git/HEAD.lock or .git/index.lock files
#      that block subsequent commits).
#   2. Refuses to commit obvious secrets-shaped files (.env*, .bak,
#      package-lock duplicates from macOS Finder).
#   3. Pre-flight build gates — RUN BEFORE STAGING (#122):
#        a. `npx tsc --noEmit`               — catches type errors
#        b. `npx next lint --max-warnings 0` — catches lint errors
#      Both MUST pass. Skipping lint cost us three failed Vercel
#      deploys on 2026-04-30 — typecheck was clean, ESLint was not,
#      and Vercel runs lint as part of `npm run build`. The script
#      now matches Vercel's gate so we never push a broken commit.
#      Override with SKIP_PREFLIGHT=1 ./scripts/commit-and-push.sh "msg"
#      for emergencies (e.g., docs-only changes the linter dislikes
#      for unrelated reasons).
#   4. Stages, commits, pushes master.
#   5. Fast-forward merges main from master and pushes main (this is
#      the production branch — Vercel deploys from main).
#
# Exits non-zero on any step that fails. Run from the repo root.
#
# Idempotent: if there's nothing to commit, the commit step exits
# cleanly (we let `git commit` fail with "nothing to commit" — the
# script then exits with that code so you can see it).

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <commit message>" >&2
  exit 1
fi
MSG="$*"

cd "$(git rev-parse --show-toplevel)"

# 1. Clear stale locks. Best-effort — these are flaky from the sandbox
#    bind-mount handoff and aren't always present.
rm -f .git/HEAD.lock .git/index.lock 2>/dev/null || true

# 2. Defense in depth: detect secrets-likely files in the working tree.
#    GitHub Push Protection blocks pushes containing common API key
#    formats; failing fast here saves a force-push cleanup later.
SECRETS_LIKELY=$(git status --porcelain | awk '{print $2}' | \
  grep -E '\.(bak|backup)$|\.env(\.|$)|package-lock [0-9]+\.json' | \
  grep -v '\.env\.example$' || true)
if [ -n "$SECRETS_LIKELY" ]; then
  echo "⚠️  Refusing to commit — these files look like secrets/backups:" >&2
  echo "$SECRETS_LIKELY" | sed 's/^/    /' >&2
  echo "" >&2
  echo "Add to .gitignore (preferred), or git rm --cached, then retry." >&2
  exit 1
fi

# 3. Pre-flight build gates (#122). Skip with SKIP_PREFLIGHT=1.
#
# We intentionally run these BEFORE `git add` — if either fails, the
# working tree stays unstaged so the developer can fix and retry
# without having to `git reset` first.
#
# Why both, not just one:
#   • tsc --noEmit catches type errors but not ESLint rule violations
#     or undefined-rule references (the exact bug that broke prod
#     for 4 hours on 2026-04-30 — typecheck PASSED, lint FAILED).
#   • next lint mirrors Vercel's build-time check exactly. If next
#     lint exits 0 here, the Vercel build gate will not be the reason
#     a deploy fails.
#
# `--max-warnings 0` because Vercel treats warnings as errors during
# build (next.config flag default). If your local lint shows warnings
# that aren't real, fix them or scope an // eslint-disable rather than
# let them slip through.
if [ "${SKIP_PREFLIGHT:-0}" != "1" ]; then
  # Important: use `npm run` (not `npx`) so we bind to the LOCAL
  # binaries in node_modules/.bin — `npx tsc` sometimes resolves to
  # an unrelated abandoned `tsc` package on the registry. `npm run`
  # always uses package.json's script definition, which calls the
  # local typescript install.
  echo "▶ pre-flight: tsc --noEmit"
  if ! npm run --silent typecheck; then
    echo "" >&2
    echo "✘ tsc failed — fix type errors before committing." >&2
    echo "  (override with SKIP_PREFLIGHT=1 if you really must)" >&2
    exit 1
  fi

  # `next lint` via `npm run lint` for the same reason. We pass
  # --max-warnings=0 explicitly via `--` so warnings fail the gate
  # even if package.json's `lint` script doesn't include it
  # (Vercel's deploy gate also treats warnings as errors).
  echo "▶ pre-flight: next lint --max-warnings 0"
  if ! npm run --silent lint -- --max-warnings 0; then
    echo "" >&2
    echo "✘ next lint failed — fix ESLint errors before committing." >&2
    echo "  Vercel runs the same check during deploy; pushing now will" >&2
    echo "  produce a failed build. Override with SKIP_PREFLIGHT=1 only" >&2
    echo "  if you are certain (e.g., docs-only change with a known" >&2
    echo "  unrelated lint regression)." >&2
    exit 1
  fi

  echo "✓ pre-flight passed"
fi

# 4. Stage everything else (.gitignore'd files won't be picked up).
git add -A

# 5. Commit. Skip if nothing changed.
if git diff --cached --quiet; then
  echo "nothing to commit; skipping push"
  exit 0
fi
git commit -m "$MSG"

# 6. Push master.
git push origin master

# 7. Fast-forward main → master and push.
git checkout main
git pull --ff-only origin main
git merge master --ff-only
git push origin main
git checkout master

echo
echo "✅ shipped: $MSG"
