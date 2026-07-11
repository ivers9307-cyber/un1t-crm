#!/usr/bin/env bash
#
# Vercel "Ignored Build Step" — skip a build when the tip commit touches ONLY
# non-build paths (docs, changelog, memory, CI config). Cuts Build CPU Minutes,
# the largest line on the Vercel bill, for the docs-only commits we push often.
#
# Wire it up (once, in the dashboard): Project → Settings → Git →
#   Ignored Build Step → "Run my command":  bash scripts/vercel-ignore-build.sh
# Until that setting points here, this file does nothing.
#
# Vercel contract: exit 1 = BUILD, exit 0 = SKIP.
# This script FAILS SAFE — anything it can't confidently classify → BUILD.
#
# Scope note: it only inspects the tip commit (HEAD vs HEAD^). That's correct
# for our workflow because every push builds incrementally, so a docs-only tip
# means the code it sits on was already built by an earlier push (and merges to
# main are squashed to a single commit). If HEAD^ is unavailable (first deploy,
# shallow clone with no parent), it builds.

set -euo pipefail

# No parent commit to diff against → build to be safe.
if ! git rev-parse --verify HEAD^ >/dev/null 2>&1; then
  echo "No parent commit — building."
  exit 1
fi

CHANGED="$(git diff --name-only HEAD^ HEAD)"

# Empty diff (e.g. an empty/merge commit) → build to be safe.
if [ -z "$CHANGED" ]; then
  echo "No file changes detected — building."
  exit 1
fi

# Paths that never affect the deployed Next.js output. Everything else
# (src/, public/, package.json, vercel.json, next.config.*, mobile/, shared/,
#  supabase/, scripts/, …) forces a build.
IGNORE_RE='^(docs/|memory/|\.github/|\.claude/|[^/]*\.md$|LICENSE$)'

# Collect the changed paths that are NOT in the ignore set. If any exist, the
# commit touches build-relevant files → build. (Capture-then-test avoids the
# `grep -q` exit-code-in-a-pipe subtleties under `set -o pipefail`.)
BUILD_RELEVANT="$(printf '%s\n' "$CHANGED" | grep -vE "$IGNORE_RE" || true)"

if [ -n "$BUILD_RELEVANT" ]; then
  echo "Build-relevant changes detected — building:"
  printf '%s\n' "$BUILD_RELEVANT"
  exit 1
fi

echo "Only non-build paths changed — skipping build."
exit 0
