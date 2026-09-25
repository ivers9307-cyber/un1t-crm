## PR AVAIL.3 — contractors' "unavailable" time off moves into availability

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nobody files "Unavailable" as a time-off request any more. The type disappears from every request form. Contractors (and casual staff), who had no other type, get "My availability" wherever "Request time off" used to be. The server refuses a new `unavailable` request with a message that points at My availability, so an old phone says so in its existing error alert. Migration 631 carries every current `unavailable` request (approved or pending, not yet ended) into `staff_unavailability` as an all-day dated rule, keeps the days already gone as time off, and records every row it touched in a ledger so the move can be undone exactly. Leave balances, pay and manager notices do not move.

**Why:** AVAIL.1 (#1762/#1763) and AVAIL.2 (#1765) built self-declared availability: no approval, managers told. Until this PR the same fact ("I can't work 3–5 Oct") has two homes. Contractors file it as an `unavailable` time-off request that a manager must approve (all 39 such rows on prod were approved by hand), and it shows as a leave bar. The same person can also declare it in My availability, where it shows as grey shading and an "Unavailable" badge in the ranked picker. CANDIDATES.1 (#1766) and GRID.1 (#1768) already read both. This PR leaves one home.

**Architecture:** One forward migration (631) creates a service-role-only ledger `time_off_availability_moves`, a move function and a restore function, then calls the move function once for the Dublin business day of the apply. Code changes are small and share one rule in `shared/time-off.js` (`isRequestableTimeOffType`, `canRequestTimeOff`, the copy). The POST route refuses the type before it reads anything. The phone decisions live in `mobile/lib/leave-form.js` (no RN component test runner); the `.jsx` only renders them.

**Tech Stack:** Postgres plpgsql (SECURITY INVOKER, `search_path ''`, service_role only), PGlite replay test, Next.js 16 route, React client components (jsdom tests), Expo Router screens, Vitest.

**Size / ships:** S. **Mig 631** (applied AFTER the deploy, see DEPLOY ORDER). **OTA: yes** (`shared/time-off.js`, `mobile/lib/`, `mobile/components/`, `mobile/app/`). No native dependency, no `runtimeVersion` bump, no store build.

**Depends on:** 16 AVAIL.1a (#1762, mig 630 applied) and AVAIL.1b (#1763), 17 AVAIL.2 (#1765). All merged. Written against `origin/main` `28bbe7b1` (#1767). If main moves before the build, find each anchor by the quoted text, not the line number.

**Worktree:** `git fetch origin main && git worktree add ../un1t-crm-avail3 -b avail-3 origin/main`, then `npm ci`. Never `git stash`. Run single files with `npx vitest run <file>`; the whole suite and `npm run build` only at the PR gate (8GB machine).

---

### The data today (read-only Supabase MCP on `iyvtbjjxdggiadzwwvdj`, 25 Sep 2026, counts only)

| What | Count |
|---|---|
| `time_off_requests` rows of type `unavailable` | **39**, every one `approved`, every one reviewed by someone other than the requester, none recorded on behalf (`created_by` null), none with a cancel ask |
| people who filed them | 6, **all `employment_type = 'contractor'`**, all active, none tombstoned. There are 6 active contractors and 8 active employees (`fte`); no `casual` profiles exist |
| **past** (`end_date < today`) | 28 rows, 5 people. **They stay where they are.** |
| **started** (`start_date < today <= end_date`) | 2 rows, 1 person, the longer spans 29 days. **Split:** 10 elapsed person-days stay as time off, the rest moves |
| **future** (`start_date >= today`) | 9 rows, 4 people, the longest spans 19 days, the furthest ends 27 Dec (93 days ahead) |
| **the carry set** (started + future) | **11 rows, 5 people, 1 studio, 81 person-days carried** (one overlapping pair, so a few days are counted twice), 0 pending, 0 exact duplicates, longest reason 9 characters |
| `staff_unavailability` / `staff_availability_changes` | **0 / 0**: nobody has saved availability yet, so nothing can collide and no notice is owed |
| new `unavailable` requests in the last 7 days | 3, the newest this morning. **The count at apply time will differ: the migration computes its set live, and the pre-checks list it** |
| allowance rows / other-type rows | 1 `staff_allowances` row (a contractor's, the 20-day row mig 616's header left in place) / 31 rows of other types |
| triggers on `time_off_requests` | one: `trg_update_holiday_allowance AFTER UPDATE`, whose function acts on `NEW.type = 'holiday'` only (mig 616, `supabase/migrations/616_time_off_created_by_allowance_seed.sql:36-73`) |

---

### Decisions (each pinned by a test named in brackets)

1. **What moves: `type = 'unavailable'`, status `approved` OR `pending`, `end_date >= today` (Dublin), person not tombstoned.** Pending moves too: availability needs no approval (Richard's decision), so a declaration that was waiting for one is simply declared. Rejected and cancelled rows do not move (a manager said no, or the coach withdrew it). A tombstoned person's rows are left alone: the RPC refuses a tombstone anyway and nobody can roster them. `[move: moves future + pending, splits started, leaves the rest]`
2. **The past stays as history.** A row that ended before today is not touched, not copied, not relabelled. Past calendars, My leave and past reports read exactly what they read today. `[move: … leaves the rest]`, post-check (k)
3. **A started row is split at today.** The time-off row keeps `start_date..yesterday` (with `total_days` trimmed to the elapsed days); `today..end_date` becomes the availability rule. No day is shown twice and no elapsed day is rewritten. This matches AVAIL.1's own rule for a started availability rule (mig 630 keeps elapsed days as history). `[move: every carried day is covered, every elapsed day kept]`
4. **A future row is DELETED from `time_off_requests`, after its full row (`to_jsonb`) lands in the ledger.** Deleting is what makes every reader (the web calendar's leave bars, CANDIDATES.1's `on_leave`, GRID.1's leave cell, the phone Schedule tab, My leave, the approvals queue, reports) show the days exactly once with no reader changed. Rejected: setting `status = 'cancelled'` (My leave and the Time Off page would tell the coach their days were "Cancelled", and ten-plus readers would need a new filter); a new status value (a CHECK change plus every reader). Nothing references `time_off_requests(id)` (no FK in any migration: `git grep -E "REFERENCES (public\.)?time_off_requests" origin/main -- supabase/migrations` is empty), so a delete strands nothing. `[restore: restores every row byte-for-byte]`
5. **The rule:** `kind 'dated'`, all day, `start_date = greatest(start_date, today)`, `end_date` unchanged, note = the trimmed reason (blank → null). One rule per distinct (person, start, end); two identical requests make one rule; an identical all-day rule the coach already declared is reused, never duplicated. The carried set is exactly what `replace_staff_unavailability` would store, so the coach's first Save of an untouched editor is a no-op (`changed: false`), not a phantom "removed and re-added" notice. `[move: rules are dated, all day, today..end, note trimmed]`, `[move: a save of the same set is a no-op]`, `[move: duplicates collapse; an existing identical rule is reused]`
6. **No notice, no change row.** The move writes `staff_unavailability` directly and never calls the RPC, so it writes no `staff_availability_changes` row. The AVAIL.1a notice path (the route's immediate send and the checklist-sweep arm) only ever reads change rows with `notified_at IS NULL` (`src/lib/availability-notify.js:125-128, 289-308`), so nobody is pushed. The ledger is the audit ("where did this rule come from"). `[move: no notice, no change row, no allowance change]`, post-check (k)
7. **Leave balances and pay cannot move.** The only trigger is `AFTER UPDATE` and both of its branches start with `NEW.type = 'holiday'`; the split UPDATE touches `unavailable` rows only, and a DELETE fires nothing. The PGlite test installs the REAL mig 616 function and a contractor allowance row and proves `staff_allowances` byte-identical after a move and after a restore. Payroll and contractor invoices do not read time off (`git grep -n -i "time_off\|leave" origin/main -- src/lib/payroll.js src/lib/contractor-invoices.js` is empty). `[move: no notice, no change row, no allowance change]`, pre/post fingerprint (e)/(k)
8. **Guards abort the whole move** (nothing half-moved): an open cancellation ask on a carry row (`avail3_open_cancel_ask`: the coach asked to cancel it, an owner has not decided, so the operator decides first); a note over 200 characters (`avail3_note_too_long`, mig 630's CHECK; never silently truncated); a rule starting more than 730 days ahead (`avail3_too_far_ahead`, `AVAILABILITY_LIMITS.aheadDays`: the coach's next save would be refused); more than 60 current dated rules for one person (`avail3_too_many_dates`, `AVAILABILITY_LIMITS.dated`: same reason). All four are 0 today. `[guards]`
9. **Idempotent and re-runnable.** A second call finds nothing (moved rows are gone, split rows now end yesterday, the ledger's primary key is the request id). The function stays after the migration so a straggler can be carried by one `SELECT` (see DEPLOY ORDER step 3). `[move: idempotent]`
10. **The type is no longer offered to anyone.** Only contractors and casual staff were ever offered it (`shared/time-off.js:18-30`); employees keep holiday, sick, unpaid and other. With nothing left to request, a contractor's "Request time off" becomes "My availability": the phone's floating button and Today shortcut, the web "My roster" button, and the web Time Off page's header button for anyone who is not an approver. A form reached anyway (an old link, a notification, a stale tab) shows "Use My availability instead" with a button to it, not an empty type list. `[shared: …]`, `[leave-form: leaveRequestEntry / leaveFormGate]`, `[RequestTimeOffModal]`, `[MonthRoster]`, `[TimeOffManager]`
11. **An old phone that still offers the type: the server REFUSES, with words that say where to go.** `POST /api/schedule/time-off` answers 400 `UNAVAILABLE_MOVED_ERROR` for `type: 'unavailable'` from anyone (own or on behalf), before any read. The old phone already shows the server's `error` in its "Couldn't submit" alert (`mobile/app/(staff)/schedule/time-off-new.jsx:161-163`), and the old web modal shows it inline. Rejected: accept and convert. It would be a second writer to `staff_unavailability` outside the RPC (a read-modify-write of the whole set, racing the coach's own editor), it would owe the managers a notice from a new path, and the old phone would then show "Request sent · Your manager has been notified. Track it under My leave" (`mobile/lib/leave-form.js:160-167`), which would be false twice. Six contractors are affected and the window closes at their second app launch after the OTA. `[POST: 400 for unavailable]`
12. **History keeps its label.** `TIME_OFF_TYPES`, the leave labels, the calendars' amber "Unavailable" style, the report buckets, the DB CHECK (mig 283) and `timeOffTypeSchema` all keep `unavailable`. Taking it out of the Zod enum would turn the refusal in decision 11 into a bare "Invalid request body". `[shared: history keeps its label]`
13. **Deciding a pending `unavailable` request still works** between the deploy and the migration (minutes): `isTimeOffTypeAllowedFor` is unchanged (it is the employment gate for decisions on existing rows). Its contractor message is reworded because it told managers to "ask them to file it as Unavailable", which is no longer possible. `[shared: history keeps its label]`, `[PUT: contractor holiday message]`
14. **DEPLOY ORDER: code first, then the migration.** No code reads the ledger or calls the functions, so the code works with or without 631. Applying after the deploy means the door that creates `unavailable` requests is shut before the move runs, so nothing is filed behind it. (The function is re-runnable, so the other order is recoverable, not wrong.)
15. **Per person, not per studio** (index default 1). A request filed at one studio becomes availability at every studio the contractor belongs to. Today every contractor belongs to exactly one studio (6 contractors, 6 `profile_locations` rows), so nothing changes in effect.

---

### File map

| File | Change | OTA path |
|---|---|---|
| `supabase/migrations/631_unavailable_time_off_to_availability.sql` (create) | ledger table, move + restore functions, the move, self-check | no |
| `tests/migration-631-unavailable-time-off-to-availability.test.js` (create) | PGlite replay (real 616 + 630 + 631) | no |
| `shared/time-off.js` (modify: header comment lines 1-8; after line 21; lines 27-34; comment 40-44; lines 53-54) | `NON_REQUESTABLE_TYPES`, `isRequestableTimeOffType`, `canRequestTimeOff`, `UNAVAILABLE_MOVED_ERROR`, `AVAILABILITY_INSTEAD`, reworded `RESTRICTED_TYPE_ERROR`, `CONTRACTOR_DECIDE_ERROR` | **yes** |
| `shared/time-off.test.js` (modify: imports lines 2-6, lines 19-24, add a describe) | | **yes** (test-only) |
| `src/app/api/schedule/time-off/route.js` (modify: imports lines 20-22; after line 267) | refuse `unavailable` | no |
| `src/app/api/schedule/time-off/route.test.js` (modify: lines 526-540; add a describe) | | no |
| `src/app/api/schedule/time-off/[id]/route.js` (modify: import line 13; lines 223-227) | shared contractor message | no |
| `src/app/api/schedule/time-off/[id]/route.test.js` (modify: line 318) | message pinned | no |
| `src/lib/openapi.js` (modify: lines 4718, 4722, 4736) | descriptions | no |
| `mobile/lib/leave-form.js` (modify: import line 18; lines 183-194; append) | `leaveRequestEntry`, `leaveFormGate`, `leaveFloatingButtons({ employmentType })` | **yes** |
| `mobile/lib/leave-form.test.js` (modify: import lines 4-7; lines 224-229; add describes) | | **yes** (test-only) |
| `mobile/components/LeaveFloatingButtons.jsx` (modify) | entry label, icon, target | **yes** |
| `mobile/app/(staff)/(tabs)/schedule.jsx` (modify: lines 769-772) | pass `employmentType`, push the target | **yes** |
| `mobile/components/dashboard/PersonalDashboard.jsx` (modify: import after line 31; lines 772-783) | Today shortcut | **yes** |
| `mobile/app/(staff)/schedule/time-off-new.jsx` (modify: header comment; imports lines 27-30; line 36) | gate before the form | **yes** |
| `src/components/dashboard/RequestTimeOffModal.jsx` (modify: line 12; before line 81) | notice instead of a form | no |
| `src/components/dashboard/RequestTimeOffModal.test.jsx` (create) | | no |
| `src/components/dashboard/MonthRoster.jsx` (modify: imports lines 29, 35; button lines 601-608) | "My availability" link for contractors | no |
| `src/components/dashboard/MonthRoster.availability.test.jsx` (create) | | no |
| `src/components/TimeOffManager.jsx` (modify: imports lines 3-8; header button 309-315; form 766-770, 813, 874-981) | link for contractors; notice in the form | no |
| `src/components/TimeOffManager.leave.test.jsx` (modify: tests at lines 108-117 and 131-133) | | no |
| `docs/CHANGELOG.md` | one row after `gh pr create` | no |

**Not touched, on purpose:** `timeOffTypeSchema` (decision 12); `isTimeOffTypeAllowedFor` (decision 13); the report generator, `ScheduleCalendar.jsx`'s leave `TYPE` map (line 110), `TimeOffManager`'s `TYPE_CONFIG`, `roster-card-model.js`'s `LEAVE_SPECIFICITY` (line 302), `swap-lifecycle.js`'s label (line 466): all render history; `mobile/app/(staff)/schedule/my-leave.jsx` (it lists the coach's own requests, past Unavailable ones included, which is right); the approvals providers (a pending `unavailable` row simply stops existing); `shared/availability.js`, the availability route, RPC and notice path (read only). No new top-level entry under `mobile/`, so `check:ota-paths` needs no decision.

---

### DEPLOY ORDER (the operator: me, under the standing merge authority)

1. **Merge.** Vercel deploys the refusal and the forms; `eas-update.yml` publishes the OTA. Wait for the prod deployment of the merge commit to be READY and the EAS Update run to be green. One phone update at a time: do not merge another OTA PR until this run is green.
2. **Apply mig 631** via Supabase MCP `apply_migration` on **un1t-crm** (`iyvtbjjxdggiadzwwvdj`; confirm with `list_projects`, never the sentinel project), the same hour: pre-checks (a)–(h) first, output saved to the scratchpad as `mig631-rollback-2026-09-2x.txt` (it holds the carry set and the fingerprints the rollback is judged against), then apply, then post-checks (i)–(q), then `get_advisors` security AND performance.
3. **If 631 went on before the deploy** (or anything was filed during the gap): re-run the move for the stragglers, then post-check (j) again:
   ```sql
   SELECT public.move_unavailable_time_off_to_availability((now() AT TIME ZONE 'Europe/Dublin')::date);
   ```
4. **Rollback** (data): `SELECT public.restore_moved_unavailable_time_off();` puts every moved row back byte-for-byte, re-extends every split row, and removes each carried rule the coach has not changed since (a changed one is left alone and reported as `restored_rule_changed`). Then compare fingerprint `all_unavailable_fp` with the pre-check value. Revert the code in the same hour if the forms should offer the type again. The ledger and the two functions stay (history); a later forward migration may drop them.
5. Do not apply it within 15 minutes of Dublin midnight: "today" is taken once, from the instant of the apply.

---

### Task 0: Preconditions (no commit)

- [ ] **Step 1: The dependencies are merged and live**

```bash
git fetch origin main && git log origin/main --oneline | grep -m3 -E 'AVAIL\.(1a|1b|2)'
git ls-tree --name-only origin/main supabase/migrations/ | grep -E '/63[01]_'
```

Expected: the three merge commits (#1762, #1763, #1765); `630_staff_availability.sql` present and no `631_` file. With Supabase MCP `list_migrations` on `iyvtbjjxdggiadzwwvdj`: `630_staff_availability` is applied and nothing called `631_*` exists. Stop if any differs.

- [ ] **Step 2: The anchors this plan edits are where it says**

```bash
grep -n "const RESTRICTED_VALUES = \['unavailable'\]" shared/time-off.js
grep -n "export const RESTRICTED_TYPE_ERROR" shared/time-off.js
grep -n "const { type, start_date, end_date, reason, location_id, profile_id } = validation.data" src/app/api/schedule/time-off/route.js
grep -n "ask them to file it as Unavailable" 'src/app/api/schedule/time-off/[id]/route.js'
grep -n "onRequest={() => router.push('/schedule/time-off-new')}" 'mobile/app/(staff)/(tabs)/schedule.jsx'
grep -n "router.push('/schedule/time-off-new')" mobile/components/dashboard/PersonalDashboard.jsx
grep -n "export default function TimeOffNew" 'mobile/app/(staff)/schedule/time-off-new.jsx'
grep -n "export function leaveFloatingButtons" mobile/lib/leave-form.js
```

Expected: one line each. If main moved, re-find by the quoted text.

- [ ] **Step 3: Re-run the carry-set count (read-only), and note it for the PR body**

```sql
WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d)
SELECT r.status,
       CASE WHEN r.start_date < t.d THEN 'split' ELSE 'moved' END AS action,
       count(*) AS n, count(DISTINCT r.profile_id) AS people
  FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id, t
 WHERE r.type = 'unavailable' AND r.status IN ('approved', 'pending')
   AND r.end_date >= t.d AND p.deleted_at IS NULL
 GROUP BY 1, 2 ORDER BY 1, 2;
```

Expected on 25 Sep: approved/moved 9 (4 people), approved/split 2 (1 person). Any other shape is fine (the migration computes it live), but say it in the PR.

---

### Task 1: Migration 631 and its PGlite replay

**Files:**
- Create: `supabase/migrations/631_unavailable_time_off_to_availability.sql`
- Create: `tests/migration-631-unavailable-time-off-to-availability.test.js`

- [ ] **Step 1: Write the failing PGlite test**

Same approach as `tests/migration-630-staff-availability.test.js` and `tests/migration-624-time-off-cancel-request.test.js`: boot PGlite, recreate the minimum prod shape, apply the REAL 616, 630 and 631 files, then call the functions with a fixed `today`. Every test runs inside `BEGIN … ROLLBACK`, so each starts from the same seed. (`db.exec` below is PGlite's in-process multi-statement SQL runner, as in the 630 test; nothing here spawns a process.)

A statement that raises inside a transaction aborts it, so a helper that does `SET ROLE … RESET ROLE` in a `finally` would lose the real error. The guard tests therefore go through `expectRaise`, which wraps the call in a savepoint.

```js
// AVAIL.3 — behavioural test for migration 631: contractors' "unavailable"
// time off moves into staff availability.
//
// Boots PGlite, recreates time_off_requests / staff_allowances /
// profile_compensation / profiles / cron_heartbeats in their prod shape,
// installs the REAL mig 616 allowance trigger function, the REAL mig 630
// availability tables + RPC, and the REAL mig 631 file, then drives
// move_unavailable_time_off_to_availability(today) and
// restore_moved_unavailable_time_off() with a FIXED today. Proves: exactly the
// right rows move, the past and every other type are untouched byte-for-byte,
// a started row is split with no day lost or doubled, nothing is notified,
// allowances cannot move, the guards abort everything, the move is idempotent,
// and the restore brings back the exact rows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const read = (name) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', name), 'utf8')
const MIG_616 = read('616_time_off_created_by_allowance_seed.sql')
const MIG_630 = read('630_staff_availability.sql')
const MIG_631 = read('631_unavailable_time_off_to_availability.sql')

const TODAY = '2026-09-25'
const MOVE_SQL = 'SELECT public.move_unavailable_time_off_to_availability($1::date) AS r'
const LOC = 'a0000000-0000-0000-0000-00000000000a'
const CON_A = '10000000-0000-0000-0000-00000000000a' // contractor
const CON_B = '10000000-0000-0000-0000-00000000000b' // contractor
const CON_C = '10000000-0000-0000-0000-00000000000c' // contractor
const FTE = '10000000-0000-0000-0000-00000000000f'   // employee
const GONE = '10000000-0000-0000-0000-0000000000ee'  // tombstoned contractor
const OWNER = '10000000-0000-0000-0000-0000000000aa'

const R = {
  FUTURE: '20000000-0000-0000-0000-000000000001',    // CON_A approved 3-5 Oct, reason ' Wedding '
  STARTED: '20000000-0000-0000-0000-000000000002',   // CON_A approved 20-30 Sep, reason 'Away'
  PAST: '20000000-0000-0000-0000-000000000003',      // CON_A approved 1-2 Sep
  PENDING: '20000000-0000-0000-0000-000000000004',   // CON_B pending 10 Oct, blank reason
  REJECTED: '20000000-0000-0000-0000-000000000005',  // CON_B rejected 12 Oct
  CANCELLED: '20000000-0000-0000-0000-000000000006', // CON_B cancelled 14 Oct
  HOLIDAY: '20000000-0000-0000-0000-000000000007',   // FTE approved holiday 6-8 Oct
  TOMB: '20000000-0000-0000-0000-000000000008',      // GONE approved 20-21 Oct
}

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  -- Supabase's default privileges: the migration must take the browser's away.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, employment_type text, deleted_at timestamptz);
  CREATE TABLE public.profile_compensation (profile_id uuid PRIMARY KEY REFERENCES public.profiles(id), annual_leave_entitlement numeric);
  CREATE TABLE public.cron_heartbeats (
    name text PRIMARY KEY, last_ok_at timestamptz, expected_interval_seconds int, grace_seconds int, notes text
  );
  CREATE TABLE public.staff_allowances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    year int NOT NULL,
    total_days numeric(5,1) NOT NULL DEFAULT 20,
    used_days numeric(5,1) NOT NULL DEFAULT 0,
    carried_over numeric(5,1) NOT NULL DEFAULT 0,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    UNIQUE (profile_id, year)
  );
  -- mig 011 with mig 283's widened type CHECK.
  CREATE TABLE public.time_off_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type = ANY (ARRAY['holiday','sick','unpaid','other','unavailable'])),
    start_date date NOT NULL, end_date date NOT NULL,
    total_days numeric(5,1) NOT NULL DEFAULT 1,
    reason text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
    reviewed_by uuid REFERENCES public.profiles(id), reviewed_at timestamptz, review_note text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    CONSTRAINT valid_date_range CHECK (end_date >= start_date)
  );
  CREATE FUNCTION public.update_holiday_allowance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  CREATE TRIGGER trg_update_holiday_allowance AFTER UPDATE ON public.time_off_requests
    FOR EACH ROW EXECUTE FUNCTION public.update_holiday_allowance();
`

// mig 624's seven columns, in prod's column order (after 616's created_by).
const CANCEL_COLUMNS = `
  ALTER TABLE public.time_off_requests
    ADD COLUMN cancel_requested_at timestamptz,
    ADD COLUMN cancel_requested_by uuid REFERENCES public.profiles(id),
    ADD COLUMN cancel_request_note text,
    ADD COLUMN cancel_decided_at timestamptz,
    ADD COLUMN cancel_decided_by uuid REFERENCES public.profiles(id),
    ADD COLUMN cancel_decision text CHECK (cancel_decision IN ('approved', 'rejected')),
    ADD COLUMN cancel_decision_note text;
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}');
  INSERT INTO public.profiles (id, full_name, employment_type, deleted_at) VALUES
    ('${CON_A}', 'Contractor A', 'contractor', NULL), ('${CON_B}', 'Contractor B', 'contractor', NULL),
    ('${CON_C}', 'Contractor C', 'contractor', NULL), ('${FTE}', 'Employee F', 'fte', NULL),
    ('${GONE}', 'Gone G', 'contractor', '2026-09-01T00:00:00Z'), ('${OWNER}', 'Owner O', 'fte', NULL);
  -- Prod has one contractor allowance row (mig 616 header); it must not move.
  INSERT INTO public.staff_allowances (profile_id, year, total_days, used_days) VALUES
    ('${CON_A}', 2026, 20, 0), ('${FTE}', 2026, 20, 3);
  INSERT INTO public.time_off_requests
    (id, profile_id, location_id, type, start_date, end_date, total_days, reason, status, reviewed_by, reviewed_at, created_at, updated_at) VALUES
    ('${R.FUTURE}',    '${CON_A}', '${LOC}', 'unavailable', '2026-10-03', '2026-10-05', 3,  ' Wedding ', 'approved',  '${OWNER}', '2026-09-10T09:00:00Z', '2026-09-09T09:00:00Z', '2026-09-10T09:00:00Z'),
    ('${R.STARTED}',   '${CON_A}', '${LOC}', 'unavailable', '2026-09-20', '2026-09-30', 11, 'Away',      'approved',  '${OWNER}', '2026-09-11T09:00:00Z', '2026-09-10T09:00:00Z', '2026-09-11T09:00:00Z'),
    ('${R.PAST}',      '${CON_A}', '${LOC}', 'unavailable', '2026-09-01', '2026-09-02', 2,  NULL,        'approved',  '${OWNER}', '2026-08-20T09:00:00Z', '2026-08-19T09:00:00Z', '2026-08-20T09:00:00Z'),
    ('${R.PENDING}',   '${CON_B}', '${LOC}', 'unavailable', '2026-10-10', '2026-10-10', 1,  '',          'pending',   NULL,       NULL,                   '2026-09-24T09:00:00Z', '2026-09-24T09:00:00Z'),
    ('${R.REJECTED}',  '${CON_B}', '${LOC}', 'unavailable', '2026-10-12', '2026-10-12', 1,  NULL,        'rejected',  '${OWNER}', '2026-09-20T09:00:00Z', '2026-09-19T09:00:00Z', '2026-09-20T09:00:00Z'),
    ('${R.CANCELLED}', '${CON_B}', '${LOC}', 'unavailable', '2026-10-14', '2026-10-14', 1,  NULL,        'cancelled', NULL,       NULL,                   '2026-09-19T09:00:00Z', '2026-09-20T09:00:00Z'),
    ('${R.HOLIDAY}',   '${FTE}',   '${LOC}', 'holiday',     '2026-10-06', '2026-10-08', 3,  NULL,        'approved',  '${OWNER}', '2026-09-15T09:00:00Z', '2026-09-14T09:00:00Z', '2026-09-15T09:00:00Z'),
    ('${R.TOMB}',      '${GONE}',  '${LOC}', 'unavailable', '2026-10-20', '2026-10-21', 2,  NULL,        'approved',  '${OWNER}', '2026-08-25T09:00:00Z', '2026-08-24T09:00:00Z', '2026-08-25T09:00:00Z');
`

let db
const runSql = (text) => db.exec(text)
const q = async (sql, params = []) => (await db.query(sql, params)).rows

// Outside a transaction only (grants tests, and the happy-path calls inside
// inTx that are expected to succeed).
async function asRole(role, sql, params = []) {
  await runSql(`SET ROLE ${role}`)
  try { return await db.query(sql, params) } finally { await runSql('RESET ROLE') }
}

const move = async (today = TODAY) => (await asRole('service_role', MOVE_SQL, [today])).rows[0].r
const restore = async () =>
  (await asRole('service_role', 'SELECT public.restore_moved_unavailable_time_off() AS r')).rows[0].r

/** Each test starts from SEED and leaves nothing behind. */
async function inTx(fn) {
  await runSql('BEGIN')
  try {
    await runSql(SEED)
    await fn()
  } finally {
    await runSql('ROLLBACK')
  }
}

/**
 * Inside inTx: run `sql` as service_role, expect it to raise `re`, then undo
 * just that statement (ROLLBACK TO SAVEPOINT also undoes the SET ROLE) so the
 * test can keep reading.
 */
async function expectRaise(sql, params, re) {
  await runSql('SAVEPOINT before_raise')
  await runSql('SET ROLE service_role')
  let error = null
  try { await db.query(sql, params) } catch (e) { error = e }
  await runSql('ROLLBACK TO SAVEPOINT before_raise')
  await runSql('RESET ROLE')
  expect(error?.message).toMatch(re)
}

const rowJson = async (id) => (await q('SELECT to_jsonb(r) AS j FROM public.time_off_requests r WHERE id = $1', [id]))[0]?.j ?? null
const allTimeOff = async () => q('SELECT to_jsonb(r) AS j FROM public.time_off_requests r ORDER BY id')
const allowances = async () => q('SELECT to_jsonb(s) AS j FROM public.staff_allowances s ORDER BY id')
const rulesOf = async (profileId) => q(
  `SELECT kind, start_date::text, end_date::text, all_day, start_time, end_time, note
     FROM public.staff_unavailability WHERE profile_id = $1 ORDER BY start_date, end_date`, [profileId])

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIG_616)
  await runSql(CANCEL_COLUMNS)
  await runSql(MIG_630)
  await runSql(MIG_631) // no unavailable rows exist yet: its own move is a no-op here
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 631 — grants and posture', () => {
  it('the browser roles hold nothing on the ledger and cannot run either function', async () => {
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(role, 'SELECT 1 FROM public.time_off_availability_moves')).rejects.toThrow(/permission denied/)
      await expect(asRole(role, `SELECT public.move_unavailable_time_off_to_availability('${TODAY}')`)).rejects.toThrow(/permission denied/)
      await expect(asRole(role, 'SELECT public.restore_moved_unavailable_time_off()')).rejects.toThrow(/permission denied/)
    }
  })

  it('RLS is on and there are no policies on the ledger', async () => {
    expect(await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.time_off_availability_moves'::regclass`))
      .toEqual([{ relrowsecurity: true }])
    expect(await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'time_off_availability_moves'`))
      .toEqual([{ n: 0 }])
  })
})

describe('migration 631 — the move', () => {
  it('moves future + pending, splits started, leaves the rest byte-for-byte', () => inTx(async () => {
    const untouched = {}
    for (const k of ['PAST', 'REJECTED', 'CANCELLED', 'HOLIDAY', 'TOMB']) untouched[k] = await rowJson(R[k])

    const r = await move()
    expect(r).toMatchObject({ moved: 2, split: 1, rules_inserted: 3, rules_reused: 0, people: 2 })

    expect(await rowJson(R.FUTURE)).toBeNull()
    expect(await rowJson(R.PENDING)).toBeNull()
    expect(await rowJson(R.STARTED)).toMatchObject({
      start_date: '2026-09-20', end_date: '2026-09-24', total_days: 5, status: 'approved', type: 'unavailable',
    })
    for (const k of Object.keys(untouched)) expect(await rowJson(R[k])).toEqual(untouched[k])
  }))

  it('rules are dated, all day, today..end, note trimmed (blank is null)', () => inTx(async () => {
    await move()
    expect(await rulesOf(CON_A)).toEqual([
      { kind: 'dated', start_date: '2026-09-25', end_date: '2026-09-30', all_day: true, start_time: null, end_time: null, note: 'Away' },
      { kind: 'dated', start_date: '2026-10-03', end_date: '2026-10-05', all_day: true, start_time: null, end_time: null, note: 'Wedding' },
    ])
    expect(await rulesOf(CON_B)).toEqual([
      { kind: 'dated', start_date: '2026-10-10', end_date: '2026-10-10', all_day: true, start_time: null, end_time: null, note: null },
    ])
    expect(await rulesOf(GONE)).toEqual([])
  }))

  it('the ledger holds the FULL original row of everything it touched', () => inTx(async () => {
    const before = { FUTURE: await rowJson(R.FUTURE), STARTED: await rowJson(R.STARTED), PENDING: await rowJson(R.PENDING) }
    await move()
    const ledger = await q(`SELECT time_off_request_id AS id, action, original, rule_inserted, moved_today::text
                              FROM public.time_off_availability_moves ORDER BY time_off_request_id`)
    expect(ledger).toEqual([
      { id: R.FUTURE, action: 'moved', original: before.FUTURE, rule_inserted: true, moved_today: TODAY },
      { id: R.STARTED, action: 'split', original: before.STARTED, rule_inserted: true, moved_today: TODAY },
      { id: R.PENDING, action: 'moved', original: before.PENDING, rule_inserted: true, moved_today: TODAY },
    ])
  }))

  it('no notice, no change row, no allowance change (the REAL mig 616 trigger ran on the split)', () => inTx(async () => {
    const allowancesBefore = await allowances()
    await move()
    expect(await q('SELECT count(*)::int AS n FROM public.staff_availability_changes')).toEqual([{ n: 0 }])
    expect(await allowances()).toEqual(allowancesBefore)
  }))

  it('a save of the same set through the AVAIL.1 RPC is a no-op (the carried rules are canonical)', () => inTx(async () => {
    await move()
    const dated = [
      { start_date: '2026-09-25', end_date: '2026-09-30', all_day: true, note: 'Away' },
      { start_date: '2026-10-03', end_date: '2026-10-05', all_day: true, note: 'Wedding' },
    ]
    const { rows } = await asRole('service_role',
      'SELECT public.replace_staff_unavailability($1, $1, $2::date, $3::jsonb, $4::jsonb) AS r',
      [CON_A, TODAY, '[]', JSON.stringify(dated)])
    expect(rows[0].r).toMatchObject({ changed: false, change_id: null })
  }))

  it('every carried day is covered, every elapsed day kept, and no day is in both', () => inTx(async () => {
    await move()
    const lost = await q(`
      SELECT m.profile_id, g.d::date::text AS day
        FROM public.time_off_availability_moves m,
             generate_series(greatest((m.original->>'start_date')::date, m.moved_today),
                             (m.original->>'end_date')::date, interval '1 day') g(d)
       WHERE NOT EXISTS (SELECT 1 FROM public.staff_unavailability u
                          WHERE u.profile_id = m.profile_id AND u.kind = 'dated' AND u.all_day
                            AND g.d::date BETWEEN u.start_date AND u.end_date)`)
    expect(lost).toEqual([])
    const doubled = await q(`
      SELECT r.id FROM public.time_off_requests r
        JOIN public.staff_unavailability u ON u.profile_id = r.profile_id AND u.kind = 'dated'
                                          AND u.start_date <= r.end_date AND r.start_date <= u.end_date
       WHERE r.type = 'unavailable' AND r.status IN ('approved', 'pending')`)
    expect(doubled).toEqual([])
    expect(await q(`SELECT start_date::text, end_date::text FROM public.time_off_requests WHERE id = $1`, [R.STARTED]))
      .toEqual([{ start_date: '2026-09-20', end_date: '2026-09-24' }])
  }))

  it('is idempotent: a second run finds nothing and changes nothing', () => inTx(async () => {
    await move()
    const timeOff = await allTimeOff()
    const rules = await q('SELECT to_jsonb(u) AS j FROM public.staff_unavailability u ORDER BY id')
    expect(await move()).toMatchObject({ moved: 0, split: 0, rules_inserted: 0, people: 0 })
    expect(await allTimeOff()).toEqual(timeOff)
    expect(await q('SELECT to_jsonb(u) AS j FROM public.staff_unavailability u ORDER BY id')).toEqual(rules)
    expect(await q('SELECT count(*)::int AS n FROM public.time_off_availability_moves')).toEqual([{ n: 3 }])
  }))

  it('duplicates collapse; an identical rule the coach already declared is reused', () => inTx(async () => {
    await runSql(`
      INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, total_days, reason, status, created_at)
      VALUES ('${CON_C}', '${LOC}', 'unavailable', '2026-10-15', '2026-10-16', 2, 'first',  'approved', '2026-09-01T00:00:00Z'),
             ('${CON_C}', '${LOC}', 'unavailable', '2026-10-15', '2026-10-16', 2, 'second', 'approved', '2026-09-02T00:00:00Z');
      INSERT INTO public.staff_unavailability (profile_id, kind, start_date, end_date, all_day, note)
      VALUES ('${CON_B}', 'dated', '2026-10-10', '2026-10-10', true, 'said it myself');`)
    expect(await move()).toMatchObject({ moved: 4, split: 1, rules_inserted: 3, rules_reused: 2, people: 3 })
    // One rule for the pair, carrying the EARLIER request's note; the other note stays in the ledger.
    expect(await rulesOf(CON_C)).toEqual([
      { kind: 'dated', start_date: '2026-10-15', end_date: '2026-10-16', all_day: true, start_time: null, end_time: null, note: 'first' },
    ])
    // The coach's own rule is kept as they wrote it, and not duplicated.
    expect(await rulesOf(CON_B)).toEqual([
      { kind: 'dated', start_date: '2026-10-10', end_date: '2026-10-10', all_day: true, start_time: null, end_time: null, note: 'said it myself' },
    ])
    expect(await q(`SELECT rule_inserted FROM public.time_off_availability_moves WHERE time_off_request_id = $1`, [R.PENDING]))
      .toEqual([{ rule_inserted: false }])
  }))

  it('an overlapping pair (different ranges) keeps both rules', () => inTx(async () => {
    await runSql(`
      INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, total_days, status)
      VALUES ('${CON_C}', '${LOC}', 'unavailable', '2026-11-01', '2026-11-05', 5, 'approved'),
             ('${CON_C}', '${LOC}', 'unavailable', '2026-11-04', '2026-11-08', 5, 'approved');`)
    await move()
    expect((await rulesOf(CON_C)).map((x) => [x.start_date, x.end_date]))
      .toEqual([['2026-11-01', '2026-11-05'], ['2026-11-04', '2026-11-08']])
  }))
})

describe('migration 631 — guards abort the whole move', () => {
  const nothingMoved = async () => {
    expect(await q('SELECT count(*)::int AS n FROM public.time_off_availability_moves')).toEqual([{ n: 0 }])
    expect(await q('SELECT count(*)::int AS n FROM public.staff_unavailability')).toEqual([{ n: 0 }])
    expect(await rowJson(R.FUTURE)).not.toBeNull()
    expect((await rowJson(R.STARTED)).end_date).toBe('2026-09-30')
  }

  it('an open cancellation ask', () => inTx(async () => {
    await runSql(`UPDATE public.time_off_requests SET cancel_requested_at = now(), cancel_requested_by = '${CON_A}' WHERE id = '${R.FUTURE}'`)
    await expectRaise(MOVE_SQL, [TODAY], /avail3_open_cancel_ask/)
    await nothingMoved()
  }))

  it('a decided ask is not open: the row moves', () => inTx(async () => {
    await runSql(`UPDATE public.time_off_requests
                     SET cancel_requested_at = now(), cancel_requested_by = '${CON_A}',
                         cancel_decided_at = now(), cancel_decided_by = '${OWNER}', cancel_decision = 'rejected'
                   WHERE id = '${R.FUTURE}'`)
    expect(await move()).toMatchObject({ moved: 2 })
  }))

  it('a note over 200 characters (never truncated)', () => inTx(async () => {
    await runSql(`UPDATE public.time_off_requests SET reason = repeat('x', 201) WHERE id = '${R.FUTURE}'`)
    await expectRaise(MOVE_SQL, [TODAY], /avail3_note_too_long/)
    await nothingMoved()
  }))

  it('a date more than two years ahead', () => inTx(async () => {
    await runSql(`INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, total_days, status)
                  VALUES ('${CON_C}', '${LOC}', 'unavailable', '2028-09-26', '2028-09-26', 1, 'approved')`)
    await expectRaise(MOVE_SQL, [TODAY], /avail3_too_far_ahead/)
    await nothingMoved()
  }))

  it('more than 60 current dated rules for one person', () => inTx(async () => {
    // 59 existing one-day rules + CON_A's 2 carried = 61.
    await runSql(`INSERT INTO public.staff_unavailability (profile_id, kind, start_date, end_date, all_day)
                  SELECT '${CON_A}', 'dated', d, d, true
                    FROM generate_series('2026-11-01'::date, '2026-12-29'::date, interval '1 day') g(d)`)
    await expectRaise(MOVE_SQL, [TODAY], /avail3_too_many_dates/)
    expect(await q('SELECT count(*)::int AS n FROM public.time_off_availability_moves')).toEqual([{ n: 0 }])
    expect(await rowJson(R.FUTURE)).not.toBeNull()
  }))

  it('no today', () => inTx(async () => {
    await expectRaise('SELECT public.move_unavailable_time_off_to_availability(NULL)', [], /avail3_bad_args/)
  }))
})

describe('migration 631 — restore', () => {
  it('restores every row byte-for-byte and removes the carried rules', () => inTx(async () => {
    const timeOff = await allTimeOff()
    const allowancesBefore = await allowances()
    await move()
    expect(await restore()).toMatchObject({ restored: 3, rules_removed: 3, rules_changed_since: 0 })
    expect(await allTimeOff()).toEqual(timeOff)
    expect(await allowances()).toEqual(allowancesBefore)
    expect(await q('SELECT count(*)::int AS n FROM public.staff_unavailability')).toEqual([{ n: 0 }])
    expect(await q('SELECT DISTINCT restore_outcome FROM public.time_off_availability_moves'))
      .toEqual([{ restore_outcome: 'restored' }])
  }))

  it('leaves a rule the coach has changed since, and reports it', () => inTx(async () => {
    await move()
    await runSql(`UPDATE public.staff_unavailability SET note = 'my own words'
                   WHERE profile_id = '${CON_A}' AND start_date = '2026-10-03'`)
    expect(await restore()).toMatchObject({ restored: 3, rules_removed: 2, rules_changed_since: 1 })
    expect(await rowJson(R.FUTURE)).not.toBeNull()
    expect((await rulesOf(CON_A)).map((x) => x.note)).toEqual(['my own words'])
    expect(await q('SELECT restore_outcome FROM public.time_off_availability_moves WHERE time_off_request_id = $1', [R.FUTURE]))
      .toEqual([{ restore_outcome: 'restored_rule_changed' }])
  }))

  it('is idempotent', () => inTx(async () => {
    await move()
    await restore()
    const timeOff = await allTimeOff()
    expect(await restore()).toMatchObject({ restored: 0, rules_removed: 0, rules_changed_since: 0 })
    expect(await allTimeOff()).toEqual(timeOff)
  }))

  it('a restored row is not moved again by a later run (the ledger remembers it)', () => inTx(async () => {
    await move()
    await restore()
    expect(await move()).toMatchObject({ moved: 0, split: 0 })
  }))
})

describe('migration 631 — applying the file moves what is there at apply time', () => {
  it('carries a future row and splits a started one, relative to the Dublin day of the apply', async () => {
    const fresh = new PGlite()
    try {
      await fresh.exec(BASE_SCHEMA)
      await fresh.exec(MIG_616)
      await fresh.exec(CANCEL_COLUMNS)
      await fresh.exec(MIG_630)
      await fresh.exec(`
        INSERT INTO public.locations VALUES ('${LOC}');
        INSERT INTO public.profiles (id, full_name, employment_type) VALUES ('${CON_A}', 'Contractor A', 'contractor');
        INSERT INTO public.time_off_requests (id, profile_id, location_id, type, start_date, end_date, total_days, status) VALUES
          ('${R.FUTURE}',  '${CON_A}', '${LOC}', 'unavailable',
             (now() AT TIME ZONE 'Europe/Dublin')::date + 10, (now() AT TIME ZONE 'Europe/Dublin')::date + 12, 3, 'approved'),
          ('${R.STARTED}', '${CON_A}', '${LOC}', 'unavailable',
             (now() AT TIME ZONE 'Europe/Dublin')::date - 3,  (now() AT TIME ZONE 'Europe/Dublin')::date + 3,  7, 'approved');`)
      await fresh.exec(MIG_631)
      expect((await fresh.query('SELECT action FROM public.time_off_availability_moves ORDER BY action')).rows)
        .toEqual([{ action: 'moved' }, { action: 'split' }])
      const left = (await fresh.query(`
        SELECT id, end_date = (now() AT TIME ZONE 'Europe/Dublin')::date - 1 AS ends_yesterday, total_days::float8 AS total_days
          FROM public.time_off_requests`)).rows
      expect(left).toEqual([{ id: R.STARTED, ends_yesterday: true, total_days: 3 }])
    } finally {
      await fresh.close()
    }
  }, 60_000)
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run tests/migration-631-unavailable-time-off-to-availability.test.js`
Expected: the suite fails at import with `ENOENT` on `631_unavailable_time_off_to_availability.sql`.

- [ ] **Step 3: Write the migration**

```sql
-- 631 — AVAIL.3: contractors' "unavailable" time off moves into availability.
--
-- WHAT THIS DOES
-- ──────────────
-- Coaches used to say "I can't work 3-5 Oct" by filing a time_off_requests
-- row of type 'unavailable' that a manager approved (contractors and casual
-- staff had no other type). AVAIL.1 (mig 630) made that self-declared: a
-- staff_unavailability rule, no approval, managers told. The AVAIL.3 code
-- (deployed BEFORE this file is applied) stops offering and accepting the
-- type. This file carries every current one across:
--
--   CARRY SET  type = 'unavailable', status approved OR pending,
--              end_date >= today (Dublin, taken once at apply), and the
--              person is not tombstoned (profiles.deleted_at IS NULL).
--              Rejected / cancelled rows, rows that ended, other types and a
--              tombstone's rows are NOT touched.
--   FUTURE     (start_date >= today) the row is DELETED from time_off_requests
--              after its full row is copied into the ledger.
--   STARTED    (start_date < today) the row is SPLIT: it keeps
--              start_date..yesterday as time off (total_days trimmed to the
--              elapsed days); today..end_date moves. The days already gone
--              stay history, and no day is ever in both places.
--   RULE       kind 'dated', all day, greatest(start_date, today)..end_date,
--              note = the trimmed reason (blank -> NULL). One rule per
--              distinct (person, start, end); an identical all-day rule the
--              person already has is reused. The earliest request's note wins
--              a collapse; every other note stays in the ledger's copy.
--
-- WHAT IT MUST NOT DO, AND WHY IT CAN'T
-- ─────────────────────────────────────
--   * Notify anyone. It writes staff_unavailability directly, never through
--     replace_staff_unavailability, and writes NO staff_availability_changes
--     row. The AVAIL.1a notice path (route + checklist-sweep arm) only reads
--     change rows with notified_at IS NULL, so nothing is owed or sent.
--   * Move a leave balance or pay. The one trigger on time_off_requests is
--     trg_update_holiday_allowance, AFTER UPDATE, and both branches of its
--     function (mig 616) test NEW.type = 'holiday'. The split UPDATE touches
--     'unavailable' rows only; DELETE fires nothing. Payroll and contractor
--     invoices do not read time_off_requests.
--   * Lose a day. The move function checks, before it returns, that every
--     carried (person, day) is covered by an all-day dated rule and that
--     every split row still starts where it did and ends yesterday; any miss
--     raises and the whole transaction rolls back.
--
-- THE LEDGER (time_off_availability_moves) is the audit AND the rollback
-- record: one row per time_off_requests row touched, the FULL original row
-- (to_jsonb), the rule it became, whether that rule was inserted or reused.
-- Service-role only (RLS on, no policies, no browser grants), like mig 630.
-- No FKs on purpose: it must outlive anything it points at.
--
-- TWO FUNCTIONS STAY after this file (service_role only):
--   move_unavailable_time_off_to_availability(p_today date) -> jsonb
--     re-runnable: carries anything eligible that is not in the ledger yet
--     (a straggler filed before the code deployed). Idempotent.
--   restore_moved_unavailable_time_off(p_batch_id uuid DEFAULT NULL) -> jsonb
--     THE ROLLBACK: re-inserts every moved row byte-for-byte (same id),
--     re-extends every split row, deletes each carried rule the person has
--     not changed since (a changed one is left and reported as
--     restored_rule_changed). Idempotent. A restored row stays remembered by
--     the ledger, so a later move leaves it alone; to move it again, delete
--     its ledger row first.
--
-- GUARDS (any one aborts the whole move, nothing half-moved):
--   avail3_open_cancel_ask  a carry row has a cancellation ask no owner has
--                           decided (decide it first, then re-apply)
--   avail3_note_too_long    a reason over 200 characters (mig 630's note
--                           CHECK); never silently truncated
--   avail3_too_far_ahead    a rule starting more than 730 days ahead
--                           (AVAILABILITY_LIMITS.aheadDays: the coach's next
--                           save would be refused)
--   avail3_too_many_dates   more than 60 current dated rules for one person
--                           (AVAILABILITY_LIMITS.dated: same reason)
-- All four were 0 on 25 Sep.
--
-- APPLY AFTER THE AVAIL.3 CODE HAS DEPLOYED (the POST then refuses the type,
-- so nothing can be filed behind the move). Not within 15 minutes of Dublin
-- midnight. On 25 Sep the carry set was 11 rows / 5 people (9 moved, 2 split,
-- 0 pending); it is computed live.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; save ALL output to the scratchpad as the
-- rollback record: mig631-rollback-<date>.txt)
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The names are free:
--       SELECT to_regclass('public.time_off_availability_moves'),
--              to_regprocedure('public.move_unavailable_time_off_to_availability(date)'),
--              to_regprocedure('public.restore_moved_unavailable_time_off(uuid)');
--     Expected: NULL, NULL, NULL.
-- (b) The AVAIL.3 code is live: the Vercel production deployment of the merge
--     commit is READY (Vercel MCP list_deployments). Optional proof, safe
--     because the refusal happens before any read or write: from a signed-in
--     crm.repset.ie tab, POST /api/schedule/time-off
--     {"type":"unavailable","start_date":"<tomorrow>","end_date":"<tomorrow>"}
--     answers 400 "Unavailable is no longer a time-off request…".
-- (c) THE CARRY SET, row by row (ids and shapes only, no names):
--       WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d)
--       SELECT r.id, r.profile_id, r.location_id, r.status, r.start_date, r.end_date, r.total_days,
--              char_length(r.reason) AS reason_chars,
--              (r.cancel_requested_at IS NOT NULL AND r.cancel_decided_at IS NULL) AS open_cancel_ask,
--              CASE WHEN r.start_date < t.d THEN 'split' ELSE 'moved' END AS action
--         FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id, t
--        WHERE r.type = 'unavailable' AND r.status IN ('approved', 'pending')
--          AND r.end_date >= t.d AND p.deleted_at IS NULL
--        ORDER BY r.profile_id, r.start_date;
--     25 Sep: 11 rows, 5 people, 9 moved + 2 split, all approved,
--     reason_chars <= 9, open_cancel_ask false everywhere.
-- (d) The guards, each expected 0:
--       WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d),
--       c AS (SELECT r.* FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id, t
--              WHERE r.type = 'unavailable' AND r.status IN ('approved','pending') AND r.end_date >= t.d AND p.deleted_at IS NULL)
--       SELECT (SELECT count(*) FROM c WHERE cancel_requested_at IS NOT NULL AND cancel_decided_at IS NULL) AS open_asks,
--              (SELECT count(*) FROM c WHERE char_length(btrim(coalesce(reason, ''))) > 200) AS long_notes,
--              (SELECT count(*) FROM c, t WHERE greatest(c.start_date, t.d) > t.d + 730) AS too_far,
--              (SELECT count(*) FROM (SELECT profile_id FROM (
--                  SELECT profile_id FROM c
--                  UNION ALL SELECT u.profile_id FROM public.staff_unavailability u, t WHERE u.kind = 'dated' AND u.end_date >= t.d
--                ) x GROUP BY profile_id HAVING count(*) > 60) y) AS too_many;
-- (e) FINGERPRINTS (save every value; post-check (k) compares):
--       WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d),
--       carry AS (SELECT r.id FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id, t
--                  WHERE r.type = 'unavailable' AND r.status IN ('approved','pending') AND r.end_date >= t.d AND p.deleted_at IS NULL)
--       SELECT
--         (SELECT md5(string_agg(to_jsonb(s)::text, ',' ORDER BY s.id)) FROM public.staff_allowances s) AS allowances_fp,
--         (SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id)) FROM public.time_off_requests r
--           WHERE r.type <> 'unavailable') AS other_types_fp,
--         (SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id)) FROM public.time_off_requests r
--           WHERE r.type = 'unavailable' AND r.id NOT IN (SELECT id FROM carry)) AS untouched_unavailable_fp,
--         (SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id)) FROM public.time_off_requests r
--           WHERE r.type = 'unavailable') AS all_unavailable_fp,
--         (SELECT count(*) FROM public.staff_unavailability) AS rules,
--         (SELECT count(*) FROM public.staff_availability_changes) AS changes,
--         (SELECT count(*) FROM public.staff_availability_changes WHERE notified_at IS NULL) AS changes_owed,
--         (SELECT count(*) FROM public.push_event_sends WHERE event_key LIKE 'availability_changed:%') AS availability_pushes;
-- (f) The person-days to carry (post-check (l) must find every one covered):
--       WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d)
--       SELECT count(*) AS person_days, count(DISTINCT (r.profile_id, g.d)) AS distinct_person_days
--         FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id, t,
--              generate_series(greatest(r.start_date, t.d), r.end_date, interval '1 day') g(d)
--        WHERE r.type = 'unavailable' AND r.status IN ('approved','pending') AND r.end_date >= t.d AND p.deleted_at IS NULL;
--     25 Sep: 81 person-days (one overlapping pair).
-- (g) The trigger is still only the allowance one, and it still keys on holiday:
--       SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--        WHERE tgrelid = 'public.time_off_requests'::regclass AND NOT tgisinternal;
--       SELECT pg_get_functiondef('public.update_holiday_allowance()'::regprocedure)
--              LIKE '%NEW.type = ''holiday'' AND NEW.status = ''approved''%'
--          AND pg_get_functiondef('public.update_holiday_allowance()'::regprocedure)
--              LIKE '%NEW.type = ''holiday'' AND OLD.status = ''approved''%';
--     Expected: one row, trg_update_holiday_allowance AFTER UPDATE; true.
-- (h) Advisor baseline: get_advisors(security) rls_enabled_no_policy count.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (i) The ledger matches the carry set in (c), row for row:
--       SELECT action, count(*), count(DISTINCT profile_id), count(*) FILTER (WHERE rule_inserted)
--         FROM public.time_off_availability_moves GROUP BY action;
--       SELECT time_off_request_id FROM public.time_off_availability_moves ORDER BY 1;  -- = the ids in (c)
-- (j) Nothing eligible remains (0):
--       WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d)
--       SELECT count(*) FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id, t
--        WHERE r.type = 'unavailable' AND r.status IN ('approved','pending') AND r.end_date >= t.d AND p.deleted_at IS NULL;
-- (k) Fingerprints: allowances_fp and other_types_fp IDENTICAL to (e);
--     untouched_unavailable_fp, now computed as
--       (SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id)) FROM public.time_off_requests r
--         WHERE r.type = 'unavailable'
--           AND r.id NOT IN (SELECT time_off_request_id FROM public.time_off_availability_moves))
--     IDENTICAL to (e); changes, changes_owed, availability_pushes IDENTICAL
--     to (e) (nobody notified); rules = (e).rules + the rules_inserted in (i).
-- (l) No carried day lost (0 rows):
--       SELECT m.time_off_request_id, g.d::date
--         FROM public.time_off_availability_moves m,
--              generate_series(greatest((m.original->>'start_date')::date, m.moved_today),
--                              (m.original->>'end_date')::date, interval '1 day') g(d)
--        WHERE NOT EXISTS (SELECT 1 FROM public.staff_unavailability u
--                           WHERE u.profile_id = m.profile_id AND u.kind = 'dated' AND u.all_day
--                             AND g.d::date BETWEEN u.start_date AND u.end_date);
-- (m) Split rows kept their elapsed days (every row: same start, ends the
--     day before moved_today):
--       SELECT r.id, r.start_date, r.end_date, r.total_days, m.moved_today
--         FROM public.time_off_availability_moves m JOIN public.time_off_requests r ON r.id = m.time_off_request_id
--        WHERE m.action = 'split';
-- (n) Grants: 0 rows from
--       SELECT r, p FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
--        WHERE has_table_privilege(r, 'public.time_off_availability_moves', p);
--     and false, false from
--       SELECT has_function_privilege('authenticated', 'public.move_unavailable_time_off_to_availability(date)', 'EXECUTE'),
--              has_function_privilege('authenticated', 'public.restore_moved_unavailable_time_off(uuid)', 'EXECUTE');
-- (o) get_advisors security AND performance: rls_enabled_no_policy +1 (the
--     ledger), nothing else new (no FK, so no unindexed_foreign_keys).
-- (p) Browser eyeball (Claude in Chrome, crm.repset.ie): the week holding a
--     carried contractor's future day shows grey availability shading for
--     them and NO amber Unavailable leave bar; the coach grid shows the
--     availability, not leave; Schedule > Time Off lists no future
--     Unavailable row; the contractor's own "My availability" lists the
--     carried dates with their notes.
-- (q) 30 minutes later: cron_heartbeats 'availability-notice-sweep' fresh,
--     and availability_pushes still equal to (e).
--
-- ROLLBACK (data): SELECT public.restore_moved_unavailable_time_off();
--   then all_unavailable_fp must equal (e) again (a restored_rule_changed
--   row means the coach edited that rule since: their rule is kept, so they
--   now have both; tell them). Revert the AVAIL.3 code in the same hour if
--   the forms should offer the type again. The ledger and both functions
--   stay; drop them in a later forward migration once nobody needs them.

BEGIN;

-- ── The ledger ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.time_off_availability_moves (
  time_off_request_id uuid PRIMARY KEY,
  batch_id            uuid NOT NULL,
  profile_id          uuid NOT NULL,
  action              text NOT NULL,
  moved_today         date NOT NULL,
  original            jsonb NOT NULL,
  rule                jsonb NOT NULL,
  rule_inserted       boolean NOT NULL DEFAULT false,
  moved_at            timestamptz NOT NULL DEFAULT now(),
  restored_at         timestamptz,
  restore_outcome     text,
  CONSTRAINT time_off_availability_moves_action CHECK (action IN ('moved', 'split')),
  CONSTRAINT time_off_availability_moves_restore CHECK (
    (restored_at IS NULL AND restore_outcome IS NULL)
    OR (restored_at IS NOT NULL AND restore_outcome IN ('restored', 'restored_rule_changed'))
  )
);

CREATE INDEX IF NOT EXISTS time_off_availability_moves_batch_idx
  ON public.time_off_availability_moves (batch_id);

ALTER TABLE public.time_off_availability_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.time_off_availability_moves FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.time_off_availability_moves TO service_role;

COMMENT ON TABLE public.time_off_availability_moves IS
  'AVAIL.3 (mig 631) — one row per time_off_requests row of type unavailable carried into staff_unavailability: the FULL original row (to_jsonb), the dated all-day rule it became, whether that rule was inserted or an identical one reused, and whether the move was a delete (moved) or a split at moved_today (split). The audit and the rollback record for restore_moved_unavailable_time_off(). No FKs on purpose (it outlives what it points at). Service-role only.';

-- ── The move ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.move_unavailable_time_off_to_availability(p_today date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_batch  uuid := gen_random_uuid();
  v_n      int;
  v_moved  int;
  v_split  int;
  v_rules  int;
  v_people int;
BEGIN
  IF p_today IS NULL THEN
    RAISE EXCEPTION 'avail3_bad_args: today is required';
  END IF;

  -- Nothing else writes time_off_requests while this runs (reads carry on).
  LOCK TABLE public.time_off_requests IN SHARE ROW EXCLUSIVE MODE;

  -- 1. THE CARRY SET, recorded in full before anything changes.
  INSERT INTO public.time_off_availability_moves
         (time_off_request_id, batch_id, profile_id, action, moved_today, original, rule)
  SELECT r.id, v_batch, r.profile_id,
         CASE WHEN r.start_date < p_today THEN 'split' ELSE 'moved' END,
         p_today,
         to_jsonb(r),
         jsonb_build_object(
           'kind', 'dated',
           'start_date', GREATEST(r.start_date, p_today),
           'end_date', r.end_date,
           'all_day', true,
           'start_time', NULL,
           'end_time', NULL,
           'note', NULLIF(btrim(COALESCE(r.reason, '')), ''))
    FROM public.time_off_requests r
    JOIN public.profiles p ON p.id = r.profile_id
   WHERE r.type = 'unavailable'
     AND r.status IN ('approved', 'pending')
     AND r.end_date >= p_today
     AND p.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.time_off_availability_moves m WHERE m.time_off_request_id = r.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n = 0 THEN
    RETURN jsonb_build_object('batch_id', NULL, 'moved', 0, 'split', 0,
                              'rules_inserted', 0, 'rules_reused', 0, 'people', 0);
  END IF;

  -- 2. GUARDS. A raise here rolls back step 1 with it.
  IF EXISTS (SELECT 1 FROM public.time_off_availability_moves m
              WHERE m.batch_id = v_batch
                AND (m.original->>'cancel_requested_at') IS NOT NULL
                AND (m.original->>'cancel_decided_at') IS NULL) THEN
    RAISE EXCEPTION 'avail3_open_cancel_ask: a request being carried has a cancellation no owner has decided; decide it first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.time_off_availability_moves m
              WHERE m.batch_id = v_batch AND char_length(m.rule->>'note') > 200) THEN
    RAISE EXCEPTION 'avail3_note_too_long: a reason is over 200 characters, the availability note limit';
  END IF;
  IF EXISTS (SELECT 1 FROM public.time_off_availability_moves m
              WHERE m.batch_id = v_batch AND (m.rule->>'start_date')::date > p_today + 730) THEN
    RAISE EXCEPTION 'avail3_too_far_ahead: a date starts more than two years ahead';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT x.profile_id FROM (
        SELECT m.profile_id FROM public.time_off_availability_moves m WHERE m.batch_id = v_batch
        UNION ALL
        SELECT u.profile_id FROM public.staff_unavailability u
         WHERE u.kind = 'dated' AND u.end_date >= p_today
           AND u.profile_id IN (SELECT m2.profile_id FROM public.time_off_availability_moves m2 WHERE m2.batch_id = v_batch)
      ) x GROUP BY x.profile_id HAVING count(*) > 60
    ) y
  ) THEN
    RAISE EXCEPTION 'avail3_too_many_dates: someone would have more than 60 dated availability entries';
  END IF;

  -- 3. One writer per person at a time: the same lock the AVAIL.1 RPC takes,
  --    in a fixed order, so a coach saving right now queues behind the move.
  PERFORM pg_advisory_xact_lock(hashtextextended('staff_unavailability:' || x.profile_id::text, 0))
     FROM (SELECT DISTINCT m.profile_id FROM public.time_off_availability_moves m
            WHERE m.batch_id = v_batch ORDER BY m.profile_id) x;

  -- 4. Which rules to insert: one per (person, start, end), the earliest
  --    request's, and none where the person already has that all-day rule.
  UPDATE public.time_off_availability_moves m
     SET rule_inserted = true
   WHERE m.time_off_request_id IN (
     SELECT DISTINCT ON (b.profile_id, b.rule->>'start_date', b.rule->>'end_date') b.time_off_request_id
       FROM public.time_off_availability_moves b
      WHERE b.batch_id = v_batch
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_unavailability u
           WHERE u.profile_id = b.profile_id AND u.kind = 'dated' AND u.all_day
             AND u.start_date = (b.rule->>'start_date')::date
             AND u.end_date = (b.rule->>'end_date')::date)
      ORDER BY b.profile_id, b.rule->>'start_date', b.rule->>'end_date',
               (b.original->>'created_at') NULLS LAST, b.time_off_request_id);

  -- The mig 630 CHECKs judge every row: one bad rule aborts everything.
  INSERT INTO public.staff_unavailability (profile_id, kind, start_date, end_date, all_day, note)
  SELECT m.profile_id, 'dated', (m.rule->>'start_date')::date, (m.rule->>'end_date')::date, true, m.rule->>'note'
    FROM public.time_off_availability_moves m
   WHERE m.batch_id = v_batch AND m.rule_inserted;
  GET DIAGNOSTICS v_rules = ROW_COUNT;

  -- 5. Time off. The split UPDATE fires trg_update_holiday_allowance, which
  --    acts on type 'holiday' only; these rows are 'unavailable'.
  UPDATE public.time_off_requests r
     SET end_date = p_today - 1,
         total_days = LEAST(r.total_days, (p_today - r.start_date)::numeric),
         updated_at = now()
    FROM public.time_off_availability_moves m
   WHERE m.batch_id = v_batch AND m.action = 'split' AND r.id = m.time_off_request_id;
  GET DIAGNOSTICS v_split = ROW_COUNT;

  DELETE FROM public.time_off_requests r
   USING public.time_off_availability_moves m
   WHERE m.batch_id = v_batch AND m.action = 'moved' AND r.id = m.time_off_request_id;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  -- 6. PROVE IT before returning. Any failure raises; the caller's
  --    transaction (the migration, or a manual re-run) rolls back whole.
  IF v_moved + v_split <> v_n THEN
    RAISE EXCEPTION 'avail3_postcheck: % rows recorded, % moved + % split', v_n, v_moved, v_split;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.time_off_availability_moves m,
           generate_series((m.rule->>'start_date')::date, (m.rule->>'end_date')::date, interval '1 day') g(d)
     WHERE m.batch_id = v_batch
       AND NOT EXISTS (SELECT 1 FROM public.staff_unavailability u
                        WHERE u.profile_id = m.profile_id AND u.kind = 'dated' AND u.all_day
                          AND g.d::date BETWEEN u.start_date AND u.end_date)
  ) THEN
    RAISE EXCEPTION 'avail3_postcheck: a carried day is not covered by an availability rule';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.time_off_availability_moves m
      LEFT JOIN public.time_off_requests r ON r.id = m.time_off_request_id
     WHERE m.batch_id = v_batch AND m.action = 'split'
       AND (r.id IS NULL OR r.type <> 'unavailable'
            OR r.start_date <> (m.original->>'start_date')::date
            OR r.end_date <> p_today - 1
            OR r.status <> (m.original->>'status'))
  ) THEN
    RAISE EXCEPTION 'avail3_postcheck: a split row lost its elapsed days';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id
     WHERE r.type = 'unavailable' AND r.status IN ('approved', 'pending')
       AND r.end_date >= p_today AND p.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.time_off_availability_moves m
                        WHERE m.time_off_request_id = r.id AND m.restored_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'avail3_postcheck: an eligible unavailable request is still time off';
  END IF;

  SELECT count(DISTINCT m.profile_id) INTO v_people
    FROM public.time_off_availability_moves m WHERE m.batch_id = v_batch;

  RETURN jsonb_build_object('batch_id', v_batch, 'moved', v_moved, 'split', v_split,
                            'rules_inserted', v_rules, 'rules_reused', v_n - v_rules, 'people', v_people);
END;
$$;

COMMENT ON FUNCTION public.move_unavailable_time_off_to_availability(date) IS
  'AVAIL.3 (mig 631) — carries every time_off_requests row of type unavailable (approved or pending, end_date >= p_today, person not tombstoned, not already in the ledger) into staff_unavailability as an all-day dated rule from greatest(start_date, p_today): future rows are deleted, started rows split at p_today (start..p_today-1 stays time off). Full originals go to time_off_availability_moves first. Writes no staff_availability_changes row, so nobody is notified. Guards (avail3_*) abort everything; proves no day lost before returning. Idempotent. service_role only.';

REVOKE ALL ON FUNCTION public.move_unavailable_time_off_to_availability(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_unavailable_time_off_to_availability(date) TO service_role;

-- ── The rollback ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.restore_moved_unavailable_time_off(p_batch_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  m                 record;
  v_rule_id         uuid;
  v_restored        int := 0;
  v_rules_removed   int := 0;
  v_rules_changed   int := 0;
BEGIN
  LOCK TABLE public.time_off_requests IN SHARE ROW EXCLUSIVE MODE;

  FOR m IN
    SELECT * FROM public.time_off_availability_moves
     WHERE restored_at IS NULL AND (p_batch_id IS NULL OR batch_id = p_batch_id)
     ORDER BY profile_id, time_off_request_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('staff_unavailability:' || m.profile_id::text, 0));

    IF m.action = 'moved' THEN
      -- The exact row, same id, every column as it was.
      INSERT INTO public.time_off_requests
      SELECT * FROM jsonb_populate_record(NULL::public.time_off_requests, m.original)
      ON CONFLICT (id) DO NOTHING;
    ELSE
      -- AFTER UPDATE trigger: type 'unavailable', so no allowance moves.
      UPDATE public.time_off_requests r
         SET end_date = (m.original->>'end_date')::date,
             total_days = (m.original->>'total_days')::numeric,
             updated_at = (m.original->>'updated_at')::timestamptz
       WHERE r.id = m.time_off_request_id;
    END IF;

    v_rule_id := NULL;
    IF m.rule_inserted THEN
      SELECT u.id INTO v_rule_id
        FROM public.staff_unavailability u
       WHERE u.profile_id = m.profile_id AND u.kind = 'dated' AND u.all_day
         AND u.start_date = (m.rule->>'start_date')::date
         AND u.end_date = (m.rule->>'end_date')::date
         AND u.note IS NOT DISTINCT FROM (m.rule->>'note')
       ORDER BY u.created_at, u.id
       LIMIT 1;
      IF v_rule_id IS NOT NULL THEN
        DELETE FROM public.staff_unavailability WHERE id = v_rule_id;
        v_rules_removed := v_rules_removed + 1;
      ELSE
        v_rules_changed := v_rules_changed + 1;
      END IF;
    END IF;

    UPDATE public.time_off_availability_moves
       SET restored_at = now(),
           restore_outcome = CASE WHEN m.rule_inserted AND v_rule_id IS NULL
                                  THEN 'restored_rule_changed' ELSE 'restored' END
     WHERE time_off_request_id = m.time_off_request_id;
    v_restored := v_restored + 1;
  END LOOP;

  RETURN jsonb_build_object('restored', v_restored, 'rules_removed', v_rules_removed,
                            'rules_changed_since', v_rules_changed);
END;
$$;

COMMENT ON FUNCTION public.restore_moved_unavailable_time_off(uuid) IS
  'AVAIL.3 (mig 631) — the rollback of move_unavailable_time_off_to_availability: re-inserts every moved row byte-for-byte (same id), re-extends every split row, and deletes each carried rule the person has not changed since (else restore_outcome = restored_rule_changed and their rule stays). One batch, or all when p_batch_id is NULL. Idempotent (restored_at). service_role only.';

REVOKE ALL ON FUNCTION public.restore_moved_unavailable_time_off(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_moved_unavailable_time_off(uuid) TO service_role;

-- ── The move itself, for the Dublin business day of this apply ──────────
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.move_unavailable_time_off_to_availability((now() AT TIME ZONE 'Europe/Dublin')::date);
  RAISE NOTICE 'mig 631 move: %', v_result;
END $$;

-- ── Self-check against the catalog, never this text (the mig 153 lesson) ──
DO $$
DECLARE
  v_role text;
  v_priv text;
  v_n    int;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.time_off_availability_moves', v_priv) THEN
        RAISE EXCEPTION 'mig 631: % still holds % on the ledger', v_role, v_priv;
      END IF;
    END LOOP;
    IF has_function_privilege(v_role, 'public.move_unavailable_time_off_to_availability(date)', 'EXECUTE')
       OR has_function_privilege(v_role, 'public.restore_moved_unavailable_time_off(uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'mig 631: % can execute a move function', v_role;
    END IF;
  END LOOP;

  IF NOT has_function_privilege('service_role', 'public.move_unavailable_time_off_to_availability(date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.restore_moved_unavailable_time_off(uuid)', 'EXECUTE')
     OR NOT has_table_privilege('service_role', 'public.time_off_availability_moves', 'SELECT') THEN
    RAISE EXCEPTION 'mig 631: service_role lacks what the functions need';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.time_off_availability_moves'::regclass) THEN
    RAISE EXCEPTION 'mig 631: RLS is not enabled on the ledger';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'time_off_availability_moves';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'mig 631: expected no policies on the ledger, found %', v_n;
  END IF;

  -- The move's own post-checks ran inside it; this is the belt.
  SELECT count(*) INTO v_n
    FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id
   WHERE r.type = 'unavailable' AND r.status IN ('approved', 'pending')
     AND r.end_date >= (now() AT TIME ZONE 'Europe/Dublin')::date AND p.deleted_at IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'mig 631: % eligible unavailable requests are still time off', v_n;
  END IF;
END $$;

COMMIT;
```

- [ ] **Step 4: Run the test and the replay checks, expect PASS**

Run: `npx vitest run tests/migration-631-unavailable-time-off-to-availability.test.js`
Expected: all passed.

If something fails, check these before touching a test:
- `total_days` for the split row comes back through `to_jsonb`, which PGlite parses as a JSON number (`5.0` → `5`). The apply-time test casts to `float8` for the same reason (PGlite may hand a bare `numeric` back as a string).
- The restore tests compare whole rows with `toEqual`. A difference there (a timestamp's precision after `to_jsonb` → `jsonb_populate_record`) is a real defect in the restore's byte-for-byte promise: fix the SQL, never the test.

Run: `npm run check:rls-restrictive && npm run check:select-columns`
Expected: both exit 0 (no policy on the ledger; the replayed schema learns the new table, and no code selects from it).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/631_unavailable_time_off_to_availability.sql tests/migration-631-unavailable-time-off-to-availability.test.js
git commit -m "AVAIL.3 — mig 631: carry unavailable time off into availability, with a ledger and a tested restore

Future approved/pending unavailable requests become all-day dated rules and
leave time_off_requests; started ones split at today; the past, other types
and tombstones are untouched. No change rows, so no notices; the allowance
trigger acts on holiday only. Service-role only. Applied AFTER the deploy.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Do NOT apply it. The operator applies it after the deploy (DEPLOY ORDER).

---

### Task 2: `shared/time-off.js` — "unavailable" is no longer requestable

**Files:**
- Modify: `shared/time-off.js`
- Test: `shared/time-off.test.js`

- [ ] **Step 1: Write the failing tests**

In `shared/time-off.test.js`, add the new names to the import at lines 2-6:

```js
import {
  TIME_OFF_TYPES, timeOffTypesFor, defaultTimeOffTypeFor, timeOffTypeLabel,
  isTimeOffTypeAllowedFor, timeOffLeaveLabel, isExpiredPendingRequest, effectiveTimeOffStatus, leaveClashLabel,
  leaveClashPrompt, leaveDateRangeLabel, leavePreviewLine,
  isRequestableTimeOffType, canRequestTimeOff, UNAVAILABLE_MOVED_ERROR, RESTRICTED_TYPE_ERROR,
  CONTRACTOR_DECIDE_ERROR, AVAILABILITY_INSTEAD,
} from './time-off'
```

Replace the test at lines 19-24 (`'restricts contractors + casual to unavailable only'`) with:

```js
  it('AVAIL.3 — contractors + casual have nothing to request: no types, no default', () => {
    for (const et of ['contractor', 'casual']) {
      expect(timeOffTypesFor(et)).toEqual([])
      expect(defaultTimeOffTypeFor(et)).toBeNull()
      expect(canRequestTimeOff(et)).toBe(false)
    }
  })
```

Append a new describe at the end of the file:

```js
// AVAIL.3 — "unavailable" moved into availability (mig 631).
describe('AVAIL.3 — unavailable is no longer requested', () => {
  it('no employment type is offered unavailable, and employees keep their four types', () => {
    for (const et of ['fte', 'contractor', 'casual', null, undefined, 'weird']) {
      expect(timeOffTypesFor(et).map((t) => t.value)).not.toContain('unavailable')
    }
    expect(timeOffTypesFor('fte').map((t) => t.value)).toEqual(['holiday', 'sick', 'unpaid', 'other'])
    expect(canRequestTimeOff('fte')).toBe(true)
    expect(canRequestTimeOff(null)).toBe(true)
  })

  it('isRequestableTimeOffType refuses unavailable only', () => {
    expect(isRequestableTimeOffType('unavailable')).toBe(false)
    for (const t of ['holiday', 'sick', 'unpaid', 'other']) expect(isRequestableTimeOffType(t)).toBe(true)
  })

  it('history keeps its label: the catalogue, the leave label and the decision gate are unchanged', () => {
    expect(TIME_OFF_TYPES.map((t) => t.value)).toContain('unavailable')
    expect(timeOffTypeLabel('unavailable')).toBe('Unavailable')
    expect(timeOffLeaveLabel('unavailable')).toBe('Unavailable')
    // Deciding a pending unavailable request still works for a contractor.
    expect(isTimeOffTypeAllowedFor('contractor', 'unavailable')).toBe(true)
    expect(isTimeOffTypeAllowedFor('contractor', 'holiday')).toBe(false)
  })

  it('every message names My availability; none tells anyone to file Unavailable', () => {
    expect(UNAVAILABLE_MOVED_ERROR).toMatch(/^Unavailable is no longer a time-off request\./)
    expect(UNAVAILABLE_MOVED_ERROR).toMatch(/My availability/)
    expect(UNAVAILABLE_MOVED_ERROR).toMatch(/No approval is needed/)
    expect(RESTRICTED_TYPE_ERROR).toMatch(/^Contractors.*My availability/)
    expect(CONTRACTOR_DECIDE_ERROR).toMatch(/^Contractors don’t take leave\. Decline this request/)
    expect(CONTRACTOR_DECIDE_ERROR).not.toMatch(/file it as Unavailable/)
    expect(AVAILABILITY_INSTEAD).toEqual({
      title: 'Use My availability instead',
      message: expect.stringMatching(/My availability/),
      action: 'Open My availability',
      onBehalf: expect.stringMatching(/^Contractors don’t take leave, so there is nothing to record here/),
    })
  })

  it('no em dashes in any of the words (staff copy follows the customer-copy rule)', () => {
    for (const s of [UNAVAILABLE_MOVED_ERROR, RESTRICTED_TYPE_ERROR, CONTRACTOR_DECIDE_ERROR, ...Object.values(AVAILABILITY_INSTEAD)]) {
      expect(s).not.toMatch(/—/)
    }
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run shared/time-off.test.js`
Expected: FAIL (`isRequestableTimeOffType is not a function`; the contractor test gets `['unavailable']`).

- [ ] **Step 3: Implement**

In `shared/time-off.js`, replace the header comment (lines 1-8) with:

```js
// Canonical time-off type catalogue + employment-gated option lists. Shared by
// web (RequestTimeOffModal, TimeOffManager) + mobile (time-off-new) so the
// gating can't drift. The DB CHECK (mig 283) allows all five; the manager
// approval screen + reports render/bucket them.
//
// Gating (product decision 2026-06-17): full-time employees get the four leave
// types; contractors + casual staff got 'unavailable' only. Unknown/null
// employment defaults to the full menu (don't over-restrict a mis-typed FTE).
//
// AVAIL.3 (mig 631): 'unavailable' is no longer REQUESTED by anyone. Saying
// when you can't work is My availability (AVAIL.1/2): self-declared, no
// approval, managers told. So contractors and casual staff have nothing to
// request here at all, and every form sends them there instead. The type stays
// in TIME_OFF_TYPES, the labels and the DB CHECK because past rows keep it.
```

After `const RESTRICTED_VALUES = ['unavailable']` (line 21) add:

```js

// AVAIL.3 — types nobody may file as a NEW request (history keeps them).
export const NON_REQUESTABLE_TYPES = Object.freeze(['unavailable'])

export function isRequestableTimeOffType(type) {
  return !NON_REQUESTABLE_TYPES.includes(type)
}
```

Replace `timeOffTypesFor` and `defaultTimeOffTypeFor` (lines 27-34) with:

```js
export function timeOffTypesFor(employmentType) {
  const allowed = allowedTimeOffValues(employmentType)
  return TIME_OFF_TYPES.filter(t => allowed.includes(t.value) && isRequestableTimeOffType(t.value))
}

// null when there is nothing to request (AVAIL.3: contractors, casual staff).
export function defaultTimeOffTypeFor(employmentType) {
  return timeOffTypesFor(employmentType)[0]?.value ?? null
}

// AVAIL.3 — false = send this person to My availability instead of a form.
export function canRequestTimeOff(employmentType) {
  return timeOffTypesFor(employmentType).length > 0
}
```

Replace the comment above `isRestrictedEmployment` (lines 40-44, the one that says "36 approved `unavailable` rows predate this") with:

```js
// LEAVE.2 — employment gate as a yes/no, for the SERVER'S DECISIONS on
// existing rows (approve). A restricted employment may only ever hold
// 'unavailable'; since AVAIL.3 nobody files a NEW one (the POST refuses it
// with UNAVAILABLE_MOVED_ERROR before this gate), but a pending one filed
// before the move can still be decided.
```

Replace `RESTRICTED_TYPE_ERROR` (lines 53-54) with:

```js
export const RESTRICTED_TYPE_ERROR =
  'Contractors don’t book leave. Set the days and times you can’t work in My availability, on the Schedule screen.'

// AVAIL.3 — the POST's answer to a new 'unavailable' request (an old phone
// or a stale tab still offers it). The old phone shows it in its
// "Couldn't submit" alert, so it must say where to go.
export const UNAVAILABLE_MOVED_ERROR =
  'Unavailable is no longer a time-off request. Set the days and times you can’t work in My availability, on the Schedule screen. No approval is needed, and your managers are told.'

// AVAIL.3 — approving a contractor's holiday/sick/unpaid/other (existing rows).
export const CONTRACTOR_DECIDE_ERROR =
  'Contractors don’t take leave. Decline this request: they can set when they can’t work in My availability.'

// AVAIL.3 — what a form shows instead of itself when there is nothing to request.
export const AVAILABILITY_INSTEAD = Object.freeze({
  title: 'Use My availability instead',
  message: 'Contractors don’t request time off. Say when you can’t work in My availability: no approval is needed, and your managers are told.',
  action: 'Open My availability',
  onBehalf: 'Contractors don’t take leave, so there is nothing to record here. They set when they can’t work in their own availability.',
})
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run shared/time-off.test.js`
Expected: all passed. The existing `'isTimeOffTypeAllowedFor: contractors only unavailable; FTE/unknown unrestricted'` test (lines 40-47) still passes unchanged: that gate did not move.

- [ ] **Step 5: Commit**

```bash
git add shared/time-off.js shared/time-off.test.js
git commit -m "AVAIL.3 — shared: unavailable is no longer requestable; contractors have nothing to request

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The server refuses a new `unavailable` request

**Files:**
- Modify: `src/app/api/schedule/time-off/route.js` (import lines 20-22; after line 267)
- Modify: `src/app/api/schedule/time-off/[id]/route.js` (import line 13; lines 223-227)
- Modify: `src/lib/openapi.js` (lines 4718, 4722, 4736)
- Test: `src/app/api/schedule/time-off/route.test.js`, `src/app/api/schedule/time-off/[id]/route.test.js`

- [ ] **Step 1: Write the failing tests**

In `src/app/api/schedule/time-off/route.test.js`, replace the test at lines 526-540 (`'400 when a contractor files holiday, sick or unpaid leave; unavailable is accepted'`) with:

```js
  it('400 when a contractor files holiday, sick, unpaid or other leave, pointing at My availability', async () => {
    getCurrentUser.mockResolvedValue(USER)
    for (const type of ['holiday', 'sick', 'unpaid', 'other']) {
      const { db, insertSpy } = buildDb({ employmentType: 'contractor' })
      createServerClient.mockReturnValue(db)
      const res = await POST(req({ type, start_date: '2026-06-01', end_date: '2026-06-02' }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/^Contractors.*My availability/)
      expect(insertSpy).not.toHaveBeenCalled()
    }
  })
```

Append a new describe directly after the `POST /api/schedule/time-off — LEAVE.2` describe (it closes just before `// LEAVEPHONE.1 — before filing, the coach's leave form asks the SERVER two`, ~line 667):

```js
// AVAIL.3 — "unavailable" moved into availability (mig 631). An old phone or a
// stale tab can still send it; the answer must say where to go, and nothing
// may be read or written first.
describe('POST /api/schedule/time-off — AVAIL.3: unavailable is refused', () => {
  const COACH9 = '99999999-9999-4999-8999-999999999999'
  const HC = { id: 'hc', role: 'head_coach', profileRole: 'staff', full_name: 'Head', activeLocation: { id: 'loc-1' }, locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'head_coach' } }

  it.each([
    ['a contractor, for themselves', USER, 'contractor', {}],
    ['an employee, for themselves', USER, 'fte', {}],
    ['an approver, on a contractor\'s behalf', HC, 'contractor', { profile_id: COACH9 }],
  ])('400 with the My availability message: %s', async (_label, who, employmentType, extra) => {
    getCurrentUser.mockResolvedValue(who)
    const { db, insertSpy } = buildDb({ employmentType })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'unavailable', start_date: '2026-10-03', end_date: '2026-10-05', ...extra }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      success: false,
      error: expect.stringMatching(/^Unavailable is no longer a time-off request\..*My availability/),
    })
    expect(insertSpy).not.toHaveBeenCalled()
    // Refused before the database is even opened: no read, no write, no notice.
    expect(createServerClient).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('401 still comes first for a signed-out caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ type: 'unavailable', start_date: '2026-10-03', end_date: '2026-10-05' }))
    expect(res.status).toBe(401)
  })

  it('the type still parses, so the refusal (not "Invalid request body") is what an old phone sees', async () => {
    const { timeOffTypeSchema } = await import('@/lib/schemas')
    expect(timeOffTypeSchema.safeParse('unavailable').success).toBe(true)
  })
})
```

In `src/app/api/schedule/time-off/[id]/route.test.js`, in `'400 approving holiday for a contractor, and no allowance is created'` (line 312), replace `expect((await res.json()).error).toMatch(/Contractors/)` (line 318) with:

```js
    const error = (await res.json()).error
    expect(error).toMatch(/^Contractors don’t take leave\. Decline this request/)
    expect(error).not.toMatch(/file it as Unavailable/)
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run src/app/api/schedule/time-off/route.test.js 'src/app/api/schedule/time-off/[id]/route.test.js'`
Expected: the AVAIL.3 describe fails (201 instead of 400; `createServerClient` was called); both contractor-message tests fail on the words.

- [ ] **Step 3: Implement**

In `src/app/api/schedule/time-off/route.js`, change the shared import (lines 20-22) to:

```js
import {
  isTimeOffTypeAllowedFor, RESTRICTED_TYPE_ERROR, isExpiredPendingRequest, effectiveTimeOffStatus,
  isRequestableTimeOffType, UNAVAILABLE_MOVED_ERROR,
} from '@shared/time-off'
```

Directly after `const { type, start_date, end_date, reason, location_id, profile_id } = validation.data` (line 267) insert:

```js

  // AVAIL.3 — 'unavailable' moved into availability (mig 631): self-declared
  // in My availability, no approval. The forms no longer offer it; an old
  // phone or a stale tab still can, so refuse it here, before any read, with
  // words that say where to go (the old phone shows `error` in its alert).
  // Refused, not converted: a second writer to staff_unavailability outside
  // the replace RPC would race the coach's own editor, and the old phone
  // would then claim "your manager has been notified… track it under My leave".
  if (!isRequestableTimeOffType(type)) {
    return NextResponse.json({ success: false, error: UNAVAILABLE_MOVED_ERROR }, { status: 400 })
  }
```

In `src/app/api/schedule/time-off/[id]/route.js`, change line 13 to:

```js
import { isExpiredPendingRequest, isTimeOffTypeAllowedFor, timeOffLeaveLabel, CONTRACTOR_DECIDE_ERROR } from '@shared/time-off'
```

and replace lines 223-227:

```js
    if (!isTimeOffTypeAllowedFor(employmentType, existing.type)) {
      return NextResponse.json({
        success: false,
        error: 'Contractors can only be marked Unavailable. Decline this request and ask them to file it as Unavailable.',
      }, { status: 400 })
```

with:

```js
    if (!isTimeOffTypeAllowedFor(employmentType, existing.type)) {
      return NextResponse.json({ success: false, error: CONTRACTOR_DECIDE_ERROR }, { status: 400 })
```

(the `}` closing the `if` on line 228 stays).

In `src/lib/openapi.js`:
- line 4718: replace `Contractors may only file \`unavailable\` (400 otherwise).` with `AVAIL.3: \`unavailable\` is refused for everyone (400, before any read): saying when you cannot work is PUT /api/schedule/availability, self-declared with no approval. Contractors and casual staff have no leave types to file (400).`
- line 4722: replace the 400 description with `'Invalid dates, no studio to file against (no location_id and no active studio), type unavailable (moved to availability, AVAIL.3), no working days, contractor leave type, or insufficient holiday balance'`.
- line 4736: replace `and a contractor leave type other than unavailable (400).` with `and a contractor leave type other than unavailable (400; a pending unavailable request filed before AVAIL.3 can still be decided).`

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run src/app/api/schedule/time-off/route.test.js 'src/app/api/schedule/time-off/[id]/route.test.js' src/lib/openapi.test.js`
Expected: all passed. `'approves a contractor\'s unavailable leave without touching allowances'` ([id] test, line 323) still passes: deciding was not changed (decision 13). `'applies the contractor and balance rules to the PERSON, not the caller'` (line 633) still passes (status 400 only).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/time-off/route.js src/app/api/schedule/time-off/route.test.js \
  'src/app/api/schedule/time-off/[id]/route.js' 'src/app/api/schedule/time-off/[id]/route.test.js' src/lib/openapi.js
git commit -m "AVAIL.3 — POST time-off refuses unavailable before any read, and says where to go

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The phone's leave decisions (`mobile/lib/leave-form.js`)

**Files:**
- Modify: `mobile/lib/leave-form.js` (import line 18; lines 183-194; append)
- Test: `mobile/lib/leave-form.test.js`

- [ ] **Step 1: Write the failing tests**

In `mobile/lib/leave-form.test.js`, extend the import (lines 4-7):

```js
import {
  leavePreviewFrom, leaveDaysLabel, leaveDaysHint, pendingHolidayDays, leaveBalanceView, leaveBalanceLines,
  leaveClashSummary, submittedDays, leaveSubmittedMessage, leaveFloatingButtons,
  leaveRequestEntry, leaveFormGate,
} from './leave-form'
```

In the `leaveFloatingButtons` describe (line 223), replace the first test (lines 224-229) with:

```js
  it('a 390pt phone at the default text size keeps the full label', () => {
    expect(leaveFloatingButtons({ width: 390, fontScale: 1 })).toEqual({
      compact: false, requestLabel: 'Request time off', myLeaveLabel: 'My leave',
      requestA11y: 'Request time off', myLeaveA11y: 'My leave, your time-off requests',
      requestIcon: 'add', requestTarget: '/schedule/time-off-new',
    })
  })
```

and add inside the same describe:

```js
  it('AVAIL.3 — a contractor\'s request button opens My availability, full and compact', () => {
    expect(leaveFloatingButtons({ width: 390, fontScale: 1, employmentType: 'contractor' })).toMatchObject({
      compact: false, requestLabel: 'My availability', requestA11y: 'My availability, when you can’t work',
      requestIcon: 'time-outline', requestTarget: '/schedule/availability', myLeaveLabel: 'My leave',
    })
    expect(leaveFloatingButtons({ width: 320, fontScale: 1, employmentType: 'casual' }))
      .toMatchObject({ compact: true, requestLabel: 'Availability', requestTarget: '/schedule/availability' })
  })
```

Append at the end of the file:

```js
// AVAIL.3 — "unavailable" moved into availability: a contractor has nothing to
// request, so every entry that said "Request time off" opens My availability.
describe('leaveRequestEntry', () => {
  it('an employee (or unknown employment) requests time off', () => {
    for (const et of ['fte', null, undefined]) {
      expect(leaveRequestEntry(et)).toEqual({
        target: '/schedule/time-off-new', label: 'Request time off', shortLabel: 'Time off',
        a11y: 'Request time off', icon: 'add', rowIcon: 'calendar-outline',
      })
    }
  })
  it('a contractor or casual staff member is sent to My availability', () => {
    for (const et of ['contractor', 'casual']) {
      expect(leaveRequestEntry(et)).toEqual({
        target: '/schedule/availability', label: 'My availability', shortLabel: 'Availability',
        a11y: 'My availability, when you can’t work', icon: 'time-outline', rowIcon: 'time-outline',
      })
    }
  })
})

describe('leaveFormGate', () => {
  it('no gate for anyone with something to request', () => {
    expect(leaveFormGate('fte')).toBeNull()
    expect(leaveFormGate(undefined)).toBeNull() // profile still loading: never a false gate
  })
  it('a contractor reaching the form (old link, notification) is told where to go', () => {
    expect(leaveFormGate('contractor')).toEqual({
      title: 'Use My availability instead',
      message: expect.stringMatching(/My availability/),
      action: 'Open My availability',
      target: '/schedule/availability',
    })
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run mobile/lib/leave-form.test.js`
Expected: FAIL (`leaveRequestEntry is not a function`; the 390pt object lacks `requestIcon`).

- [ ] **Step 3: Implement**

Change the import at line 18 to:

```js
import {
  isRestrictedEmployment, timeOffTypeLabel, leaveDateRangeLabel, leavePreviewLine, canRequestTimeOff, AVAILABILITY_INSTEAD,
} from 'shared/time-off'
```

Replace `leaveFloatingButtons` (lines 183-194) with:

```js
export function leaveFloatingButtons({ width, fontScale, employmentType } = {}) {
  const w = Number(width)
  const scale = Number(fontScale) > 0 ? Number(fontScale) : 1
  const compact = !(Number.isFinite(w) && w >= FLOATING_TEXT_PT * scale + FLOATING_CHROME_PT)
  // AVAIL.3 — "My availability" is one character shorter than "Request time
  // off", so the same width estimate holds for both.
  const entry = leaveRequestEntry(employmentType)
  return {
    compact,
    requestLabel: compact ? entry.shortLabel : entry.label,
    myLeaveLabel: 'My leave',
    requestA11y: entry.a11y,
    myLeaveA11y: 'My leave, your time-off requests',
    requestIcon: entry.icon,
    requestTarget: entry.target,
  }
}
```

Append at the end of the file:

```js
// ── AVAIL.3: where "Request time off" goes ────────────────────────────────
//
// "Unavailable" moved into availability (mig 631). Contractors and casual
// staff had no other type, so for them every entry point that said "Request
// time off" (the Schedule tab's floating button, the Today shortcut) opens My
// availability instead. Unknown employment keeps the leave form, matching
// shared/time-off's "don't over-restrict a mis-typed FTE" (and a profile still
// loading never sends anyone the wrong way for long).
export function leaveRequestEntry(employmentType) {
  if (canRequestTimeOff(employmentType)) {
    return {
      target: '/schedule/time-off-new', label: 'Request time off', shortLabel: 'Time off',
      a11y: 'Request time off', icon: 'add', rowIcon: 'calendar-outline',
    }
  }
  return {
    target: '/schedule/availability', label: 'My availability', shortLabel: 'Availability',
    a11y: 'My availability, when you can’t work', icon: 'time-outline', rowIcon: 'time-outline',
  }
}

/** What the leave form shows INSTEAD of itself, or null to show the form. */
export function leaveFormGate(employmentType) {
  if (canRequestTimeOff(employmentType)) return null
  return {
    title: AVAILABILITY_INSTEAD.title,
    message: AVAILABILITY_INSTEAD.message,
    action: AVAILABILITY_INSTEAD.action,
    target: '/schedule/availability',
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run mobile/lib/leave-form.test.js && npm run check:mobile-imports`
Expected: all passed; `check:mobile-imports` resolves `canRequestTimeOff` and `AVAILABILITY_INSTEAD` in `shared/time-off.js`.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/leave-form.js mobile/lib/leave-form.test.js
git commit -m "AVAIL.3 — phone: a contractor's leave entry points open My availability (decisions + tests)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The phone screens (OTA bundle paths)

**Files:**
- Modify: `mobile/components/LeaveFloatingButtons.jsx`
- Modify: `mobile/app/(staff)/(tabs)/schedule.jsx:769-772`
- Modify: `mobile/components/dashboard/PersonalDashboard.jsx` (import after line 31; lines 772-783)
- Modify: `mobile/app/(staff)/schedule/time-off-new.jsx`

There is no React Native component test runner; every decision is in Task 4's lib. These edits only render it. `check:mobile-lint` is the gate for the `.jsx`.

- [ ] **Step 1: `LeaveFloatingButtons` renders the entry**

Add a line to the header comment after line 12: `// AVAIL.3 — for a contractor the request button opens My availability.` Replace the component (lines 18-46) with:

```jsx
export default function LeaveFloatingButtons({ onMyLeave, onRequest, employmentType }) {
  const { width, fontScale } = useWindowDimensions()
  // AVAIL.3 — for a contractor the right-hand button is "My availability".
  // onRequest gets the route to open; the screen owns the router.
  const b = leaveFloatingButtons({ width, fontScale, employmentType })
  return (
    <View
      pointerEvents="box-none"
      className="absolute bottom-6 left-6 right-6 flex-row flex-wrap-reverse items-center gap-2"
    >
      <Pressable
        onPress={onMyLeave}
        accessibilityRole="button"
        accessibilityLabel={b.myLeaveA11y}
        className="bg-un1t-surface border border-un1t-border rounded-full px-5 py-3.5 flex-row items-center shadow-lg active:opacity-80"
      >
        <Ionicons name="list-outline" size={18} color="#111827" />
        <Text className="text-un1t-text font-semibold ml-1.5">{b.myLeaveLabel}</Text>
      </Pressable>
      <Pressable
        onPress={() => onRequest(b.requestTarget)}
        accessibilityRole="button"
        accessibilityLabel={b.requestA11y}
        className="ml-auto bg-un1t-text rounded-full px-5 py-3.5 flex-row items-center shadow-lg active:opacity-80"
      >
        <Ionicons name={b.requestIcon} size={20} color="#FFFFFF" />
        <Text className="text-un1t-bg font-semibold ml-1.5">{b.requestLabel}</Text>
      </Pressable>
    </View>
  )
}
```

- [ ] **Step 2: The Schedule tab passes the employment type and opens the target**

In `mobile/app/(staff)/(tabs)/schedule.jsx`, replace lines 769-772:

```jsx
        <LeaveFloatingButtons
          onRequest={() => router.push('/schedule/time-off-new')}
          onMyLeave={() => router.push('/schedule/my-leave')}
        />
```

with:

```jsx
        <LeaveFloatingButtons
          employmentType={profile?.employment_type}
          onRequest={(target) => router.push(target)}
          onMyLeave={() => router.push('/schedule/my-leave')}
        />
```

`profile` is already in scope (it gates the buttons on line 768, `canMobile(profile, 'time_off', activeLocation)`).

- [ ] **Step 3: The Today shortcut**

In `mobile/components/dashboard/PersonalDashboard.jsx`, after the import on line 31 (`import { myLeaveCancelOutcome } from '../../lib/my-leave'`) add:

```js
import { leaveRequestEntry } from '../../lib/leave-form'
```

Replace lines 772-783 (the comment and the `<Pressable>` that pushes `/schedule/time-off-new`) with:

```jsx
      {/* Request time off — top-of-page shortcut, directly under Needs
          attention, so a coach can request leave without scrolling past the
          roster or hopping to the Schedule tab. AVAIL.3: for a contractor it
          opens My availability (they have no leave types). */}
      {(() => {
        const entry = leaveRequestEntry(profile?.employment_type)
        return (
          <Pressable
            onPress={() => router.push(entry.target)}
            accessibilityRole="button"
            accessibilityLabel={entry.a11y}
            className="flex-row items-center bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-3.5 mb-3 active:opacity-70"
          >
            <Ionicons name={entry.rowIcon} size={18} color="#64748B" />
            <Text className="text-sm font-medium text-un1t-text ml-2.5">{entry.label}</Text>
            <View className="flex-1" />
            <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
          </Pressable>
        )
      })()}
```

(`profile` comes from `useAuth()` at line 405 in the same component.)

- [ ] **Step 4: The leave form gates itself**

In `mobile/app/(staff)/schedule/time-off-new.jsx`:

1. Add to the header comment after line 16:
   ```js
   //
   // AVAIL.3 — a contractor (or casual staff member) has no leave types left:
   // "unavailable" moved into My availability. Reached anyway (an old link, a
   // notification), the screen says so and offers My availability instead of
   // showing an empty form. The gate is decided in lib/leave-form.js.
   ```
2. Change the `leave-form` import (lines 27-30) to add `leaveFormGate`:
   ```js
   import {
     leavePreviewFrom, leaveDaysLabel, leaveDaysHint, leaveBalanceView, leaveBalanceLines, leaveClashSummary,
     submittedDays, leaveSubmittedMessage, leaveFormGate,
   } from '../../../lib/leave-form'
   ```
3. Rename `export default function TimeOffNew() {` (line 36) to `function TimeOffForm() {`. Its body is unchanged.
4. Insert ABOVE it (the gate is its own component, so the form's hooks never run conditionally):

```jsx
export default function TimeOffNew() {
  const { profile } = useAuth()
  const gate = leaveFormGate(profile?.employment_type)
  if (gate) return <UseAvailabilityInstead gate={gate} />
  return <TimeOffForm />
}

function UseAvailabilityInstead({ gate }) {
  const router = useRouter()
  function close() {
    if (router.canGoBack()) router.back()
    else router.replace('/(tabs)/schedule')
  }
  return (
    <View className="flex-1 bg-un1t-bg p-4">
      <Stack.Screen
        options={{
          title: 'Time off',
          headerLeft: () => (
            <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
              <Text className="text-base text-un1t-text">Close</Text>
            </Pressable>
          ),
        }}
      />
      <View className="bg-un1t-surface border border-un1t-border rounded-xl px-4 py-4">
        <Text accessibilityRole="header" className="text-base font-semibold text-un1t-text">{gate.title}</Text>
        <Text className="text-sm text-un1t-subtle mt-1">{gate.message}</Text>
        <Pressable
          onPress={() => router.replace(gate.target)}
          accessibilityRole="button"
          accessibilityLabel={gate.action}
          className="mt-4 bg-un1t-text rounded-full px-5 py-3 items-center active:opacity-80"
        >
          <Text className="text-un1t-bg font-semibold">{gate.action}</Text>
        </Pressable>
      </View>
    </View>
  )
}
```

`View`, `Text`, `Pressable`, `useRouter`, `Stack` and `useAuth` are already imported (lines 19-25).

- [ ] **Step 5: Lint and the import check**

Run: `npm run check:mobile-lint && npm run check:mobile-imports && npm run check:ota-paths`
Expected: all exit 0 (`react-hooks/rules-of-hooks` holds because `TimeOffForm` is its own component; no new top-level `mobile/` entry).

- [ ] **Step 6: Commit**

```bash
git add mobile/components/LeaveFloatingButtons.jsx 'mobile/app/(staff)/(tabs)/schedule.jsx' \
  mobile/components/dashboard/PersonalDashboard.jsx 'mobile/app/(staff)/schedule/time-off-new.jsx'
git commit -m "AVAIL.3 — phone: contractors' Request time off becomes My availability; the form gates itself

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web "My roster" (dashboard) — button and modal

**Files:**
- Modify: `src/components/dashboard/RequestTimeOffModal.jsx` (line 12; before line 81; comment lines 99-100)
- Modify: `src/components/dashboard/MonthRoster.jsx` (imports lines 29, 35; lines 601-608)
- Create: `src/components/dashboard/RequestTimeOffModal.test.jsx`
- Create: `src/components/dashboard/MonthRoster.availability.test.jsx`

- [ ] **Step 1: Write the failing tests**

`src/components/dashboard/RequestTimeOffModal.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// AVAIL.3 — the dashboard's time-off modal: a contractor has nothing to
// request ("unavailable" moved into availability), so the modal points at My
// availability instead of showing a one-option form; an employee's form never
// offers Unavailable.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import RequestTimeOffModal from './RequestTimeOffModal'

afterEach(() => cleanup())

describe('RequestTimeOffModal — AVAIL.3', () => {
  it('a contractor gets My availability, not a form', () => {
    render(<RequestTimeOffModal open onClose={() => {}} employmentType="contractor" />)
    expect(screen.getByText('Use My availability instead')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open My availability' }).getAttribute('href')).toBe('/schedule/availability')
    expect(screen.queryByRole('button', { name: 'Submit request' })).toBeNull()
    expect(screen.queryByLabelText('From')).toBeNull()
  })

  it('an employee still gets the four leave types, and no Unavailable', () => {
    render(<RequestTimeOffModal open onClose={() => {}} employmentType="fte" />)
    const options = Array.from(screen.getByLabelText('Type').options).map((o) => o.value)
    expect(options).toEqual(['holiday', 'sick', 'unpaid', 'other'])
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeTruthy()
  })
})
```

`src/components/dashboard/MonthRoster.availability.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// AVAIL.3 — "My roster"'s header: a contractor gets a My availability link
// where everyone else gets "Request time off".

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import MonthRoster from './MonthRoster'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

const weeks = [[{ iso: '2099-06-10', dayNum: 10, inMonth: true, isToday: false, isPast: false, shifts: [] }]]
const renderFor = (employmentType) =>
  render(<MonthRoster weeks={weeks} monthLabel="June 2099" monthSummary="" weekPanels={[]} employmentType={employmentType} />)

afterEach(() => cleanup())

describe('MonthRoster header — AVAIL.3', () => {
  it('a contractor gets a My availability link, no Request time off button', () => {
    renderFor('contractor')
    expect(screen.getByRole('link', { name: 'My availability' }).getAttribute('href')).toBe('/schedule/availability')
    expect(screen.queryByRole('button', { name: 'Request time off' })).toBeNull()
  })

  it('an employee (or unknown employment) keeps Request time off', () => {
    renderFor('fte')
    expect(screen.getByRole('button', { name: 'Request time off' })).toBeTruthy()
    cleanup()
    renderFor(undefined)
    expect(screen.getByRole('button', { name: 'Request time off' })).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run src/components/dashboard/RequestTimeOffModal.test.jsx src/components/dashboard/MonthRoster.availability.test.jsx`
Expected: FAIL (the contractor still sees a form with "Type: Unavailable"; no link).

- [ ] **Step 3: Implement**

`src/components/dashboard/RequestTimeOffModal.jsx`:
- Replace line 12 with:
  ```js
  import Link from 'next/link'
  import { timeOffTypesFor, defaultTimeOffTypeFor, canRequestTimeOff, AVAILABILITY_INSTEAD } from '@shared/time-off'
  ```
- Directly before `return (` (line 81) insert:

```jsx
  // AVAIL.3 — nothing to request (a contractor): "unavailable" moved into My
  // availability, so say where to go instead of showing an empty form.
  if (!canRequestTimeOff(employmentType)) {
    return (
      <Modal
        open={open}
        onClose={handleClose}
        title={AVAILABILITY_INSTEAD.title}
        size="sm"
        footer={<Button type="button" variant="secondary" onClick={handleClose}>Close</Button>}
      >
        <p className="text-sm text-un1t-subtle">{AVAILABILITY_INSTEAD.message}</p>
        <Link href="/schedule/availability" className="mt-3 inline-block text-sm font-medium text-un1t-text underline">
          {AVAILABILITY_INSTEAD.action}
        </Link>
      </Modal>
    )
  }
```

- Update the comment at lines 99-100 to: `{/* Type — dropdown when the employee has a choice; a static line when only one type is allowed. Contractors never reach here (AVAIL.3). */}`.

`src/components/dashboard/MonthRoster.jsx`:
- Change line 29 to `import { CalendarOff, CalendarX, RefreshCw } from 'lucide-react'` and add after line 35:
  ```js
  import Link from 'next/link'
  import { canRequestTimeOff } from '@shared/time-off'
  ```
- Replace lines 601-608 (the "Request time off" `<button>`) with:

```jsx
          {canRequestTimeOff(employmentType) ? (
            <button
              type="button"
              onClick={() => { setTimeOffSuccess(false); setTimeOffOpen(true) }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-un1t-border bg-un1t-surface text-xs text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border transition-colors"
            >
              <CalendarOff size={13} aria-hidden="true" />
              Request time off
            </button>
          ) : (
            // AVAIL.3 — contractors have no leave types; "unavailable" is My availability.
            <Link
              href="/schedule/availability"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-un1t-border bg-un1t-surface text-xs text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border transition-colors"
            >
              <CalendarX size={13} aria-hidden="true" />
              My availability
            </Link>
          )}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run src/components/dashboard/`
Expected: all passed, including `MonthRoster.adjust.test.jsx` and `MonthRoster.briefing.test.jsx` (they pass no `employmentType`, so the button stays).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/RequestTimeOffModal.jsx src/components/dashboard/RequestTimeOffModal.test.jsx \
  src/components/dashboard/MonthRoster.jsx src/components/dashboard/MonthRoster.availability.test.jsx
git commit -m "AVAIL.3 — web My roster: contractors get My availability, the modal points there too

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web Time Off page — header button and the form

**Files:**
- Modify: `src/components/TimeOffManager.jsx` (imports lines 3-8; header button 309-315; form 766-770, 813, 874-981)
- Test: `src/components/TimeOffManager.leave.test.jsx` (tests at lines 108-117 and 131-133)

- [ ] **Step 1: Write the failing tests**

In `src/components/TimeOffManager.leave.test.jsx`, replace `'a contractor is offered Unavailable only'` (lines 108-117) with:

```jsx
  it('AVAIL.3 — a contractor gets a My availability link instead of Request Time Off', async () => {
    mockFetch({ requests: [] })
    await act(async () => { render(<TimeOffManager user={CONTRACTOR} canApprove={false} />) })
    expect(screen.getByRole('link', { name: 'My availability' }).getAttribute('href')).toBe('/schedule/availability')
    expect(screen.queryByRole('button', { name: /Request Time Off/ })).toBeNull()
  })
```

In `'an approver can record leave for a colleague; types follow that person'`, replace the contractor block (lines 131-133):

```jsx
    fireEvent.change(select, { target: { value: 'c1' } })
    let dialog = screen.getByRole('dialog')
    expect(Array.from(dialog.querySelectorAll('button[aria-pressed]')).map((b) => b.textContent.trim())).toEqual(['Unavailable'])
```

with:

```jsx
    // AVAIL.3 — a contractor has nothing to record: a note, no types, no submit.
    fireEvent.change(select, { target: { value: 'c1' } })
    let dialog = screen.getByRole('dialog')
    expect(dialog.querySelectorAll('button[aria-pressed]')).toHaveLength(0)
    expect(dialog.textContent).toMatch(/Contractors don’t take leave, so there is nothing to record here/)
    expect(screen.queryByRole('button', { name: 'Record Time Off' })).toBeNull()
```

The rest of the test (switching to `f1`, Sick, posting) is unchanged and must still pass.

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run src/components/TimeOffManager.leave.test.jsx`
Expected: FAIL (the contractor still sees the button; the on-behalf dialog still offers Unavailable).

- [ ] **Step 3: Implement**

Imports: add after line 3 `import Link from 'next/link'`; change line 5 to add `CalendarX`:

```js
import { CalendarOff, CalendarX, Plus, Check, X, Palmtree, ThermometerSun, Ban, Wallet, CircleEllipsis, AlertTriangle } from 'lucide-react'
```

and line 8 to:

```js
import { timeOffTypesFor, defaultTimeOffTypeFor, leaveClashLabel, leaveClashPrompt, canRequestTimeOff, AVAILABILITY_INSTEAD } from '@shared/time-off'
```

Header button: replace lines 309-315 with:

```jsx
        {/* AVAIL.3 — a contractor who is not an approver has nothing to request
            ("unavailable" moved into My availability). An approver keeps the
            button: they record leave for colleagues. */}
        {!isManager && !canRequestTimeOff(user.employment_type) ? (
          <Link
            href="/schedule/availability"
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-un1t-text text-un1t-bg font-medium hover:bg-un1t-accent transition-colors"
          >
            <CalendarX size={16} aria-hidden="true" /> My availability
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-un1t-text text-un1t-bg font-medium hover:bg-un1t-accent transition-colors"
          >
            <Plus size={16} /> Request Time Off
          </button>
        )}
```

In `TimeOffFormModal`, replace the LEAVE.3 comment at lines 766-767 with:

```js
  // LEAVE.3 — the menu follows the PERSON the leave is for. AVAIL.3: a
  // contractor has no types left ("unavailable" moved into availability), so
  // the form shows AVAILABILITY_INSTEAD in place of itself.
```

and after line 770 (`const effectiveType = …`) add:

```js
  const nothingToRequest = typeOptions.length === 0
```

At the top of `handleSubmit`, after `e.preventDefault()` (line 813), add:

```js
    if (nothingToRequest) return
```

Wrap the form body from the Type selection comment (line 874, `{/* Type selection — the shared catalogue, gated by the employment`) through the closing `</p>` (line 981) in a conditional. Insert before line 874:

```jsx
          {nothingToRequest ? (
            <div role="note" className="rounded-lg border border-un1t-border bg-un1t-surface p-3 text-sm text-un1t-subtle">
              {onBehalf ? AVAILABILITY_INSTEAD.onBehalf : (
                <>
                  {AVAILABILITY_INSTEAD.message}{' '}
                  <Link href="/schedule/availability" className="font-medium text-un1t-text underline">
                    {AVAILABILITY_INSTEAD.action}
                  </Link>
                </>
              )}
            </div>
          ) : (
          <>
```

and after the `</p>` at line 981 (before `</form>` at line 982):

```jsx
          </>
          )}
```

The lines between are unchanged (re-indenting them is optional; do not change their content).

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run src/components/TimeOffManager.leave.test.jsx src/components/TimeOffManager.a11y.test.jsx src/components/TimeOffManager.cancel.test.jsx src/components/TimeOffManager.days.test.jsx`
Expected: all passed. `'Approve Unavailable request from Sam Demo'` (the pending row in the approver tests) still renders: history keeps its label, and deciding a pending unavailable request did not change.

Run: `npm run lint && npm run check:guardrails`
Expected: 0 (every `<button>` inside the form still has `type`; internal links are `<Link>` per `@next/next/no-html-link-for-pages`).

- [ ] **Step 5: Commit**

```bash
git add src/components/TimeOffManager.jsx src/components/TimeOffManager.leave.test.jsx
git commit -m "AVAIL.3 — web Time Off: contractors get My availability; the form says so for them and on their behalf

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine).

- [ ] **Focused tests, date code in both zones:**

```bash
npx vitest run tests/migration-631-unavailable-time-off-to-availability.test.js tests/migration-630-staff-availability.test.js \
  shared/time-off.test.js mobile/lib/leave-form.test.js src/app/api/schedule/time-off/ src/components/TimeOffManager \
  src/components/dashboard/ src/lib/openapi.test.js tests/ota-trigger-paths.test.js
for tz in Europe/Dublin America/Los_Angeles; do
  TZ=$tz npx vitest run tests/migration-631-unavailable-time-off-to-availability.test.js mobile/lib/leave-form.test.js
done
```

Expected: `0 failed` every time.

- [ ] **The 12-command CI mirror, then the build:**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
npm run build
```

Expected: every command exits 0; `✓ Compiled successfully`.

- [ ] **On the PR:** **Test & lint** and **Next build** (required) green on the final rebase, and **Mobile bundle export** green (it bundles the changed `.jsx`).

- [ ] **Independent review** (standing rule). Point the reviewer at:
  - The migration against decisions 1-9: the carry predicate, the split arithmetic (`total_days` for a split row), the dedupe `DISTINCT ON`, the four guards, the in-function proofs, the restore's byte-for-byte promise and its `restored_rule_changed` path, and that nothing writes `staff_availability_changes`.
  - That no reader shows a carried day twice or loses one: CANDIDATES.1 (`src/lib/candidates-data.js:88-103`, approved leave only), GRID.1 (`src/lib/roster-grid-model.js:226-227`, leave shadows availability), the web week view, the phone Schedule tab (`schedule.jsx`'s `todaysLeave`), My leave.
  - The refusal sits after auth and before `createServerClient()`; the old phone's alert shows `error` (`time-off-new.jsx:161-163`).
  - The phone in the iOS Simulator as a contractor test account: the floating button reads "My availability" and opens the availability sheet; the Today shortcut too; a deep link to `/schedule/time-off-new` shows the gate. 🔴 The simulator talks to PROD: look, do not save.

### Merge steps (after review is approved and the gate is green)

1. Rebase on `origin/main`, wait for the required checks, merge (auto-merge).
2. Watch the prod deployment and the EAS Update run. **One phone update at a time.**
3. Apply mig 631 (DEPLOY ORDER step 2), with every pre- and post-check. Record the rollback file in the scratchpad.
4. Post-check (p) in the browser, (q) 30 minutes later.
5. Tell Richard the counts, so he can tell the contractors: their Unavailable days are now under My availability, and they add new ones there.

### PR

**Title:** `AVAIL.3 — contractors' "unavailable" time off moves into availability (mig 631 after deploy, OTA)`

**Body must say, in this order:**
1. **Depends on AVAIL.1a/1b (#1762/#1763, mig 630) and AVAIL.2 (#1765), all live.**
2. **🔴 This merge publishes an OTA at 100%** (`shared/time-off.js`, `mobile/lib/leave-form.js`, `mobile/components/…`, `mobile/app/…`). No native dependency, no `runtimeVersion` bump, no new top-level `mobile/` entry.
3. **🔴 Mig 631 is applied AFTER the prod deploy**, not before: the code does not depend on it, and applying after means the door that creates `unavailable` requests is shut before the move runs. Pre/post checks, the fingerprints and the rollback (`restore_moved_unavailable_time_off()`, tested) are in the file header. Expected advisor change: `rls_enabled_no_policy` +1.
4. The carry set counted at Task 0 (25 Sep: 11 rows, 5 contractors, 9 moved + 2 split, 81 person-days, 0 pending), and what stays (28 past rows, every other type).
5. What people see: no form offers Unavailable; contractors' "Request time off" (phone floating button and Today shortcut, web My roster, web Time Off header) is "My availability"; a form reached anyway says "Use My availability instead". An old phone that files Unavailable gets "Unavailable is no longer a time-off request. Set the days and times you can't work in My availability…" in its Couldn't submit alert (refused, not converted: decision 11).
6. What cannot change: leave balances (the allowance trigger acts on holiday only; PGlite-proven with the real mig 616 function), pay (payroll and invoices do not read time off), manager notices (no change rows are written; the sweep has nothing owed). Every carried day is shown once: future days as availability, days already gone as time off.
7. Deciding a pending Unavailable request still works (for the minutes between deploy and apply).
8. Test counts per file; CI mirror + build green.
9. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit a pushed row (`merge=union`).

```
| #<PR> | AVAIL.3 — contractors' "unavailable" time off moves into availability | 2026-09-2x. Wave 2 PR 18. **Mig 631, applied AFTER the deploy**; **OTA** (shared/time-off, mobile lib/components/app). Nobody files `unavailable` any more: `shared/time-off` `isRequestableTimeOffType`/`canRequestTimeOff`; contractors + casual have no leave types, so "Request time off" is "My availability" on the phone (floating button, Today shortcut) and the web (My roster, Time Off header for non-approvers); a form reached anyway shows "Use My availability instead". `POST /api/schedule/time-off` refuses `unavailable` for everyone, before any read, with a message naming My availability (an old phone shows it in its alert; refused, not converted). Mig 631: service-role ledger `time_off_availability_moves` (full original row, the rule, inserted or reused) + `move_unavailable_time_off_to_availability(date)` (approved or pending, end ≥ Dublin today, not tombstoned; future rows deleted, started rows split at today so the elapsed days stay time off; one all-day dated rule per distinct range, note = trimmed reason, an identical existing rule reused; guards for an open cancel ask, note >200, >730 days ahead, >60 dates; proves no day lost; idempotent) + `restore_moved_unavailable_time_off()` (byte-for-byte rollback, tested). No `staff_availability_changes` rows, so no manager notices; the allowance trigger acts on holiday only, so no balance moves. Carried <n> rows / <p> people (25 Sep count: 11 / 5). |
```

Also correct nothing in the index row 18: it already says mig 631 and OTA yes.

---

### Review notes / open questions (for Richard)

1. **Managers can no longer record a contractor's absence.** Before, an approver could record "Unavailable" for a contractor who phoned in (none of the 39 rows were recorded that way). Now there is no type to record, and managers cannot set availability on a coach's behalf (index default 19). The workaround is to take the contractor off the shift. Should managers be able to set a coach's availability for them? It would need a `profile_id` on the availability PUT, a manager gate and a notice to the coach.
2. **A pending Unavailable request becomes availability with no manager decision and no notice.** There were none on 25 Sep; the pre-check lists any at apply time. Consistent with "no approval", but a manager who had one waiting will see it vanish from the approvals queue.
3. **Reports.** The Time Off Summary and Roster Coverage reports read `time_off_requests`, so future Unavailable days drop out of them after the move (past periods are unchanged). Should those reports gain an availability section, or is availability not report material?
4. **Telling the contractors.** The move sends no push by design. Six people are affected; a line from Richard in the team chat ("your Unavailable days are now under My availability; add new ones there") is cheaper than a one-off notification path.
5. **The ledger and the two functions stay.** Propose dropping them in a forward migration once the move has held for a month (no restore wanted).
6. **Casual staff** are treated like contractors (no leave types, sent to My availability). There are none today.
7. **The database still accepts a new `unavailable` row.** The server refuses it, and no other writer exists (the staff assistant has no create tool). A `CHECK … NOT VALID` cannot be used: it would also refuse the split UPDATE, the restore, and status changes on the 28 past rows. A `BEFORE INSERT` trigger refusing the type is possible if Richard wants the database itself to hold the line.
8. **A rule carried from a note-bearing request shows that note to managers** (AVAIL.1 decision: managers see notes). Managers already saw the same text as the request's reason.

### Follow-ups found while planning (not in this PR)

- 🔴 The Time Off Summary report drops any request that crosses the report's period edge: it selects `.gte('start_date', period_start).lte('end_date', period_end)` (`src/lib/report-generator.js:312-317`), so leave spanning a month end is in neither month's report. (After this PR a split row, now ending yesterday, newly fits inside the current month's report.) It also discards the read error (already listed in the index).
- `RequestTimeOffModal`'s `todayIso()` builds "today" from the browser's local date (`src/components/dashboard/RequestTimeOffModal.jsx:14-17`), not Dublin's (`dublinTodayStr`), so the date picker's minimum can be a day off for a browser in another zone around midnight.
- `shared/time-off.js`'s old comment said "36 approved `unavailable` rows predate this"; there were 39. This PR's comment rewrite removes it.
