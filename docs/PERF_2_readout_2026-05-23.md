# PERF.2 — pg_stat_statements 7-day readout (2026-05-23)

Project: `un1t-crm` (Supabase `iyvtbjjxdggiadzwwvdj`). Sections 1–6 are the
diagnosis; §7 is the action list. **Update — all of PERF.2.A–F were
implemented and shipped the same day; see "Implementation status" below.**
The pg_stat_statements window was left running.

## TL;DR

Roughly **half of all database exec time** (~417 s of 840 s) is the
**sidebar radar badge polling**. `Sidebar.jsx` polls `/api/lead-radar/count`
and `/api/churn-radar/count` every **60 s per open operator session**; each
poll runs the *entire* radar load (`loadFunnel` / `loadRadar`), which
paginates a full sequential scan of the 13 MB `contacts` table — 8 scans per
lead-radar poll, 2 per churn-radar poll — just to return one integer badge
count. There is no index on the `(location_id, glofox_membership_status)`
filter. Absolute load is still small (~120 s DB time/day, 100 % cache hit) so
this is proactive tuning, not a fire — but it is pure waste and it adds
latency to every radar page.

---

## Implementation status (shipped 2026-05-23)

All six actionable items (A–F) were implemented and applied the same day.
G (unused-index review) stays deferred, per the recommendation.

| Item | What shipped | Verified |
|---|---|---|
| PERF.2.B | mig 202 — `idx_contacts_location_membership_status` | `EXPLAIN` now Index Scan (was Seq Scan, 8,162 rows filtered) |
| PERF.2.D | mig 203 — 11 FK covering indexes | advisor `unindexed_foreign_keys`: 11 → **0** |
| PERF.2.E | mig 204 — `(select auth.uid())` wraps on 9 RLS policies | advisor `auth_rls_initplan`: 9 → **0** |
| PERF.2.F | mig 205 — `idx_deals_location_status_created` | index present |
| PERF.2.A + C | `src/lib/radar-cache.js` — 60 s in-process TTL memo; 11 radar routes switched to cached loaders, with cache invalidation on the 4 mutating routes | full suite 2,205 tests passing; ESLint clean |

Migrations 202–205 live in `supabase/migrations/` and were applied to the
project. The radar caching uses a plain in-process TTL memo, **not**
`unstable_cache` — this codebase deliberately removed Next's data cache after
the 2026-05-05 stale-read incident, so an explicit, process-local, 60 s-bounded
memo is the right fit (mutations call `invalidateRadar()` for immediate
freshness). Effectiveness will show in the next pg_stat readout.

---

## 1. Window summary

| Metric | Value |
|---|---|
| `stats_reset` | 2026-05-16 06:25:10 UTC |
| Window length | 7 d 00:40 |
| Distinct statements | 1,280 |
| Total calls | 1,171,357 |
| Database size | 61 MB |
| Total exec time (all statements) | 840,180 ms (~120 s/day) |

Window is intact and matches the PERF.1 reset — readout is valid.

**Methodology note — fix the query-2 snippet for PERF.3.** The task's query 2
filters `AND query NOT ILIKE '%pg_catalog%'`. Every PostgREST request is
wrapped with `pg_catalog.count(_postgrest_t)`, so that filter silently
excludes **all application queries** and query 2 shows only auth/infra/DDL.
The numbers below come from re-running query 2 *without* the `pg_catalog`
exclusion. Drop that line next time.

Time split across the corrected total: `contacts` queries **518,343 ms
(61.7 %)**, schema introspection **82,697 ms (9.8 %)**, `deals` queries
**72,764 ms (8.7 %)**.

---

## 2. Top cumulative-load queries

(Corrected — includes PostgREST app queries. `pct` is share of the 840 s total.)

| # | Query | Calls | Total ms | Mean ms | pct |
|---|---|--:|--:|--:|--:|
| 1 | `contacts` SELECT — `location_id = $1 AND glofox_membership_status = ANY($2) ORDER BY id` (proj: id,name,email,phone,status,last_attended_at,…) | 14,781 | 255,460 | 17.3 | **30.3 %** |
| 2 | `contacts` SELECT — same WHERE, MEMBER_COLUMNS projection | 2,372 | 99,430 | 41.9 | **11.8 %** |
| 3 | `contacts` SELECT — same WHERE, member-profile projection variant | 1,453 | 59,059 | 40.6 | **7.0 %** |
| 4 | `SELECT name FROM pg_timezone_names` | 80 | 52,946 | 662 | 6.3 % |
| 5 | `deals` board — `status=$1 AND location_id=$2 AND stage_id=ANY($3) ORDER BY created_at DESC` + LATERAL `contacts` embed | 111 | 49,189 | 443 | 5.9 % |
| 6 | `cron_heartbeats` UPDATE | 47,498 | 22,504 | 0.47 | 2.7 % |
| 7 | PostgREST `set_config(...)` per-request | 361,907 | 21,215 | 0.06 | 2.5 % |
| 8 | `contacts` UPDATE — glofox sync write-back | 1,500 | 16,180 | 10.8 | 1.9 % |
| 9 | `glofox_webhook_events` INSERT | 1,756 | 12,844 | 7.3 | 1.5 % |
| 10 | `pg_available_extensions` introspection | 28 | 12,758 | 456 | 1.5 % |

Diagnosis / recommendation, one-liners:

- **#1 — Lead Radar badge poll. ROOT CAUSE.** `src/app/api/lead-radar/count/route.js`
  → `loadFunnel` → `fetchNonMembers` (`src/lib/lead-radar-data.js`).
  `glofox_membership_status IN (non-member statuses)` matches ~7,000 of 8,162
  rows → 8 paginated **seq scans** of the 13 MB heap per call, all to compute
  one `funnel.filter(tier==='high').length` badge integer. → **PERF.2.A**.
- **#2 / #3 — Churn Radar badge poll + radar page.** `churn-radar/count` →
  `loadRadar` → `fetchMembers`; plus the radar page's per-tab loads. Same
  WHERE shape, MEMBER_COLUMNS projection. Members are only ~13 % of the table
  so an index *will* be used here. → **PERF.2.B + .A**.
- **#4 / #10 — `pg_timezone_names`, `pg_available_extensions`.** Supabase
  Studio dashboard + PostgREST schema-cache reloads. Not app code, not
  fixable in the repo. Ignore (or just don't leave Studio open).
- **#5 — Pipeline/Deals board.** 443 ms mean, 3.1 s max. Filter columns are
  each single-column-indexed but there's no composite for filter+sort, and
  the LATERAL `contacts` embed pays RLS per deal. → **PERF.2.F**.
- **#6 `cron_heartbeats`, #7 `set_config`, #8 glofox write-back, #9 webhook
  insert** — all expected, cheap per call (≤11 ms). Ignore.

---

## 3. Top mean-time queries (≥10 calls)

| Query | Calls | Mean ms | Max ms | Note |
|---|--:|--:|--:|---|
| `pg_timezone_names` | 80 | 662 | 1,087 | Studio/PostgREST infra — ignore |
| `pg_available_extensions` | 28 | 456 | 805 | Studio infra — ignore |
| `deals` board (full `*` + contacts embed) | 111 | 443 | 3,139 | **PERF.2.F** — worst real user-facing latency |
| `deals` `.*` + contacts embed | 12 | 277 | 1,043 | same family |
| `deals` value-only aggregate | 13 | 151 | 173 | pipeline value rollup — acceptable |
| `base_types` introspection | 80 | 144 | 447 | PostgREST schema cache — ignore |
| `contacts` `WHERE location_id` (no status filter) ORDER BY id | 83 | 79 | 570 | full seq scan; low volume — fixed for free by **PERF.2.B** |
| `contacts` membership variants (#2/#3 family) | — | 37–49 | 1,693 | covered by **PERF.2.A/.B** |

Nothing individually slow is a surprise. The `deals` board is the only
genuinely slow *user-facing* query (sub-3 s worst case).

---

## 4. Cache hit ratio

Query 4 returned **no rows** — not a single statement has
`shared_blks_read > 1000`. The whole 61 MB database is resident in
`shared_buffers`; cache hit ratio is effectively **100 %** everywhere.

Implication: there is **zero disk-read pressure**. All the `contacts`
seq-scan cost in §2 is in-RAM CPU (scanning ~1,023 8 KB buffers + filtering
8,162 rows + sort + `json_agg` per call), not I/O. The fixes below target
scan *volume* and *frequency*, not I/O.

---

## 5. High-call-count / N+1 candidates (>1,000 calls)

| Query | Calls | calls/day | Mean ms | Verdict |
|---|--:|--:|--:|---|
| `set_config(...)` per request | 361,907 | 51,424 | 0.06 | PostgREST infra — unavoidable |
| auth `sessions`/`users`/`mfa_*`/`identities` | ~53k each | ~7,600 | <0.25 | GoTrue infra — unavoidable |
| `profiles WHERE id = $1` | 20,218 | 2,874 | 0.30 | per-request auth profile — fine |
| **`contacts` lead-radar SELECT (#1)** | **14,781** | **2,111** | **17.3** | **★ over-fetch — PERF.2.A** |
| `organizations WHERE active` | 14,894 | 2,119 | 0.20 | frequent, trivial — fine |
| `tv_displays` / `tv_content` / `tv_templates` | ~14,900 each | ~2,100 | <0.10 | TV-dashboard poll — cheap, fine |
| `profile_locations` + `locations` embed | 13,810 | 1,965 | 0.90 | per-request auth context — fine |
| `locations WHERE active` | 10,223 | 1,455 | 0.61 | frequent, trivial — fine |
| `postmark_webhook_queue` drain | 10,128 | 1,441 | 0.27 | cron drain — fine |
| **`contacts` churn-radar SELECT (#2/#3)** | **3,825** | **546** | **~41** | **★ over-fetch — PERF.2.A/.B** |

The only N+1 / over-fetch smell is the radar family (#1, #2, #3). Everything
else high-count is sub-millisecond infrastructure.

**Why it's an over-fetch, precisely:** `Sidebar.jsx` has
`POLL_INTERVAL_MS = 60_000`. Two badge endpoints each re-run a *full* radar
computation every 60 s per logged-in operator:

- `loadFunnel` / `loadCleanup` / `loadClassPass` each independently call
  `fetchNonMembers` (8 pages × full scan).
- `loadRadar` / `loadQuarantine` / `loadOverdue` each independently call
  `fetchMembers` (2 pages × full scan); `loadWinback` calls
  `fetchWinbackContacts`.

So a single Lead Radar page view that opens all three tabs = 24 full
`contacts` scans, and the badge alone = 8 scans/minute/session forever.

---

## 6. Advisor delta vs PERF.1

Performance advisor payload was too large to return inline (166 KB);
summarised by lint name. PERF.1 baseline in parentheses.

| Lint | Level | Count | vs PERF.1 |
|---|---|--:|---|
| `duplicate_index` | INFO | **0** | PERF.1 dropped 13 — none regressed ✓ |
| `unindexed_foreign_keys` | INFO | **11** | PERF.1 added 11 FK indexes; these are 11 **newer** tables it never covered |
| `auth_rls_initplan` | WARN | **9** | PERF.1 wrapped 8; 9 remain on tables added since |
| `multiple_permissive_policies` | WARN | **59** | PERF.1 dropped 6 redundant policies; 59 still flagged |
| `unused_index` | INFO | **~175** | informational — see caveat below |

- **`unindexed_foreign_keys` (11):** `car_bca_submissions`, `car_documents`
  (×2 FKs), `churn_radar_actions`, `fte_expense_claims`, `invoices_queue`
  (×2), `lead_radar_actions`, `policy_versions`, `push_reminder_sends`,
  `tv_templates`. All small tables today — low urgency, cheap insurance. → **PERF.2.D**.
- **`auth_rls_initplan` (9):** `policies`, `policy_versions`, `policy_views`
  (×3), `audit_events`, `fte_expense_claims`, `fte_expense_items`,
  `invoices_queue`. Same un-wrapped `auth.*()` pattern PERF.1's lesson
  documents — just on tables created after mig 162. → **PERF.2.E**.
- **`multiple_permissive_policies` (59):** WARN-level, mostly the staff /
  scheduling tables (`shifts`, `shift_*`, `staff_allowances`,
  `xero_connections`, `strap_assignments`, `ble_bridges`, …). Each
  overlapping permissive policy is evaluated per row. Pre-existing, not a
  regression; consolidating is a larger RLS-refactor project — out of scope
  for PERF.2.
- **`unused_index` (~175): do NOT bulk-drop.** The stats window is only
  7 days. Any index serving a monthly/quarterly job (reports, tax/Xero, race
  events, BCA) looks "unused" here but isn't. Defer; if pursued, cross-check
  each against a ≥90-day window first.

No `no_primary_key` findings.

---

## 7. Prioritized action list

Ordered by impact ÷ effort. Diagnosis only — Richard decides what ships.

### PERF.2.A — Cache the radar load behind the polled badge endpoints  *(highest yield)*
**Problem:** `/api/lead-radar/count` and `/api/churn-radar/count` run the full
`loadFunnel` / `loadRadar` on every 60 s sidebar poll → queries #1+#2+#3.
**Change (app):** memoise `loadFunnel(locationId)` / `loadRadar(locationId)`
server-side with a short TTL (60–120 s) so the badge poll *and* the radar
page share one computation instead of each triggering a fresh set of full
scans. Cheapest variant: an in-process `Map` cache keyed by `locationId` with
a timestamp; ideal variant: a tiny cache table or reuse of the
`*_radar_snapshots` rows if a slightly stale badge is acceptable.
**Expected gain:** collapses the ~14,781 + ~3,825 radar calls toward the
number of distinct compute windows — **~40–45 % of total DB exec time**.
**Effort:** medium (one cache util + 4 call sites in `lead-radar-data.js` /
`churn-radar-data.js`).

### PERF.2.B — Index `contacts(location_id, glofox_membership_status)`
**Problem:** every radar query seq-scans `contacts`; `EXPLAIN` confirms
`Seq Scan … Rows Removed by Filter: 8162`. The existing
`idx_contacts_location` is useless (single location → ~all rows).
**Change (DDL):**
```sql
CREATE INDEX CONCURRENTLY idx_contacts_location_membership_status
  ON public.contacts (location_id, glofox_membership_status);
```
**Expected gain:** churn-radar fetches (#2/#3, members = ~13 % of table)
become bitmap index scans — **~12–15 %**. Note: the lead-radar query (#1)
matches ~86 % of the table, so the planner will (correctly) still seq-scan
it — #1's real fix is PERF.2.A. Also speeds future audience-builder `eq`
filters on membership status. Ship regardless; near-zero risk on a 13 MB table.
**Effort:** trivial.

### PERF.2.C — De-duplicate the per-tab radar re-fetch
**Problem:** in `churn-radar-data.js`, `loadRadar` / `loadQuarantine` /
`loadOverdue` each call `fetchMembers` independently; in `lead-radar-data.js`,
`loadFunnel` / `loadCleanup` / `loadClassPass` each call `fetchNonMembers`.
A multi-tab page view scans `contacts` 2–3× for identical data.
**Change (app):** fetch the member/non-member set once per request and pass it
into the builders.
**Expected gain:** a few %; largely subsumed by PERF.2.A if A lands first —
do C only if A is deferred.
**Effort:** low–medium.

### PERF.2.D — Add the 11 missing FK covering indexes
One migration adding btree indexes on the 11 `unindexed_foreign_keys` columns
(§6). Low impact today (tables are tiny) but cheap; bundle with PERF.2.E.
**Effort:** low. **Gain:** negligible now, future-proofing.

### PERF.2.E — Wrap `auth.*()` in the 9 remaining RLS policies
Apply the PERF.1 `auth_rls_initplan` fix — `(SELECT auth.uid())` etc. — to the
9 policies in §6. Completes the mig-162 pattern on tables added since.
**Effort:** low. **Gain:** low (low-traffic tables) but correctness/consistency.

### PERF.2.F — Composite index for the Deals board
**Problem:** the pipeline board query (#5) filters
`location_id + status + stage_id` and sorts `created_at DESC` with only
single-column indexes; 443 ms mean / 3.1 s max.
**Change (DDL):**
```sql
CREATE INDEX CONCURRENTLY idx_deals_location_status_created
  ON public.deals (location_id, status, created_at DESC);
```
Secondary factor: the LATERAL `contacts` embed pays RLS per deal — only worth
revisiting if the index alone doesn't bring the mean down.
**Expected gain:** ~3–5 %, and removes the worst user-facing latency spike.
**Effort:** trivial.

### PERF.2.G — (defer) `unused_index` review
~175 INFO-level unused indexes. Do **not** bulk-drop on a 7-day window —
re-evaluate against ≥90 days of stats first. Lowest priority.

---

*Generated by the PERF.2 scheduled task. pg_stat_statements was **not** reset —
the window keeps accumulating for the next readout.*
