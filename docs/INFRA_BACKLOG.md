# Infra backlog — 2026-07-11 review

Actions from the infra review. Code-side items are shipped; the rest are
account/dashboard actions (no API/MCP path) captured here as runbooks.

| # | Item | State |
|---|------|-------|
| 1 | Pre-prod net (previews) | **PR-only previews** — kept previews, dropped the staging branch. Needs the Ignored Build Step enabled once. |
| 4 | DB hygiene (FK indexes, PK, search_path) | **DONE** — mig 402, applied to prod |
| 4b | Drop unused indexes | **Not recommended** (see below) |
| 2 | champ-app DB isolation + Auth conn cap | Decision + runbook below |
| 3 | PITR backups | Operator toggle below |
| 5 | Retire un1t-platform | Runbook below |

---

## #4b — Unused indexes: leave them

The advisor's "175 unused indexes" sounds large but the **total footprint is
~3 MB**, and most are legitimate *rare-path* indexes (e.g.
`idx_wa_messages_broadcast`, `sequence_steps_sms_idx`, the `generated_reports`
set) that simply haven't been scanned since the last stats reset — `idx_scan`
is not "never needed", it's "not since the counter reset". Storage saving is
trivial and write overhead on these low-volume tables is negligible, while
dropping a rare-path index risks a slow query later. **Do not bulk-drop.**
Re-evaluate only per-table if a specific table's write rate becomes hot.

## #2 — champ-app DB isolation (decision) + Auth connection cap

**Decision: DEFER the split, document the coupling.** All apps reach Postgres
via PostgREST/HTTP (supabase-js), so there is no serverless connection-pool
exhaustion cliff, and only one location is live. **Split trigger:** before
pushing the consumer app hard, before location #3, or if customer traffic
starts degrading staff-CRM latency. **When you split:** champ-app gets its own
Supabase project; shared data flows via API, not a shared DB.

**Auth connection cap (do now — dashboard/support):** the Auth (GoTrue) server
is capped at **10 connections** (advisor `auth_db_connections_absolute`), and it
is shared by staff *and* customer logins. Switch to percentage-based allocation
(or raise the cap) via Supabase project settings / support. No MCP path.

## #3 — PITR (point-in-time recovery)

**Recommended — operator toggle.** Pro gives daily backups, 7-day retention
only. Migrations are forward-only and run against prod; the "reconcile could
mass-clear the arrears book" class of bug needs **minute-level** rewind, not
last-night. Enable: Supabase → Project → Database → Backups → **Point-in-Time
Recovery** (paid add-on, ~$100/mo for 7-day). Justified by the financial (Xero,
invoices, arrears) and health data in the DB.

## #5 — Retire un1t-platform

Separate Next deployment holding the **prod service-role key**, stale. Live
surface (verified): pages `/`, `/cost`, `/alerts` + `/alerts/[id]`, `/balances`,
`/login`; API `/api/branding`, `/api/sentinel-runbook`, `/api/auth/sign-out`.
It's a monitoring / cost / alerts / balances viewer over the CRM DB.

**Runbook:**
1. **Confirm/port the surfaces.** Decide if anyone relies on `/cost`, `/alerts`,
   `/balances`. The alerts/incidents data lives in the **un1t-sentinel** project;
   port any still-wanted view into un1t-sentinel or a master-only un1t-crm route.
2. **Stop deploying it.** Delete the un1t-platform Vercel project (or disable its
   git deployment).
3. **Rotate the service-role key.** Supabase → Settings → API → roll the
   `service_role` key. NOTE: this key is shared — rolling it invalidates it for
   **every** legitimate holder too, so update the env in un1t-crm (and any other
   real holder) in the same window; un1t-platform, left un-updated, then goes
   dark. This is the point: the stale deployment loses DB access.
4. Remove un1t-platform's env/config once confirmed dead.

Vercel project deletion + service-role rotation are dashboard actions — no MCP
path, so these are yours to execute; ordering above avoids an outage.

---

_Still open from the review (not in scope for this pass): #6 error-visibility
after disabling Observability Plus (e.g. Sentry free / a sentinel 5xx watcher),
#7 CI gap — `next build` **DONE** (SAAS4-W0.3, parallel "Next build" job in
web-ci.yml); the route-level integration smoke against a Supabase branch
remains open (planned as part of the Section-4 SaaS machinery CI ladder,
alongside the cross-tenant harness)._
