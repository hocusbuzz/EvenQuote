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
#   2. Stages everything currently modified or untracked under tracked
#      directories. Skips .env.local* backups and known noise.
#   3. Commits with the supplied message.
#   4. Pushes master.
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

# 3. Stage everything else (.gitignore'd files won't be picked up).
git add -A

# 3. Commit. Skip if nothing changed.
if git diff --cached --quiet; then
  echo "nothing to commit; skipping push"
  exit 0
fi
git commit -m "$MSG"

# 4. Push master.
git push origin master

# 5. Fast-forward main → master and push.
git checkout main
git pull --ff-only origin main
git merge master --ff-only
git push origin main
git checkout master

echo
echo "✅ shipped: $MSG"
