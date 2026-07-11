# Staging environment — the one pre-prod safety net

Every merge to `main` auto-deploys to **production** (live gym: payments, door
access, Mia messaging real customers), and we disabled preview builds for cost.
That left no place to smoke-test before prod. `staging` is that place: **one**
persistent pre-prod environment, not N per-branch previews.

## How it works

- **Branch:** `staging` (long-lived). PRs merge to `main`; to pre-test, push to
  `staging` first (or open a PR into `staging`), verify, then promote to `main`.
- **Builds:** `scripts/vercel-ignore-build.sh` skips every preview build EXCEPT
  `VERCEL_GIT_COMMIT_REF=staging`, so only `staging` and `main` build. (Staging
  still skips docs-only commits, like prod.)
- **Database:** a Supabase **preview branch** so migrations and destructive
  changes are exercised against a copy before they touch the prod project. New
  migrations (`supabase/migrations/NNN_*.sql`) are written idempotently so a
  fresh staging branch can replay the full history.

## One-time setup (dashboard — operator)

1. **Create the branch:** `git branch staging origin/main && git push -u origin staging`.
2. **Vercel → Settings → Git → Ignored Build Step → "Run my command":**
   `bash scripts/vercel-ignore-build.sh` (this is what makes previews-off +
   staging-on take effect; it's already merged, just needs enabling once).
3. **Vercel → Settings → Environment Variables:** add a **Preview** scope set
   pointed at staging infra — at minimum `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` for the Supabase
   **staging branch** (below). Point Postmark/WhatsApp/Stripe/Xero at test
   credentials or sandboxes so staging can't message real customers or move
   money. **Never point staging at the prod Supabase project.**
4. **Supabase → Branches → create a branch** off the un1t-crm project. It
   replays `supabase/migrations/` and gives you an isolated URL + keys; put
   those in the Vercel Preview env vars from step 3.

## Using it

- Push work to `staging` (or PR into it) → Vercel builds a preview at the
  staging URL against the staging DB → smoke-test → then merge to `main` for
  prod. Migrations: apply to the Supabase **staging branch** first, verify, then
  to prod via MCP (the repo file is the source of truth for both).

## Cost note

This adds **one** always-building branch, not per-branch previews — the
Build-CPU-Minutes win from disabling previews stays intact; staging is the
deliberate exception that buys back a pre-prod check.
