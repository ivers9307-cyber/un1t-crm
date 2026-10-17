# Hatch bookings into class_bookings, CRM class messaging hard-off (P1.1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hatch Street's un1t.online bookings appear in `class_bookings`, so the coach live roster, claim search and the studio scorecard's no-show / attended cells work at Hatch. The CRM never sends a class reminder, credits attendance, or fires a session/achievement/goal/tier push for a un1t.online booking or at a un1t.online studio.

**Architecture:**
- **Hard-off first, in code and in the schema.** `class_bookings` gets `source_platform` (mirrors mig 730) plus a CHECK that ties it to the `un1t:` id namespace, so a un1t row cannot be tagged `glofox` by any writer. The two automatic customer-facing readers (`send-class-booking-reminders`, `credit-attendance`) select `source_platform = 'glofox'` only AND drop every location whose `membership_source` is `un1t_online`. Neither depends on a setting or on a capability flag (capabilities flip later in P1.2).
- **Projection:** the un1t.online sync projects the `un1t_bookings` rows it just upserted into `class_bookings` (new `src/lib/un1t-online-bookings.js`, next to `un1t-online-occurrences.js`), in the Glofox shape every reader already understands.
- **Guard:** a manifest test classifies every reader of `class_bookings`; a new reader fails CI until classified, and every customer-messaging or attendance-crediting reader must filter `source_platform = 'glofox'`.

**Tech Stack:** Supabase migration (SQL), Node sync engine, Next.js crons and server page, Vitest.

**Spec:** `docs/superpowers/plans/2026-10-17-un1t-online-p1-plan.md` §P1.1 and Decision 1 (2026-10-17): "the CRM must NOT send them … bookings may be projected only with `send-class-booking-reminders` and `credit-attendance` … off for every un1t.online location, enforced in code per location, not by an optional setting. If that cannot be guaranteed, bookings stay unprojected." This plan guarantees it (Task 2), so the projection proceeds.

## Reader audit (main at `61d0af06`)

Every reference to `class_bookings` in `src/`, `shared/`, `mobile/`, `supabase/` (migrations, functions, views, RPCs) and the companion repos. Live: 0 triggers on the table (`pg_trigger`), RLS = one staff SELECT policy (`class_bookings_location_read`, mig 288:33-35), no realtime publication (`src/lib/live-access.js:40-51`). Nothing in `mobile/` or `supabase/functions/` reads it.

| # | Reader | Kind | With a un1t row today | Change |
|---|---|---|---|---|
| 1 | `send-class-booking-reminders` (`src/app/api/cron/send-class-booking-reminders/route.js:84-93`) | **customer-messaging** (push) | **no source gate at all**: a future `BOOKED` Hatch row would be reminded | Task 2: `.eq('source_platform','glofox')` + drop un1t_online locations |
| 2 | `credit-attendance` (`src/app/api/cron/credit-attendance/route.js:71-80`, then `createParticipationSession` + `finalizeSessionRewards` :172-184) | **data-writing + customer-messaging** (HR sessions, points, achievements, session/goal/tier pushes, monthly targets) | skipped today only because `bookings` capability is false (`:60`, `sources/un1t-online.js:16`); opens the day P1.2 flips it | Task 2: same hard-off, independent of capability |
| 3 | `notify-onboarding-pace` → `loadJourneyLane` (`route.js:84`, `onboarding-journey-data.js:128-145`) | customer-messaging | inert: only `membership_source = 'glofox'` locations, and the read is location-scoped | Task 2: pinned in the manifest |
| 4 | `/pulse` journey lane (`api/pulse/journey/route.js:46`) | staff display | inert at Hatch (no contacts with `glofox_membership_status` member) | none |
| 5 | `loadContactJourney` (`onboarding-journey-data.js:248-255`) → contact page (`(sales)/contacts/[id]/page.js:182`), member app `/api/me/journey:31` | display (member-facing) | **acts**: no location filter, so a dual-studio member's Hatch classes would count toward their Stillorgan journey while the pace push (row 3) does not | Task 2: `.eq('source_platform','glofox')` (keeps today's numbers; app and push agree) |
| 6 | `getClassRoster` (`class-bookings.js:166-176`) → live roster `api/live/[locationId]/route.js:33-40`, claim search `api/live/[locationId]/contacts/route.js:45` + `hr-claim.js:26-45` | staff display | **acts** (intended): Hatch /live shows who is booked into the current un1t class; names come from `member_name` only (no `glofox_member_id`) | Task 3 fills `member_name` |
| 7 | `lookupBookedMember` (`class-bookings.js:98-109`) → `bridge-samples.js:430`, `live-class.js:215`, apple-health ingest `:102` | device / HR linking (data-writing: `class_link_source`) | inert: keyed on `glofox_member_id`, which un1t rows never carry | none |
| 8 | `resolveBookedOccurrenceForMember` (`class-bookings.js:217-239`) → `bridge-samples.js:423`, `live-class.js:210` | device / HR linking | inert: same key | none |
| 9 | `fetchFloor` (`shared/studio-kpis.js:297-305`, maths `shared/studio-kpi-math.js:226-243,273-300`) → `/dashboard/studio` | staff display | no-show / attended / activation shown "unavailable" for non-Glofox (`dashboard/studio/page.js:93-123`, #2078) | Task 4: no-show and attended visits re-enabled for un1t_online; activation stays unavailable |
| 10 | `campaign_outcome_stats` RPC (mig 513:95-99) → `/api/campaigns/[id]/outcomes:94` | staff display | **miscounts**: filters lowercase `'cancelled'`, so projected `CANCELLED` rows would count as "class attendances" | Task 1: `CREATE OR REPLACE` with a case-correct filter |
| 11 | `upsertClassBookings` (`class-bookings.js:59-73`) ← `glofox-sync.js:2112-2126`, `api/admin/backfill-class-bookings/route.js:75` | data-writing (Glofox) | never touches a `un1t:` id; writes `source_platform` by default | Task 1 CHECK makes a mis-tagged write impossible |
| 12 | champ-app `src/lib/claim-candidates.js:200-207` (other repo, service role) | member display (strap-claim nudge) | a dual-studio member's Hatch booking could overlap a Stillorgan detection visit | follow-up in champ-app (Overlaps) |

**Glofox reconcile / cancel on bookings:** there is none. Unlike occurrences (#2078 restricted `class-occurrences.js`'s cancel reconcile to `source_platform = 'glofox'`), nothing updates or deletes `class_bookings`; the only Glofox write is the per-member upsert keyed on 24-hex Glofox ids (row 11). The Task 2 guard fails any future `.update(` / `.delete(` on `class_bookings` that does not filter `source_platform`.

**Not readers:** hyrox (reads `class_occurrences`), `auto-end-stale-hr-sessions` (occurrences), Mia tools, climate/Shelly runners (occurrences), `person-accounts.js:658` and `live-access.js:40` (comments).

## Global Constraints

- **Migration number NNN (controller assigns;** `ls supabase/migrations | sort -V | tail -3` shows 732 last, 730 used twice). Apply to prod **before** the code deploys: rows 1 and 2 filter on the new column, and a PostgREST filter on a missing column fails the whole query (Stillorgan reminders would stop).
- **Status mapping (Glofox shape).** Live `class_bookings` holds only `BOOKED` (attended true 9,167 / false 1,362) and `WAITING` (24); attendance is the `attended` boolean, never the status. `computeFloor`/`computeActivation` count only `status === 'BOOKED'` (`studio-kpi-math.js:227,277`), so the P1 plan's `ATTENDED` / `NO_SHOW` statuses would silently drop every un1t visit from no-show and attended visits, and fixing that means editing `shared/` (an OTA). So:
  - `booked` → `BOOKED`, `attended=false`; `attended` → `BOOKED`, `attended=true`; `no_show` → `BOOKED`, `attended=false`; `cancelled` → `CANCELLED`, `attended=false`;
  - any other non-empty value → its uppercase, `attended=false`; null → null, `attended=false`;
  - the un1t status is kept in `raw.un1t.status`.
- **Ids:** `glofox_booking_id = 'un1t:' || un1t_bookings.un1t_id`, `glofox_event_id = 'un1t:' || un1t_bookings.event_id`, `glofox_member_id = null`, `source_platform = 'un1t_online'`.
- **Other columns:** `contact_id` = the `un1t_bookings` row's `contact_id` (set by the sync's `contactIdOf`, `un1t-online-sync.js:321`), `member_name` = `contacts.name` for that id, `class_name` = event `title` (≤200 chars), `starts_at` = event `starts_at`, `raw = { un1t: { status, source, credit_charged } }` (never the booking's own `raw`), `synced_at` = the run's now.
- **Live shape check (2026-10-17):** `un1t_bookings` 231 attended, 24 booked, 61 cancelled, 10 no_show; 0 with null `contact_id` or `event_id`; 0 `class_bookings` ids starting `un1t`.
- **Projection rules:** only where `locations.membership_source = 'un1t_online'` (same gate as occurrences, `un1t-online-sync.js:370-373`); upsert `onConflict: 'location_id,glofox_booking_id'` in chunks of 200; reads in chunks of 100; **never deletes**; **never throws**; a failure is `counts.class_bookings = { error: {code, message} }` + `logWarn`, and never changes the run's or the connection's status.
- **Hard-off is unconditional:** no setting, no capability, no env flag can turn reminders or crediting on for a un1t row or a un1t_online location.
- **No `mobile/` or `shared/` changes** (both publish an OTA). No new route.

## Review Focus

1. **A future `booked` Hatch class** inside the reminder window: no push, no nudge row; a Stillorgan booking in the same tick is still reminded. Test in Task 2.
2. **`bookings` capability flipped true for un1t_online** (what P1.2 will do): a Hatch attended row is still not credited. Test in Task 2.
3. **Hatch's `membership_source` changed away from `un1t_online`** while its projected rows remain: still never reminded or credited (row filter). Test in Task 2.
4. **A projection writer bug that omits `source_platform`:** the DB refuses the row (CHECK), the sync records the error, the run stays ok. Tests in Tasks 1 and 3.
5. **A past un1t class nobody marked** stays `booked` → `BOOKED`/`attended=false` and counts as a no-show, exactly as an unmarked Glofox booking does. Pinned in Task 4.

---

### Task 1: Migration NNN — `class_bookings.source_platform`, namespace CHECK, campaign stats fix

**Files:**
- Create: `supabase/migrations/NNN_class_bookings_source_platform.sql`
- Test: `tests/migration-NNN-class-bookings-source-platform.test.js` (file-text pins), plus existing guards

**Interfaces:**
- Produces:
  - `class_bookings.source_platform text NOT NULL DEFAULT 'glofox' CONSTRAINT class_bookings_source_platform_check CHECK (source_platform IN ('glofox','un1t_online'))`;
  - `CONSTRAINT class_bookings_source_namespace_check CHECK ((source_platform = 'un1t_online') = (glofox_booking_id LIKE 'un1t:%') AND (source_platform = 'un1t_online') = (glofox_event_id LIKE 'un1t:%'))`;
  - `public.campaign_outcome_stats(uuid, int)` unchanged except the bookings join filter becomes `upper(coalesce(b.status, '')) <> 'CANCELLED'`.

- [ ] **Step 1: Write the failing test** `tests/migration-NNN-class-bookings-source-platform.test.js`:
  - `adds source_platform with the glofox default and the two-value CHECK`;
  - `the namespace CHECK ties un1t_online to the un1t: prefix on BOTH ids`;
  - `campaign_outcome_stats keeps mig 513's body except the CANCELLED filter`: the replaced function text contains `upper(coalesce(b.status, '')) <> 'CANCELLED'` and no `is distinct from 'cancelled'` on the bookings join; it is `security invoker`; it restates `revoke execute … from public, anon, authenticated` and `grant execute … to service_role`;
  - `self-check reads the catalog`: the file has a `DO $$` block that checks `information_schema.columns`, `pg_constraint` (both names), `has_table_privilege('authenticated','public.class_bookings','SELECT')`, no write policy in `pg_policy`, and `has_function_privilege` false for `anon`/`authenticated` on the RPC.
- [ ] **Step 2:** Run `npx vitest run tests/migration-NNN-class-bookings-source-platform.test.js`. Expected: FAIL (file missing).
- [ ] **Step 3: Write the migration.** `BEGIN` / `SET LOCAL lock_timeout = '5s'`; the column (metadata-only); the namespace CHECK added `NOT VALID` then `VALIDATE CONSTRAINT` in the same file (≈10.5k rows); `CREATE OR REPLACE FUNCTION public.campaign_outcome_stats` copied from mig 513:41-111 with the one filter change; `COMMENT ON COLUMN` (namespace, "the CRM never reminds or credits un1t_online rows: send-class-booking-reminders and credit-attendance filter source_platform = 'glofox'"); refresh mig 726's `un1t_bookings` table comment (it says "NOT written to class_bookings"); the catalog self-check. No grant line: `class_bookings` holds table-level SELECT for `authenticated` (not column-granted), say so in a comment.
- [ ] **Step 4:** Run the test, then `npx vitest run tests/table-default-acl-guard.test.js tests/function-execute-guard.test.js && npm run check:select-columns && npm run check:rpc-names && npm run check:rls-restrictive`. Expected: PASS.
- [ ] **Step 5:** Commit `UN1TBOOK.1 — class_bookings.source_platform + un1t: namespace CHECK; campaign stats count CANCELLED correctly (mig NNN)`.

---

### Task 2: Hard-off for every un1t.online booking and studio + reader manifest guard

**Files:**
- Modify: `src/app/api/cron/send-class-booking-reminders/route.js:55-110`
- Modify: `src/app/api/cron/credit-attendance/route.js:57-89`
- Modify: `src/lib/onboarding-journey-data.js:249-255` (`loadContactJourney`)
- Test: `src/app/api/cron/send-class-booking-reminders/route.un1t-off.test.js` (new; the existing `route.test.js` fake lacks `eq`/`in`: add them there too), `src/app/api/cron/credit-attendance/route.membership-source.test.js`, `src/lib/onboarding-journey-data.test.js`
- Create: `tests/class-bookings-readers-guard.test.js`

**Interfaces:**
- Consumes: `listLocationsByMembershipSource(db, 'un1t_online')` → `{ ids: string[]|null, error }` (`src/lib/membership/source.js`), Task 1's column.
- Produces: export `CRM_CLASS_MESSAGING_PLATFORM = 'glofox'` from `src/lib/class-bookings.js`; both crons filter `.eq('source_platform', CRM_CLASS_MESSAGING_PLATFORM)`.
- Reminders response gains `skipped_un1t_online: number`; credit-attendance response gains `skipped_un1t_online: number`.
- Failure rules (CLAUDE.md louder-failure): in **reminders**, a failed un1t_online locations read is `logError` + continue with the row filter alone (the row filter plus the Task 1 CHECK already exclude every un1t row; failing closed would drop Stillorgan's reminders). In **credit-attendance**, it answers 500 with no heartbeat, like its existing seam read at `:61-64`.

- [ ] **Step 1: Write the failing tests.**
  - Reminders: `a un1t_online booking in the window is never pushed or claimed` — the fake returns the query's recorded filters; assert the `class_bookings` query carries `eq source_platform glofox`, and that with a Hatch (un1t_online) row and a Stillorgan row in the data, `sendNudgeOnce` is called once, for Stillorgan (Review Focus 1).
  - Reminders: `a glofox-tagged booking at a un1t_online location is skipped and counted` (`skipped_un1t_online: 1`).
  - Reminders: `a failed un1t_online locations read still reminds Stillorgan, logs an error, and keeps the row filter`.
  - Credit: `with the un1t_online provider's bookings capability forced true, a Hatch attended row is still not credited` (mock `MEMBERSHIP_SOURCES.un1t_online.capabilities.bookings = true`; `createParticipationSession` not called for it) (Review Focus 2).
  - Credit: `a Hatch row whose location is no longer un1t_online is still not credited` — the query filter, asserted on the recorded call (Review Focus 3).
  - Credit: `a failed un1t_online locations read answers 500 and does not stamp`.
  - Journey: `loadContactJourney counts only glofox bookings` — the recorded `class_bookings` query has `eq source_platform glofox`.
  - Guard `tests/class-bookings-readers-guard.test.js`: scan non-test files under `src/`, `shared/`, `mobile/`, `supabase/functions/` for `class_bookings` referenced in a `.from(` call, and `supabase/migrations/` for function/view bodies that read it. Assert every file is in a `MANIFEST` of `{ path: { kind: 'display'|'data-writing'|'customer-messaging'|'staff-messaging'|'device', reason } }` (rows 1-11 of the audit table); every `customer-messaging` and attendance-crediting entry (reminders, credit-attendance) contains `source_platform', CRM_CLASS_MESSAGING_PLATFORM` or `'source_platform', 'glofox'` and `'un1t_online'`; any `.update(` or `.delete(` chained on `class_bookings` fails unless the chain names `source_platform`; an unlisted new reader fails with its path in the message; a listed path that no longer reads it fails as stale.
- [ ] **Step 2:** Run `npx vitest run src/app/api/cron/send-class-booking-reminders src/app/api/cron/credit-attendance src/lib/onboarding-journey-data.test.js tests/class-bookings-readers-guard.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reminders: read the un1t_online ids once per tick, add the row filter to the paginated query, drop rows at those locations before `selectDueClassReminders`, count them. Credit: add the row filter, merge the un1t_online ids into the skip set as their own counter (`skipped_un1t_online`, not folded into `skipped_no_source`). Journey: one `.eq`. Comment each filter with "Decision 1 (2026-10-17): the CRM never sends class reminders or attendance rewards for un1t.online; the un1t.online app does".
- [ ] **Step 4:** Run the same tests: PASS. Run `npm run check:guardrails && npm run check:select-columns && npm run check:route-guards`.
- [ ] **Step 5:** Commit `UN1TBOOK.2 — class reminders and attendance crediting hard-off for un1t.online; class_bookings reader manifest`.

---

### Task 3: Project `un1t_bookings` into `class_bookings`

**Files:**
- Create: `src/lib/un1t-online-bookings.js`
- Modify: `src/lib/un1t-online-sync.js:355-379` (call after the `un1t_bookings` upsert), header comment step 6
- Modify: `eslint.guardrails.config.mjs:469` (arm the new file for `no-unchecked-supabase-write`)
- Modify: `tests/class-bookings-readers-guard.test.js` (add the new writer: `data-writing`)
- Test: `src/lib/un1t-online-bookings.test.js`, `src/lib/un1t-online-sync.test.js` (replace `class_bookings is never written`, `:574-580`, and the `:547` assertion)

**Interfaces:**
- Consumes: the sync's `mapped.un1t_bookings` and `mapped.un1t_events` (`un1t-online-sync.js:358`).
- Produces:
  - `mapUn1tBookingStatus(status: string|null) → { status: string|null, attended: boolean }`;
  - `mapUn1tBookingToClassBooking(bookingRow, { locationId, event: { title, starts_at }|null, memberName?: string|null, nowIso }) → row|null` — null when no `un1t_id`, no `event_id`, or no event; omits the `member_name` key when `memberName === undefined`;
  - `projectUn1tBookings(db, { locationId, bookings, events, nowIso }) → Promise<{ upserted: number, skipped_no_event: number, names?: 'unreadable' } | { error: { code, message } }>`, never throws.
- Event lookup: the run's mapped events first; ids still missing are read from `un1t_events` (`select('un1t_id, title, starts_at').eq('location_id', locationId).in('un1t_id', chunk)`); a failure of that read returns `{ error }` and writes nothing (a later run retries; nothing is lost). Bookings whose event is still unknown are skipped and counted, never written with a null `starts_at` (which would overwrite a good one).
- Names: `contacts.select('id, name').in('id', chunk)`. A failed read is `logWarn` + `names: 'unreadable'` and the rows are written **without** the `member_name` key, so existing names are kept.
- Sync counts: `counts.class_bookings` = the result, or `{ skipped: 'membership_source' }` when the studio is not `un1t_online`.

- [ ] **Step 1: Write the failing tests** (`un1t-online-bookings.test.js`):
  - `maps every un1t status to the Glofox shape` — the table from Global Constraints, including `'waitlisted'` → `WAITLISTED`/false and null → null/false.
  - `maps a booking with un1t: ids, source_platform un1t_online, no glofox_member_id, the event's title and starts_at`, and `raw` holds only `{ un1t: { status, source, credit_charged } }`.
  - `a booking with no event_id or an unknown event is skipped and counted, never written`.
  - `reads missing events from un1t_events scoped to the location; a failed read writes nothing and returns error`.
  - `a failed names read writes rows without member_name and reports names: unreadable` (assert no row object has the key).
  - `upserts in chunks of 200 on location_id,glofox_booking_id and never deletes` (no `delete` in the log).
  - `a CHECK violation from the upsert is returned as {code, message}, never thrown` (Review Focus 4).
  - Sync: `a un1t_online studio projects its bookings after un1t_bookings is written` (`counts.class_bookings.upserted`); `a glofox studio is skipped: { skipped: 'membership_source' }`; `a projection failure leaves the run ok, the connection connected, memberships written, and counts.class_bookings.error set`.
- [ ] **Step 2:** Run `npx vitest run src/lib/un1t-online-bookings.test.js src/lib/un1t-online-sync.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the module (shape after `un1t-online-occurrences.js`: `safeError`, `chunks`, last-row-wins per id) and wire it in the TABLES loop when `spec.table === 'un1t_bookings'`, with the same `membership_source` gate as 6b.
- [ ] **Step 4:** Run the tests: PASS. Then `npm run check:guardrails && npm run check:select-columns`.
- [ ] **Step 5:** Commit `UN1TBOOK.3 — project un1t.online bookings into class_bookings`.

---

### Task 4: Studio scorecard: Hatch no-show and attended visits

**Files:**
- Modify: `src/app/dashboard/studio/page.js:84-123` (`withoutBookingKpis`, `loadLocationScorecard`), `:345-366` (cell sublabels)
- Test: `src/app/dashboard/studio/page.test.js` (update the UN1TCLASS.3 block, `:225-275`)

**Interfaces:**
- `withoutBookingKpis(floor, { keepAttendance: boolean })`: always nulls `activation`; when `keepAttendance` is false also nulls `noShowPct`, `attendedVisits` and each `groupTable[].noShowPct` (today's behaviour).
- `loadLocationScorecard` returns `bookingKpis: glofox` (activation sublabel + Glofox trainer footer, unchanged) and new `attendanceKpis: glofox || r.source === 'un1t_online'`; the No-show and Attended-visits cells key their sublabels on `attendanceKpis`. `FloorTable` is unchanged.
- Activation stays unavailable for un1t_online: its cohort is `contacts.converted_at` at the location, which the un1t sync never writes and which misses the dual-studio members.

- [ ] **Step 1: Write the failing tests.**
  - `un1t column: no-show and attended visits render from projected bookings; activation stays unavailable` — with `noShowPct: 12, attendedVisits: 88` the cells show `12%` + `target under` and `88` + `across 100 classes`; activation shows `—` + `unavailable`.
  - `un1t column: the by-class table shows per-class no-show`.
  - `glofox column unchanged` (existing test stays green).
  - `a non-Glofox, non-un1t source keeps all three booking cells unavailable` (source `'none'`-shaped reads stub).
- [ ] **Step 2:** Run `npx vitest run src/app/dashboard/studio/page.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement; update the UN1TCLASS.3 comment to say bookings are projected for un1t.online (Review Focus 5 belongs in that comment: an unmarked past booking is a no-show, as at Glofox).
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `UN1TBOOK.4 — Hatch scorecard shows no-show and attended visits from projected bookings`.

---

### Task 5: Verify and ship

- [ ] **Step 1:** Run the 13-command CI mirror individually, then `npm run build`.
- [ ] **Step 2 (controller):** Apply mig NNN to `iyvtbjjxdggiadzwwvdj` before merge; `get_advisors` (security). Confirm `select source_platform, count(*) from class_bookings group by 1` = only `glofox`, 10,553 rows.
- [ ] **Step 3 (controller, after deploy):** run one Hatch sync (Settings → Integrations → un1t.online → Sync now). Expect `counts.class_bookings.upserted` ≈ 326 and, at Hatch, `BOOKED/true` ≈ 231, `BOOKED/false` ≈ 34, `CANCELLED` ≈ 61, all `source_platform = 'un1t_online'`. After the next reminder tick and the next 03:00 credit run: `customer_engagement_nudges` has no `class_reminder` and `heart_rate_sessions` no participation session for a `un1t:` event; both cron responses show `skipped_un1t_online` 0 (no Glofox rows at Hatch).
- [ ] **Step 4:** Add the changelog entry after `gh pr create`.

---

## Decisions for Richard

None blocking. One later product question, resolved conservatively here: a dual-studio member's Hatch classes do **not** count toward their first-90-days journey (app card and pace push), because the pace push is studio-scoped and the two must agree. Counting cross-studio attendance is a separate change to both.

## Overlaps

- `src/lib/un1t-online-sync.js`, `src/lib/un1t-online-sync.test.js`: any P1 workstream touching the sync (P1.2 classifier fed from the seam, P1.4 Mia if it adds sync reads).
- `src/app/dashboard/studio/page.js` + `page.test.js`: the P1.2 radar / membership-capability workstream.
- `src/app/api/cron/credit-attendance/route.js`: P1.2's `bookings` capability flip must land **after** this plan (this plan is what keeps crediting off once the capability is true).
- `eslint.guardrails.config.mjs`: every workstream arming a path (trivial merge).
- Migration number: shared counter.
- champ-app (other repo, not this PR): `src/lib/claim-candidates.js:200-207` reads the member's bookings with no location filter; add `.eq('source_platform', 'glofox')` (or the member's location) there before Hatch has a bridge.
