# Hatch bookings into `class_bookings` (spec C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hatch Street's un1t.online bookings land in `class_bookings` with explicit `ATTENDED` / `NO_SHOW` statuses, feeding a coach "who's coming" list on `/live/<Hatch>` (new `class_roster` permission) and honest no-show / attended figures on the staff studio dashboard, while one predicate with two guards keeps every CRM reminder, reward and push off those rows.

**Architecture:** Two PRs, in the spec's rollout order. **PR 1** (guards) is built from the unmerged branch `un1t-online-bookings` (commits UN1TBOOK.1, .2, .4 and the non-projection half of .5, with migration 733 renumbered), plus the predicate module `src/lib/class-booking-platform.js`, the `shared/` outcome helper, the `class_roster` permission and its roster route and page. **PR 2** (projection) ports UN1TBOOK.3 and the .5 floor test onto main after PR 1 is live in production, then changes the mapping to explicit statuses and adds the C-4 tie-break pre-read. PR 2 is never pushed (so never gets a Vercel preview, which writes to the production database) until PR 1's production deploy is verified.

**Tech Stack:** Supabase Postgres migrations (applied by the controller through Supabase MCP), Next.js 16 App Router routes and server pages, React client components, `shared/` plain-JS modules (OTA path), Vitest (+ PGlite for the migration test).

**Spec:** `docs/superpowers/specs/2026-10-17-hatch-bookings-projection-design.md` (spec C). Source branch, read only: `~/code/un1t-crm-bookings`, branch `un1t-online-bookings`, commits `bb49226c` (.1), `0210a8ac` (.2), `1c71e0d9` (.3), `edb8d648` (.4), `dc915543` (.5). Its plan commit `41786acc` is superseded by this plan and is NOT brought over.

## Global Constraints

- House rules: `CLAUDE.md` invariants apply to every task. Each PR = a fresh worktree and branch off a fresh `origin/main` (`git fetch origin main && git checkout -b <branch> origin/main`), the 13-command CI mirror green, `npm run build` green, one `docs/changelog/entries/<PR>.md` row added after `gh pr create`. Never `git stash`; never checkout, rebase or edit `~/code/un1t-crm-bookings`.
- Migrations: numbered `NNN` (and `NNN+1`) = the next free numbers at build time (`git ls-tree --name-only origin/main supabase/migrations | sort -V | tail -3`; 735 is the last on 17 Oct). Forward-only. Implementer subagents have no MCP access: every migration is applied by the controller via Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj` before the PR merges (do it before `git push` so the PR preview reads a real column), then `get_advisors` (type `security`).
- **Ordering (spec Rollout, C-12):** PR 1 merged AND its production deployment READY before PR 2 is pushed. Vercel previews use the production database, so a preview carrying the projection could write Hatch rows while production's reminder cron lacks the guards.
- `CRM_CLASS_MESSAGING_PLATFORM = 'glofox'`. `source_platform` values: `'glofox'` (default, every existing row) and `'un1t_online'`. un1t rows: `glofox_booking_id = 'un1t:' + un1t_bookings.un1t_id`, `glofox_event_id = 'un1t:' + un1t_bookings.event_id`, `glofox_member_id = null`.
- Hard rule: no capability (`capabilities.bookings` included), setting, `notification_config` or env flag turns reminders, crediting, rewards or pushes on for a un1t row or at a `membership_source = 'un1t_online'` location.
- Status table (projection): `booked` → `BOOKED`/false/rank 0; `attended` → `ATTENDED`/true/rank 1; `no_show` → `NO_SHOW`/false/rank 1; `cancelled` → `CANCELLED`/false/rank 1; anything else → not projected, `skipped_unknown_status`.
- `raw = { un1t: { status, source, credit_charged, has_guest, updated_at, written_by } }` and nothing else; `updated_at` is un1t.online's own (`un1t_bookings.remote_updated_at`); `written_by` is `'sync'` here, `'crm'` for D.
- Projection chunks: upsert 200, reads 100. Never deletes, never throws, a failed read writes nothing. `counts.class_bookings = { upserted, kept_stored, skipped_no_event, skipped_unknown_status, names?, error? }`, counts only; errors carry `code` and `message` only.
- `class_roster`: web key, default on for `staff`, `head_coach`, `manager`, `owner` (and `master`), off for `reception`. Parity: `WEB_ONLY_OK` reason exactly `web /live roster only; phone screen out of scope`.
- Roster window unchanged: 20 min before start to 10 min after end (`OCC_PRE_MS` / `OCC_POST_MS`, `src/lib/class-occurrences.js:497-498`).
- No fill, no-show or other aggregate studio metric on a TV or any customer-facing screen (#2067 rule). Business dashboard and phone unchanged.
- **OTA:** any task touching `shared/` or `mobile/` publishes an OTA to production phones at 100% when its PR merges (`eas-update.yml`). PR 1 does (Tasks 5 and 6); PR 2 does not.
- Tests use fictional ids and names only: the repo is public.

## Review Focus

1. **PR 1 live, PR 2 not yet:** Hatch has zero decided bookings, so the dashboard must show "unavailable" for no-show AND attended visits, never "0". Test in Task 5.
2. **A guarded cron's select forgets `source_platform`:** the predicate drops every row (Stillorgan silently loses reminders). Expect a `logError` naming the count, not silence. Test in Task 3.
3. **A coach with `class_roster` at Hatch only, active location Stillorgan:** `/live/<Hatch>` and its roster route admit them (resolved at the target location), `/live/<Stillorgan>` does not. Test in Tasks 7 and 8.
4. **A `class_roster`-only coach opens `/live/<Hatch>` between classes:** an empty state explaining the 20-minute window, not a blank page. Test in Task 8.
5. **un1t.online staff correct a mark, or a member cancels and re-books:** the sync-written row follows un1t.online (`attended` → `no_show`, `attended` → `booked`, `cancelled` → `booked` all land); only a CRM-written row is protected by the rank rule. Test in Task 13.

---

## PR 1 — guards, who's coming, outcome helper (branch `un1t-bookings-guards`)

### Task 1: Port the branch's guard commits and renumber the migration

**Files:**
- Create (from the branch): `supabase/migrations/NNN_class_bookings_source_platform.sql`, `tests/migration-NNN-class-bookings-source-platform.test.js`, `src/app/api/cron/send-class-booking-reminders/route.un1t-off.test.js`, `tests/class-bookings-readers-guard.test.js`
- Modify (from the branch): `tests/helpers/closed-functions.js`, both cron routes and their tests, `src/lib/class-bookings.js`, `src/lib/onboarding-journey-data.js` (+ test), `src/app/dashboard/studio/page.js` (+ test)

**Interfaces:**
- Produces: column `class_bookings.source_platform text NOT NULL DEFAULT 'glofox'`, constraints `class_bookings_source_platform_check` and `class_bookings_source_namespace_check`; `campaign_outcome_stats(uuid, int)` with the bookings filter `upper(coalesce(b.status, '')) NOT IN ('CANCELLED', 'NO_SHOW')`.

- [ ] **Step 1 (controller, Supabase MCP, read-only): baseline, recorded.** 17 Oct: past un1t bookings still `booked` = **0** (attended 229, cancelled 59, no_show 10; future booked 30), from `select b.status, e.starts_at < now() as past, count(*) from un1t_bookings b join un1t_events e on e.location_id = b.location_id and e.un1t_id = b.event_id group by 1, 2;`. Hatch's no-show rate works from day one. Re-run at build time and put the numbers in the PR body. No 24-hex CHECK on Glofox ids (dropped, Richard 17 Oct): only the two `un1t:` ↔ `un1t_online` CHECKs.
- [ ] **Step 2: Bring the commits over.** In a fresh worktree on `un1t-bookings-guards` off `origin/main`:
  ```bash
  git fetch origin main && git checkout -b un1t-bookings-guards origin/main
  git cherry-pick bb49226c 0210a8ac edb8d648        # no sync file in these: no conflict expected
  git cherry-pick --no-commit dc915543
  git restore --source=HEAD --staged --worktree -- src/lib/un1t-online-sync.test.js
  git rm -q --cached src/lib/un1t-online-bookings.floor.test.js && rm src/lib/un1t-online-bookings.floor.test.js
  git commit -C dc915543 --reset-author   # then amend the subject: "UN1TBOOK.5a — mig comments and test hygiene (floor test moves to PR 2)"
  ```
  The floor test and the sync-test line belong to PR 2 (they need `src/lib/un1t-online-bookings.js`).
- [ ] **Step 3: Renumber.** `git mv` the migration to `NNN_class_bookings_source_platform.sql` and the test to `tests/migration-NNN-class-bookings-source-platform.test.js`; in both, and in `closed-functions.js` (`closedBy: NNN`), the guard test header and the two cron comments, replace `733` with `NNN` and the occurrences reference `mig 730` with `mig 734` (file `734_class_occurrences_source_platform.sql`, #2081). `grep -rn "733" <those files>` must then show only `733_org_settings_audit` if anything.
- [ ] **Step 4: Write the failing tests** in the migration test: rename `campaign_outcome_stats keeps mig 513's body except the CANCELLED filter` to `... except the CANCELLED / NO_SHOW filter`, asserting the text contains `upper(coalesce(b.status, '')) NOT IN ('CANCELLED', 'NO_SHOW')`; PGlite: `after NNN neither cancelled spelling nor NO_SHOW counts; BOOKED, WAITING and a null status still do`; `the self-check aborts the whole file when campaign_outcome_stats lacks the NO_SHOW filter`; `a glofox row with a non-hex booking id is still accepted (no id-shape CHECK)`.
- [ ] **Step 5: Run** `npx vitest run tests/migration-NNN-class-bookings-source-platform.test.js`. Expected: FAIL on the new filter assertions.
- [ ] **Step 6: Edit the migration:** the bookings join filter becomes `upper(coalesce(b.status, '')) NOT IN ('CANCELLED', 'NO_SHOW')`; the self-check's `position(...)` looks for that text; the CAMPAIGN STATS comment says no Glofox number moves (no Glofox row is `CANCELLED` or `NO_SHOW`; `WAITING` keeps counting). The GRANT comment keeps "none needed, not column-granted" and the self-check adds: no row in `information_schema.column_privileges` for `class_bookings` and grantee `authenticated`. No other CHECK is added.
- [ ] **Step 7: Run** `npx vitest run tests/migration-NNN-class-bookings-source-platform.test.js tests/function-execute-guard.test.js tests/table-default-acl-guard.test.js src/app/api/cron src/lib/onboarding-journey-data.test.js src/app/dashboard/studio tests/class-bookings-readers-guard.test.js && npm run check:select-columns && npm run check:rpc-names && npm run check:rls-restrictive`. Expected: PASS.
- [ ] **Step 8: Commit** `UN1TBOOK.6 — mig NNN (was 733): campaign stats exclude NO_SHOW too; renumbered onto main`.

### Task 2: The predicate module

**Files:**
- Create: `src/lib/class-booking-platform.js`, `src/lib/class-booking-platform.test.js`
- Modify: `src/lib/class-bookings.js` (the constant moves out; re-export it)

**Interfaces:**
- Consumes: `listLocationsByMembershipSource(db, 'un1t_online') → { ids: string[]|null, error }` (`src/lib/membership/source.js:98`).
- Produces:
  - `export const CRM_CLASS_MESSAGING_PLATFORM = 'glofox'` (re-exported from `src/lib/class-bookings.js` so existing imports keep working);
  - `crmMayActOnClassBooking(row, { un1tOnlineLocationIds: Set<string> }) → boolean`: true only when `row.source_platform === CRM_CLASS_MESSAGING_PLATFORM` AND `!un1tOnlineLocationIds.has(row.location_id)`; a row with no `source_platform` is false; throws `TypeError` when `un1tOnlineLocationIds` is not a `Set` (a caller must decide what an unreadable list means);
  - `scopeToCrmActionable(query) → query`: returns `query.eq('source_platform', CRM_CLASS_MESSAGING_PLATFORM)`;
  - `readUn1tOnlineLocationIds(db) → Promise<{ ids: Set<string>, error: null } | { ids: null, error }>`.

- [ ] **Step 1: Write the failing tests** (`class-booking-platform.test.js`): `a glofox row at a Glofox studio is actionable`; `a un1t_online row is not`; `a glofox-tagged row at a un1t_online studio is not`; `a row with no source_platform key is not`; `throws TypeError without a Set`; `scopeToCrmActionable adds eq source_platform glofox and returns the builder`; `readUn1tOnlineLocationIds returns a Set of ids`; `a failed read returns ids null and the error`; `consults no capability, setting or env` (module text, comments stripped with `tests/helpers/js-code.js` `codeOfFile`, has no `capabilities`, `notification_config`, `settings` or `process.env`).
- [ ] **Step 2: Run** `npx vitest run src/lib/class-booking-platform.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the four exports in `src/lib/class-booking-platform.js`; header comment cites decision 7 and spec C §2. `class-bookings.js` replaces its constant with `export { CRM_CLASS_MESSAGING_PLATFORM } from '@/lib/class-booking-platform'`.
- [ ] **Step 4: Run** the test file plus `npx vitest run tests/class-bookings-readers-guard.test.js src/app/api/cron`. Expected: PASS.
- [ ] **Step 5: Commit** `UN1TBOOK.7 — class-booking-platform.js: one predicate, both guards`.

### Task 3: Reminders and credit-attendance on the predicate

**Files:**
- Modify: `src/app/api/cron/send-class-booking-reminders/route.js`, `src/app/api/cron/credit-attendance/route.js`
- Test: `src/app/api/cron/send-class-booking-reminders/route.un1t-off.test.js`, `src/app/api/cron/credit-attendance/route.membership-source.test.js`, `tests/class-bookings-readers-guard.test.js` (HARD_OFF + wrapped-chain detector)

**Interfaces:**
- Consumes: Task 2's four exports.
- Produces: both responses keep `skipped_un1t_online: number`. Reminders: on a failed `readUn1tOnlineLocationIds`, `logError` and continue with `new Set()` (row guard alone, backed by the namespace CHECK). Credit-attendance: on failure, 500 with no heartbeat (unchanged from the branch).

- [ ] **Step 1: Write the failing tests.** Use a fake db that **ignores** `.eq`/`.not`/`.in` filters on `class_bookings` (returns every fixture row) but records them. Reminders: `with filters ignored, a due un1t_online row at Hatch is never pushed, with Hatch lead times set and capabilities.bookings forced true`; `a dual-studio member's Hatch booking (a Stillorgan contact with a push token) is never pushed`; `a Stillorgan glofox row in the same tick is pushed once`; `the class_bookings select names source_platform and the recorded filters include eq source_platform glofox`; `a returned row without source_platform is dropped, counted in skipped_un1t_online, and logged once at error with the count` (Review Focus 2); keep the branch's `a failed un1t_online locations read still reminds Stillorgan, logs an error, and keeps the row filter`. Credit: `with filters ignored and capabilities.bookings forced true, an attended un1t_online row creates no participation session and calls no reward`; `a glofox-tagged row at a un1t_online studio is not credited and counts skipped_un1t_online`; `a Stillorgan attended glofox row is still credited`; keep `a failed un1t_online locations read answers 500, credits nothing and does not stamp`. Existing fixtures gain `source_platform: 'glofox'`.
- [ ] **Step 2: Run** `npx vitest run src/app/api/cron/send-class-booking-reminders src/app/api/cron/credit-attendance`. Expected: FAIL (rows without the column, ignored filters).
- [ ] **Step 3: Implement.** Both routes: `readUn1tOnlineLocationIds` once per tick; the query through `scopeToCrmActionable(db.from('class_bookings').select('<cols>, source_platform'))`; `crmMayActOnClassBooking` on every row before anything is chosen or credited; the branch's inline `listLocationsByMembershipSource` call and `un1tOnline` set go. Reminders: when a dropped row's `source_platform !== CRM_CLASS_MESSAGING_PLATFORM`, one `logError('cron-class-reminders', 'query filter let a non-CRM row through', { count })` per tick. In `tests/class-bookings-readers-guard.test.js` (it would otherwise fail from here on): the HARD_OFF test requires `readUn1tOnlineLocationIds(` and `crmMayActOnClassBooking(` instead of the `'un1t_online'` literal and the inline `.eq`, and a chain counts as scoped when it carries the constant `.eq` OR is the argument of `scopeToCrmActionable(` (detector test: `a chain wrapped as scopeToCrmActionable(db.from('class_bookings')…) counts as scoped; an unwrapped one does not`).
- [ ] **Step 4: Run** the same tests plus `npx vitest run tests/class-bookings-readers-guard.test.js`, then `npm run check:guardrails && npm run check:select-columns && npm run check:route-guards`. Expected: PASS.
- [ ] **Step 5: Commit** `UN1TBOOK.8 — reminders and credit-attendance decide through crmMayActOnClassBooking`.

### Task 4: Journey reads and the two HR-linking helpers

**Files:**
- Modify: `src/lib/onboarding-journey-data.js` (`fetchAttendanceByContact`, `loadContactJourney`), `src/lib/class-bookings.js` (`lookupBookedMember` :98-109, `resolveBookedOccurrenceForMember` :217-239)
- Test: `src/lib/onboarding-journey-data.test.js`, `src/lib/class-bookings.test.js`

**Interfaces:**
- Consumes: `scopeToCrmActionable(query)`.
- Produces: no signature change. Both helpers stay location-scoped; the location guard is their caller's location (bridge / live class at a studio).

- [ ] **Step 1: Write the failing tests:** `lookupBookedMember filters source_platform glofox`; `resolveBookedOccurrenceForMember filters source_platform glofox`; journey: the branch's two filter tests now assert the query went through `scopeToCrmActionable` (recorded `eq source_platform glofox`), unchanged otherwise.
- [ ] **Step 2: Run** `npx vitest run src/lib/class-bookings.test.js src/lib/onboarding-journey-data.test.js`. Expected: FAIL on the two helpers.
- [ ] **Step 3: Implement:** wrap the four `class_bookings` queries with `scopeToCrmActionable(...)` (the journey ones replace the branch's inline `.eq`).
- [ ] **Step 4: Run** the same tests plus `npx vitest run src/lib/bridge-samples src/lib/live-class src/app/api/wearables tests/class-bookings-readers-guard.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `UN1TBOOK.9 — journey reads and HR booking links take the CRM-actionable scope`.

### Task 5: `bookingOutcome` in `shared/` and the studio page zero-state  ⚠ OTA (`shared/`)

**Files:**
- Modify: `shared/studio-kpi-math.js` (`computeFloor` :191, `computeActivation` :273), `shared/studio-kpis.js` (`fetchFloor` select :297-305), `src/app/dashboard/studio/page.js` (`withoutBookingKpis`)
- Test: `shared/studio-kpi-math.test.js`, `shared/studio-kpis.test.js`, `src/app/dashboard/studio/page.test.js`

**Interfaces:**
- Produces: `export function bookingOutcome(row: { source_platform?: string, status: string|null, attended: boolean }) → 'attended' | 'no_show' | 'undecided' | 'excluded'`. A missing `source_platform` is read as `'glofox'` (display only; the predicate's opposite default is deliberate). Glofox: `BOOKED` → `attended`/`no_show` by `attended`; any other status → `excluded` (today's `status !== 'BOOKED'` skip). un1t_online: `ATTENDED` → `attended`, `NO_SHOW` → `no_show`, `BOOKED` → `undecided`, anything else → `excluded`. `undecided` is outside numerator and denominator.
- `withoutBookingKpis(floor, { keepAttendance })` (branch): when `keepAttendance` and `floor.noShowPct == null`, `attendedVisits` is also `null`.

- [ ] **Step 1: Write the failing tests.** Math: `bookingOutcome: glofox BOOKED attended / not attended, WAITING and CANCELLED excluded`; `bookingOutcome: a row with no source_platform is read as glofox`; `bookingOutcome: un1t_online ATTENDED, NO_SHOW, BOOKED undecided, CANCELLED excluded`; `computeFloor: un1t past BOOKED rows leave numerator and denominator; all undecided gives noShowPct null and per-group noShowPct null`; `computeActivation counts a un1t ATTENDED as a visit, never a un1t BOOKED`; every existing Glofox `computeFloor`/`computeActivation` test stays green unchanged. `fetchFloor selects source_platform on class_bookings`. Page: `un1t column with no decided bookings shows no-show and attended visits unavailable, never 0` (Review Focus 1; `noShowPct: null, attendedVisits: 0` in → both cells `—` + `unavailable`); the branch's un1t pass-through test stays; `activation stays unavailable at Hatch`.
- [ ] **Step 2: Run** `npx vitest run shared/studio-kpi-math.test.js shared/studio-kpis.test.js src/app/dashboard/studio/page.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `bookingOutcome` and switch `computeFloor`'s `b.status !== 'BOOKED'` / `!b.attended` and `computeActivation`'s filter to it; add `source_platform` to `fetchFloor`'s bookings select; the page's zero-state rule. Rewrite the branch's page comment (UN1TBOOK.4 "an unmarked past booking is a no-show") to: a past un1t `BOOKED` is undecided; activation stays unavailable at Hatch because spec A never writes `contacts.converted_at` (A, Anti-goals) (Left to the builder 3, resolved).
- [ ] **Step 4: Run** the same tests and `npm run check:mobile-imports && npm run check:ota-paths`. Expected: PASS.
- [ ] **Step 5: Commit** `UN1TBOOK.10 — bookingOutcome: un1t ATTENDED / NO_SHOW counted, a past un1t BOOKED undecided (shared/, OTA)`.

### Task 6: The `class_roster` permission  ⚠ OTA (`shared/`)

**Files:**
- Modify: `shared/permissions.js` (`WEB_PERMISSIONS` after `class_timer` :113; `DEFAULT_WEB_PERMISSIONS_BY_ROLE` :324-511), `shared/permission-bundles.js` (`KEY_BUNDLES`, beside `class_timer` :165), `scripts/check-mobile-parity.mjs` (`WEB_ONLY_OK` :76), `src/lib/nav-items.js` (Members `anyPermission` :219), `src/app/(members)/layout.js` (`live` tab :37), `src/app/live/page.js` (:21)
- Create: `supabase/migrations/NNN+1_permission_key_bundles_reseed_class_roster.sql`
- Test: `shared/permissions.test.js`, `shared/permission-bundles.test.js`, `src/lib/nav-items.test.js` (:128), `src/app/live/page.test.js`

**Interfaces:**
- Produces: key `class_roster`, label `Class roster`, hint `See who is booked into the class running now on the live class page, without heart-rate data, pairing or door unlock.`; defaults `master/staff/head_coach/manager/owner: true`, `reception: false`; `KEY_BUNDLES.class_roster = ['bundle_members']` (same home as `class_timer`; behaviour-neutral in SQL because `auth_mobile_can` is never asked about a web-only key). Not in `CROSS_PLATFORM_KEYS`; no `MOBILE_PERMISSIONS` entry; no phone-defaults migration.

- [ ] **Step 1: Write the failing tests:** `class_roster defaults on for staff, head_coach, manager, owner and master, off for reception`; `class_roster never implies studio_management` (a role template with `class_roster: true, studio_management: false` resolves studio_management false); nav: Members `anyPermission` equals the existing list with `'class_roster'` after `'class_timer'`; `/live` index: `redirects a class_roster-only user to /live/<active>` and `redirects a user with neither key to /`.
- [ ] **Step 2: Run** `npx vitest run shared/permissions.test.js shared/permission-bundles.test.js src/lib/nav-items.test.js src/app/live/page.test.js && npm run check:mobile-parity && npm run check:bundle-sql`. Expected: FAIL.
- [ ] **Step 3: Implement** the key, defaults, bundle entry, nav and tab `perms: ['studio_management', 'class_roster']`, the `/live` index (`hasPermission` for either key), and `WEB_ONLY_OK.class_roster = 'web /live roster only; phone screen out of scope'`. The migration copies mig 665's shape: one transaction, `TRUNCATE private.permission_key_bundles;` then the block printed by `node scripts/generate-bundle-sql.mjs` between `-- BEGIN GENERATED` / `-- END GENERATED`, header saying it adds `class_roster → bundle_members` and is behaviour-neutral for RLS.
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run src/lib/nav-bundles-integration.test.js tests/check-bundle-sql.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `UN1TBOOK.11 — class_roster permission: the who's coming list without door unlock (mig NNN+1, shared/, OTA)`.

### Task 7: `GET /api/live/[locationId]/roster`

**Files:**
- Create: `src/app/api/live/[locationId]/roster/route.js`, `src/app/api/live/[locationId]/roster/route.test.js`
- Modify: `src/lib/live-access.js` (`guardLiveLocation`), `src/app/api/live/[locationId]/route.js` (adds `has_bridge`), `src/lib/openapi.js` (near :8240), `src/app/api/live/gate.test.js`

**Interfaces:**
- Consumes: `getClassRoster(db, { locationId }) → { occurrence, roster }`, `mergeRosterWithSessions(roster, [])`.
- Produces: `guardLiveLocation(user, locationId, { roles = null, permission = LIVE_PERMISSION } = {})`; refusal message `Class roster permission required` when `permission === 'class_roster'`. Route answers `{ ok: true, occurrence, roster, has_bridge }`, where `has_bridge` = at least one `ble_bridges` row at the location (a failed read logs and answers `false`). The main live route's payload also gains `has_bridge`.

- [ ] **Step 1: Write the failing tests:** roster route: `401 anonymous`; `403 for a member of another location without touching the db`; `403 for a member without class_roster`; `a class_roster-only user gets occurrence, roster labels and has_bridge, and no sessions or straps keys`; `resolves class_roster at the target location, not the active one` (Review Focus 3: granted at Hatch only, active Stillorgan → 200 for Hatch, 403 for Stillorgan); `roster lists ATTENDED and NO_SHOW members, skips CANCELLED`. `gate.test.js` each-block: `403s a class_roster-only member` on every existing `/api/live/**` route.
- [ ] **Step 2: Run** `npx vitest run 'src/app/api/live'`. Expected: FAIL (route missing).
- [ ] **Step 3: Implement** the guard option, the route (service role; `guardLiveLocation(user, locationId, { permission: 'class_roster' })`; one `ble_bridges` `select('id').eq('location_id', locationId).limit(1)`), `has_bridge` on the main route, the openapi entry.
- [ ] **Step 4: Run** `npx vitest run 'src/app/api/live' tests/role-sweep && npm run check:route-guards && npm run check:location-scoping`. Expected: PASS.
- [ ] **Step 5: Commit** `UN1TBOOK.12 — /api/live/[id]/roster under class_roster`.

### Task 8: `/live/<id>` admits `class_roster`

**Files:**
- Create: `src/app/live/[locationId]/ClassRosterPanel.jsx` (moved out of `LiveClassClient.jsx` :356-405), `src/app/live/[locationId]/LiveRosterClient.jsx`, `src/app/live/[locationId]/LiveRosterClient.test.jsx`
- Modify: `src/app/live/[locationId]/page.js` (:39), `src/app/live/[locationId]/LiveClassClient.jsx`, `src/app/live/[locationId]/page.test.js`

**Interfaces:**
- Consumes: Task 7's route and `has_bridge`.
- Produces: `ClassRosterPanel({ roster, occurrence, hasBridge = true })`: header `{present}/{booked} booked here` when `hasBridge`, else `{booked} booked`. `LiveRosterClient({ locationId, locationName, timeZone })` polls `/api/live/${locationId}/roster` every 15 s and renders only `ClassRosterPanel`; with no live class, the empty state `No class on right now. The list opens 20 minutes before a class starts.`; with a live class and nobody booked, `Nobody is booked into {occurrence.name}.`

- [ ] **Step 1: Write the failing tests:** page: `renders LiveRosterClient for a class_roster-only user at their location`; `renders LiveClassClient when studio_management is held` (existing); `redirects a user with neither key`; `a roster-only render reads no tv_displays token`. Client: `shows "{n} booked" without a bridge and "{p}/{n} booked here" with one`; `shows the empty state with no live class` (Review Focus 4); `renders no HR grid, straps, pairing, Detected tab or test-mode control`. Existing `LiveClassClient.gates.test.jsx` stays green.
- [ ] **Step 2: Run** `npx vitest run 'src/app/live'`. Expected: FAIL.
- [ ] **Step 3: Implement:** the page admits `hasPermissionForLocation(user, locationId, 'studio_management') || …'class_roster'`; with `studio_management` it renders `LiveClassClient` exactly as today (passing `hasBridge={data.has_bridge}` to the panel), otherwise `LiveRosterClient` and skips the `tv_displays` read.
- [ ] **Step 4: Run** `npx vitest run 'src/app/live' && npm run check:guardrails && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `UN1TBOOK.13 — /live/<id> shows the class roster to class_roster holders; HR board stays behind studio_management`.

### Task 9: Extend the reader guard

**Files:**
- Modify: `tests/class-bookings-readers-guard.test.js`

**Interfaces:**
- Consumes: Task 2's exports; Tasks 3, 4, 7 call sites.
- Produces: kinds `display | data-writing | customer-messaging | reward | conversational-read | staff-messaging | device`; `HELPER_CALLERS` manifest for callers of `getClassRoster(`, `lookupBookedMember(`, `resolveBookedOccurrenceForMember(`; D (`data-writing`) and E (`conversational-read`) register here when they land.

- [ ] **Step 1: Write the failing tests:** credit-attendance reclassified `reward`; `every chain in a customer-messaging or reward file is scoped` (Task 3's detector); `the class_bookings chains inside lookupBookedMember and resolveBookedOccurrenceForMember are scoped`; `every caller of the three class-bookings helpers is in HELPER_CALLERS` (today: `/api/live/[locationId]/route.js`, `…/contacts/route.js`, `…/roster/route.js` as `display`; `bridge-samples.js`, `live-class.js`, `wearables/apple-health/ingest/route.js` as `device`); `no TV or public file reads class_bookings or imports fetchFloor` (`src/app/tv/**`, `src/app/api/public/**`, `src/lib/live-board.js`, `src/lib/tv-*.js`). Header comment points at the spec, not the branch's superseded plan.
- [ ] **Step 2: Run** `npx vitest run tests/class-bookings-readers-guard.test.js`. Expected: FAIL on the new assertions.
- [ ] **Step 3: Implement** the kinds, `HELPER_CALLERS` and the TV scan in the guard file (no product code should need to change; if it does, the earlier task missed a call site).
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** `UN1TBOOK.14 — class_bookings guard: reward and conversational kinds, helper callers, nothing on TVs`.

### Task 10: Ship PR 1 and verify in production

- [ ] **Step 1:** Run the CI mirror (all 13, `CLAUDE.md` Build) and `npm run build`. Expected: all green.
- [ ] **Step 2 (controller):** apply migrations `NNN` then `NNN+1` via Supabase MCP `apply_migration` on `iyvtbjjxdggiadzwwvdj` (confirm the project with `list_projects`), then `get_advisors` type `security`: no new finding. Then (Supabase MCP, read-only) `select source_platform, count(*) from class_bookings group by 1;` → only `glofox`.
- [ ] **Step 3:** `git push -u origin HEAD`, `gh pr create --base main --fill` (title `UN1TBOOK.6-14 — class_bookings guards and Hatch who's coming (migs NNN, NNN+1 applied)`; body flags the OTA from `shared/`), then add `docs/changelog/entries/<PR>.md` (one row) and push.
- [ ] **Step 4 (controller):** after merge, confirm the production deployment of the merge commit is READY (`gh api repos/{owner}/{repo}/commits/<sha>/status` or Vercel MCP `list_deployments`) and the OTA workflow published (`gh run list --workflow eas-update.yml -L 1`).
- [ ] **Step 5 (controller, next morning, Supabase MCP read-only + Vercel logs):** reminders `tick` logs show `sent` in Stillorgan's normal range and `skipped_un1t_online: 0`; class-reminder rows in `customer_engagement_nudges` since the deploy are in line with the same window a week earlier; the 03:00 `credit-attendance` response is normal (`credited` > 0 on a class day, `skipped_un1t_online: 0`). Only then may Task 11 push.

---

## PR 2 — the projection (branch `un1t-bookings-projection`)

### Task 11: Port UN1TBOOK.3 onto main (gate: PR 1 live)

**Files:**
- Create (from the branch): `src/lib/un1t-online-bookings.js`, `src/lib/un1t-online-bookings.test.js`, `src/lib/un1t-online-bookings.floor.test.js`
- Modify: `src/lib/un1t-online-sync.js` (conflict), `src/lib/un1t-online-sync.test.js`, `eslint.guardrails.config.mjs`, `tests/class-bookings-readers-guard.test.js`

- [ ] **Step 1 (controller): gate.** Task 10 Step 5 passed. Until then this branch may be built locally (local dev has no database) but is not pushed.
- [ ] **Step 2: Cherry-pick and resolve.**
  ```bash
  git fetch origin main && git checkout -b un1t-bookings-projection origin/main
  git cherry-pick 1c71e0d9
  ```
  Resolve `src/lib/un1t-online-sync.js` (UN1THARD.1-4 changed it): keep main's header (steps 1, 6c history) and add the branch's sentence about bookings to step 6; keep main's loop and its `6c. The history window` block untouched; put the branch's bookings block inside the `TABLES` loop directly after 6b, relabelled `6b (bookings)`. Resolve the guard test by adding only the `src/lib/un1t-online-bookings.js` `data-writing` entry to PR 1's manifest. Then `git checkout dc915543 -- src/lib/un1t-online-bookings.floor.test.js` and apply .5's one-line removal in `un1t-online-sync.test.js`; replace main's `class_bookings is never written` assertions (:555, :582-587) with the branch's projection tests.
- [ ] **Step 3: Run** `npx vitest run src/lib/un1t-online-bookings.test.js src/lib/un1t-online-sync.test.js tests/class-bookings-readers-guard.test.js`. Expected: PASS except the floor test, which still pins the branch's Glofox shape (rewritten in Task 12).
- [ ] **Step 4: Commit** `UN1TBOOK.15 — port the un1t.online bookings projection onto main (sync conflict resolved)`.

### Task 12: Explicit statuses, guest name, `raw.un1t`

**Files:**
- Modify: `src/lib/un1t-online-bookings.js`
- Test: `src/lib/un1t-online-bookings.test.js`, `src/lib/un1t-online-bookings.floor.test.js`

**Interfaces:**
- Produces (D imports the mapper):
  - `UN1T_STATUS_RANK = { BOOKED: 0, ATTENDED: 1, NO_SHOW: 1, CANCELLED: 1 }`;
  - `mapUn1tBookingStatus(status: string|null) → { status, attended, rank } | null` (null = not projectable: unknown, empty or null);
  - `mapUn1tBookingToClassBooking(bookingRow, { locationId, event, memberName, nowIso, writtenBy = 'sync' }) → row | null`, null also for an unprojectable status; `member_name = 'Guest'` when `bookingRow.contact_id` is null and `bookingRow.has_guest` is true; `raw.un1t.updated_at = bookingRow.remote_updated_at ?? null` (null when un1t.online gives none, never our clock; D does the same, C wins over D).

- [ ] **Step 1: Write the failing tests:** `maps every row of the status table` (four statuses, upper-case input too); `an unknown status (e.g. 'waitlisted'), empty or null is not projected, counted skipped_unknown_status, with one logWarn per run naming the distinct values`; `raw holds exactly status, source, credit_charged, has_guest, updated_at, written_by` (`Object.keys` equality); `writtenBy 'crm' is carried into raw.un1t.written_by`; `a guest booking with no contact is named Guest`; `a dual-studio booking keeps its Stillorgan contact_id and Hatch location_id`. Floor test rewritten: `an unmarked past un1t booking is undecided: outside numerator and denominator`; `NO_SHOW is a no-show and ATTENDED a visit, CANCELLED outside`; `all undecided gives noShowPct null`; keep `both projections key the same class by the same un1t: event id`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-bookings.test.js src/lib/un1t-online-bookings.floor.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the table, the mapper changes and the new count; update the module header (no more "Glofox shape").
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `UN1TBOOK.16 — explicit ATTENDED / NO_SHOW, unknown statuses skipped, Guest, raw.un1t for D`.

### Task 13: The C-4 tie-break pre-read

**Files:**
- Modify: `src/lib/un1t-online-bookings.js`
- Test: `src/lib/un1t-online-bookings.test.js`

**Interfaces:**
- Produces: `shouldReplaceStored(incoming, stored) → boolean` (pure; `incoming`/`stored` are `{ status, raw }` class_bookings rows, `stored` may be null); `projectUn1tBookings` result gains `kept_stored`.

  Rule, in order (spec §7 as decided 17 Oct): no stored row → true; stored `raw.un1t.written_by !== 'crm'` (sync-written, or missing) → true, always; otherwise (CRM-written): stored status not in `UN1T_STATUS_RANK` → rank 0; incoming rank > stored rank → true; incoming rank < stored rank → false; same rank: both `raw.un1t.updated_at` present → true when incoming ≥ stored (compared as instants, un1t.online's clock only), else (either missing) → true.

- [ ] **Step 1: Write the failing tests:** sync-written stored rows (Review Focus 5): `cancel then rebook: a sync BOOKED replaces a sync-written CANCELLED`; `un-marked attendance: a sync BOOKED replaces a sync-written ATTENDED`; `a sync NO_SHOW replaces a sync-written ATTENDED whatever the timestamps`; `a stored row with no written_by is treated as sync-written`. CRM-written stored rows: `a terminal sync status overwrites a stored CRM BOOKED even with an older updated_at`; `a sync BOOKED never undoes a stored CRM CANCELLED, even with a newer updated_at, and counts kept_stored`; `same rank against a CRM row: the newer un1t.online updated_at wins either way`; `a CRM row with no un1t.online timestamp loses to the sync row of the same rank`; `equal timestamps re-write (idempotent re-run)`; `the pre-read is location-scoped, in chunks of 100, selecting glofox_booking_id, status, raw`; `a failed pre-read writes nothing and returns error`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-bookings.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the pre-read before the upsert loop (`.from('class_bookings').select('glofox_booking_id, status, raw').eq('location_id', locationId).in('glofox_booking_id', chunk)`) and filter rows through `shouldReplaceStored`.
- [ ] **Step 4: Run** the test file, `npm run check:guardrails && npm run check:select-columns`. Expected: PASS.
- [ ] **Step 5: Commit** `UN1TBOOK.17 — a sync row follows un1t.online; a CRM row: terminal beats BOOKED, newer wins within a rank on un1t.online's clock`.

### Task 14: Sync counts, CLAUDE.md line

**Files:**
- Modify: `src/lib/un1t-online-sync.js`, `src/lib/un1t-online-sync.test.js`, `CLAUDE.md` (line 64)

- [ ] **Step 1: Write the failing tests** (sync): `counts.class_bookings carries upserted, kept_stored, skipped_no_event and skipped_unknown_status`; keep `a glofox studio is skipped: { skipped: 'membership_source' }`, `a projection failure leaves the run ok, the connection connected, memberships written, and counts.class_bookings.error set`, `does not project when the un1t_bookings upsert fails`; `counts.history is still measured after the projection` (the 6c block runs).
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-sync.test.js`. Expected: FAIL on the new counts.
- [ ] **Step 3: Implement:** `counts.class_bookings` is the projection's result object as returned (Tasks 12-13 keys); nothing else in the run changes.
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Edit `CLAUDE.md` line 64:** "but its bookings are NOT, and CRM class reminders …" becomes: its bookings are projected into `class_bookings` with `source_platform = 'un1t_online'` (#<PR 2>); the CRM never reminds, rewards or pushes for them or at a un1t.online studio, and `src/lib/class-booking-platform.js` (`crmMayActOnClassBooking`, both guards) is the rule, pinned by `tests/class-bookings-readers-guard.test.js`.
- [ ] **Step 6: Commit** `UN1TBOOK.18 — sync records the projection counts; CLAUDE.md Hatch line`.

### Task 15: Ship PR 2 and verify live

- [ ] **Step 1:** CI mirror (13) and `npm run build`. Expected: green. No migration in this PR.
- [ ] **Step 2:** push, `gh pr create --base main --fill` (title `UN1TBOOK.15-18 — Hatch bookings into class_bookings`), changelog entry, merge after green.
- [ ] **Step 3 (controller, after deploy):** trigger one Hatch run (Settings → Integrations → un1t.online → Sync now, or wait for the 15-min cron). Supabase MCP read-only: the latest `un1t_sync_runs.counts->'class_bookings'` shows `upserted` near the live `un1t_bookings` count at Hatch (326 on 17 Oct) and every `skipped_*` explained; `select status, attended, count(*) from class_bookings where source_platform = 'un1t_online' group by 1, 2;` ≈ `ATTENDED` 229, `CANCELLED` 59, `NO_SHOW` 10, `BOOKED` 30 and every `BOOKED` in the future (Task 1 Step 1 baseline, 17 Oct).
- [ ] **Step 4 (controller, a day later, Supabase MCP read-only):** no `customer_engagement_nudges` row keyed on a `un1t:` booking id; `select count(*) from heart_rate_sessions where glofox_event_id like 'un1t:%'` = 0; both crons' `skipped_un1t_online` 0.
- [ ] **Step 5 (controller, read-only):** for past Hatch occurrences compare `class_occurrences.raw->>'booked'` with the count of non-`CANCELLED` projected rows per event; if `bookings_count` includes cancellations, open a follow-up to fill `raw.booked` from the projection (spec Rollout 5).
- [ ] **Step 6 (Richard, MIA TEST account):** book a Hatch class 40+ minutes ahead in un1t.online; within 15 minutes it is `BOOKED` in `class_bookings`; a `class_roster`-only coach sees it on `/live/<Hatch>` from 20 minutes before; the reminder tick does not include it (proof is the tick log and the nudge ledger). Mark attended in un1t.online: `ATTENDED` on the next run, no participation session the next morning. Also cancel and re-book once: the row ends `BOOKED` on the next run (rule 0, whether or not un1t.online reuses the id).

---

## Out of this repo

- **champ-app** `src/lib/claim-candidates.js:200-207` (still on champ-app `origin/main`) reads a member's `class_bookings` by `contact_id` with no source filter. A separate champ-app PR adds `.eq('source_platform', 'glofox')` there before Hatch has a bridge (Left to the builder 4); it may merge any time after migration `NNN` is applied.
