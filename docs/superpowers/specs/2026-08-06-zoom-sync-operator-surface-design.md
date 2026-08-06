# Zoom contact sync — operator surface — design

**Date:** 2026-08-06
**Status:** Spec, awaiting approval
**Ticket:** ZOOMOPS.1
**Builds on:** ZOOMSYNC.1 / ZOOMSYNC.2 (`2026-08-06-zoom-contact-sync-design.md`)

## Problem

The Zoom Phone contact sync shipped and works. Nobody can operate it.

Every question asked during go-live was answered by a developer with a terminal, the cron secret, and read access to production logs and the database:

- *What will it do before it does it?* → `curl …?dry=1`
- *What did it do last night?* → the HTTP response, which nobody was awake to read
- *Which contacts is it skipping?* → an ad-hoc SQL query against `contacts`
- *The deletion guard tripped — now what?* → `?dry=1`, read the sample, `?force=1`

None of that is an operator workflow, and the gap is not theoretical. During the pilot the sync reported 308 skipped rows and **no surface in the product could say which rows or why**. It took a database query to discover that 46 of them were phone numbers stored without a country code — a data-entry problem an operator could have fixed in minutes, invisible to the only people who could fix it.

The second gap is memory. `cron_heartbeats.last_outcome` holds one row and is overwritten every night, so "did last Tuesday's run also trip the guard?" is unanswerable.

## Goals

- An operator can see whether the sync is healthy without asking a developer.
- An operator can preview a run before it happens, and see what past runs did.
- The contacts the sync cannot use are visible and fixable by the people who own the data.
- Recovering from a tripped deletion guard is a product action, not a shell command.

## Non-goals

- **No per-tenant credentials, org-level connection records, or connect flow.** That is a separate project — see [Deferred: tenant rollout](#deferred-tenant-rollout).
- **No changes to the sync's behaviour.** Same rules, same guard, same thresholds. This is a window onto it, not a rewrite.
- **No inline contact editing.** The report links to the contact drawer that already exists.
- **No mobile surface.** Settings surfaces are web-only in this codebase.

## Architecture

Three surfaces, one new table, no new sync logic.

### The run recorder belongs in the library, not the routes

`runZoomContactSync()` in `src/lib/zoom/reconcile.js` is already the single entry point — the cron calls it, and the new manual route will call it too. The run record is therefore written **inside that function**, not by either caller.

This matters for a reason worth stating explicitly: if each route recorded its own runs, a future third trigger would silently produce no history, and the two existing recorders would drift. Putting it in the function means every invocation is recorded exactly once, by construction, and a new caller inherits history for free.

It writes a row on entry (`started_at`, trigger, flags) and stamps the outcome on exit (counts, guard state, error). A crash between the two leaves a row with a null `finished_at`, which is itself the signal that a run died mid-flight — currently invisible.

### `zoom_sync_runs`

The one new table.

| Column | Purpose |
|---|---|
| `id`, `started_at`, `finished_at` | A null `finished_at` on an old row means the run died |
| `organization_id` | Tenant boundary. See below — this is deliberate |
| `trigger` | `'cron'` or `'manual'` |
| `triggered_by` | `profiles.id` when manual, null for cron |
| `dry`, `forced`, `limit_applied` | What was asked for |
| `creates`, `updates`, `deletes`, `enqueued` | What it decided and what it queued |
| `guard_tripped`, `guard_threshold`, `guard_attempted`, `guard_sample` (`text[]`) | The full guard verdict, including the numbers it wanted to delete |
| `owned_in_zoom` | Directory size at the time |
| `stats` (jsonb) | `scanned` / `excludedClassPass` / `rejected` / `noName` / `collapsed` / `orgLocations` |
| `error` | Populated when the run failed |

**Pruning:** the sync's own cron deletes rows older than 90 days at the end of each nightly run. No separate cron, no separate heartbeat — a prune that only runs when the sync runs is exactly the coupling we want, since an unconfigured tenant generates no rows to prune.

**`organization_id`** is read from `ZOOM_SYNC_ORGANIZATION_ID`, the same value the desired-state builder already resolves its location set from. It is populated from day one even though only one value can occur today. Adding a tenant column to a table that already holds live history means a backfill against rows whose tenant must be inferred, which is exactly the migration that goes wrong. The column costs nothing now and removes that step from the tenant rollout later.

### The rejected-contacts report

This piece carries a real trap, and the design exists to avoid it.

The obvious implementation — a query that finds contacts the sync would skip — creates a **second source of truth**. It would agree with the sync on the day it was written and quietly diverge from it at the first normaliser change. A report that confidently lists the wrong rows is worse than no report, because it will be believed.

So `buildDesiredContacts()` gains an optional collect mode. Same function, same code path, same rules; when enabled it accumulates the rejected rows with a reason code instead of only incrementing a counter:

| Reason | Meaning | Count at time of writing |
|---|---|---|
| `no_phone` | No phone value at all | ~219 |
| `unparseable` | A phone value the normaliser refuses | ~89 |
| `no_name` | A usable number but no name to attach | 0 |

The report is a view over the sync's own verdict and cannot contradict it. Off by default so the nightly run pays nothing for it.

Computed live. **No table** — it is derivable from `contacts`, and a stored copy would go stale the moment somebody fixed a number.

Each row links to the existing contact drawer, so the fix happens where the data lives. `unparseable` rows are the actionable ones; `no_phone` rows are mostly leads who never gave a number and are informational.

## Surfaces

### Health row

Zoom joins `/settings/integration-health` as one more row, deriving status the same way the existing rows do, with a `remedy` line and an `href` to the detail page.

| Status | Condition |
|---|---|
| `down` | Heartbeat stale, or the last run errored |
| `warn` | Last run tripped the deletion guard, or reported publish failures |
| `ok` | Last run completed cleanly |
| `unknown` | Never run, or not configured |

One structural wrinkle: `getIntegrationHealth(db, locationId)` is per-location, and Zoom is per-organisation. The row resolves the location's `organization_id` and appears for **every location in that org**. This is correct rather than a compromise: one Zoom directory serves every handset on the account, so the sync's health is equally true at every location. Locations in an org that is not `ZOOM_SYNC_ORGANIZATION_ID` get no row at all.

### Detail page

`/settings/integrations/zoom-contacts`:

- **Status header** — current state, directory size, when it last ran
- **Run history** — the last 30 runs: when, trigger, who, counts, guard verdict. Dry runs included and visibly marked
- **Rejected contacts** — grouped by reason, each linking to the contact drawer
- **Controls** — below

## Controls and permissions

One route: `POST /api/integrations/zoom-contacts/run`, body `{ dry?, limit?, force? }`, calling the same `runZoomContactSync()`.

| Control | Who | Notes |
|---|---|---|
| **Preview** (`dry: true`) | manager and up | Writes nothing to Zoom |
| **Run now** (optional `limit`) | owner, master | |
| **Override guard** (`force: true`) | owner, master | Confirmation renders the guard `sample` |

The `force` confirmation shows the actual numbers the run intends to delete, taken from the last run's `guard_sample`. Approving an abstract count is not consent; approving a list you can read is. This mirrors the arrears-reconcile `?dry=1` → `?force=1` convention already in the estate.

Permission key `integrations_zoom_manage`, registered `WEB_ONLY_OK` — there is no mobile settings surface and the parity linter demands the choice be explicit.

Route guard follows the house skeleton: `getCurrentUser()` → role check (403) → `validateBody` → org-membership check → `createServerClient()` → work → `{ success, data }`. Registered in `src/lib/openapi.js`.

**Duration.** An unlimited manual run enqueues one QStash job per pending write — over six thousand on a cold directory. The route therefore carries the same `maxDuration = 300` as the cron and relies on the same bounded-concurrency publish loop; it inherits that budget rather than defining its own. A preview is cheap regardless, since it publishes nothing. If a manual unlimited run ever does exceed the budget the failure is benign — whatever was enqueued stays enqueued, and the next run picks up the remainder — but the UI should default the **Run now** control to a limit rather than to unlimited, so the expensive path is a deliberate choice.

The **cron route is unchanged**. It keeps its `CRON_SECRET` guard and its query params; the operator route is an addition, not a replacement, so an authenticated browser session never becomes a way to bypass cron auth.

## Testing

Pure, no database:

- Reject-reason classification — a row with no phone, an unparseable number, a missing name each produce the right code
- Collect mode returns the same counts as counting mode, on the same input. This is the test that stops the report drifting from the sync
- Run-record shaping from a `runZoomContactSync` result, including the guard-tripped and error shapes
- Health-row status derivation across stale / errored / guard-tripped / clean / never-run
- Permission gate: `dry` allowed for manager, `force` refused for manager, both allowed for owner

Route tests per house pattern: 401 unauthenticated, 403 for a manager attempting `force`, 400 on a malformed body, and a run recorded on success.

## Rollout

1. Migration for `zoom_sync_runs` applied before the code that writes it deploys.
2. Merge. The health row appears; history is empty until the next run.
3. First nightly run populates history with no operator action.
4. Confirm the rejected report's counts match the live dry-run `stats` — if they disagree, the collect mode has diverged and that is a bug, not a rounding difference.

Nothing here is gated behind the `ZOOM_*` secrets, so the surfaces render for an unconfigured tenant too. They show `unknown` and an empty history, which is honest.

## Deferred: tenant rollout

Deliberately out of scope, recorded so the boundary is clear.

The sync's credentials live in **global Vercel environment variables** — `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_SYNC_ORGANIZATION_ID`. That works for exactly one tenant and cannot be extended: there is no per-tenant environment variable.

Serving a second tenant needs credentials in the database, per organisation. The existing `channel_connections` registry is **location-keyed**, and Zoom is the estate's first genuinely org-level integration, so it needs an org-level analogue rather than a forced fit. Zoom's Server-to-Server OAuth is three pasted credentials rather than a redirect handshake, so the connect flow is a form, not an OAuth dance.

Two things in this spec exist to make that project cheaper: `zoom_sync_runs.organization_id`, and the health row already resolving org from location.

No tenant is waiting on this today.

## Risks

- **The report is only as honest as its shared code path.** The collect-mode equivalence test is the thing keeping it truthful; if that test is ever weakened, the report becomes a liability rather than a feature.
- **`force` is genuinely destructive.** It exists because a tripped guard cannot otherwise clear — suppressing deletes keeps the directory large, so the same batch re-trips nightly. Restricting it to owner and master, and showing the sample before acting, are the whole mitigation.
- **Run history will show dry runs prominently**, because previews are the most common trigger. If that turns out to bury the real runs, filtering is a small follow-up, not a redesign.
- **This adds an operator surface to a feature whose handset behaviour is still unverified.** Nobody has yet confirmed a name appears on a real desk phone. That remains true regardless of how good the admin page is.
