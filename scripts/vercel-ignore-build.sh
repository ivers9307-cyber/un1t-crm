#!/usr/bin/env bash
#
# Vercel "Ignored Build Step" — cuts Build CPU Minutes (the largest line on the
# Vercel bill) two ways:
#   1. Previews build ONLY for branches with an open pull request. Real PRs keep
#      their preview (our pre-prod net); work-in-progress branch pushes — e.g.
#      the many worktrees — don't build, which was most of the spend.
#   2. For production, skips a build when the tip commit touches ONLY non-build
#      paths (docs, changelog, memory, CI config).
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

# Previews build ONLY for branches with an open pull request. That keeps a
# preview (our pre-prod net) for every real PR while skipping work-in-progress
# branch pushes (the worktrees) — which was most of the Build CPU Minutes.
# VERCEL_GIT_PULL_REQUEST_ID is the PR number, empty until a PR is opened for the
# branch. Only skip when Vercel EXPLICITLY says preview; an unset/unknown
# VERCEL_ENV falls through to the production logic below, so we can never
# accidentally skip a production build.
if [ "${VERCEL_ENV:-}" = "preview" ] && [ -z "${VERCEL_GIT_PULL_REQUEST_ID:-}" ]; then
  echo "Preview build for a branch with no open PR — skipping (open a PR to preview)."
  exit 0
fi

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
