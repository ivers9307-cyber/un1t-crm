# Hatch timetable into the shared class spine (P1.1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hatch Street's un1t.online classes appear in `class_occurrences`, so its 2 TV displays show "current class" and "Up next", and the business dashboard's "today's classes" counts them. Nothing messages a customer or switches a device.

**Architecture:** The un1t.online sync (`src/lib/un1t-online-sync.js`) projects its `un1t_events` rows into `class_occurrences` after it upserts them, using a new `source_platform` column and a namespaced id. `class_bookings` is NOT written (that is P1.1b, gated by the decision that the CRM never sends class reminders or attendance pushes at Hatch). The studio scorecard's floor cells that need bookings show "unavailable" for non-Glofox sources.

**Tech Stack:** Supabase migration (SQL), Node sync engine, Next.js server page, Vitest.

**Spec:** `docs/superpowers/plans/2026-10-17-un1t-online-p1-plan.md` §P1.1 and its decisions (2026-10-17): decision 2 is "TVs and dashboards from Hatch's timetable: yes"; decision 1 is "no CRM class reminders or attendance pushes at Hatch".

## Global Constraints

- **Migration number 730** (729 is taken). Re-check with `ls supabase/migrations | sort -V | tail -2` before writing it.
- **Id rule:** `glofox_event_id = 'un1t:' || un1t_events.un1t_id`. The namespace guarantees no collision with a Glofox 24-hex id in the readers that look up `glofox_event_id` with no location filter (`credit-attendance`, `auto-end-stale-hr-sessions`, the climate `automation_fire_log` reads).
- **Column mapping:**
  - `source_platform = 'un1t_online'`, `name = title`, `program = null`, `starts_at`, `ends_at`;
  - `capacity = clients_limit`, `instructor = null`;
  - `raw = { booked: bookings_count, un1t: { status, access_mode, is_free, series_id } }`;
  - `synced_at = the run's now`.
  - `cancelled_at` = the run's now when `status = 'cancelled'` (keep an existing earlier `cancelled_at`), otherwise null. The un1t event status enum is `scheduled | cancelled | completed`.
- **Never delete** a projected occurrence, and never mark one cancelled because it is absent from a pull (`/events` is a window).
- **Projection failure never fails the sync.** The membership and contact data are the primary payload. A failed projection upsert is logged as `{code, message}` only and recorded in `counts.class_occurrences = { error }`. The run status and connection status are unchanged (CLAUDE.md "louder failure" rule).
- **Writes are service-role**, upserting `onConflict: 'location_id,glofox_event_id'` in chunks of 200.
- **Nothing writes `class_bookings`.** Nothing under `mobile/` or `shared/` changes.
- **Glofox behaviour unchanged:** Glofox rows get `source_platform = 'glofox'` by column default; `syncOccurrencesForLocation` is untouched.

## Review Focus

1. **A cancelled un1t class** gets `cancelled_at` set and disappears from TV "Up next" (readers filter `cancelled_at IS NULL`). Re-cancelling keeps the first `cancelled_at`. Test in Task 2.
2. **A un1t event id colliding with a Glofox id** is impossible thanks to the `un1t:` prefix. Test in Task 2.
3. **The projection upsert fails:** the sync still reports `ok`, members still sync, and the failure is in counts. Test in Task 2.
4. **The Hatch studio scorecard:** fill % and classes come from the projected occurrences; no-show, activation and attended visits show "unavailable", never 0%. Test in Task 3.
5. **Shelly class mode at Hatch:** all 6 devices are disabled with mode `none` today, so nothing switches. If one is later set to class mode it follows the un1t timetable, which is intended. A test pins that `loadTodayOccurrences` treats a un1t row like any other.

---

### Task 1: Migration 730, `class_occurrences.source_platform`

**Files:**
- Create: `supabase/migrations/730_class_occurrences_source_platform.sql`
- Test: the existing guards (`tests/table-default-acl-guard.test.js`, `npm run check:select-columns`, `check:rls-restrictive`)

**Interfaces:**
- Produces: `class_occurrences.source_platform text NOT NULL DEFAULT 'glofox' CONSTRAINT class_occurrences_source_platform_check CHECK (source_platform IN ('glofox','un1t_online'))`.

- [ ] **Step 1:** Write the migration: `BEGIN` / `SET LOCAL lock_timeout = '5s'` / `ADD COLUMN IF NOT EXISTS`. Include a `COMMENT ON COLUMN` that names the `un1t:` id namespace and says no `class_bookings` are written for `un1t_online`. Add a `DO $$` self-check against the catalog: the column exists, NOT NULL, default `'glofox'`, and the CHECK admits both values. `class_occurrences` has table-level SELECT for `authenticated` (not column-granted), so the new column is readable by the phone with no grant line. State that in a comment.
- [ ] **Step 2:** Run `npx vitest run tests/table-default-acl-guard.test.js && npm run check:select-columns && npm run check:rls-restrictive`. Expected: pass.
- [ ] **Step 3:** Commit `UN1TCLASS.1 — class_occurrences.source_platform (mig 730)`.

Apply to prod (Supabase MCP, project `iyvtbjjxdggiadzwwvdj`) **before** the PR merges, then `get_advisors`.

---

### Task 2: Project `un1t_events` into `class_occurrences`

**Files:**
- Create: `src/lib/un1t-online-occurrences.js` (pure `mapUn1tEventToOccurrence(eventRow, { locationId, nowIso, existingCancelledAt })` and `projectUn1tOccurrences(db, { locationId, events, nowIso })`)
- Modify: `src/lib/un1t-online-sync.js` (call `projectUn1tOccurrences` after the `un1t_events` upsert succeeds; record `counts.class_occurrences`)
- Test: `src/lib/un1t-online-occurrences.test.js`, `src/lib/un1t-online-sync.test.js`

**Interfaces:**
- Consumes: the `un1t_events` rows the sync just mapped (`un1t_id, title, status, access_mode, is_free, starts_at, ends_at, capacity, bookings_count, series_id`).
- `projectUn1tOccurrences` reads the existing `cancelled_at` for those ids, with `.in('glofox_event_id', ids)` chunked at 200 and `.eq('location_id', locationId)`. It then upserts and returns `{ upserted: number }`, or `{ error: {code, message} }`. It never throws.

- [ ] **Step 1: Write the failing tests.**
  - `maps a un1t event to an occurrence with the un1t: id and source_platform`: every column from the Global Constraints mapping.
  - `cancelled status sets cancelled_at to now; an existing cancelled_at is kept; a scheduled event clears it` (Review Focus 1).
  - `the id is always prefixed`, so `'un1t:' + id` never equals a bare 24-hex Glofox id (Review Focus 2).
  - `upserts in chunks of 200 on location_id,glofox_event_id and never deletes`.
  - Sync test: `a projection failure leaves the run ok and the connection connected, with counts.class_occurrences.error` (Review Focus 3).
  - Sync test: `class_bookings is never written`.
- [ ] **Step 2:** Run `npx vitest run src/lib/un1t-online-occurrences.test.js src/lib/un1t-online-sync.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the module and wire it into the sync.
- [ ] **Step 4:** Run the same tests: PASS. Then run `npm run check:guardrails` (arm the new file for `no-unchecked-supabase-write` in `eslint.guardrails.config.mjs`) and `npm run check:select-columns`.
- [ ] **Step 5:** Commit `UN1TCLASS.2 — project un1t.online events into class_occurrences`.

---

### Task 3: Studio scorecard floor for a non-Glofox source

**Files:**
- Modify: `src/app/dashboard/studio/page.js` (`loadLocationScorecard`)
- Test: `src/app/dashboard/studio/page.test.js`
- Test (pin): `src/lib/shelly/reconcile.test.js` (or the existing desired-state test), covering a un1t-sourced occurrence.

**Interfaces:**
- For `r.source !== 'glofox'`, take the result of `fetchFloor` and keep `classes`, `fillPct` and `fillPct7d`. Set `noShowPct`, `activation` and `attendedVisits` to `null`, so the cells render "— unavailable". Keep `groupTable` rows with their fill only (null `noShowPct` in each row) and `noData` as computed. For Glofox the result is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `un1t column: fill and classes render from occurrences; no-show, activation and attended visits are unavailable` (Review Focus 4).
  - `glofox column floor unchanged`.
  - The Shelly pin: `a un1t: occurrence drives the class-mode window like a Glofox one` (Review Focus 5).
- [ ] **Step 2:** Run `npx vitest run src/app/dashboard/studio/page.test.js` plus the Shelly test. Expected: FAIL (the pin may pass already; if so, say so).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `UN1TCLASS.3 — Hatch floor shows fill from its timetable; booking-based cells unavailable`.

---

### Task 4: Verify and ship

- [ ] **Step 1:** Run the full CI mirror (13 commands, individually) and `npm run build`.
- [ ] **Step 2 (controller):** Apply mig 730 to prod. After the merge and deploy, the next un1t sync tick projects about 138 events. Check `select count(*) from class_occurrences where source_platform='un1t_online'` and that the Hatch TV payload shows a class.
- [ ] **Step 3:** Add the changelog entry after `gh pr create`.
