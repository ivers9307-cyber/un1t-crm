## PR AVAIL.1 — coach availability: weekly unavailable windows and dated exceptions, managers told, shaded on the web roster

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A coach declares when they CANNOT work: weekly windows (a weekday and a time, or the whole day) and dated exceptions (a date or a date range, all day or a time window, with an optional note). Everything else counts as available. There is no approval. The managers at every studio the coach belongs to get ONE push per save (inside 07:00–22:00 studio time; a save outside the band is told at 07:00). On the web, the manager's week view shades a coach's unavailable windows beside the leave bars, and the assign-coach picker shows an advisory "Unavailable: …" badge that never blocks.

**Why:** Coaches already say "I can't do Tuesdays" through time off: 39 `time_off_requests` rows of type `unavailable` live on 25 Sep (read-only query), each one a one-off request a manager has to approve, and none of them recurring. Nothing tells a manager building a week who cannot do which slot. CANDIDATES.1 (19), GRID.1 (21), REPLACE.1 (20) and AVAIL.2/3 (17/18) all read what this PR stores.

**Richard's decisions (don't reopen):** self-declared, no approval, managers notified of changes. **Index defaults applied:** (1) per PERSON, not per studio, declared as UNAVAILABLE windows; (2) managers told once per save, at every studio the coach belongs to, inside the 07:00–22:00 notice band.

**Split: two PRs, merged in this order.** One PR would be ~25 files across a migration, a cron arm, a route, a notification category and three web surfaces; independent review of that is where defects hide. The seam is clean: 1a is everything the phone (AVAIL.2) needs and everything with a deploy order; 1b is web UI only.

| PR | What | Mig | OTA on merge | Depends on |
|---|---|---|---|---|
| **AVAIL.1a** | mig 630 + `shared/availability.js` + `notify_availability_change` registration + `/api/schedule/availability` (GET own, PUT own, GET studio range) + manager notice (immediate in band, deferred by a third arm of the `*/15` checklist-sweep cron) + OpenAPI | 630 | **yes** (`shared/**` is a bundle path; see below) | batch 2 merged (13, 15) |
| **AVAIL.1b** | web "My availability" page under Schedule, the calendar's seventh data slice, unavailable bars in the week view, the picker badge | — | no | AVAIL.1a merged |

**AVAIL.1a publishes an OTA, and the index says it does not.** `shared/availability.js`, `shared/permissions.js`, `shared/permission-bundles.js` and `shared/push-channels.js` all change, and `shared/**` is in `eas-update.yml`'s publish trigger (CLAUDE.md, "A push to `main` touching a bundle path PUBLISHES AN OTA"). What phones get: one new toggle, "… Availability changes", in the notification settings screen (it renders from `MOBILE_PERMISSIONS`), and a module nothing on the phone imports yet. Harmless, but it IS a publish: merge one phone update at a time and check the EAS Update run before the next (index, merge authority). Correct the index row 16 "OTA" cell when this merges.

**Tech Stack:** Postgres (plpgsql RPC, SECURITY INVOKER, service_role only), Next.js 16 route + `after()`, Supabase service-role client, Zod 4, pure JS in `shared/`, React client components, Vitest (node, jsdom, PGlite).

**Worktree:** each PR in its own fresh worktree off `origin/main` (`git fetch origin main && git worktree add ../un1t-crm-avail1a -b avail-1a origin/main`, then `npm ci`). Never `git stash` (shared stack). Tests: `npx vitest run <file>`.

**Neighbours checked (plans on disk 25 Sep):** HEARTBEAT.1 (31, same batch) edits `send-push-reminders` and `contract-reminders`, not `checklist-sweep`, so the third arm below does not collide with it. WORKTIME.1 (15) adds a `useEffect`, a `wt` lookup and badges inside `AssignCoachModal`; SHIFTTYPE.1 (13) adds an import and `cardTone` changes to `roster-card-model.js`. AVAIL.1b rebases onto both (Task 11 says where each insertion goes).

---

### Decisions this plan makes (each flagged again in Review notes)

1. **One rules table with a `kind`, not two tables.** `staff_unavailability(kind IN ('weekly','dated'))` with per-kind CHECKs. The two kinds share every column except the day selector (a weekday, or a date range), every reader wants both (the picker asks "any rule on this date"), and the save replaces both in one transaction. One table = one grant posture, one index, one replace statement, one manager range query. The cost is nullable columns guarded by a CHECK instead of NOT NULL, which the self-check and the PGlite test pin.
2. **Weekday codes are `'mon'..'sun'` text**, exactly `shift_templates.days_of_week` (CHECK in `supabase/migrations/067_roster_v2_shift_blocks.sql:38-40`) and `WEEKDAY_CODES` (`src/lib/roster.js:19`). Not integers: an integer would need a Monday=0 vs JS Sunday=0 decision the rest of the schedule code never had to make. A test pins `AVAILABILITY_WEEKDAYS` equal to `WEEKDAY_CODES`.
3. **FKs:** `profile_id → profiles ON DELETE CASCADE`, `actor_id → profiles ON DELETE SET NULL`. A staff profile is never deleted (mig 622 tombstones it), so both are inert. CASCADE rather than RESTRICT for the rules because a rule about a person who no longer exists has no history value (unlike leave or pay), matching `time_off_requests`/`shift_assignments`; SET NULL for the actor because an audit row must survive its actor, matching `roster_change_log.actor_id` (mig 236:17).
4. **Service-role only: RLS enabled, NO policies, NO browser grants.** Every reader is an `/api` route (the phone in AVAIL.2 uses the same route with its Bearer token), nothing needs realtime, and it is the posture of the 47 tables `get_advisors` already lists under `rls_enabled_no_policy` (INFO; read 25 Sep: `equipment`, `issues`, `checklist_instances`, …). It follows mig 625's direction (the browser lost its writes to leave). An owner-reads-own + manager-reads RLS model was considered and rejected: it is policy surface nobody calls, and mig 626 shows how much care each such policy costs. Expected advisor change after apply: `rls_enabled_no_policy` 47 → 49, nothing else.
5. **An RPC does the save**, `public.replace_staff_unavailability(...)`, so "replace my weekly set and my current/future dates, and log it" is one transaction under a per-person advisory lock. Two PostgREST calls (delete, insert) would lose a coach's whole availability on a failure between them. It returns `changed: false` without writing when nothing changed, so a repeated Save neither logs nor notifies.
6. **Past dated exceptions are history.** A save replaces weekly rules and dated rules whose `end_date >= today` (Dublin). Rules that ended before today are kept, never returned by the own GET, never offered for edit, and a save may not add one (`availability_past_date`).
7. **No `updated_at`.** Rules are replaced, never edited in place; `created_at` is when that version was saved.
8. **Audit = `staff_availability_changes`, one row per real change**, with the before/after snapshot, the actor (the master's id under "View as user"), and the notice state (`notified_at`, `notice_outcome`). It doubles as the deferred-notice queue: the cron arm reads the rows whose notice is still owed. Not `roster_change_log`: that table is per location and per block (mig 236), and availability is per person.
9. **Registered category, not categoryless.** `category: 'availability_change'` → key `notify_availability_change`, Android channel `updates`, no email fallback. It is a preference a manager may reasonably mute, so it gets a toggle (CLAUDE.md: categoryless is for operational notices that aren't a preference). **Default ON for all six roles**, like `notify_shift_reminder`, NOT only the manager roles: `sendPushOnce` passes no `locationId`, so `resolvePushAllowedIds` suppresses a recipient when ANY of their assignments resolves the key false (`src/lib/push.js:127-131`). An owner who also holds a `staff` row somewhere (PUSH-LOC.1, `src/lib/push.js:137-142`) would never hear. Recipients are narrowed to roster builders per studio in code, so a staff-role default ON sends nothing extra.
10. **Recipients:** active profiles at each of the coach's studios with per-studio role `owner`, `manager` or `head_coach` (`RUNWAY_NOTIFY_ROLES`, `src/lib/roster-runway-notify.js:47`: the people who build rosters), plus masters linked to the studio (the `resolveRoleRecipientIds` rule, `src/lib/push.js:364-379`), minus the coach. Read with its own query because `resolveRoleRecipientIds` discards its read error (`const { data: links }`), and "the read failed" must never be stamped as "nobody to tell".
11. **Quiet hours defer, never drop.** `src/lib/staff-push-hours.js` is the rule (07:00 inclusive to 22:00 exclusive at the studio's `locations.timezone`; every studio is `Europe/Dublin` today, read 25 Sep). Unlike `time_off_inbound` and the leave cancel ask (`src/app/api/schedule/time-off/[id]/route.js:416-418` send with no band "because there is no later tick"), availability is not a decision anyone must take tonight, so it waits: the save sends at once when in band; otherwise the row stays un-notified and the checklist-sweep arm tells the managers on the first tick at or after 07:00. Several overnight saves by one coach become ONE notice (earliest `before` against latest `after`). A notice older than 24 hours is dropped as `stale` (the swap expiry notice's rule, `EXPIRY_NOTICE_MAX_AGE_MS`, `src/lib/swap-cover.js:222`). Quiet hours gate the notice, never the save.
12. **The cron arm is a third arm of `/api/cron/checklist-sweep`** (`*/15`), isolated exactly like COVERLOOP.1's swap arm, with a heartbeat row of its own, `availability-notice-sweep`, inserted by mig 630 (the SWAPHB.1 lesson, mig 623: an arm whose failures only reach `last_outcome` pages nobody). Not `send-push-reminders`: HEARTBEAT.1 (31, same batch) edits that route.
13. **Duplicate protection:** every notice goes through `sendPushOnce(db, 'availability_changed:<change id>', …)` (`src/lib/push-dedup.js`), so the route's immediate send, a retry and the sweep can never double-push a manager; a manager at both studios gets one push per save. `notified_at` is stamped AFTER the send (CLAUDE.md BAREWRITE (c): never claim-before-send without a lease).
14. **Managers see the coach's note.** The editor says so.
15. **Overnight windows are not supported** (end must be after start on the same day); a shift that crosses midnight is judged against the whole day. Said in the editor and in `shared/availability.js`.

---

### File map

**AVAIL.1a**

| File | Change |
|---|---|
| `supabase/migrations/630_staff_availability.sql` (create) | two tables, the RPC, grants, heartbeat row, self-check |
| `tests/migration-630-staff-availability.test.js` (create) | PGlite replay: grants, CHECKs, the RPC's replace / no-op / history / past-date rules |
| `shared/availability.js` (create) | pure rules: normalise, validate, `rulesOnDate`, `unavailableFor`, `unavailableSummary`, `describeRule`, `diffAvailability` |
| `shared/availability.test.js` (create) | the table |
| `shared/permissions.js` (modify: after line 720; six role blocks at lines 787, 826, 868, 904, 944, 986) | `notify_availability_change`, default ON everywhere |
| `shared/permission-bundles.js` (modify: lines 335, 380, after 397) | `EXEMPT_KEYS` literal + the two "26 personal" comments → 27 |
| `shared/push-channels.js` (modify: after line 101) | `availability_change: 'updates'` |
| `src/lib/notifications-registry.js` (modify: after the `contract_issued` entry, before `])` at line 260) | registry entry |
| `src/lib/availability-change-registration.test.js` (create) | pins every registration site |
| `src/lib/push-channels.test.js` (modify: `STAFF_TYPES`, lines 14-29) | `'availability_changed'` |
| `src/lib/availability-server.js` (create) | Zod body schema, own read, save (RPC), studio range read |
| `src/lib/availability-server.test.js` (create) | |
| `src/lib/availability-notify.js` (create) | notice text, band split, recipient read, `deliverAvailabilityNotice`, `runAvailabilityNoticeSweep` |
| `src/lib/availability-notify.test.js` (create) | |
| `src/app/api/schedule/availability/route.js` (create) | GET own, GET studio range, PUT own |
| `src/app/api/schedule/availability/route.test.js` (create) | |
| `src/app/api/cron/checklist-sweep/route.js` (modify) | third arm + its heartbeat |
| `src/app/api/cron/checklist-sweep/route.test.js` (modify) | mock the arm; `stampedNames` ignores the new row; new describe block |
| `src/lib/openapi.js` + `src/lib/openapi.test.js` (modify) | GET + PUT registered |
| `eslint.guardrails.config.mjs` (modify: the `no-unchecked-supabase-write` list, after `'src/lib/waitlist-entry.js',` ~line 290) | arm the three new server files |
| `docs/CHANGELOG.md` | row after `gh pr create` |

**AVAIL.1b**

| File | Change |
|---|---|
| `src/components/schedule/useScheduleData.js` (modify: SLICES line 156, EMPTY 170, signature 178, state ~184, setters 239-242, the allSettled array ending line 261, backstop list 325, deps 350, return 355) | seventh slice `availability`, only when `canReadAvailability` |
| `src/components/schedule/useScheduleData.test.js` (modify) | |
| `src/components/schedule/SchedulePartialLoadNote.jsx` (modify) | availability line + `AVAILABILITY_NOT_FLAGGED_MESSAGE` |
| `src/lib/roster-card-model.js` + `.test.js` (modify) | `dayUnavailableBars` |
| `src/components/ScheduleCalendar.jsx` (modify: imports 60/67-69/83, hook call 392-404, after 411, week-view leave bars ~1297-1317, modal render ~1402-1413, `AssignCoachModal` 1671-1765) | bars + badge |
| `src/components/ScheduleCalendar.availability.test.jsx` (create) | |
| `src/components/AvailabilityEditor.jsx` + `.test.jsx` (create) | the editor |
| `src/app/(team)/schedule/availability/page.js` (create) | the page |
| `src/components/ScheduleTabs.jsx` + `.test.jsx` (modify) | "Availability" tab for everyone |
| `docs/CHANGELOG.md` | row |

**Not touched, on purpose:** `mobile/**` (AVAIL.2 builds the phone screen and the tap route for `data.type: 'availability_changed'`; until then a tap opens the app without navigating, which `mobile/lib/notification-nav.js` already does for an unknown type); `time_off_requests` and its `unavailable` type (AVAIL.3); the month view (the brief asks for the week view); the staff assistant.

---

# AVAIL.1a

**Ships:** migration 630 + web deploy + OTA (shared). **DEPLOY ORDER:**
1. Operator applies mig 630 FIRST via Supabase MCP `apply_migration` against **un1t-crm** (`iyvtbjjxdggiadzwwvdj`; confirm with `list_projects`, never the sentinel project), with the pre-checks run and their output saved to the scratchpad as the rollback record, then the post-checks, then `get_advisors` (security AND performance). Safe alone: new objects only; nothing reads them until the code deploys.
2. Then merge. Vercel deploys the route and the cron arm (first tick within 15 minutes); `eas-update.yml` publishes the OTA.
3. If the code lands first: every `/api/schedule/availability` call answers 500 (relation or function missing, logged), the sweep arm reports `errors: 1` each tick and `availability-notice-sweep` has no row to stamp (a logged no-op). Nothing is written and nobody is pushed.

---

### Task 1: Migration 630

**Files:**
- Create: `supabase/migrations/630_staff_availability.sql`
- Create: `tests/migration-630-staff-availability.test.js`

- [ ] **Step 1: Write the failing PGlite test**

Same approach as `tests/migration-613-shift-block-removals.test.js`: boot PGlite, recreate only what the file touches, apply the real file, exercise it as each role. (`db.exec` below is PGlite's multi-statement SQL runner, as in the 613 test; nothing here spawns a process.)

```js
// AVAIL.1 — behavioural test for migration 630 (staff availability).
//
// Boots PGlite, recreates the minimum prod shape the file touches (profiles,
// cron_heartbeats, the three API roles with Supabase's default privileges),
// applies the REAL file and checks: the browser roles hold nothing on either
// table or the RPC; the CHECKs refuse malformed rules; and the RPC's rules:
// replace weekly + current/future dated, keep past dated as history, refuse a
// past date, no-op (no change row) when nothing changed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/630_staff_availability.sql'),
  'utf8',
)

const TODAY = '2026-09-25'
const COACH_A = '10000000-0000-0000-0000-00000000000a'
const COACH_B = '10000000-0000-0000-0000-00000000000b'
const COACH_C = '10000000-0000-0000-0000-00000000000c'
const COACH_D = '10000000-0000-0000-0000-00000000000d'
const MASTER = '10000000-0000-0000-0000-0000000000ff'
const GONE = '10000000-0000-0000-0000-0000000000ee'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  -- Supabase's default privileges: every new public table and function is
  -- granted to all three API roles. The migration must take the browser's away.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, deleted_at timestamptz);
  CREATE TABLE public.cron_heartbeats (
    name text PRIMARY KEY, last_ok_at timestamptz, expected_interval_seconds int,
    grace_seconds int, notes text
  );
`

const SEED = `
  INSERT INTO public.profiles (id, full_name, deleted_at) VALUES
    ('${COACH_A}', 'Coach A', NULL), ('${COACH_B}', 'Coach B', NULL),
    ('${COACH_C}', 'Coach C', NULL), ('${COACH_D}', 'Coach D', NULL),
    ('${MASTER}', 'Master M', NULL), ('${GONE}', 'Gone G', now());
`

let db
const runSql = (text) => db.exec(text)

async function asRole(role, sql, params = []) {
  await runSql(`SET ROLE ${role}`)
  try {
    return await db.query(sql, params)
  } finally {
    await runSql('RESET ROLE')
  }
}

async function save(profile, weekly, dated, { today = TODAY, actor = profile } = {}) {
  const res = await asRole(
    'service_role',
    'SELECT public.replace_staff_unavailability($1, $2, $3::date, $4::jsonb, $5::jsonb) AS r',
    [profile, actor, today, JSON.stringify(weekly), JSON.stringify(dated)],
  )
  return res.rows[0].r
}

const count = async (table, where) =>
  (await db.query(`SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`)).rows[0].n

const MON_MORNING = { weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00', note: null }
const OCT_3 = { start_date: '2026-10-03', end_date: '2026-10-03', all_day: true, start_time: null, end_time: null, note: 'Wedding' }

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIGRATION)
  await runSql(SEED)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 630 — grants and posture', () => {
  it('anon and authenticated hold nothing on either table', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['staff_unavailability', 'staff_availability_changes']) {
        await expect(asRole(role, `SELECT 1 FROM public.${table}`)).rejects.toThrow(/permission denied/)
      }
    }
  })

  it('the browser roles cannot execute the RPC; service_role can', async () => {
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(role,
        `SELECT public.replace_staff_unavailability('${COACH_D}', '${COACH_D}', '${TODAY}', '[]', '[]')`,
      )).rejects.toThrow(/permission denied/)
    }
    await expect(save(COACH_D, [], [])).resolves.toMatchObject({ changed: false })
  })

  it('RLS is on and there are no policies (service-role only, like the 47 tables the advisor already lists)', async () => {
    const { rows } = await db.query(`
      SELECT relname, relrowsecurity FROM pg_class
       WHERE oid IN ('public.staff_unavailability'::regclass, 'public.staff_availability_changes'::regclass)
       ORDER BY relname`)
    expect(rows.map((r) => r.relrowsecurity)).toEqual([true, true])
    const policies = await db.query(`SELECT count(*)::int AS n FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('staff_unavailability', 'staff_availability_changes')`)
    expect(policies.rows[0].n).toBe(0)
  })

  it('inserts the availability-notice-sweep heartbeat row (900s + 1800s grace)', async () => {
    const { rows } = await db.query(`SELECT expected_interval_seconds, grace_seconds FROM public.cron_heartbeats WHERE name = 'availability-notice-sweep'`)
    expect(rows).toEqual([{ expected_interval_seconds: 900, grace_seconds: 1800 }])
  })
})

describe('migration 630 — the rule CHECKs', () => {
  const insert = (cols) => runSql(`INSERT INTO public.staff_unavailability (profile_id, ${Object.keys(cols).join(', ')})
    VALUES ('${COACH_D}', ${Object.values(cols).map((v) => (v === null ? 'NULL' : `'${v}'`)).join(', ')})`)

  it('refuses a weekday that is not a mon..sun code', async () => {
    await expect(insert({ kind: 'weekly', weekday: 'monday', all_day: 'true' })).rejects.toThrow(/staff_unavailability_weekday/)
  })
  it('refuses a weekly rule carrying dates, and a dated rule with no dates', async () => {
    await expect(insert({ kind: 'weekly', weekday: 'mon', start_date: '2026-10-01', end_date: '2026-10-01', all_day: 'true' })).rejects.toThrow(/staff_unavailability_kind_shape/)
    await expect(insert({ kind: 'dated', all_day: 'true' })).rejects.toThrow(/staff_unavailability_kind_shape/)
  })
  it('refuses a range over 366 days and an end before the start', async () => {
    await expect(insert({ kind: 'dated', start_date: '2026-10-01', end_date: '2027-10-02', all_day: 'true' })).rejects.toThrow(/staff_unavailability_kind_shape/)
    await expect(insert({ kind: 'dated', start_date: '2026-10-02', end_date: '2026-10-01', all_day: 'true' })).rejects.toThrow(/staff_unavailability_kind_shape/)
  })
  it('refuses an end time at or before the start, and all_day with times', async () => {
    await expect(insert({ kind: 'weekly', weekday: 'mon', all_day: 'false', start_time: '12:00', end_time: '12:00' })).rejects.toThrow(/staff_unavailability_window/)
    await expect(insert({ kind: 'weekly', weekday: 'mon', all_day: 'true', start_time: '09:00', end_time: '10:00' })).rejects.toThrow(/staff_unavailability_window/)
  })
  it('refuses a note over 200 characters', async () => {
    await expect(insert({ kind: 'weekly', weekday: 'mon', all_day: 'true', note: 'x'.repeat(201) })).rejects.toThrow(/staff_unavailability_note/)
  })
})

describe('migration 630 — replace_staff_unavailability', () => {
  it('a first save writes the rules and ONE change row with before [] and the after snapshot', async () => {
    const r = await save(COACH_A, [MON_MORNING], [OCT_3])
    expect(r.changed).toBe(true)
    expect(r.change_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.before).toEqual([])
    expect(r.after).toEqual([
      { kind: 'dated', weekday: null, start_date: '2026-10-03', end_date: '2026-10-03', all_day: true, start_time: null, end_time: null, note: 'Wedding' },
      { kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:00', note: null },
    ])
    expect(await count('staff_unavailability', `profile_id = '${COACH_A}'`)).toBe(2)
    expect(await count('staff_availability_changes', `profile_id = '${COACH_A}'`)).toBe(1)
  })

  it('saving the same set again is a no-op: changed false, no new change row, rows untouched', async () => {
    const ids = (await db.query(`SELECT id FROM public.staff_unavailability WHERE profile_id = '${COACH_A}' ORDER BY id`)).rows
    const r = await save(COACH_A, [MON_MORNING], [OCT_3])
    expect(r).toMatchObject({ changed: false, change_id: null })
    expect(await count('staff_availability_changes', `profile_id = '${COACH_A}'`)).toBe(1)
    expect((await db.query(`SELECT id FROM public.staff_unavailability WHERE profile_id = '${COACH_A}' ORDER BY id`)).rows).toEqual(ids)
  })

  it('all_day wins over any times sent with it, and duplicates collapse', async () => {
    const r = await save(COACH_B, [
      { weekday: 'tue', all_day: true, start_time: '09:00', end_time: '10:00' },
      { weekday: 'tue', all_day: true },
    ], [])
    expect(r.after).toEqual([{ kind: 'weekly', weekday: 'tue', start_date: null, end_date: null, all_day: true, start_time: null, end_time: null, note: null }])
  })

  it('a dated rule that ended before today is HISTORY: kept by a replace, never in before/after', async () => {
    await runSql(`INSERT INTO public.staff_unavailability (profile_id, kind, start_date, end_date, all_day)
      VALUES ('${COACH_C}', 'dated', '2026-09-01', '2026-09-02', true)`)
    const r = await save(COACH_C, [MON_MORNING], [])
    expect(r.before).toEqual([])
    expect(await count('staff_unavailability', `profile_id = '${COACH_C}' AND end_date = '2026-09-02'`)).toBe(1)
    await save(COACH_C, [], [])
    expect(await count('staff_unavailability', `profile_id = '${COACH_C}'`)).toBe(1) // only the history row
  })

  it('a dated rule running through today is current: replaced like any other', async () => {
    await save(COACH_D, [], [{ start_date: '2026-09-20', end_date: '2026-09-27', all_day: true }], { today: '2026-09-20' })
    const r = await save(COACH_D, [], [])
    expect(r.before).toHaveLength(1)
    expect(await count('staff_unavailability', `profile_id = '${COACH_D}'`)).toBe(0)
  })

  it('refuses to ADD a date that has passed, and writes nothing', async () => {
    const before = await count('staff_availability_changes', `profile_id = '${COACH_B}'`)
    await expect(save(COACH_B, [], [{ start_date: '2026-09-01', end_date: '2026-09-02', all_day: true }]))
      .rejects.toThrow(/availability_past_date/)
    expect(await count('staff_availability_changes', `profile_id = '${COACH_B}'`)).toBe(before)
  })

  it('a malformed rule aborts the whole save: the old set survives', async () => {
    const before = await count('staff_unavailability', `profile_id = '${COACH_A}'`)
    await expect(save(COACH_A, [{ weekday: 'mon', all_day: false, start_time: '12:00', end_time: '09:00' }], []))
      .rejects.toThrow(/staff_unavailability_window/)
    expect(await count('staff_unavailability', `profile_id = '${COACH_A}'`)).toBe(before)
  })

  it('records the actor (a master under View as user) separately from the person', async () => {
    const r = await save(COACH_B, [{ weekday: 'fri', all_day: true }], [], { actor: MASTER })
    const { rows } = await db.query(`SELECT profile_id, actor_id FROM public.staff_availability_changes WHERE id = $1`, [r.change_id])
    expect(rows).toEqual([{ profile_id: COACH_B, actor_id: MASTER }])
  })

  it('refuses a tombstoned profile and non-array arguments', async () => {
    await expect(save(GONE, [], [])).rejects.toThrow(/availability_no_profile/)
    await expect(asRole('service_role',
      `SELECT public.replace_staff_unavailability('${COACH_A}', '${COACH_A}', '${TODAY}', '{}'::jsonb, '[]'::jsonb)`,
    )).rejects.toThrow(/availability_bad_args/)
  })

  it('a change row starts un-notified; notified_at and notice_outcome move together', async () => {
    expect(await count('staff_availability_changes', 'notified_at IS NULL')).toBeGreaterThan(0)
    await expect(runSql(`UPDATE public.staff_availability_changes SET notified_at = now() WHERE notice_outcome IS NULL`))
      .rejects.toThrow(/staff_availability_changes_notice_pair/)
    await expect(runSql(`UPDATE public.staff_availability_changes SET notified_at = now(), notice_outcome = 'maybe'`))
      .rejects.toThrow(/staff_availability_changes_notice_outcome/)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run tests/migration-630-staff-availability.test.js`
Expected: the suite fails in `beforeAll` with `ENOENT` on `630_staff_availability.sql`.

- [ ] **Step 3: Write the migration**

```sql
-- 630 — AVAIL.1: coach availability. A coach declares when they CANNOT work;
-- everything else is available. No approval. Managers are told of a change.
--
-- THE MODEL (Richard's decisions + plan index defaults 1 and 2)
-- ─────────────────────────────────────────────────────────────
--   * Per PERSON, not per studio: a coach at both studios declares once.
--   * UNAVAILABLE windows, two kinds, one table:
--       weekly  weekday ('mon'..'sun', the shift_templates.days_of_week codes,
--               mig 067) + a time window or the whole day;
--       dated   start_date..end_date (at most 366 days) + a time window or
--               the whole day, optional note.
--     No overnight windows: end_time > start_time on the same day.
--   * A save REPLACES the person's weekly rules and their dated rules that
--     have not ended (end_date >= the caller's Dublin today). A dated rule
--     that ended before today is history: kept, never replaced, never added.
--   * Every real change writes ONE staff_availability_changes row (before and
--     after snapshots, the actor). That row is also the notice queue: the
--     route tells the managers at once inside 07:00-22:00 studio time, and
--     the checklist-sweep cron's availability arm tells them at 07:00 for a
--     save made outside it, then stamps notified_at + notice_outcome.
--
-- POSTURE: SERVICE ROLE ONLY. RLS is enabled with NO policies and the browser
-- roles hold NO privilege on either table or on the RPC. Every reader is an
-- /api route on the service-role client (the phone included, with its Bearer
-- token), so a policy here would be surface nobody calls. This is the posture
-- of the ~47 tables get_advisors lists as rls_enabled_no_policy (INFO);
-- expect that count to rise by exactly 2.
--
-- FKs: profile_id CASCADE, actor_id SET NULL. Both are inert: a staff profile
-- is never deleted (mig 622 tombstones it). CASCADE for the rules because a
-- rule about a person who no longer exists has no history value; SET NULL for
-- the actor because an audit row must outlive its actor (roster_change_log,
-- mig 236, does the same).
--
-- WHY AN RPC FOR THE SAVE: "delete my current rules, insert the new set, log
-- it" as two PostgREST calls loses a coach's whole availability if the second
-- fails. The function does it in one transaction under a per-person advisory
-- lock, and returns changed=false WITHOUT WRITING when the new set equals the
-- current one, so a repeated Save neither logs nor notifies anyone.
-- SECURITY INVOKER, search_path '', every name schema-qualified; EXECUTE for
-- service_role only (the mig 612 posture). Errors the route maps to 400: any
-- 'availability_*' P0001 message, 23514 (CHECK), 22007/22008/22P02/22023
-- (unparseable input).
--
-- NOT APPLIED BY THE PR. Apply BEFORE the AVAIL.1a code deploys (safe alone:
-- new objects only; nothing reads them until the code lands).
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; keep the output in the scratchpad)
-- ─────────────────────────────────────────────────────────────────────────
-- (a) Nothing by these names exists yet:
--       SELECT to_regclass('public.staff_unavailability'), to_regclass('public.staff_availability_changes'),
--              to_regprocedure('public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb)');
--     Expected: NULL, NULL, NULL.
-- (b) SELECT name FROM public.cron_heartbeats WHERE name = 'availability-notice-sweep';   -- 0 rows
-- (c) The columns the RPC reads exist:
--       SELECT column_name FROM information_schema.columns
--        WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name IN ('id', 'deleted_at');  -- 2 rows
-- (d) The advisor baseline: get_advisors(security) → rls_enabled_no_policy count (47 on 25 Sep).
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (e) SELECT r, t, p FROM unnest(ARRAY['anon', 'authenticated']) r,
--            unnest(ARRAY['public.staff_unavailability', 'public.staff_availability_changes']) t,
--            unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
--      WHERE has_table_privilege(r, t, p);
--     Expected: 0 rows.
-- (f) SELECT has_function_privilege('authenticated', 'public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb)', 'EXECUTE'),
--            has_function_privilege('service_role',  'public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb)', 'EXECUTE');
--     Expected: false, true.
-- (g) SELECT name, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats
--      WHERE name = 'availability-notice-sweep';   -- 900, 1800
-- (h) get_advisors (security AND performance). Expected: rls_enabled_no_policy
--     +2 (these two tables), nothing else new. unindexed_foreign_keys: none
--     (all three FKs are indexed below).
-- (i) Smoke once deployed:
--       PUT /api/schedule/availability {"weekly":[],"dated":[]} as yourself → 200 { changed: false }.
--
-- ROLLBACK (only before any coach has saved; afterwards, dump both tables
-- first):
--   DROP FUNCTION IF EXISTS public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb);
--   DROP TABLE IF EXISTS public.staff_availability_changes;
--   DROP TABLE IF EXISTS public.staff_unavailability;
--   DELETE FROM public.cron_heartbeats WHERE name = 'availability-notice-sweep';
-- and revert the AVAIL.1a code in the same hour (its routes 500 without them).

BEGIN;

-- ── The rules ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_unavailability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  weekday     text,
  start_date  date,
  end_date    date,
  all_day     boolean NOT NULL DEFAULT false,
  start_time  time,
  end_time    time,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_unavailability_kind CHECK (kind IN ('weekly', 'dated')),
  CONSTRAINT staff_unavailability_weekday CHECK (
    weekday IS NULL OR weekday IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')
  ),
  CONSTRAINT staff_unavailability_kind_shape CHECK (
    (kind = 'weekly' AND weekday IS NOT NULL AND start_date IS NULL AND end_date IS NULL)
    OR (kind = 'dated' AND weekday IS NULL AND start_date IS NOT NULL AND end_date IS NOT NULL
        AND end_date >= start_date AND end_date - start_date <= 365)
  ),
  CONSTRAINT staff_unavailability_window CHECK (
    (all_day AND start_time IS NULL AND end_time IS NULL)
    OR (NOT all_day AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
  ),
  CONSTRAINT staff_unavailability_note CHECK (note IS NULL OR char_length(note) <= 200)
);

-- Serves every read and the RPC's replace: "this person's weekly rules, and
-- their dated rules ending on or after a date" (and the manager range read's
-- profile_id IN (...)). Leads with profile_id, so it also covers the FK.
CREATE INDEX IF NOT EXISTS staff_unavailability_profile_kind_end_idx
  ON public.staff_unavailability (profile_id, kind, end_date);

ALTER TABLE public.staff_unavailability ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_unavailability FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_unavailability TO service_role;

COMMENT ON TABLE public.staff_unavailability IS
  'AVAIL.1 (mig 630) — when a coach CANNOT work, per person. kind weekly = weekday (mon..sun, shift_templates.days_of_week codes) + a window or all day; kind dated = start_date..end_date (<= 366 days) + a window or all day, optional note (managers see it). Everything else is available. Written ONLY by public.replace_staff_unavailability (service role); dated rules that ended before the saver''s Dublin today are history and are never replaced. Service-role only: RLS on, no policies, no browser grants.';

-- ── The audit / notice queue ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_availability_changes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_id       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  before         jsonb NOT NULL DEFAULT '[]'::jsonb,
  after          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  notified_at    timestamptz,
  notice_outcome text,
  CONSTRAINT staff_availability_changes_notice_outcome CHECK (
    notice_outcome IS NULL OR notice_outcome IN ('sent', 'no_recipients', 'stale', 'reverted')
  ),
  CONSTRAINT staff_availability_changes_notice_pair CHECK ((notified_at IS NULL) = (notice_outcome IS NULL))
);

-- A person's history, newest first (also covers the profile_id FK).
CREATE INDEX IF NOT EXISTS staff_availability_changes_profile_created_idx
  ON public.staff_availability_changes (profile_id, created_at DESC);
-- The cron arm's read: notices still owed, oldest first.
CREATE INDEX IF NOT EXISTS staff_availability_changes_unnotified_idx
  ON public.staff_availability_changes (created_at)
  WHERE notified_at IS NULL;
-- Covers the actor_id FK (advisor unindexed_foreign_keys).
CREATE INDEX IF NOT EXISTS staff_availability_changes_actor_idx
  ON public.staff_availability_changes (actor_id)
  WHERE actor_id IS NOT NULL;

ALTER TABLE public.staff_availability_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_availability_changes FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_availability_changes TO service_role;

COMMENT ON TABLE public.staff_availability_changes IS
  'AVAIL.1 (mig 630) — one row per real change to a coach''s availability (the RPC writes none for a no-op save): before/after snapshots of the weekly + current/future dated rules, actor_id (the master under View as user). Also the notice queue: notified_at NULL = the managers are still owed a push (sent at once inside 07:00-22:00 studio time, else by the checklist-sweep cron''s availability arm); notice_outcome says how it ended (sent | no_recipients | stale after 24h | reverted when later saves undid it). Service-role only.';

-- ── The save ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.replace_staff_unavailability(
  p_profile_id uuid,
  p_actor_id   uuid,
  p_today      date,
  p_weekly     jsonb,
  p_dated      jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_before    jsonb;
  v_after     jsonb;
  v_change_id uuid;
BEGIN
  IF p_profile_id IS NULL OR p_today IS NULL THEN
    RAISE EXCEPTION 'availability_bad_args: a profile and today are required';
  END IF;
  IF jsonb_typeof(COALESCE(p_weekly, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_dated, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'availability_bad_args: weekly and dated must be arrays';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_profile_id AND p.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'availability_no_profile: % is not a current staff profile', p_profile_id;
  END IF;

  -- One save per person at a time: a double-clicked Save, or the phone and
  -- the web at once, queue here instead of interleaving delete and insert.
  PERFORM pg_advisory_xact_lock(hashtextextended('staff_unavailability:' || p_profile_id::text, 0));

  -- The CURRENT set, in canonical form. The SAME columns, types and ORDER BY
  -- as v_after below: the two are compared as jsonb, so they must be built
  -- the same way.
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.kind, r.weekday, r.start_date, r.end_date,
                                                 r.all_day, r.start_time, r.end_time, r.note), '[]'::jsonb)
    INTO v_before
    FROM (
      SELECT u.kind, u.weekday, u.start_date, u.end_date, u.all_day,
             left(u.start_time::text, 5) AS start_time,
             left(u.end_time::text, 5)   AS end_time,
             u.note
        FROM public.staff_unavailability u
       WHERE u.profile_id = p_profile_id
         AND (u.kind = 'weekly' OR u.end_date >= p_today)
    ) r;

  -- The NEW set, canonical: all_day drops any times, a blank note is NULL,
  -- a dated rule with no end_date is one day, identical rules collapse.
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.kind, r.weekday, r.start_date, r.end_date,
                                                 r.all_day, r.start_time, r.end_time, r.note), '[]'::jsonb)
    INTO v_after
    FROM (
      SELECT DISTINCT
             i.kind, i.weekday, i.start_date, i.end_date, i.all_day,
             CASE WHEN i.all_day THEN NULL ELSE left(i.start_time::text, 5) END AS start_time,
             CASE WHEN i.all_day THEN NULL ELSE left(i.end_time::text, 5)   END AS end_time,
             i.note
        FROM (
          SELECT 'weekly'::text                              AS kind,
                 lower(btrim(e->>'weekday'))                 AS weekday,
                 NULL::date                                  AS start_date,
                 NULL::date                                  AS end_date,
                 COALESCE((e->>'all_day')::boolean, false)   AS all_day,
                 (e->>'start_time')::time                    AS start_time,
                 (e->>'end_time')::time                      AS end_time,
                 NULLIF(btrim(e->>'note'), '')               AS note
            FROM jsonb_array_elements(COALESCE(p_weekly, '[]'::jsonb)) e
          UNION ALL
          SELECT 'dated'::text,
                 NULL::text,
                 (e->>'start_date')::date,
                 COALESCE((e->>'end_date')::date, (e->>'start_date')::date),
                 COALESCE((e->>'all_day')::boolean, false),
                 (e->>'start_time')::time,
                 (e->>'end_time')::time,
                 NULLIF(btrim(e->>'note'), '')
            FROM jsonb_array_elements(COALESCE(p_dated, '[]'::jsonb)) e
        ) i
    ) r;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_after) AS x(kind text, end_date date)
     WHERE x.kind = 'dated' AND x.end_date < p_today
  ) THEN
    RAISE EXCEPTION 'availability_past_date: a date that has already passed cannot be added';
  END IF;

  IF v_after = v_before THEN
    RETURN jsonb_build_object('changed', false, 'change_id', NULL, 'before', v_before, 'after', v_after);
  END IF;

  DELETE FROM public.staff_unavailability u
   WHERE u.profile_id = p_profile_id
     AND (u.kind = 'weekly' OR u.end_date >= p_today);

  -- The CHECKs on the table judge every row here: one bad rule aborts the
  -- whole transaction and the old set survives untouched.
  INSERT INTO public.staff_unavailability
         (profile_id, kind, weekday, start_date, end_date, all_day, start_time, end_time, note)
  SELECT p_profile_id, x.kind, x.weekday, x.start_date, x.end_date, x.all_day, x.start_time, x.end_time, x.note
    FROM jsonb_to_recordset(v_after) AS x(kind text, weekday text, start_date date, end_date date,
                                          all_day boolean, start_time time, end_time time, note text);

  INSERT INTO public.staff_availability_changes (profile_id, actor_id, before, after)
  VALUES (p_profile_id, p_actor_id, v_before, v_after)
  RETURNING id INTO v_change_id;

  RETURN jsonb_build_object('changed', true, 'change_id', v_change_id, 'before', v_before, 'after', v_after);
END;
$$;

COMMENT ON FUNCTION public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb) IS
  'AVAIL.1 (mig 630) — replaces a coach''s weekly rules and their dated rules ending on/after p_today with p_weekly/p_dated, atomically, and logs ONE staff_availability_changes row. Returns { changed, change_id, before, after } (canonical snapshots); changed=false writes nothing. Refuses a dated rule ending before p_today (availability_past_date), a tombstoned or unknown profile (availability_no_profile), non-array input (availability_bad_args); the table CHECKs refuse malformed rules (23514). service_role only.';

REVOKE ALL ON FUNCTION public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb) TO service_role;

-- ── The cron arm's heartbeat (the SWAPHB.1 lesson, mig 623) ──────────────
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'availability-notice-sweep',
  now(),
  900,
  1800,
  'AVAIL.1 — the availability-notice arm (src/lib/availability-notify.js runAvailabilityNoticeSweep) of the */15 Vercel cron /api/cron/checklist-sweep; no route or vercel.json entry of its own. It pushes the managers about availability saves made outside 07:00-22:00 studio time (and any in-band save whose immediate push did not land). Stamped ONLY when the arm ran and reported errors: 0; quiet-hours ticks stamp. STALE = the arm threw or reported errors on every tick for 45 minutes: read last_outcome.availability_notices on the checklist-sweep row and the availability-notify logError lines.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- ── Self-check against the catalog, never this text (the mig 153 lesson) ──
DO $$
DECLARE
  v_role text;
  v_priv text;
  v_n    int;
  v_fn   text := 'public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb)';
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.staff_unavailability', v_priv)
         OR has_table_privilege(v_role, 'public.staff_availability_changes', v_priv) THEN
        RAISE EXCEPTION 'mig 630: % still holds % on an availability table', v_role, v_priv;
      END IF;
    END LOOP;
    IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'mig 630: % can execute replace_staff_unavailability', v_role;
    END IF;
  END LOOP;

  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.staff_unavailability', v_priv)
       OR NOT has_table_privilege('service_role', 'public.staff_availability_changes', v_priv) THEN
      RAISE EXCEPTION 'mig 630: service_role lacks % on an availability table', v_priv;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 630: service_role cannot execute replace_staff_unavailability';
  END IF;

  SELECT count(*) INTO v_n FROM pg_class
   WHERE oid IN ('public.staff_unavailability'::regclass, 'public.staff_availability_changes'::regclass)
     AND relrowsecurity;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'mig 630: RLS is not enabled on both availability tables';
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('staff_unavailability', 'staff_availability_changes');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'mig 630: expected no policies on the availability tables, found %', v_n;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.cron_heartbeats WHERE name = 'availability-notice-sweep') THEN
    RAISE EXCEPTION 'mig 630: the availability-notice-sweep heartbeat row is missing';
  END IF;
END $$;

COMMIT;
```

- [ ] **Step 4: Run the test and the two replay checks, expect PASS**

Run: `npx vitest run tests/migration-630-staff-availability.test.js`
Expected: all passed.
Run: `npm run check:rls-restrictive && npm run check:select-columns`
Expected: both exit 0 (no policy at all, so nothing restrictive; the replayed schema now knows both tables). If `check:select-columns`' replay cannot parse a table-level `CONSTRAINT … CHECK` line, it will say so by name: fix the parser's grammar, never the migration's shape.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/630_staff_availability.sql tests/migration-630-staff-availability.test.js
git commit -m "AVAIL.1a — mig 630: staff availability rules, change log, atomic replace RPC, sweep heartbeat

Service-role only (RLS on, no policies, no browser grants). Not applied by the PR.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Do NOT apply it yourself. The operator applies it (DEPLOY ORDER above).

---

### Task 2: `shared/availability.js` — the pure rules

**Files:**
- Create: `shared/availability.js`
- Create: `shared/availability.test.js`

Pure, no imports, no clock, no host timezone: dates are read from their own digits and weekdays come from `Date.UTC` arithmetic (the ROSTERTZ.1 lesson, `src/lib/roster.js:21-35`). The phone (AVAIL.2) and CANDIDATES.1 import it as `shared/availability`; the web as `@shared/availability`. No `src/lib` twin, so `tests/shared-pair-sync.test.js` has nothing to classify.

- [ ] **Step 1: Write the failing test**

```js
// AVAIL.1 — the availability rules, shared by the web, the API and (AVAIL.2)
// the phone. Every date here is a calendar date read from its own digits, so
// this file passes under any TZ.

import { describe, it, expect } from 'vitest'
import {
  AVAILABILITY_WEEKDAYS, AVAILABILITY_LIMITS, weekdayOf, normaliseRule, normaliseAvailability,
  splitRules, ruleProblem, availabilityProblems, rulesOnDate, unavailableFor, unavailableSummary,
  describeWindow, describeRule, diffAvailability, sameAvailability,
} from './availability'

const weekly = (weekday, start, end, note = null) =>
  ({ kind: 'weekly', weekday, all_day: !start, start_time: start, end_time: end, note })
const dated = (from, to, start = null, end = null, note = null) =>
  ({ kind: 'dated', start_date: from, end_date: to, all_day: !start, start_time: start, end_time: end, note })

describe('weekday codes', () => {
  it('are the shift_templates.days_of_week codes, Monday first', () => {
    expect(AVAILABILITY_WEEKDAYS).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
  })
  it.each([
    ['2026-09-25', 'fri'], ['2026-05-06', 'wed'], ['2026-03-29', 'sun'], ['2026-10-25', 'sun'], ['2028-02-29', 'tue'],
  ])('%s is %s', (iso, code) => expect(weekdayOf(iso)).toBe(code))
  it.each(['2026-02-30', '2026-13-01', '26-09-25', '', null, '2026-09-25T10:00:00Z'])('%s is not a day', (bad) => {
    expect(weekdayOf(bad)).toBeNull()
  })
})

describe('normaliseRule / normaliseAvailability', () => {
  it('all_day drops the times; HH:MM:SS from Postgres becomes HH:MM; a blank note is null', () => {
    expect(normaliseRule({ kind: 'weekly', weekday: 'MON', all_day: true, start_time: '09:00', end_time: '10:00', note: '  ' }))
      .toEqual({ kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: true, start_time: null, end_time: null, note: null })
    expect(normaliseRule({ kind: 'weekly', weekday: 'tue', all_day: false, start_time: '09:00:00', end_time: '12:30:00' }))
      .toMatchObject({ start_time: '09:00', end_time: '12:30' })
  })
  it('a dated rule with no end_date is one day', () => {
    expect(normaliseRule({ kind: 'dated', start_date: '2026-10-03', all_day: true })).toMatchObject({ end_date: '2026-10-03' })
  })
  it('sorts weekly Monday-first then by time, dated by date, and drops exact duplicates', () => {
    const out = normaliseAvailability({
      weekly: [weekly('tue', '09:00', '10:00'), weekly('mon', '17:00', '19:00'), weekly('mon', '09:00', '10:00'), weekly('mon', '09:00', '10:00')],
      dated: [dated('2026-11-01', '2026-11-01'), dated('2026-10-03', '2026-10-05')],
    })
    expect(out.weekly.map((r) => `${r.weekday} ${r.start_time}`)).toEqual(['mon 09:00', 'mon 17:00', 'tue 09:00'])
    expect(out.dated.map((r) => r.start_date)).toEqual(['2026-10-03', '2026-11-01'])
  })
  it('splitRules sorts flat rows (a DB read, or an RPC snapshot) into the two lists', () => {
    const out = splitRules([dated('2026-10-03', '2026-10-03'), weekly('fri', null, null)])
    expect(out.weekly).toHaveLength(1)
    expect(out.dated).toHaveLength(1)
  })
})

describe('ruleProblem', () => {
  const today = '2026-09-25'
  it.each([
    [weekly('funday', null, null), 'Choose a day of the week'],
    [weekly('mon', '09:00', null), 'Give a start and an end time, or choose all day'],
    [weekly('mon', '12:00', '12:00'), 'The end time must be after the start time'],
    [weekly('mon', '22:00', '02:00'), 'The end time must be after the start time'],
    [dated('2026-02-30', '2026-03-01'), 'Use a real date'],
    [dated('2026-10-05', '2026-10-03'), 'The last day is before the first day'],
    [dated('2026-10-01', '2027-10-01'), 'Up to a year at a time'],
    [dated('2026-09-20', '2026-09-24'), 'That date has passed'],
    [dated('2028-10-01', '2028-10-01'), 'Up to two years ahead'],
    [weekly('mon', null, null, 'x'.repeat(201)), 'Keep the note to 200 characters'],
  ])('%j → %s', (raw, message) => {
    expect(ruleProblem(normaliseRule(raw), { todayIso: today })).toBe(message)
  })
  it('accepts a good rule, and a range running through today', () => {
    expect(ruleProblem(normaliseRule(weekly('mon', '09:00', '12:00')), { todayIso: today })).toBeNull()
    expect(ruleProblem(normaliseRule(dated('2026-09-20', '2026-09-25')), { todayIso: today })).toBeNull()
    expect(ruleProblem(normaliseRule(dated('2026-10-01', '2027-09-30')), { todayIso: today })).toBeNull() // 365 days
  })
  it('availabilityProblems names the list and the index, and caps the counts', () => {
    const many = Array.from({ length: AVAILABILITY_LIMITS.weekly + 1 }, (_, i) => weekly('mon', `${String(i % 10).padStart(2, '0')}:00`, `${String(i % 10).padStart(2, '0')}:30`, `n${i}`))
    const issues = availabilityProblems(normaliseAvailability({ weekly: many, dated: [dated('2026-09-01', '2026-09-01')] }), { todayIso: today })
    expect(issues).toContainEqual({ path: 'weekly', message: `Up to ${AVAILABILITY_LIMITS.weekly} weekly entries` })
    expect(issues).toContainEqual({ path: 'dated.0', message: 'That date has passed' })
  })
})

describe('rulesOnDate / unavailableFor', () => {
  const rules = [weekly('wed', '10:00', '11:00', 'School run'), dated('2026-05-07', '2026-05-08', null, null, 'Wedding')]

  it('a weekly rule applies on every date with that weekday', () => {
    expect(rulesOnDate(rules, '2026-05-06')).toHaveLength(1)
    expect(rulesOnDate(rules, '2026-05-13')).toHaveLength(1)
    expect(rulesOnDate(rules, '2026-05-05')).toHaveLength(0)
  })
  it('overlap is strict: a shift touching the window is not flagged', () => {
    expect(unavailableFor(rules, '2026-05-06', '10:00', '12:00')).toHaveLength(1)
    expect(unavailableFor(rules, '2026-05-06', '10:30:00', '10:45:00')).toHaveLength(1)
    expect(unavailableFor(rules, '2026-05-06', '11:00', '12:00')).toBeNull()
    expect(unavailableFor(rules, '2026-05-06', '09:00', '10:00')).toBeNull()
  })
  it('an all-day rule flags any shift that day; no times asks about the whole day', () => {
    expect(unavailableFor(rules, '2026-05-07', '06:00', '07:00')[0].note).toBe('Wedding')
    expect(unavailableFor(rules, '2026-05-06')).toHaveLength(1)
  })
  it('a shift crossing midnight is judged as the whole day (no overnight windows)', () => {
    expect(unavailableFor(rules, '2026-05-06', '22:00', '00:30')).toHaveLength(1)
  })
  it('an unreal date or no rules is null', () => {
    expect(unavailableFor(rules, '2026-02-30', '10:00', '11:00')).toBeNull()
    expect(unavailableFor([], '2026-05-06', '10:00', '11:00')).toBeNull()
    expect(unavailableFor(undefined, '2026-05-06')).toBeNull()
  })
})

describe('describing rules', () => {
  it('windows in the 12-hour style of the rest of the schedule', () => {
    expect(describeWindow(normaliseRule(weekly('mon', '09:00', '12:00')))).toBe('9am–12pm')
    expect(describeWindow(normaliseRule(weekly('mon', '00:30', '12:15')))).toBe('12:30am–12:15pm')
    expect(describeWindow(normaliseRule(weekly('mon', null, null)))).toBe('all day')
  })
  it('rules', () => {
    expect(describeRule(weekly('mon', '09:00', '12:00'))).toBe('Mondays, 9am–12pm')
    expect(describeRule(dated('2026-10-03', '2026-10-03'))).toBe('3 Oct, all day')
    expect(describeRule(dated('2026-10-03', '2026-10-05', '17:00', '19:30'))).toBe('3 Oct – 5 Oct, 5pm–7:30pm')
  })
  it('the picker summary: all day wins, otherwise every window once', () => {
    expect(unavailableSummary([weekly('mon', '09:00', '12:00'), weekly('mon', null, null)])).toBe('all day')
    expect(unavailableSummary([weekly('mon', '09:00', '12:00'), dated('2026-10-05', '2026-10-05', '17:00', '19:00'), weekly('mon', '09:00', '12:00')]))
      .toBe('9am–12pm, 5pm–7pm')
    expect(unavailableSummary(null)).toBe('')
  })
})

describe('diffAvailability / sameAvailability', () => {
  it('reports what was added and removed, ignoring a changed note', () => {
    const before = [weekly('mon', '09:00', '12:00')]
    const after = [weekly('mon', '09:00', '12:00', 'new note'), weekly('tue', null, null)]
    const { added, removed } = diffAvailability(before, after)
    expect(added.map(describeRule)).toEqual(['Tuesdays, all day'])
    expect(removed).toEqual([])
    expect(sameAvailability(before, after)).toBe(false)
  })
  it('accepts either flat arrays or { weekly, dated }', () => {
    expect(sameAvailability({ weekly: [weekly('mon', null, null)], dated: [] }, [weekly('mon', null, null)])).toBe(true)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/availability.test.js`
Expected: fails to import `./availability` (module not found).

- [ ] **Step 3: Implement**

```js
// shared/availability.js
//
// AVAIL.1 — coach availability rules. PURE: no imports, no IO, no clock, no
// host timezone. Shared by the web calendar and picker, the API
// (src/lib/availability-server.js, src/lib/availability-notify.js), and the
// phone (AVAIL.2, CANDIDATES.1) as `shared/availability`.
//
// A coach declares when they CANNOT work; everything else is available.
//   weekly  { kind:'weekly', weekday:'mon'..'sun', all_day, start_time, end_time, note }
//   dated   { kind:'dated', start_date, end_date, all_day, start_time, end_time, note }
// Weekday codes are shift_templates.days_of_week's (mig 067) and
// src/lib/roster.js WEEKDAY_CODES: Monday first.
// Times are 'HH:MM' (Postgres's 'HH:MM:SS' is read too). There are NO
// overnight windows: end must be after start on the same day, and a shift
// that crosses midnight is judged against the whole day.
// The database (mig 630) enforces the same shape with CHECKs; these functions
// give the SAME answers earlier, in words a coach can act on.

export const AVAILABILITY_WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
export const AVAILABILITY_WEEKDAY_LABELS = Object.freeze({
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
})
const WEEKDAY_PLURAL = Object.freeze({
  mon: 'Mondays', tue: 'Tuesdays', wed: 'Wednesdays', thu: 'Thursdays', fri: 'Fridays', sat: 'Saturdays', sun: 'Sundays',
})
// spanDays mirrors mig 630's `end_date - start_date <= 365`; noteChars its note CHECK.
export const AVAILABILITY_LIMITS = Object.freeze({ weekly: 28, dated: 60, noteChars: 200, spanDays: 366, aheadDays: 730 })

const DAY_MS = 86400000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/

/** Whole days since 1970-01-01 for a REAL calendar date, else null. */
function dayIndex(iso) {
  const m = ISO_DAY.exec(typeof iso === 'string' ? iso : '')
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  // Date.UTC rolls 30 Feb into March; a round trip that changes the digits
  // was never a real date.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return ms / DAY_MS
}

/** 'mon'..'sun' for a real 'YYYY-MM-DD', else null. */
export function weekdayOf(iso) {
  const n = dayIndex(iso)
  if (n === null) return null
  return AVAILABILITY_WEEKDAYS[(new Date(n * DAY_MS).getUTCDay() + 6) % 7]
}

function minutes(t) {
  const m = TIME.exec(typeof t === 'string' ? t : '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
function hhmm(t) {
  const m = TIME.exec(typeof t === 'string' ? t : '')
  return m ? `${m[1]}:${m[2]}` : null
}
function time12(t) {
  const total = minutes(t)
  if (total === null) return ''
  const h = Math.floor(total / 60)
  const mm = total % 60
  const suffix = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return mm === 0 ? `${h12}${suffix}` : `${h12}:${String(mm).padStart(2, '0')}${suffix}`
}
// '2026-10-03' → '3 Oct'. String digits only: no Date, so no timezone moves a day.
const dayMonth = (iso) => `${Number(String(iso).slice(8, 10))} ${MONTHS[Number(String(iso).slice(5, 7)) - 1] || ''}`.trim()

/** One rule in canonical form (accepts API input, DB rows and RPC snapshots). */
export function normaliseRule(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kind = raw.kind === 'weekly' || raw.kind === 'dated' ? raw.kind : (raw.weekday ? 'weekly' : 'dated')
  const allDay = raw.all_day === true
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null
  return {
    kind,
    weekday: kind === 'weekly' && typeof raw.weekday === 'string' ? raw.weekday.trim().toLowerCase() : null,
    start_date: kind === 'dated' ? (raw.start_date ?? null) : null,
    end_date: kind === 'dated' ? (raw.end_date || raw.start_date || null) : null,
    all_day: allDay,
    start_time: allDay ? null : hhmm(raw.start_time),
    end_time: allDay ? null : hhmm(raw.end_time),
    note,
  }
}

// Identity of a rule's CONTENT (no note): what diffAvailability compares.
function windowKey(r) {
  return [r.kind, r.weekday ?? '', r.start_date ?? '', r.end_date ?? '', r.all_day ? 'all' : `${r.start_time}-${r.end_time}`].join('|')
}
const fullKey = (r) => `${windowKey(r)}|${r.note ?? ''}`

function compareRules(a, b) {
  if (a.kind !== b.kind) return a.kind === 'weekly' ? -1 : 1
  const byDay = a.kind === 'weekly'
    ? AVAILABILITY_WEEKDAYS.indexOf(a.weekday) - AVAILABILITY_WEEKDAYS.indexOf(b.weekday)
    : String(a.start_date).localeCompare(String(b.start_date)) || String(a.end_date).localeCompare(String(b.end_date))
  if (byDay) return byDay
  if (a.all_day !== b.all_day) return a.all_day ? -1 : 1
  return String(a.start_time ?? '').localeCompare(String(b.start_time ?? '')) || fullKey(a).localeCompare(fullKey(b))
}

function flat(input) {
  if (Array.isArray(input)) return input
  return [...(input?.weekly || []), ...(input?.dated || [])]
}

/** { weekly, dated } in canonical form: sorted, exact duplicates dropped. */
export function normaliseAvailability(input) {
  const out = { weekly: [], dated: [] }
  const seen = new Set()
  for (const [list, kind] of [[input?.weekly, 'weekly'], [input?.dated, 'dated']]) {
    for (const raw of Array.isArray(list) ? list : []) {
      const rule = normaliseRule({ ...(raw && typeof raw === 'object' ? raw : {}), kind })
      const key = fullKey(rule)
      if (seen.has(key)) continue
      seen.add(key)
      out[kind].push(rule)
    }
  }
  out.weekly.sort(compareRules)
  out.dated.sort(compareRules)
  return out
}

/** Flat rows (a DB read, an RPC snapshot) → { weekly, dated }. */
export function splitRules(rows) {
  const list = (rows || []).map(normaliseRule).filter(Boolean)
  return normaliseAvailability({
    weekly: list.filter((r) => r.kind === 'weekly'),
    dated: list.filter((r) => r.kind === 'dated'),
  })
}

/** What is wrong with one canonical rule, in the coach's words; null if nothing. */
export function ruleProblem(rule, { todayIso = null } = {}) {
  if (!rule) return 'This entry could not be read'
  if (rule.kind === 'weekly') {
    if (!AVAILABILITY_WEEKDAYS.includes(rule.weekday)) return 'Choose a day of the week'
  } else {
    const start = dayIndex(rule.start_date)
    const end = dayIndex(rule.end_date)
    if (start === null || end === null) return 'Use a real date'
    if (end < start) return 'The last day is before the first day'
    if (end - start + 1 > AVAILABILITY_LIMITS.spanDays) return 'Up to a year at a time'
    const today = dayIndex(todayIso)
    if (today !== null && end < today) return 'That date has passed'
    if (today !== null && start > today + AVAILABILITY_LIMITS.aheadDays) return 'Up to two years ahead'
  }
  if (!rule.all_day) {
    const s = minutes(rule.start_time)
    const e = minutes(rule.end_time)
    if (s === null || e === null) return 'Give a start and an end time, or choose all day'
    if (e <= s) return 'The end time must be after the start time'
  }
  if (rule.note && rule.note.length > AVAILABILITY_LIMITS.noteChars) return `Keep the note to ${AVAILABILITY_LIMITS.noteChars} characters`
  return null
}

/** Every problem with a canonical { weekly, dated }: [{ path, message }] (validateBody's issue shape). */
export function availabilityProblems(input, opts = {}) {
  const issues = []
  if (input.weekly.length > AVAILABILITY_LIMITS.weekly) issues.push({ path: 'weekly', message: `Up to ${AVAILABILITY_LIMITS.weekly} weekly entries` })
  if (input.dated.length > AVAILABILITY_LIMITS.dated) issues.push({ path: 'dated', message: `Up to ${AVAILABILITY_LIMITS.dated} dates` })
  for (const kind of ['weekly', 'dated']) {
    input[kind].forEach((rule, i) => {
      const message = ruleProblem(rule, opts)
      if (message) issues.push({ path: `${kind}.${i}`, message })
    })
  }
  return issues
}

/** The rules that apply on one date. */
export function rulesOnDate(rules, dateIso) {
  const day = dayIndex(dateIso)
  if (day === null) return []
  const wd = weekdayOf(dateIso)
  return (rules || []).map(normaliseRule).filter((r) => {
    if (!r) return false
    if (r.kind === 'weekly') return r.weekday === wd
    const s = dayIndex(r.start_date)
    const e = dayIndex(r.end_date)
    return s !== null && e !== null && s <= day && day <= e
  })
}

/**
 * Is this person unavailable for [startTime, endTime) on dateIso? null when
 * not, else the matching rules (sorted). Overlap is strict: a shift ending
 * as a window starts is fine. No times, or an end not after the start (a
 * shift crossing midnight), asks about the whole day. ADVISORY everywhere it
 * is used: it never blocks an assignment.
 */
export function unavailableFor(rules, dateIso, startTime = null, endTime = null) {
  const s = minutes(startTime)
  const e = minutes(endTime)
  const wholeDay = s === null || e === null || e <= s
  const hits = rulesOnDate(rules, dateIso).filter((r) => {
    if (r.all_day || wholeDay) return true
    const rs = minutes(r.start_time)
    const re = minutes(r.end_time)
    if (rs === null || re === null) return true // unreadable window: flag it, the advisory side
    return s < re && rs < e
  })
  return hits.length ? hits.sort(compareRules) : null
}

/** '9am–12pm' or 'all day'. */
export function describeWindow(rule) {
  const r = normaliseRule(rule)
  if (!r || r.all_day) return 'all day'
  return `${time12(r.start_time)}–${time12(r.end_time)}`
}

/** 'Mondays, 9am–12pm' · '3 Oct, all day' · '3 Oct – 5 Oct, 5pm–7:30pm'. */
export function describeRule(rule) {
  const r = normaliseRule(rule)
  if (!r) return ''
  const when = r.kind === 'weekly'
    ? (WEEKDAY_PLURAL[r.weekday] || r.weekday)
    : (r.start_date === r.end_date ? dayMonth(r.start_date) : `${dayMonth(r.start_date)} – ${dayMonth(r.end_date)}`)
  return `${when}, ${describeWindow(r)}`
}

/** The picker badge text for unavailableFor's matches. */
export function unavailableSummary(matches) {
  if (!matches || matches.length === 0) return ''
  if (matches.some((r) => normaliseRule(r)?.all_day)) return 'all day'
  return [...new Set(matches.map(describeWindow))].join(', ')
}

/** What a save added and removed, by content (a note-only edit is neither). */
export function diffAvailability(before, after) {
  const b = flat(splitRules(flat(before)))
  const a = flat(splitRules(flat(after)))
  const bKeys = new Set(b.map(windowKey))
  const aKeys = new Set(a.map(windowKey))
  return {
    added: a.filter((r) => !bKeys.has(windowKey(r))),
    removed: b.filter((r) => !aKeys.has(windowKey(r))),
  }
}

/** Same rules AND same notes. */
export function sameAvailability(x, y) {
  const a = flat(splitRules(flat(x))).map(fullKey)
  const b = flat(splitRules(flat(y))).map(fullKey)
  return a.length === b.length && a.every((k, i) => k === b[i])
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run shared/availability.test.js`
Expected: all passed. Then `npm run check:guardrails` (shared/ is in its scope): exit 0.

- [ ] **Step 5: Commit**

```bash
git add shared/availability.js shared/availability.test.js
git commit -m "AVAIL.1a — shared/availability.js: the pure availability rules (web, API, phone)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Register the `availability_change` push category

**Files:**
- Create: `src/lib/availability-change-registration.test.js`
- Modify: `shared/permissions.js`, `shared/permission-bundles.js`, `shared/push-channels.js`, `src/lib/notifications-registry.js`, `src/lib/push-channels.test.js`

CLAUDE.md: an UNREGISTERED category fails CLOSED (reaches masters only), and `category` is the BARE name. Pass `'availability_change'`; the key is `notify_availability_change`.

- [ ] **Step 1: Write the failing test**

```js
// AVAIL.1 — the `availability_change` push category is registered at EVERY
// site a category needs. An unregistered category fails CLOSED (CLAUDE.md):
// only masters would ever see it. Default ON for all six roles, not just the
// roster builders: sendPushOnce passes no locationId, so ONE assignment that
// resolves the key false (an owner who is `staff` somewhere, PUSH-LOC.1)
// silences the person everywhere. Recipients are narrowed in code instead.

import { describe, it, expect } from 'vitest'
import { MOBILE_PERMISSIONS, DEFAULT_MOBILE_PERMISSIONS_BY_ROLE, NOTIFY_KEYS } from '@shared/permissions'
import { EXEMPT_KEYS } from '@shared/permission-bundles'
import { androidChannelId } from '@shared/push-channels'
import { getNotificationCategory } from './notifications-registry'

const KEY = 'notify_availability_change'

describe('availability_change category registration', () => {
  it('is a personal, mobile-only notify toggle with a label the settings screens can render', () => {
    const entry = MOBILE_PERMISSIONS.find((p) => p.key === KEY)
    expect(entry).toMatchObject({ key: KEY, mobileOnly: true, isNotify: true })
    expect(entry.label).toMatch(/Availability changes/)
    expect(NOTIFY_KEYS).toContain(KEY)
  })

  it('defaults ON for every role', () => {
    const roles = Object.keys(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE)
    expect(roles.sort()).toEqual(['head_coach', 'manager', 'master', 'owner', 'reception', 'staff'])
    for (const role of roles) expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[role][KEY], role).toBe(true)
  })

  it('is exempt from the location feature gate, like every notify_* key', () => {
    expect(EXEMPT_KEYS).toContain(KEY)
  })

  it('rides the Android "updates" channel (an FYI, nothing to decide)', () => {
    expect(androidChannelId({ category: 'availability_change', type: 'availability_changed' })).toBe('updates')
  })

  it('is in the registry: event + cron, roster builders, no email fallback', () => {
    expect(getNotificationCategory('availability_change')).toMatchObject({
      category: 'availability_change',
      label: 'Availability changes',
      trigger: { kind: 'event' },
      recipients: { kind: 'roles_at_location' },
      configurable: { leadTimes: false, roles: false },
      fallbackEmail: false,
    })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/availability-change-registration.test.js`
Expected: 5 failed (the first on `entry` being `undefined`).

- [ ] **Step 3: Implement (five files)**

**(a) `shared/permissions.js`, the key.** Directly under the `notify_shift_reminder` entry (line 720):

```js
  // AVAIL.1 — a coach at your studio changed when they are unavailable.
  // Recipients are the roster builders (owner, manager, head coach) at each
  // of the coach's studios; sent 07:00-22:00 studio time, later if saved
  // outside it. Default ON for every role (see
  // src/lib/availability-change-registration.test.js for why not only the
  // manager roles).
  { key: 'notify_availability_change', label: '… Availability changes', hint: 'Notify when a coach at your studio changes when they are unavailable (roster builders)', mobileOnly: true, isNotify: true },
```

(Copy the leading `… ` from the line above.)

**(b) `shared/permissions.js`, six role defaults.** Under each of the six `    notify_shift_reminder: true,` lines (787 master, 826 staff, 868 reception, 904 head_coach, 944 manager, 986 owner):

```js
    notify_availability_change: true,
```

Check: `grep -c "notify_availability_change: true," shared/permissions.js` prints `6`.

**(c) `shared/permission-bundles.js`.** Under `'notify_shift_reminder',` (line 397) add `  'notify_availability_change',`; change `26 personal` to `27 personal` at lines 335 and 380.

**(d) `shared/push-channels.js`.** In `CATEGORY_CHANNELS`, under `shift_adjusted: 'updates',` (line 101):

```js
  availability_change: 'updates', // AVAIL.1 — a coach changed their availability; an FYI
```

**(e) `src/lib/notifications-registry.js`.** After the `contract_issued` entry's closing `},` (the last entry, before `])` at line 260):

```js
  {
    category: 'availability_change',
    label: 'Availability changes',
    description: 'A coach at your studio saved a change to when they are unavailable: which weekly times or dates were added or removed. One notification per save. Sent between 7am and 10pm studio time; a change saved outside those hours is sent at 7am, and several overnight changes by one coach arrive as one.',
    trigger: { kind: 'event', source: 'PUT /api/schedule/availability (inside 07:00-22:00) + the checklist-sweep cron (deferred ones) -> src/lib/availability-notify.js' },
    recipients: { kind: 'roles_at_location', detail: 'Owner, manager and head coach (and masters) at every studio the coach belongs to, never the coach' },
    configurable: { leadTimes: false, roles: false },
    // An FYI with nothing to decide, and the roster shows it: no email.
    fallbackEmail: false,
  },
```

**(f) `src/lib/push-channels.test.js`.** Add to `STAFF_TYPES`, after `'roster_runway', // RUNWAY.1 …`:

```js
  'availability_changed', // AVAIL.1 — rides category 'availability_change'
```

- [ ] **Step 4: Run it with the drift guards, expect PASS**

Run: `npx vitest run src/lib/availability-change-registration.test.js shared/permission-bundles.test.js src/lib/push-channels.test.js src/lib/shared-permissions.test.js tests/push-category-literals.test.js src/lib/shift-reminder-registration.test.js`
Expected: all passed.
Run: `npm run check:mobile-parity && npm run check:bundle-sql`
Expected: both exit 0 (`mobileOnly: true` satisfies parity; `EXEMPT_KEYS` is not in the SQL mirror).

- [ ] **Step 5: Commit**

```bash
git add shared/permissions.js shared/permission-bundles.js shared/push-channels.js src/lib/notifications-registry.js src/lib/availability-change-registration.test.js src/lib/push-channels.test.js
git commit -m "AVAIL.1a — register the availability_change push category, default on, updates channel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `src/lib/availability-server.js` — schema, own read, save, studio read

**Files:**
- Create: `src/lib/availability-server.js`
- Create: `src/lib/availability-server.test.js`

**Before you start:** `grep -n "export const realIsoDate" src/lib/schemas.js`. DATECHECK.1 (plan 11) adds it. If it prints nothing, add exactly DATECHECK.1's line directly under `isRealCalendarDate` (`src/lib/schemas.js:32-38`) in this PR, so the later rebase is a no-op:

```js
export const realIsoDate = isoDate.refine(isRealCalendarDate, 'Use a real date, YYYY-MM-DD')
```

Every `.select()` below is a literal on its `.from()` chain so `check:select-columns` can read it (a shared constant hid selects from it, `src/app/api/schedule/time-off/route.js:118-121`).

- [ ] **Step 1: Write the failing test**

```js
// AVAIL.1 — the availability data layer. The RPC's own rules are pinned by
// tests/migration-630-staff-availability.test.js; this file pins what the
// routes rely on: the body schema, the reads' filters and shapes, and that a
// failed read or save is an error, never an empty answer.

import { describe, it, expect } from 'vitest'
import { WEEKDAY_CODES } from '@/lib/roster'
import { AVAILABILITY_WEEKDAYS } from '@shared/availability'
import {
  AvailabilityPutSchema, readOwnAvailability, saveOwnAvailability, readStudioAvailability, isAvailabilityInputError,
} from './availability-server'

// A recording fake: each from() gets a builder whose chain methods record
// their arguments and whose await resolves handlers[table](call).
function fakeDb(handlers, rpc = null) {
  const calls = []
  return {
    calls,
    rpc: rpc || (async () => ({ data: null, error: null })),
    from(table) {
      const call = { table, ops: [] }
      calls.push(call)
      const b = {}
      for (const m of ['select', 'eq', 'in', 'is', 'or', 'order', 'limit', 'range']) {
        b[m] = (...args) => { call.ops.push([m, ...args]); return b }
      }
      b.then = (resolve, reject) => Promise.resolve().then(() => handlers[table](call)).then(resolve, reject)
      return b
    },
  }
}
const op = (call, name) => call.ops.find((o) => o[0] === name)

describe('weekday codes', () => {
  it('match the roster code (shift_templates.days_of_week)', () => {
    expect([...AVAILABILITY_WEEKDAYS]).toEqual([...WEEKDAY_CODES])
  })
})

describe('AvailabilityPutSchema', () => {
  it('accepts the documented body and defaults the lists and all_day', () => {
    const r = AvailabilityPutSchema.safeParse({ weekly: [{ weekday: 'mon', start_time: '09:00', end_time: '12:00' }] })
    expect(r.success).toBe(true)
    expect(r.data).toEqual({ weekly: [{ weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00' }], dated: [] })
  })
  it.each([
    [{ weekly: [{ weekday: 'monday', all_day: true }] }],
    [{ dated: [{ start_date: '2026-02-30', all_day: true }] }],
    [{ weekly: [{ weekday: 'mon', start_time: '9am', end_time: '10am' }] }],
    [{ weekly: [{ weekday: 'mon', all_day: true, note: 'x'.repeat(201) }] }],
    [{ weekly: 'mon' }],
  ])('refuses %j', (body) => expect(AvailabilityPutSchema.safeParse(body).success).toBe(false))
})

describe('readOwnAvailability', () => {
  it("reads the person's weekly + not-yet-ended dated rules and returns them sorted, without ids", async () => {
    const db = fakeDb({
      staff_unavailability: () => ({
        data: [
          { kind: 'dated', weekday: null, start_date: '2026-10-03', end_date: '2026-10-03', all_day: true, start_time: null, end_time: null, note: 'Wedding' },
          { kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '09:00:00', end_time: '12:00:00', note: null },
        ],
        error: null,
      }),
    })
    const { data, error } = await readOwnAvailability(db, 'p1', '2026-09-25')
    expect(error).toBeNull()
    expect(data.weekly).toEqual([{ kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:00', note: null }])
    expect(data.dated[0]).toMatchObject({ start_date: '2026-10-03', note: 'Wedding' })
    const call = db.calls[0]
    expect(op(call, 'eq')).toEqual(['eq', 'profile_id', 'p1'])
    expect(op(call, 'or')).toEqual(['or', 'kind.eq.weekly,end_date.gte.2026-09-25'])
  })
  it('a failed read is an error, never an empty availability', async () => {
    const db = fakeDb({ staff_unavailability: () => ({ data: null, error: { message: 'down' } }) })
    expect(await readOwnAvailability(db, 'p1', '2026-09-25')).toEqual({ data: null, error: { message: 'down' } })
  })
})

describe('saveOwnAvailability', () => {
  it('calls the RPC with the canonical lists and returns its answer', async () => {
    let args = null
    const db = fakeDb({}, async (name, a) => {
      args = { name, ...a }
      return { data: { changed: true, change_id: 'c1', before: [], after: [{ kind: 'weekly', weekday: 'mon', all_day: true }] }, error: null }
    })
    const weekly = [{ kind: 'weekly', weekday: 'mon', all_day: true, start_time: null, end_time: null, note: null }]
    const { result, error } = await saveOwnAvailability(db, { profileId: 'p1', actorId: 'm1', todayIso: '2026-09-25', weekly, dated: [] })
    expect(error).toBeNull()
    expect(args).toEqual({ name: 'replace_staff_unavailability', p_profile_id: 'p1', p_actor_id: 'm1', p_today: '2026-09-25', p_weekly: weekly, p_dated: [] })
    expect(result).toEqual({ changed: true, changeId: 'c1', before: [], after: [{ kind: 'weekly', weekday: 'mon', all_day: true }] })
  })
  it('passes the RPC error through', async () => {
    const db = fakeDb({}, async () => ({ data: null, error: { code: 'P0001', message: 'availability_past_date: …' } }))
    const { result, error } = await saveOwnAvailability(db, { profileId: 'p1', actorId: 'p1', todayIso: '2026-09-25', weekly: [], dated: [] })
    expect(result).toBeNull()
    expect(isAvailabilityInputError(error)).toBe(true)
  })
  it.each([
    [{ code: '23514', message: 'violates check constraint' }, true],
    [{ code: '22007', message: 'invalid input syntax for type time' }, true],
    [{ code: 'P0001', message: 'availability_no_profile: …' }, true],
    [{ code: '42P01', message: 'relation does not exist' }, false],
    [{ code: '23503', message: 'fk' }, false],
    [null, false],
  ])('isAvailabilityInputError(%j) → %s', (err, expected) => expect(isAvailabilityInputError(err)).toBe(expected))
})

describe('readStudioAvailability', () => {
  const links = [
    { profile_id: 'c1', profiles: { id: 'c1', active: true, deleted_at: null } },
    { profile_id: 'c2', profiles: { id: 'c2', active: false, deleted_at: null } },
    { profile_id: 'c3', profiles: { id: 'c3', active: null, deleted_at: null } }, // NULL counts as active (mig 626)
  ]
  it("reads that studio's ACTIVE members, then their weekly rules and the dated rules overlapping the range", async () => {
    const db = fakeDb({
      profile_locations: () => ({ data: links, error: null }),
      staff_unavailability: () => ({
        data: [{ id: 'r1', profile_id: 'c1', kind: 'weekly', weekday: 'wed', start_date: null, end_date: null, all_day: false, start_time: '10:00:00', end_time: '11:00:00', note: 'School run' }],
        error: null,
      }),
    })
    const { data, error } = await readStudioAvailability(db, { locationId: 'L1', startDate: '2026-05-04', endDate: '2026-05-10' })
    expect(error).toBeNull()
    expect(data).toEqual([{ id: 'r1', profile_id: 'c1', kind: 'weekly', weekday: 'wed', start_date: null, end_date: null, all_day: false, start_time: '10:00', end_time: '11:00', note: 'School run' }])
    const [members, rules] = db.calls
    expect(op(members, 'eq')).toEqual(['eq', 'location_id', 'L1'])
    expect(op(rules, 'in')).toEqual(['in', 'profile_id', ['c1', 'c3']])
    expect(op(rules, 'or')).toEqual(['or', 'kind.eq.weekly,and(start_date.lte.2026-05-10,end_date.gte.2026-05-04)'])
    expect(op(rules, 'range')).toEqual(['range', 0, 999])
  })
  it('pages past 1,000 rules', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, profile_id: 'c1', kind: 'weekly', weekday: 'mon', all_day: true }))
    let n = 0
    const db = fakeDb({
      profile_locations: () => ({ data: links, error: null }),
      staff_unavailability: () => ({ data: n++ === 0 ? page : [page[0]], error: null }),
    })
    const { data } = await readStudioAvailability(db, { locationId: 'L1', startDate: '2026-05-04', endDate: '2026-05-10' })
    expect(data).toHaveLength(1001)
  })
  it('no members is an empty list, with no rules read', async () => {
    const db = fakeDb({ profile_locations: () => ({ data: [], error: null }) })
    expect(await readStudioAvailability(db, { locationId: 'L1', startDate: '2026-05-04', endDate: '2026-05-10' })).toEqual({ data: [], error: null })
    expect(db.calls).toHaveLength(1)
  })
  it('a failed member read or rule read is an error, never "nobody is unavailable"', async () => {
    const down = { message: 'down' }
    const a = fakeDb({ profile_locations: () => ({ data: null, error: down }) })
    expect((await readStudioAvailability(a, { locationId: 'L1', startDate: '2026-05-04', endDate: '2026-05-10' })).error).toBe(down)
    const b = fakeDb({ profile_locations: () => ({ data: links, error: null }), staff_unavailability: () => ({ data: null, error: down }) })
    expect((await readStudioAvailability(b, { locationId: 'L1', startDate: '2026-05-04', endDate: '2026-05-10' })).error).toBe(down)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/availability-server.test.js`
Expected: fails to import `./availability-server`.

- [ ] **Step 3: Implement**

```js
// src/lib/availability-server.js
//
// AVAIL.1 — the availability data layer for /api/schedule/availability (and,
// in AVAIL.2, the phone through the same route). Service-role client passed
// in: mig 630's tables have no browser grants and no RLS policy, so the ROUTE
// is the whole access boundary (CLAUDE.md, "Service-role routes get NO RLS").
//
// Every select is a literal on its from() chain so check:select-columns can
// read it.

import { z } from 'zod'
import { timeOfDay, realIsoDate } from '@/lib/schemas'
import { AVAILABILITY_WEEKDAYS, AVAILABILITY_LIMITS, normaliseRule, splitRules } from '@shared/availability'

export const AVAILABILITY_RANGE_MAX_DAYS = 92
const PAGE = 1000

const Time = timeOfDay.nullable().optional()
const Note = z.string().max(AVAILABILITY_LIMITS.noteChars).nullable().optional()

export const WeeklyUnavailabilitySchema = z.object({
  weekday: z.enum([...AVAILABILITY_WEEKDAYS]),
  all_day: z.boolean().default(false),
  start_time: Time,
  end_time: Time,
  note: Note,
})

export const DatedUnavailabilitySchema = z.object({
  start_date: realIsoDate,
  end_date: realIsoDate.optional(),
  all_day: z.boolean().default(false),
  start_time: Time,
  end_time: Time,
  note: Note,
})

// SHAPE only. The cross-field rules (end after start, a real range, not in
// the past) are availabilityProblems() in shared/availability.js, so the
// phone's form and this route answer in the same words. The counts are
// capped here too so a hostile body is refused before it is normalised.
export const AvailabilityPutSchema = z.object({
  weekly: z.array(WeeklyUnavailabilitySchema).max(AVAILABILITY_LIMITS.weekly).default([]),
  dated: z.array(DatedUnavailabilitySchema).max(AVAILABILITY_LIMITS.dated).default([]),
})

/** An RPC error that is the CALLER's input (400), not an outage (500). */
export function isAvailabilityInputError(error) {
  if (!error) return false
  if (['23514', '22007', '22008', '22P02', '22023'].includes(error.code)) return true
  return /^availability_/.test(String(error.message || ''))
}

/**
 * The person's weekly rules and dated rules that have not ended, as
 * { weekly, dated } in canonical form. Rules ended before today are history
 * (mig 630) and are not returned.
 */
export async function readOwnAvailability(db, profileId, todayIso) {
  const { data, error } = await db
    .from('staff_unavailability')
    .select('kind, weekday, start_date, end_date, all_day, start_time, end_time, note')
    .eq('profile_id', profileId)
    .or(`kind.eq.weekly,end_date.gte.${todayIso}`)
    .order('created_at', { ascending: true })
  if (error) return { data: null, error }
  return { data: splitRules(data || []), error: null }
}

/**
 * Replace the person's weekly + current/future dated rules (the RPC,
 * mig 630). `weekly`/`dated` are canonical (normaliseAvailability).
 * @returns {{ result: { changed, changeId, before, after } | null, error }}
 */
export async function saveOwnAvailability(db, { profileId, actorId, todayIso, weekly, dated }) {
  const { data, error } = await db.rpc('replace_staff_unavailability', {
    p_profile_id: profileId,
    p_actor_id: actorId,
    p_today: todayIso,
    p_weekly: weekly,
    p_dated: dated,
  })
  if (error) return { result: null, error }
  return {
    result: {
      changed: data?.changed === true,
      changeId: data?.change_id ?? null,
      before: Array.isArray(data?.before) ? data.before : [],
      after: Array.isArray(data?.after) ? data.after : [],
    },
    error: null,
  }
}

/**
 * Every ACTIVE member of one studio, and their rules that bear on
 * [startDate, endDate]: every weekly rule, and the dated rules overlapping
 * the range. Flat rows with profile_id and id, canonical times. The caller
 * has already checked the studio (assertLocationAccess + a manager role AT
 * it); the member read is scoped to that studio, so another organisation's
 * coach can never appear. `active IS NOT FALSE` is mig 626's staff predicate
 * (a NULL active still counts); tombstones have no profile_locations at all.
 */
export async function readStudioAvailability(db, { locationId, startDate, endDate }) {
  const { data: links, error: linkError } = await db
    .from('profile_locations')
    .select('profile_id, profiles!inner(id, active, deleted_at)')
    .eq('location_id', locationId)
  if (linkError) return { data: null, error: linkError }
  const ids = [...new Set((links || [])
    .filter((l) => l?.profile_id && l.profiles?.active !== false && !l.profiles?.deleted_at)
    .map((l) => l.profile_id))]
  if (ids.length === 0) return { data: [], error: null }

  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('staff_unavailability')
      .select('id, profile_id, kind, weekday, start_date, end_date, all_day, start_time, end_time, note')
      .in('profile_id', ids)
      .or(`kind.eq.weekly,and(start_date.lte.${endDate},end_date.gte.${startDate})`)
      .order('profile_id', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return { data: null, error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { data: rows.map((r) => ({ id: r.id, profile_id: r.profile_id, ...normaliseRule(r) })), error: null }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/availability-server.test.js`
Expected: all passed. Then `npm run check:select-columns`: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/availability-server.js src/lib/availability-server.test.js src/lib/schemas.js
git commit -m "AVAIL.1a — availability data layer: body schema, own read, atomic save, studio range read

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`src/lib/schemas.js` only if you had to add `realIsoDate`.)

---

### Task 5: `src/lib/availability-notify.js` — telling the managers

**Files:**
- Create: `src/lib/availability-notify.js`
- Create: `src/lib/availability-notify.test.js`

- [ ] **Step 1: Write the failing test**

```js
// AVAIL.1 — the managers' notice. One push per save to the roster builders at
// every studio the coach belongs to, inside 07:00-22:00 studio time, deduped
// by change id; outside the band it waits for the sweep. Instants are UTC with
// the Dublin wall clock in the test name (BST on these dates: UTC+1).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/push-dedup', () => ({ sendPushOnce: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { sendPushOnce } = await import('@/lib/push-dedup')
const { logError } = await import('@/lib/log')
const {
  AVAILABILITY_NOTIFY_ROLES, AVAILABILITY_NOTICE_MAX_AGE_MS, availabilityEventKey, availabilityNoticeText,
  splitStudiosByBand, deliverAvailabilityNotice, runAvailabilityNoticeSweep,
} = await import('./availability-notify')
const { RUNWAY_NOTIFY_ROLES } = await import('./roster-runway-notify')

const COACH = 'coach-1'
const LOC_A = 'loc-a'
const LOC_B = 'loc-b'
const NOON = Date.parse('2026-09-25T11:00:00Z')      // 12:00 Dublin
const LATE = Date.parse('2026-09-25T22:30:00Z')      // 23:30 Dublin
const MON = { kind: 'weekly', weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00', note: null }
const TUE = { kind: 'weekly', weekday: 'tue', all_day: true, start_time: null, end_time: null, note: null }

function change(over = {}) {
  return { id: 'ch-1', profile_id: COACH, before: [MON], after: [TUE], created_at: '2026-09-25T10:59:00Z', ...over }
}

// Recording fake; handlers[table](call) answers each awaited chain.
function fakeDb(handlers) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, ops: [] }
      calls.push(call)
      const b = {}
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update', 'maybeSingle']) {
        b[m] = (...args) => { call.ops.push([m, ...args]); return b }
      }
      b.then = (resolve, reject) => Promise.resolve().then(() => handlers[table](call)).then(resolve, reject)
      return b
    },
  }
}
const has = (call, name) => call.ops.some((o) => o[0] === name)
const stamps = (db) => db.calls.filter((c) => c.table === 'staff_availability_changes' && has(c, 'update'))

// profile_locations answers two different reads: the coach's studios (.eq)
// and the recipients at those studios (.in). Fictional people only.
function world({ coachStudios = [LOC_A, LOC_B], tz = 'Europe/Dublin', members, linkError = null, stampError = null, queue = [], queueError = null } = {}) {
  const roster = members || [
    { profile_id: 'mgr-a', location_id: LOC_A, role: 'manager', profiles: { id: 'mgr-a', role: 'staff', active: true } },
    { profile_id: 'hc-b', location_id: LOC_B, role: 'head_coach', profiles: { id: 'hc-b', role: 'staff', active: true } },
    { profile_id: 'own', location_id: LOC_A, role: 'owner', profiles: { id: 'own', role: 'staff', active: true } },
    { profile_id: 'own', location_id: LOC_B, role: 'owner', profiles: { id: 'own', role: 'staff', active: true } },
    { profile_id: 'staff-a', location_id: LOC_A, role: 'staff', profiles: { id: 'staff-a', role: 'staff', active: true } },
    { profile_id: 'gone-mgr', location_id: LOC_A, role: 'manager', profiles: { id: 'gone-mgr', role: 'staff', active: false } },
    { profile_id: 'master', location_id: LOC_B, role: 'staff', profiles: { id: 'master', role: 'master', active: true } },
    { profile_id: COACH, location_id: LOC_A, role: 'head_coach', profiles: { id: COACH, role: 'staff', active: true } },
  ]
  return fakeDb({
    profile_locations: (call) => {
      if (has(call, 'eq')) {
        if (linkError) return { data: null, error: linkError }
        return { data: coachStudios.map((id) => ({ location_id: id, locations: { id, timezone: tz } })), error: null }
      }
      return { data: roster, error: null }
    },
    profiles: () => ({ data: { full_name: 'Sam Demo' }, error: null }),
    staff_availability_changes: (call) => (has(call, 'update')
      ? { data: null, error: stampError }
      : { data: queueError ? null : queue, error: queueError }),
  })
}

beforeEach(() => {
  sendPushOnce.mockReset()
  sendPushOnce.mockResolvedValue({ sent: 3, skipped: 0, invalidated: 0, failed: 0, deduped: 0 })
  logError.mockReset()
})

describe('constants and text', () => {
  it("tells the roster builders: the runway alert's roles", () => {
    expect(AVAILABILITY_NOTIFY_ROLES).toEqual(RUNWAY_NOTIFY_ROLES)
    expect(AVAILABILITY_NOTICE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000)
    expect(availabilityEventKey('x')).toBe('availability_changed:x')
  })
  it('says what was added and removed', () => {
    expect(availabilityNoticeText({ coachName: 'Sam Demo', before: [MON], after: [TUE] })).toEqual({
      title: 'Availability changed',
      body: 'Sam Demo is now unavailable Tuesdays, all day; available again Mondays, 9am–12pm.',
    })
  })
  it('caps a long list, and says a note-only change for what it is', () => {
    const many = ['mon', 'tue', 'wed', 'thu', 'fri'].map((weekday) => ({ ...TUE, weekday }))
    expect(availabilityNoticeText({ coachName: 'Sam Demo', before: [], after: many }).body)
      .toBe('Sam Demo is now unavailable Mondays, all day, Tuesdays, all day, Wednesdays, all day and 2 more.')
    expect(availabilityNoticeText({ coachName: ' ', before: [MON], after: [{ ...MON, note: 'x' }] }).body)
      .toBe('A coach updated the notes on their availability.')
  })
  it("splits studios by the 07:00-22:00 band at each studio's own clock", () => {
    const split = splitStudiosByBand([{ id: LOC_A, timezone: 'Europe/Dublin' }, { id: LOC_B, timezone: 'America/New_York' }], LATE)
    expect(split.inBand.map((s) => s.id)).toEqual([LOC_B]) // 18:30 in New York
    expect(split.quiet.map((s) => s.id)).toEqual([LOC_A])
  })
})

describe('deliverAvailabilityNotice', () => {
  it('in band: ONE deduped push to the roster builders and masters at both studios, never the coach, then stamped sent', async () => {
    const db = world()
    const out = await deliverAvailabilityNotice(db, change(), { nowMs: NOON })
    expect(out).toEqual({ status: 'sent', sent: 3 })
    expect(sendPushOnce).toHaveBeenCalledTimes(1)
    const [, key, ids, payload] = sendPushOnce.mock.calls[0]
    expect(key).toBe('availability_changed:ch-1')
    expect([...ids].sort()).toEqual(['hc-b', 'master', 'mgr-a', 'own'])
    expect(payload).toMatchObject({
      title: 'Availability changed',
      category: 'availability_change',
      data: { type: 'availability_changed', profile_id: COACH, change_id: 'ch-1' },
    })
    const [stamp] = stamps(db)
    expect(stamp.ops).toContainEqual(['update', { notified_at: new Date(NOON).toISOString(), notice_outcome: 'sent' }])
    expect(stamp.ops).toContainEqual(['in', 'id', ['ch-1']])
    expect(stamp.ops).toContainEqual(['is', 'notified_at', null])
  })

  it('outside the band: nothing sent, nothing stamped (the sweep sends it at 07:00)', async () => {
    const db = world()
    expect(await deliverAvailabilityNotice(db, change({ created_at: '2026-09-25T22:29:00Z' }), { nowMs: LATE })).toEqual({ status: 'deferred', sent: 0 })
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(stamps(db)).toHaveLength(0)
  })

  it('a coach with no studio: stamped no_recipients, no push', async () => {
    const db = world({ coachStudios: [] })
    expect((await deliverAvailabilityNotice(db, change(), { nowMs: NOON })).status).toBe('no_recipients')
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(stamps(db)[0].ops).toContainEqual(['update', { notified_at: new Date(NOON).toISOString(), notice_outcome: 'no_recipients' }])
  })

  it('an unreadable membership is an error: no push, no stamp (a later tick retries)', async () => {
    const db = world({ linkError: { message: 'down' } })
    expect((await deliverAvailabilityNotice(db, change(), { nowMs: NOON })).status).toBe('error')
    expect(sendPushOnce).not.toHaveBeenCalled()
    expect(stamps(db)).toHaveLength(0)
    expect(logError).toHaveBeenCalled()
  })

  it('a push that failed outright is retried later, not stamped', async () => {
    sendPushOnce.mockResolvedValueOnce({ sent: 0, skipped: 0, invalidated: 0, failed: 2, deduped: 0 })
    const db = world()
    expect((await deliverAvailabilityNotice(db, change(), { nowMs: NOON })).status).toBe('deferred')
    expect(stamps(db)).toHaveLength(0)
  })

  it('older than 24 hours: stamped stale, never sent', async () => {
    const db = world()
    const old = change({ created_at: new Date(NOON - AVAILABILITY_NOTICE_MAX_AGE_MS - 1).toISOString() })
    expect((await deliverAvailabilityNotice(db, old, { nowMs: NOON })).status).toBe('stale')
    expect(sendPushOnce).not.toHaveBeenCalled()
  })

  it('a later save that undid it: stamped reverted, never sent', async () => {
    const db = world()
    expect((await deliverAvailabilityNotice(db, change({ after: [MON] }), { nowMs: NOON })).status).toBe('reverted')
    expect(sendPushOnce).not.toHaveBeenCalled()
  })

  it('a failed stamp is reported as an error, after the push went (the ledger stops a double)', async () => {
    const db = world({ stampError: { message: 'down' } })
    expect((await deliverAvailabilityNotice(db, change(), { nowMs: NOON })).status).toBe('error')
    expect(sendPushOnce).toHaveBeenCalledTimes(1)
  })
})

describe('runAvailabilityNoticeSweep', () => {
  it("folds one coach's overnight saves into ONE notice: oldest before, newest after, newest id, every row stamped", async () => {
    const db = world({
      queue: [
        { id: 'ch-1', profile_id: COACH, before: [MON], after: [], created_at: '2026-09-24T22:10:00Z' },
        { id: 'ch-2', profile_id: COACH, before: [], after: [TUE], created_at: '2026-09-24T22:40:00Z' },
      ],
    })
    const out = await runAvailabilityNoticeSweep(db, { nowMs: Date.parse('2026-09-25T06:05:00Z') }) // 07:05 Dublin
    expect(out).toMatchObject({ pending: 2, groups: 1, sent: 1, errors: 0 })
    const [, key, , payload] = sendPushOnce.mock.calls[0]
    expect(key).toBe('availability_changed:ch-2')
    expect(payload.body).toBe('Sam Demo is now unavailable Tuesdays, all day; available again Mondays, 9am–12pm.')
    expect(stamps(db)[0].ops).toContainEqual(['in', 'id', ['ch-1', 'ch-2']])
  })

  it('reads only un-notified rows, oldest first, capped', async () => {
    const db = world()
    await runAvailabilityNoticeSweep(db, { nowMs: NOON })
    const read = db.calls.find((c) => c.table === 'staff_availability_changes')
    expect(read.ops).toContainEqual(['is', 'notified_at', null])
    expect(read.ops).toContainEqual(['order', 'created_at', { ascending: true }])
    expect(read.ops).toContainEqual(['limit', 200])
  })

  it('a quiet tick defers without errors (so the heartbeat stamps overnight)', async () => {
    const db = world({ queue: [{ id: 'ch-1', profile_id: COACH, before: [MON], after: [TUE], created_at: '2026-09-25T22:00:00Z' }] })
    expect(await runAvailabilityNoticeSweep(db, { nowMs: LATE })).toMatchObject({ deferred: 1, errors: 0 })
  })

  it('an unreadable queue is one error, never "nothing owed"', async () => {
    const db = world({ queueError: { message: 'down' } })
    expect(await runAvailabilityNoticeSweep(db, { nowMs: NOON })).toMatchObject({ errors: 1, pending: 0 })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/availability-notify.test.js`
Expected: fails to import `./availability-notify`.

- [ ] **Step 3: Implement**

```js
// src/lib/availability-notify.js
//
// AVAIL.1 — telling the managers that a coach changed their availability.
//
// WHO: the roster builders (owner, manager, head coach: the runway alert's
// roles) and masters linked to each studio the coach belongs to, active only,
// never the coach. Read here with its own query: resolveRoleRecipientIds
// (push.js) discards its read error, and "the read failed" must never be
// stamped as "nobody to tell".
//
// WHEN: staff quiet hours (src/lib/staff-push-hours.js) gate the NOTICE, never
// the save. The route calls deliverAvailabilityNotice straight after a save;
// in band it sends, otherwise the change row stays un-notified and the
// checklist-sweep cron's arm (runAvailabilityNoticeSweep) sends it on the
// first tick at or after 07:00. A coach's overnight saves become ONE notice.
// Older than 24h: dropped as stale (the swap expiry notice's rule).
//
// ONCE: sendPushOnce keyed 'availability_changed:<change id>', so the route,
// a retry and the sweep can never double-push; a manager at both studios gets
// one. notified_at is stamped AFTER the send (BAREWRITE (c): no claim-before-
// send without a lease). A push that failed outright is not stamped, so the
// next tick retries it inside the 24h window.

import { sendPushOnce } from '@/lib/push-dedup'
import { inStaffPushHours, resolveStaffTimeZone } from '@/lib/staff-push-hours'
import { RUNWAY_NOTIFY_ROLES } from '@/lib/roster-runway-notify'
import { diffAvailability, sameAvailability, describeRule } from '@shared/availability'
import { logWarn, logError } from '@/lib/log'

export const AVAILABILITY_NOTIFY_ROLES = RUNWAY_NOTIFY_ROLES
export const AVAILABILITY_NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const AVAILABILITY_SWEEP_BATCH = 200
export const availabilityEventKey = (changeId) => `availability_changed:${changeId}`

function listRules(rules, max = 3) {
  const shown = rules.slice(0, max).map(describeRule)
  const more = rules.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

/** The push text. Pure. */
export function availabilityNoticeText({ coachName, before, after }) {
  const name = (typeof coachName === 'string' && coachName.trim()) || 'A coach'
  const { added, removed } = diffAvailability(before, after)
  const parts = []
  if (added.length) parts.push(`now unavailable ${listRules(added)}`)
  if (removed.length) parts.push(`available again ${listRules(removed)}`)
  return {
    title: 'Availability changed',
    body: parts.length ? `${name} is ${parts.join('; ')}.` : `${name} updated the notes on their availability.`,
  }
}

/** Studios whose wall clock is inside 07:00-22:00 now, and the rest. */
export function splitStudiosByBand(studios, nowMs) {
  const inBand = []
  const quiet = []
  for (const s of studios || []) {
    const { timeZone, warn } = resolveStaffTimeZone(s.timezone)
    if (warn) logWarn('availability-notify', 'studio timezone unreadable, using Europe/Dublin', { location_id: s.id })
    if (inStaffPushHours(nowMs, timeZone)) inBand.push(s)
    else quiet.push(s)
  }
  return { inBand, quiet }
}

async function readRecipients(db, locationIds, coachId) {
  const { data, error } = await db
    .from('profile_locations')
    .select('profile_id, location_id, role, profiles!inner(id, role, active)')
    .in('location_id', locationIds)
  if (error) return { ids: null, error }
  const ids = new Set()
  for (const l of data || []) {
    if (!l?.profiles?.active || l.profile_id === coachId) continue
    if (AVAILABILITY_NOTIFY_ROLES.includes(l.role) || l.profiles.role === 'master') ids.add(l.profile_id)
  }
  return { ids: [...ids], error: null }
}

async function settle(db, ids, outcome, nowMs, sent = 0) {
  const { error } = await db
    .from('staff_availability_changes')
    .update({ notified_at: new Date(nowMs).toISOString(), notice_outcome: outcome })
    .in('id', ids)
    .is('notified_at', null)
  if (error) {
    logError('availability-notify', 'could not stamp the notice', { ids, outcome, err: error.message })
    return { status: 'error', sent }
  }
  return { status: outcome, sent }
}

/**
 * Tell the managers about one change (or, from the sweep, one coach's folded
 * changes: `ids` lists every row it settles, `id` is the newest).
 * Never throws. status: sent | deferred | stale | reverted | no_recipients | error.
 */
export async function deliverAvailabilityNotice(db, change, { nowMs = Date.now() } = {}) {
  try {
    const ids = Array.isArray(change.ids) && change.ids.length ? change.ids : [change.id]
    const createdMs = Date.parse(change.created_at)
    if (Number.isFinite(createdMs) && nowMs - createdMs > AVAILABILITY_NOTICE_MAX_AGE_MS) return settle(db, ids, 'stale', nowMs)
    if (sameAvailability(change.before, change.after)) return settle(db, ids, 'reverted', nowMs)

    const { data: links, error: linkError } = await db
      .from('profile_locations')
      .select('location_id, locations!inner(id, timezone)')
      .eq('profile_id', change.profile_id)
    if (linkError) {
      logError('availability-notify', "could not read the coach's studios", { change_id: change.id, err: linkError.message })
      return { status: 'error', sent: 0 }
    }
    const studios = (links || []).filter((l) => l?.location_id).map((l) => ({ id: l.location_id, timezone: l.locations?.timezone ?? null }))
    if (studios.length === 0) return settle(db, ids, 'no_recipients', nowMs)

    const { inBand, quiet } = splitStudiosByBand(studios, nowMs)
    if (inBand.length === 0) return { status: 'deferred', sent: 0 }

    const { ids: recipients, error: recipientError } = await readRecipients(db, inBand.map((s) => s.id), change.profile_id)
    if (recipientError) {
      logError('availability-notify', 'could not read the recipients', { change_id: change.id, err: recipientError.message })
      return { status: 'error', sent: 0 }
    }

    let sent = 0
    let failedOutright = false
    if (recipients.length > 0) {
      // A failed name read only costs the name ("A coach"), never the notice.
      const { data: person } = await db.from('profiles').select('full_name').eq('id', change.profile_id).maybeSingle()
      const { title, body } = availabilityNoticeText({ coachName: person?.full_name, before: change.before, after: change.after })
      const r = await sendPushOnce(db, availabilityEventKey(change.id), recipients, {
        title,
        body,
        category: 'availability_change',
        data: { type: 'availability_changed', profile_id: change.profile_id, change_id: change.id },
      })
      sent = r?.sent || 0
      failedOutright = (r?.failed || 0) > 0 && sent === 0
    }
    // A studio still in quiet hours, or a push that failed outright: leave it
    // owed. The dedup key means the managers already told are never told twice.
    if (quiet.length > 0 || failedOutright) return { status: 'deferred', sent }
    return settle(db, ids, recipients.length > 0 ? 'sent' : 'no_recipients', nowMs, sent)
  } catch (err) {
    logError('availability-notify', 'deliver threw', { change_id: change?.id, err: err?.message })
    return { status: 'error', sent: 0 }
  }
}

/**
 * The checklist-sweep cron's third arm: every notice still owed, one per
 * coach. Never throws; `errors` > 0 keeps its heartbeat from stamping.
 */
export async function runAvailabilityNoticeSweep(db, { nowMs = Date.now() } = {}) {
  const out = { pending: 0, groups: 0, sent: 0, deferred: 0, stale: 0, reverted: 0, no_recipients: 0, errors: 0 }
  const { data, error } = await db
    .from('staff_availability_changes')
    .select('id, profile_id, before, after, created_at')
    .is('notified_at', null)
    .order('created_at', { ascending: true })
    .limit(AVAILABILITY_SWEEP_BATCH)
  if (error) {
    logError('availability-notify', 'could not read the notice queue', { err: error.message })
    out.errors++
    return out
  }
  out.pending = (data || []).length
  const byCoach = new Map()
  for (const row of data || []) {
    if (!byCoach.has(row.profile_id)) byCoach.set(row.profile_id, [])
    byCoach.get(row.profile_id).push(row)
  }
  for (const rows of byCoach.values()) {
    out.groups++
    const first = rows[0]
    const last = rows[rows.length - 1]
    const r = await deliverAvailabilityNotice(db, {
      id: last.id,
      ids: rows.map((x) => x.id),
      profile_id: last.profile_id,
      before: first.before,
      after: last.after,
      created_at: last.created_at,
    }, { nowMs })
    if (r.status === 'error') out.errors++
    else out[r.status] = (out[r.status] || 0) + 1
  }
  return out
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/availability-notify.test.js tests/staff-tombstone-readers.test.js tests/push-category-literals.test.js`
Expected: all passed (the one `from('profiles')` read is `.eq('id', …)`, which the tombstone sweep accepts).

- [ ] **Step 5: Commit**

```bash
git add src/lib/availability-notify.js src/lib/availability-notify.test.js
git commit -m "AVAIL.1a — managers' availability notice: once per save, 07:00-22:00, deferred and folded overnight

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `GET/PUT /api/schedule/availability`

**Files:**
- Create: `src/app/api/schedule/availability/route.js`
- Create: `src/app/api/schedule/availability/route.test.js`

Contract:
- `GET` (no `location_id`): the caller's own `{ weekly, dated }`. Any signed-in staff profile, cookie or Bearer (`getCurrentUser`, `src/lib/auth.js:236`).
- `GET ?location_id=&start_date=&end_date=`: every active member's rules at that studio (flat rows). `assertLocationAccess` (403 for a studio outside the caller's assignments, the query-param convention), then a manager role AT that studio (`hasRoleAtLocation(user, id, MANAGER_ROLES)`, never `user.role`; master passes). Dates real, `end_date >= start_date`, at most 92 days (a month grid is 42).
- `PUT` body `{ weekly: [...], dated: [...] }`: replaces the caller's own. Always the caller's own; there is no `profile_id` in the body. `actor_id` is the master's id under View as user (`user.impersonatingFrom.masterId`, `src/lib/auth.js:353-357`).

- [ ] **Step 1: Write the failing test**

```js
// AVAIL.1 — GET/PUT /api/schedule/availability. The data layer and the
// notice are pinned in their own tests; here: the gates, the query contract,
// validation in both layers, and that a notice is handed to after() only for
// a real change.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, after: vi.fn((fn) => fn()) }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ db: true })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    hasRoleAtLocation: real.hasRoleAtLocation,
  }
})
vi.mock('@/lib/dublin-time', async (importOriginal) => ({ ...(await importOriginal()), dublinTodayStr: () => '2026-09-25' }))
vi.mock('@/lib/availability-server', async (importOriginal) => ({
  ...(await importOriginal()),
  readOwnAvailability: vi.fn(),
  saveOwnAvailability: vi.fn(),
  readStudioAvailability: vi.fn(),
}))
vi.mock('@/lib/availability-notify', () => ({ deliverAvailabilityNotice: vi.fn(async () => ({ status: 'sent', sent: 1 })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { after, NextResponse } = await import('next/server')
const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { readOwnAvailability, saveOwnAvailability, readStudioAvailability } = await import('@/lib/availability-server')
const { deliverAvailabilityNotice } = await import('@/lib/availability-notify')
const { GET, PUT } = await import('./route.js')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const coach = { id: 'u1', full_name: 'Sam Demo', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'staff' } }
const manager = { ...coach, id: 'm1', rolesByLocation: { [LOC]: 'manager' } }

const getReq = (params = {}) => {
  const url = new URL('http://test/api/schedule/availability')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const putReq = (body) => ({ url: 'http://test/api/schedule/availability', json: async () => body })

const MON = { weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00' }

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  readOwnAvailability.mockResolvedValue({ data: { weekly: [], dated: [] }, error: null })
  readStudioAvailability.mockResolvedValue({ data: [{ id: 'r1', profile_id: 'c1' }], error: null })
  saveOwnAvailability.mockResolvedValue({
    result: { changed: true, changeId: 'ch-1', before: [], after: [{ kind: 'weekly', weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00', note: null }] },
    error: null,
  })
})

describe('GET own', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq())).status).toBe(401)
    expect(readOwnAvailability).not.toHaveBeenCalled()
  })
  it('any staff member reads their own, as of Dublin today', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { weekly: [], dated: [] } })
    expect(readOwnAvailability).toHaveBeenCalledWith({ db: true }, 'u1', '2026-09-25')
  })
  it('a failed read is a 500, never an empty availability', async () => {
    getCurrentUser.mockResolvedValue(coach)
    readOwnAvailability.mockResolvedValue({ data: null, error: { message: 'down' } })
    expect((await GET(getReq())).status).toBe(500)
  })
})

describe('GET studio range', () => {
  const q = { location_id: LOC, start_date: '2026-05-04', end_date: '2026-05-10' }
  it("403 from assertLocationAccess for a studio outside the caller's assignments", async () => {
    getCurrentUser.mockResolvedValue(manager)
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false }, { status: 403 }))
    expect((await GET(getReq(q))).status).toBe(403)
    expect(readStudioAvailability).not.toHaveBeenCalled()
  })
  it('403 for a coach (staff AT that studio)', async () => {
    getCurrentUser.mockResolvedValue(coach)
    expect((await GET(getReq(q))).status).toBe(403)
    expect(readStudioAvailability).not.toHaveBeenCalled()
  })
  it('a manager at that studio reads it', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const res = await GET(getReq(q))
    expect(res.status).toBe(200)
    expect(readStudioAvailability).toHaveBeenCalledWith({ db: true }, { locationId: LOC, startDate: '2026-05-04', endDate: '2026-05-10' })
  })
  it.each([
    [{ location_id: 'nope', start_date: '2026-05-04', end_date: '2026-05-10' }],
    [{ location_id: LOC, start_date: '2026-05-04' }],
    [{ location_id: LOC, start_date: '2026-02-30', end_date: '2026-03-02' }],
    [{ location_id: LOC, start_date: '2026-05-10', end_date: '2026-05-04' }],
    [{ location_id: LOC, start_date: '2026-05-01', end_date: '2026-08-01' }], // 93 days
  ])('400 for %j', async (params) => {
    getCurrentUser.mockResolvedValue(manager)
    expect((await GET(getReq(params))).status).toBe(400)
    expect(readStudioAvailability).not.toHaveBeenCalled()
  })
})

describe('PUT own', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(putReq({ weekly: [MON] }))).status).toBe(401)
  })
  it('400 for a malformed body, nothing saved', async () => {
    getCurrentUser.mockResolvedValue(coach)
    expect((await PUT(putReq({ weekly: [{ weekday: 'monday' }] }))).status).toBe(400)
    expect(saveOwnAvailability).not.toHaveBeenCalled()
  })
  it('400 with issues for an end before the start or a passed date, nothing saved', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const res = await PUT(putReq({ weekly: [{ ...MON, end_time: '08:00' }], dated: [{ start_date: '2026-09-01', all_day: true }] }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.issues).toEqual([
      { path: 'weekly.0', message: 'The end time must be after the start time' },
      { path: 'dated.0', message: 'That date has passed' },
    ])
    expect(saveOwnAvailability).not.toHaveBeenCalled()
  })
  it('saves the canonical lists for the caller and hands the notice to after()', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const res = await PUT(putReq({ weekly: [MON, MON], dated: [] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, data: { changed: true, weekly: [{ kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:00', note: null }], dated: [] } })
    const args = saveOwnAvailability.mock.calls[0][1]
    expect(args).toMatchObject({ profileId: 'u1', actorId: 'u1', todayIso: '2026-09-25' })
    expect(args.weekly).toHaveLength(1) // duplicate collapsed
    expect(after).toHaveBeenCalledTimes(1)
    expect(deliverAvailabilityNotice).toHaveBeenCalledWith({ db: true }, expect.objectContaining({ id: 'ch-1', profile_id: 'u1', before: [] }))
  })
  it('an unchanged save notifies nobody', async () => {
    getCurrentUser.mockResolvedValue(coach)
    saveOwnAvailability.mockResolvedValue({ result: { changed: false, changeId: null, before: [], after: [] }, error: null })
    const res = await PUT(putReq({ weekly: [], dated: [] }))
    expect((await res.json()).data.changed).toBe(false)
    expect(after).not.toHaveBeenCalled()
  })
  it('records the master as the actor under View as user', async () => {
    getCurrentUser.mockResolvedValue({ ...coach, impersonatingFrom: { masterId: 'master-1' } })
    await PUT(putReq({ weekly: [MON] }))
    expect(saveOwnAvailability.mock.calls[0][1]).toMatchObject({ profileId: 'u1', actorId: 'master-1' })
  })
  it('an input error from the database is a 400; anything else a 500', async () => {
    getCurrentUser.mockResolvedValue(coach)
    saveOwnAvailability.mockResolvedValue({ result: null, error: { code: '23514', message: 'violates check constraint' } })
    expect((await PUT(putReq({ weekly: [MON] }))).status).toBe(400)
    saveOwnAvailability.mockResolvedValue({ result: null, error: { code: '42P01', message: 'relation does not exist' } })
    expect((await PUT(putReq({ weekly: [MON] }))).status).toBe(500)
    expect(after).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/availability/route.test.js`
Expected: fails to import `./route.js`.

- [ ] **Step 3: Implement**

```js
// src/app/api/schedule/availability/route.js
//
// AVAIL.1 — coach availability (mig 630). A coach says when they CANNOT
// work; no approval; the roster builders at every studio they belong to are
// told once per save (src/lib/availability-notify.js).
//
//   GET                                            the caller's own { weekly, dated }
//   GET ?location_id=&start_date=&end_date=        every active member's rules at that
//                                                  studio bearing on the range (manager)
//   PUT { weekly: [...], dated: [...] }            replace the caller's own
//
// Service-role route: mig 630's tables have no RLS policy and no browser
// grant, so THIS FILE is the whole access boundary. Own reads and writes are
// pinned to user.id (there is no profile_id parameter); the studio read runs
// assertLocationAccess and then a manager role AT that studio
// (SCHEDROLES.1: never user.role, the ACTIVE studio's). Cookie or Bearer
// (getCurrentUser), so the phone (AVAIL.2) uses this route as-is.

import { NextResponse, after } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, uuidLike, isRealCalendarDate } from '@/lib/schemas'
import { dublinTodayStr, addDaysISO } from '@/lib/dublin-time'
import {
  AvailabilityPutSchema, AVAILABILITY_RANGE_MAX_DAYS, readOwnAvailability, saveOwnAvailability,
  readStudioAvailability, isAvailabilityInputError,
} from '@/lib/availability-server'
import { normaliseAvailability, availabilityProblems, splitRules } from '@shared/availability'
import { deliverAvailabilityNotice } from '@/lib/availability-notify'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bad = (error, status = 400) => NextResponse.json({ success: false, error }, { status })

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return bad('Unauthorized', 401)

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  const db = createServerClient()

  if (!locationId) {
    const { data, error } = await readOwnAvailability(db, user.id, dublinTodayStr())
    if (error) {
      logError('api/schedule/availability', 'own read failed', { err: error.message })
      return bad('Could not load your availability', 500)
    }
    return NextResponse.json({ success: true, data })
  }

  if (!uuidLike.safeParse(locationId).success) return bad('location_id: must be a UUID')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) return bad('Forbidden — needs a manager role at that location', 403)

  const startDate = url.searchParams.get('start_date')
  const endDate = url.searchParams.get('end_date')
  for (const [name, value] of [['start_date', startDate], ['end_date', endDate]]) {
    if (!isRealCalendarDate(value)) return bad(`${name}: not a real date (YYYY-MM-DD)`)
  }
  if (endDate < startDate) return bad('end_date must be on or after start_date')
  if (endDate > addDaysISO(startDate, AVAILABILITY_RANGE_MAX_DAYS - 1)) {
    return bad(`The range is limited to ${AVAILABILITY_RANGE_MAX_DAYS} days`)
  }

  const { data, error } = await readStudioAvailability(db, { locationId, startDate, endDate })
  if (error) {
    logError('api/schedule/availability', 'studio read failed', { location_id: locationId, err: error.message })
    return bad('Could not load availability', 500)
  }
  return NextResponse.json({ success: true, data })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return bad('Unauthorized', 401)

  const v = await validateBody(request, AvailabilityPutSchema)
  if (!v.ok) return v.response

  const todayIso = dublinTodayStr()
  const input = normaliseAvailability(v.data)
  const issues = availabilityProblems(input, { todayIso })
  if (issues.length) {
    return NextResponse.json({ success: false, error: 'Invalid availability', issues }, { status: 400 })
  }

  const db = createServerClient()
  const { result, error } = await saveOwnAvailability(db, {
    profileId: user.id,
    // View as user: the person is the one being viewed; the master did it.
    actorId: user.impersonatingFrom?.masterId || user.id,
    todayIso,
    weekly: input.weekly,
    dated: input.dated,
  })
  if (error) {
    if (isAvailabilityInputError(error)) {
      return bad(String(error.message || 'Invalid availability').replace(/^availability_\w+:\s*/, ''))
    }
    logError('api/schedule/availability', 'save failed', { err: error.message, code: error.code })
    return bad('Could not save your availability', 500)
  }

  if (result.changed && result.changeId) {
    const change = { id: result.changeId, profile_id: user.id, before: result.before, after: result.after, created_at: new Date().toISOString() }
    // after(): an un-awaited promise past the response is the shape Vercel can
    // freeze mid-flight (SWAPNOTIFY.1). deliverAvailabilityNotice never throws,
    // and anything it does not settle the checklist-sweep arm picks up.
    after(() => deliverAvailabilityNotice(db, change))
  }

  return NextResponse.json({ success: true, data: { changed: result.changed, ...splitRules(result.after) } })
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/schedule/availability/route.test.js`
Expected: all passed.
Run: `npm run check:route-guards && npm run check:location-scoping`
Expected: both exit 0 (the route calls `getCurrentUser`; it queries no tenant table directly, and its studio read is behind `assertLocationAccess`).

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/schedule/availability/route.js' 'src/app/api/schedule/availability/route.test.js'
git commit -m "AVAIL.1a — GET/PUT /api/schedule/availability: own read and replace, manager studio range read

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The checklist-sweep cron's third arm

**Files:**
- Modify: `src/app/api/cron/checklist-sweep/route.js`
- Modify: `src/app/api/cron/checklist-sweep/route.test.js`

- [ ] **Step 1: Write the failing test**

In `route.test.js`, after the `vi.mock('@/lib/swap-cover-server', …)` block (lines 46-48) add:

```js
// AVAIL.1 — the availability-notice arm. Its behaviour is pinned in
// src/lib/availability-notify.test.js; here it is a spy.
const QUIET_AVAIL = { pending: 0, groups: 0, sent: 0, deferred: 0, stale: 0, reverted: 0, no_recipients: 0, errors: 0 }
vi.mock('@/lib/availability-notify', () => ({
  runAvailabilityNoticeSweep: vi.fn(async () => ({ pending: 0, groups: 0, sent: 0, deferred: 0, stale: 0, reverted: 0, no_recipients: 0, errors: 0 })),
}))
```

and with the other imports: `import { runAvailabilityNoticeSweep } from '@/lib/availability-notify'`.

Change `stampedNames` (line 72) so the SWAPHB.1 assertions keep meaning what they say (they pin the two older rows; the new row has its own block):

```js
// SWAPHB.1 — the heartbeat rows this tick stamped, in call order. AVAIL.1's
// own row is left out here and pinned in its own describe block below.
const stampedNames = () => stampHeartbeat.mock.calls.map((c) => c[0]).filter((n) => n !== 'availability-notice-sweep')
const availStamped = () => stampHeartbeat.mock.calls.some((c) => c[0] === 'availability-notice-sweep')
```

Append:

```js
// AVAIL.1 — third arm: availability notices owed (a save made outside
// 07:00-22:00, or an immediate push that did not land). Isolated like the swap
// arm, with its own heartbeat row (mig 630), stamped only on a clean run.
describe('GET /api/cron/checklist-sweep — availability-notice arm', () => {
  it('runs every tick with the cron db, reports its counts and stamps its own row', async () => {
    runAvailabilityNoticeSweep.mockResolvedValueOnce({ ...QUIET_AVAIL, pending: 2, groups: 1, sent: 1 })
    const res = await GET(req())
    const body = await res.json()
    expect(runAvailabilityNoticeSweep).toHaveBeenCalledWith(fakeDb)
    expect(body).toMatchObject({ success: true, availability_notices: { sent: 1 }, availability_sweep_failed: 0 })
    expect(stampHeartbeat).toHaveBeenCalledWith('availability-notice-sweep', expect.objectContaining({ sent: 1, errors: 0 }))
  })

  it('an arm that reports errors or throws is NOT stamped, and costs the other arms nothing', async () => {
    runAvailabilityNoticeSweep.mockResolvedValueOnce({ ...QUIET_AVAIL, errors: 1 })
    let body = await (await GET(req())).json()
    expect(body).toMatchObject({ success: true, availability_sweep_failed: 1 })
    expect(availStamped()).toBe(false)
    expect(stampedNames().sort()).toEqual(['checklist-sweep', 'swap-cover-sweep'])

    stampHeartbeat.mockClear()
    runAvailabilityNoticeSweep.mockRejectedValueOnce(new Error('boom'))
    body = await (await GET(req())).json()
    expect(body).toMatchObject({ success: true, availability_sweep_failed: 1, availability_notices: null })
    expect(availStamped()).toBe(false)
    expect(logError).toHaveBeenCalledWith('cron-checklist-sweep', 'availability notice sweep threw', expect.anything())
  })

  it('still runs when the checklist arm fails and when the swap arm throws', async () => {
    tableErrors = { checklist_instances: { message: 'down' } }
    runSwapCoverSweep.mockRejectedValueOnce(new Error('swap down'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(runAvailabilityNoticeSweep).toHaveBeenCalledTimes(1)
    expect(availStamped()).toBe(true)
  })

  it("the checklist row's last_outcome carries the arm's counts too", async () => {
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('checklist-sweep', expect.objectContaining({
      availability_notices: QUIET_AVAIL, availability_sweep_failed: 0,
    }))
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/cron/checklist-sweep/route.test.js`
Expected: the four new tests fail (`runAvailabilityNoticeSweep` never called); the existing ones still pass.

- [ ] **Step 3: Implement**

In `route.js`:

(a) Header, after the SWAPHB.1 paragraph:

```js
// AVAIL.1 — THIRD ARM: availability notices (src/lib/availability-notify.js
// runAvailabilityNoticeSweep). A coach's availability save tells the roster
// builders at once inside 07:00-22:00 studio time; a save outside it (or an
// immediate push that did not land) is owed, and this arm sends it, folding a
// coach's overnight saves into one notice. Isolated like the swap arm, in
// both directions, with its own heartbeat row 'availability-notice-sweep'
// (mig 630), stamped ONLY when the arm ran and reported errors: 0. A quiet
// tick reports errors: 0 and stamps.
```

(b) Import: `import { runAvailabilityNoticeSweep } from '@/lib/availability-notify'`.

(c) After the swap arm's heartbeat block (`if (swapSweepFailed === 0 && swapCover) { … }`, before `if (checklistError)`):

```js
  // Arm 3 — AVAIL.1 availability notices. Same isolation as arm 2.
  let availabilityNotices = null
  let availabilitySweepFailed = 0
  try {
    availabilityNotices = await runAvailabilityNoticeSweep(db)
    if ((availabilityNotices?.errors || 0) > 0) availabilitySweepFailed = 1
  } catch (e) {
    availabilitySweepFailed = 1
    availabilityNotices = null
    logError('cron-checklist-sweep', 'availability notice sweep threw', { err: e?.message })
  }
  if (availabilitySweepFailed === 0 && availabilityNotices) {
    await stampHeartbeat('availability-notice-sweep', availabilityNotices).catch((err) =>
      logWarn('cron-checklist-sweep', 'availability heartbeat failed', { err }))
  }
  const availabilityFields = { availability_notices: availabilityNotices, availability_sweep_failed: availabilitySweepFailed }
```

(d) Add `...availabilityFields` to the 500 body, the `stampHeartbeat('checklist-sweep', { … })` outcome and the final 200 body:

```js
      { success: false, error: checklistError, swap_cover: swapCover, swap_sweep_failed: swapSweepFailed, ...availabilityFields },
```
```js
  await stampHeartbeat('checklist-sweep', { ...stats, swap_cover: swapCover, swap_sweep_failed: swapSweepFailed, ...availabilityFields }).catch((err) =>
```
```js
  return NextResponse.json({ success: true, stats, swap_cover: swapCover, swap_sweep_failed: swapSweepFailed, ...availabilityFields })
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/app/api/cron/checklist-sweep/route.test.js`
Expected: all passed (old and new).
Run: `grep -L stampHeartbeat src/app/api/cron/*/route.js`
Expected: only `health-check` and `ad-insights-backfill` (unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/checklist-sweep/route.js src/app/api/cron/checklist-sweep/route.test.js
git commit -m "AVAIL.1a — checklist-sweep third arm: owed availability notices, own heartbeat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: OpenAPI, and arm the write guardrail

**Files:**
- Modify: `src/lib/openapi.js`, `src/lib/openapi.test.js`, `eslint.guardrails.config.mjs`

- [ ] **Step 1: Write the failing test**

In `src/lib/openapi.test.js`, inside `describe('getOpenApiSpec', …)`:

```js
  it('documents coach availability (AVAIL.1): own GET/PUT and the manager range read, cookie or Bearer', () => {
    const path = spec.paths['/api/schedule/availability']
    expect(path).toHaveProperty('get')
    expect(path).toHaveProperty('put')
    expect(path.put.requestBody).toBeDefined()
    expect(path.get.security).toEqual([{ CookieAuth: [] }, { BearerAuth: [] }])
  })
```

Run: `npx vitest run src/lib/openapi.test.js` → the new test fails.

- [ ] **Step 2: Implement**

In `src/lib/openapi.js`, add `import { AvailabilityPutSchema } from '@/lib/availability-server'` beside the `WindowBase` import (line 29), and after the `/api/schedule/runway` registration (ends line 4488):

```js
// AVAIL.1 — coach availability (mig 630). Own read/replace, and a manager's
// read of a studio's members for a date range.
registry.registerPath({
  method: 'get',
  path: '/api/schedule/availability',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }, { BearerAuth: [] }],
  summary: "A coach's availability: your own, or a studio's (manager)",
  description: "Without location_id: the caller's own unavailability as { weekly, dated } (weekly: weekday mon..sun + all_day or start_time/end_time HH:MM; dated: start_date..end_date + the same, optional note). Dated rules that ended before today (Dublin) are history and not returned. With location_id + start_date + end_date (real dates, at most 92 days): every active member of that studio's weekly rules and the dated rules overlapping the range, as flat rows with id and profile_id. The studio read is manager-only (master, owner, manager, head_coach AT location_id) and scoped by assertLocationAccess. Notes are the coach's own words and are shown to managers. Advisory data: nothing in the API refuses an assignment because of it.",
  responses: {
    200: { description: '{ success, data }' },
    400: { description: 'Malformed location_id, a date that is not real, end before start, or a range over 92 days', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Studio outside your assignments, or no manager role there', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'The read failed (never answered as "nobody is unavailable")', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/schedule/availability',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }, { BearerAuth: [] }],
  summary: 'Replace your own availability',
  description: "Replaces the caller's weekly rules and their dated rules that have not ended, atomically. No approval. A save that changes something tells the owner, managers and head coaches at every studio the caller belongs to (one push per save, 07:00-22:00 studio time; outside it, at 07:00). A save identical to what is stored changes nothing and tells nobody (data.changed false). 400 issues use validateBody's { path, message } shape; paths index the SORTED lists.",
  request: { body: { content: { 'application/json': { schema: AvailabilityPutSchema } } } },
  responses: {
    200: { description: '{ success, data: { changed, weekly, dated } }' },
    400: { description: 'Invalid body or rule (end not after start, not a real date, a date that has passed, over the limits)', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'The save failed; nothing was changed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

In `eslint.guardrails.config.mjs`, at the end of the `no-unchecked-supabase-write` `files` list (after `'src/lib/waitlist-entry.js',`):

```js
      // AVAIL.1 — coach availability: the save, the studio read and the
      // notice stamps. Born clean, armed on arrival.
      'src/lib/availability-server.js',
      'src/lib/availability-notify.js',
      'src/app/api/schedule/availability/**',
```

- [ ] **Step 3: Run, expect PASS**

Run: `npx vitest run src/lib/openapi.test.js && npm run check:guardrails`
Expected: all passed; exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js eslint.guardrails.config.mjs
git commit -m "AVAIL.1a — OpenAPI for /api/schedule/availability; arm the write guardrail on the new files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### AVAIL.1a gate, PR, changelog

- [ ] Rebase on `origin/main` (batch 2 may have moved lines in `shared/permissions.js`; re-run the Task 3 `grep -c` check after).
- [ ] The 12-command CI mirror, then the build:

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
npm run build
```

Expected: every command exits 0; the build lists `ƒ /api/schedule/availability`.

- [ ] Push and open the PR:

```bash
git push -u origin HEAD
gh pr create --base main --title "AVAIL.1a — coach availability: rules, API, managers told (mig 630, OTA)" --body-file <scratchpad>/avail1a-pr.md
```

**PR body points:**
- What: coaches declare unavailable windows (weekly + dated); no approval; roster builders at every studio told once per save; data layer + API only (web UI is AVAIL.1b, phone is AVAIL.2).
- **Migration 630, apply BEFORE merge** (DEPLOY ORDER above); pre/post checks and rollback are in the file header; expected advisor change `rls_enabled_no_policy` +2.
- **OTA on merge**: `shared/**` changes. Phones gain one notification toggle ("… Availability changes"); nothing else on the phone reads the new module yet. Check the EAS Update run before the next phone update.
- Quiet hours: notice deferred to 07:00 by the checklist-sweep arm (own heartbeat `availability-notice-sweep`), folded per coach, dropped after 24h; never gates the save.
- Service-role only tables; `replace_staff_unavailability` RPC (atomic, no-op when unchanged, past dated rules kept as history).
- New category `availability_change` registered at all five sites, default ON for all roles (PUSH-LOC.1 reasoning), Android `updates`, no email fallback.
- A tap on the push does not navigate yet (AVAIL.2 adds the route).
- Test counts per file; CI mirror + build green.
- Ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **CHANGELOG** (after the PR number exists; a new row under the header; never edit a pushed row):

```
| #<PR> | AVAIL.1a — coach availability: weekly unavailable windows + dated exceptions, managers told once per save | 2026-MM-DD. **Mig 630** (applied before merge), **OTA** (shared/). `staff_unavailability` (kind weekly: weekday mon..sun = shift_templates.days_of_week codes; kind dated: ≤366-day range; all day or a same-day window; note ≤200) and `staff_availability_changes` (before/after snapshots, actor, notice state), both service-role only (RLS on, no policies, no browser grants). `replace_staff_unavailability` RPC replaces weekly + not-yet-ended dated rules atomically under a per-person lock, writes nothing when unchanged, keeps ended rules as history, refuses a passed date. `GET/PUT /api/schedule/availability` (own, cookie or Bearer) + manager studio range read (≤92 days, role AT the studio). Category `availability_change` (`notify_availability_change`, default on, Android updates, no email). Notice: roster builders + masters at every studio of the coach, never the coach, `sendPushOnce` keyed by change id; 07:00-22:00 studio time, else the new third arm of `/api/cron/checklist-sweep` sends it at 07:00 (overnight saves folded into one; stale after 24h), heartbeat `availability-notice-sweep`. Shared pure rules in `shared/availability.js` for web, API and phone. |
```

---

# AVAIL.1b

**Ships:** web deploy only. No migration, nothing under `mobile/` or `shared/`, **no OTA**. Rebase on `origin/main` after AVAIL.1a merges. `ScheduleCalendar.jsx` is a conflict hotspot (13, 14, 15, 19, 20, 21, 33); Task 11 says where each insertion sits relative to WORKTIME.1's.

---

### Task 9: The calendar's seventh data slice

**Files:**
- Modify: `src/components/schedule/useScheduleData.js`, `src/components/schedule/useScheduleData.test.js`, `src/components/schedule/SchedulePartialLoadNote.jsx`, and the test that covers `partialLoadLines` (`src/components/ScheduleCalendar.partial-load.test.jsx`)

- [ ] **Step 1: Write the failing tests**

In `useScheduleData.test.js`:
- `ARGS` gains `canReadAvailability: true` (comment: `// AVAIL.1 — manager-only, like spend`).
- `defaultBody` gains, BEFORE the final `return`: `if (url.includes('/schedule/availability')) return { success: true, data: [{ id: 'av1', profile_id: 's1', kind: 'weekly', weekday: 'mon', all_day: true }] }`
- The late-loser loop's fragment list (line 598) gains `'/schedule/availability'`.
- Add:

```js
  describe('availability (AVAIL.1) — manager-only, a side slice', () => {
    it('loads with the range and the location', async () => {
      const { result } = await loaded()
      expect(result.current.availability).toHaveLength(1)
      const url = global.fetch.mock.calls.map(([u]) => u).find((u) => u.includes('/schedule/availability'))
      expect(url).toBe('/api/schedule/availability?location_id=loc1&start_date=2026-05-04&end_date=2026-05-10')
    })
    it('without canReadAvailability: no request, an empty list, nothing partial', async () => {
      const { result } = await loaded({ ...ARGS, canReadAvailability: false })
      expect(global.fetch.mock.calls.some(([u]) => u.includes('/schedule/availability'))).toBe(false)
      expect(result.current.availability).toEqual([])
      expect(result.current.partialErrors).toBeNull()
    })
    it('a failed read is a named partial error and never fails the roster', async () => {
      global.fetch = failing('/schedule/availability')
      const { result } = await loaded()
      expect(result.current.error).toBeNull()
      expect(result.current.blocks).toHaveLength(1)
      expect(Object.keys(result.current.partialErrors)).toEqual(['availability'])
      expect(result.current.partialErrors.availability.kept).toBe(false)
    })
  })
```

(`loaded` and `failing` are the file's existing helpers, used by the contractor-spend tests at lines 403-419.)

Where `partialLoadLines` is tested, add:

```js
  it('names missing availability to a manager only (AVAIL.1)', () => {
    expect(partialLoadLines({ availability: { kept: false } }, { isManager: true }))
      .toEqual(['Availability could not be loaded, so unavailable coaches are not shaded or flagged.'])
    expect(partialLoadLines({ availability: { kept: false } }, { isManager: false })).toEqual([])
  })
```

Run: `npx vitest run src/components/schedule/useScheduleData.test.js src/components/ScheduleCalendar.partial-load.test.jsx` → the new tests fail.

- [ ] **Step 2: Implement**

`useScheduleData.js`:
- In `SLICES` (line 156), after `contractorSpend`:

```js
  // AVAIL.1 — every active member's unavailability bearing on the range.
  // Manager-only (the route's gate), asked for only with canReadAvailability,
  // the way spend is asked for only with canReadSpend. A null (not asked)
  // applies as [] through listOf.
  { key: 'availability', scope: ({ locationId, range }) => `${locationId}|${range}`, apply: listOf },
```
- `EMPTY` (line 170): add `availability: []`.
- Signature (line 178): add `canReadAvailability = false`.
- State, beside `contractorSpend` (line 184): `const [availability, setAvailability] = useState([])`.
- `setters` (lines 239-242): add `availability: setAvailability`.
- The `Promise.allSettled` array, after the spend entry (ends line 261):

```js
        canReadAvailability
          ? readJson(`/api/schedule/availability?location_id=${locationId}&start_date=${startDate}&end_date=${endDate}`)
          : Promise.resolve(null),
```
- Backstop list (line 325): `['timeOff', 'holidays', 'contractorSpend', 'availability']`.
- Deps (line 350): add `canReadAvailability`.
- Return (line 355): add `availability`.
- Header: one paragraph under ROSTERLOAD.1 (review B1) saying the seventh slice exists and is gated like spend.

`SchedulePartialLoadNote.jsx`:

```js
// Shown inside the assign picker (AVAIL.1), where missing availability would
// otherwise look like every coach being free.
export const AVAILABILITY_NOT_FLAGGED_MESSAGE =
  'Availability could not be loaded, so unavailable coaches are not flagged here.'
```

and in `COPY`, after the `contractorSpend` entry:

```js
  ['availability', true,
    'Availability could not be loaded, so unavailable coaches are not shaded or flagged.',
    'Availability could not be refreshed. Showing it as it last loaded.'],
```

- [ ] **Step 3: Run, expect PASS**

Run: `npx vitest run src/components/schedule/useScheduleData.test.js src/components/ScheduleCalendar.partial-load.test.jsx`
Expected: all passed.

- [ ] **Step 4: Commit**

```bash
git add src/components/schedule/useScheduleData.js src/components/schedule/useScheduleData.test.js src/components/schedule/SchedulePartialLoadNote.jsx src/components/ScheduleCalendar.partial-load.test.jsx
git commit -m "AVAIL.1b — calendar data: availability slice, manager-only, a named partial error

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `dayUnavailableBars` — the week view's shading, as a pure model

**Files:**
- Modify: `src/lib/roster-card-model.js`, `src/lib/roster-card-model.test.js`

- [ ] **Step 1: Write the failing test**

In `roster-card-model.test.js` add `dayUnavailableBars` to the import (line 6) and:

```js
describe('dayUnavailableBars (AVAIL.1)', () => {
  const staff = [
    { id: 'c1', full_name: 'Alex Beta' },
    { id: 'c2', full_name: 'Alex Gamma' },
    { id: 'c3', full_name: 'Casey Delta' },
  ]
  const rules = [
    { id: 'r1', profile_id: 'c1', kind: 'weekly', weekday: 'wed', all_day: false, start_time: '10:00', end_time: '11:00', note: 'School run' },
    { id: 'r2', profile_id: 'c1', kind: 'weekly', weekday: 'wed', all_day: false, start_time: '17:00', end_time: '19:00', note: null },
    { id: 'r3', profile_id: 'c2', kind: 'dated', start_date: '2026-05-05', end_date: '2026-05-07', all_day: true, note: null },
    { id: 'r4', profile_id: 'c3', kind: 'weekly', weekday: 'wed', all_day: true, note: null },
    { id: 'r5', profile_id: 'stranger', kind: 'weekly', weekday: 'wed', all_day: true, note: null },
  ]

  it('one bar per person that day, first names told apart, windows summarised, notes in the title', () => {
    const bars = dayUnavailableBars(rules, '2026-05-06', staff)
    expect(bars.map((b) => b.text)).toEqual([
      'Alex B · Unavailable 10am–11am, 5pm–7pm',
      'Alex G · Unavailable all day',
      'Casey · Unavailable all day',
    ])
    expect(bars[0].title).toBe('Alex Beta: unavailable Wednesdays, 10am–11am (School run); Wednesdays, 5pm–7pm')
  })

  it("skips people not in the studio's staff list and people already shown on leave", () => {
    const bars = dayUnavailableBars(rules, '2026-05-06', staff, { skipProfileIds: ['c3'] })
    expect(bars.map((b) => b.profileId)).toEqual(['c1', 'c2'])
  })

  it('nothing on a day no rule touches', () => {
    expect(dayUnavailableBars(rules, '2026-05-04', staff)).toEqual([])
    expect(dayUnavailableBars(null, '2026-05-06', staff)).toEqual([])
  })
})
```

Run: `npx vitest run src/lib/roster-card-model.test.js` → fails (`dayUnavailableBars` is not a function).

- [ ] **Step 2: Implement**

In `roster-card-model.js` add `import { unavailableFor, unavailableSummary, describeRule } from '@shared/availability'` to the imports (beside SHIFTTYPE.1's, if merged), and after `dayLeaveBars`:

```js
/**
 * AVAIL.1 — the unavailability bars of ONE day in the manager's week view:
 * one per person with any rule that day, "Firstname · Unavailable 9am–12pm".
 * The title has the full name, every rule and its note.
 *
 * Only people in `staff` (the studio's coaches, which the calendar already
 * holds) are drawn: a rule for anyone else has no name to show. People in
 * `skipProfileIds` are left out: the caller passes the day's leave bars, and
 * leave already says more than "unavailable". ADVISORY: nothing is blocked
 * by a bar. Pure.
 *
 * @param {Array} availability  flat rules from GET /api/schedule/availability?location_id=
 * @param {string} dateStr YYYY-MM-DD
 * @param {Array<{id:string, full_name:string}>} staff
 */
export function dayUnavailableBars(availability, dateStr, staff, { skipProfileIds = [] } = {}) {
  const skip = new Set(skipProfileIds)
  const nameById = new Map((staff || []).map((s) => [s.id, s.full_name]))
  const byPerson = new Map()
  for (const rule of availability || []) {
    const id = rule?.profile_id
    if (!id || skip.has(id) || !nameById.has(id)) continue
    if (!byPerson.has(id)) byPerson.set(id, [])
    byPerson.get(id).push(rule)
  }
  const people = []
  for (const [profileId, rules] of byPerson) {
    const hits = unavailableFor(rules, dateStr)
    if (hits) people.push({ profileId, fullName: nameById.get(profileId) || 'Unknown', hits })
  }
  people.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.profileId.localeCompare(b.profileId))
  const names = firstNames(people.map((p) => ({ profiles: { full_name: p.fullName } })))
  return people.map((p, i) => ({
    id: `unavail-${p.profileId}-${dateStr}`,
    profileId: p.profileId,
    text: `${names[i]} · Unavailable ${unavailableSummary(p.hits)}`,
    title: `${p.fullName}: unavailable ${p.hits.map((r) => (r.note ? `${describeRule(r)} (${r.note})` : describeRule(r))).join('; ')}`,
  }))
}
```

- [ ] **Step 3: Run, expect PASS**

Run: `npx vitest run src/lib/roster-card-model.test.js`
Expected: all passed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/roster-card-model.js src/lib/roster-card-model.test.js
git commit -m "AVAIL.1b — dayUnavailableBars: one advisory bar per unavailable coach per day

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Shade the week view and badge the picker

**Files:**
- Modify: `src/components/ScheduleCalendar.jsx`
- Create: `src/components/ScheduleCalendar.availability.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// @vitest-environment jsdom
//
// AVAIL.1 — a manager's week view shades a coach's unavailable windows beside
// the leave bars, and the assign picker badges them. Advisory: the row stays
// tickable. A coach's calendar never asks for availability at all.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

const LOC = 'loc1'
const manager = { id: 'u1', role: 'manager', activeLocation: { id: LOC, name: 'Studio A' } }
const coachUser = { id: 'u2', role: 'staff', activeLocation: { id: LOC, name: 'Studio A' } }
const DATE = '2026-05-06' // Wednesday

const block = {
  id: 'b1', location_id: LOC, template_id: 't1', block_date: DATE, start_time: '10:00:00', end_time: '12:00:00', max_coaches: 3,
  shift_templates: { id: 't1', name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [],
}
const staff = [
  { id: 'c-busy', full_name: 'Busy Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'c-free', full_name: 'Free Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
]
const availability = [
  { id: 'av1', profile_id: 'c-busy', kind: 'weekly', weekday: 'wed', start_date: null, end_date: null, all_day: false, start_time: '10:00', end_time: '11:00', note: 'School run' },
]

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  global.fetch = vi.fn(async (url) => {
    if (url.includes('/schedule/availability')) return ok({ success: true, data: availability })
    if (url.includes('/schedule/blocks')) return ok({ success: true, data: [block] })
    if (url.includes('/api/staff')) return ok({ success: true, data: staff })
    return ok({ success: true, data: [] })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("availability on the manager's week view (AVAIL.1)", () => {
  it('shades the unavailable coach on that day, with the note in the title', async () => {
    render(<ScheduleCalendar user={manager} />)
    const bar = await screen.findByText('Busy · Unavailable 10am–11am')
    expect(bar.closest('[data-testid="unavailable-bar"]').getAttribute('title'))
      .toBe('Busy Coach: unavailable Wednesdays, 10am–11am (School run)')
    expect(screen.getAllByTestId('unavailable-bar')).toHaveLength(1) // only Wednesday
  })

  it('badges the coach in the picker, and the row can still be ticked', async () => {
    render(<ScheduleCalendar user={manager} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Manage 10am Midday Strength shift/ }))
    await waitFor(() => expect(screen.getByText('Add coach')).toBeTruthy())
    fireEvent.click(screen.getByText('Add coach'))
    await waitFor(() => expect(screen.getByText('Pick one or more coaches')).toBeTruthy())
    const badge = screen.getByText('Unavailable: 10am–11am')
    const checkbox = badge.closest('label').querySelector('input[type="checkbox"]')
    expect(checkbox.disabled).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    expect(screen.getByText('Free Coach').closest('li').textContent).not.toMatch(/Unavailable/)
  })

  it("a coach's calendar never asks for availability", async () => {
    render(<ScheduleCalendar user={coachUser} />)
    // Every read of the fan-out is started in the same Promise.allSettled, so
    // once the blocks read has gone out, any availability read would have too.
    await waitFor(() => expect(global.fetch.mock.calls.some(([u]) => u.includes('/schedule/blocks'))).toBe(true))
    expect(global.fetch.mock.calls.some(([u]) => u.includes('/schedule/availability'))).toBe(false)
    expect(screen.queryByTestId('unavailable-bar')).toBeNull()
  })
})
```

(If WORKTIME.1 has merged, its picker `fetch`es `/api/schedule/working-time`; the catch-all `ok({ success: true, data: [] })` answers it with no advisories, as in its own tests.)

Run: `npx vitest run src/components/ScheduleCalendar.availability.test.jsx` → the first two fail (no bar, no badge); the third passes already.

- [ ] **Step 2: Implement**

(a) Imports. Line 83 becomes `import { rosterToolbarModel, dayHeaderStatus, shiftCardModel, monthCellLines, dayLeaveBars, dayUnavailableBars } from '@/lib/roster-card-model'`. The `SchedulePartialLoadNote` import (lines 67-69) gains `AVAILABILITY_NOT_FLAGGED_MESSAGE`. Add `import { unavailableFor, unavailableSummary, describeRule } from '@shared/availability'`, and `CalendarX` to the existing `lucide-react` import (confirm it exists: `node -e "console.log(typeof require('lucide-react').CalendarX)"` prints `object`; if not, use `Ban`).

(b) The hook call (lines 392-404): add `availability` to the destructure and pass `canReadAvailability: isManager,` with the comment `// AVAIL.1 — manager-only, same gate as spend (the route is MANAGER_ROLES at the studio).`

(c) After `const leaveMissing = …` (line 411):

```js
  // AVAIL.1 — like leaveMissing: the picker must SAY it cannot flag anyone.
  const availabilityMissing = Boolean(partialErrors?.availability && !partialErrors.availability.kept)
```

(d) Week view: directly after the leave bars' `.map(bar => { … })}` closes (the block that renders `data-testid="leave-bar"`, ~lines 1297-1317), before the `{dayBlocks.length === 0 && …` "No shifts" line:

```jsx
                    {/* AVAIL.1 — who has said they cannot work that day.
                        Manager and "All" only (a coach is never shown other
                        coaches' availability); a person with a leave bar
                        today is not drawn twice. Advisory: nothing here
                        blocks an assignment. The words are
                        dayUnavailableBars' (pure, tested). */}
                    {isManager && viewMode === 'all' && dayUnavailableBars(
                      availability,
                      dateStr,
                      locationStaff,
                      { skipProfileIds: dayLeaveBars(timeOff, dateStr).map((b) => b.profileId) },
                    ).map((bar) => (
                      <div
                        key={bar.id}
                        data-testid="unavailable-bar"
                        title={bar.title}
                        className="rounded-md px-2 py-1.5 text-xs flex items-center gap-1.5 bg-slate-500/10 border-l-[3px] border-slate-400"
                      >
                        <CalendarX size={12} className="shrink-0 text-slate-700" aria-hidden="true" />
                        <span className="font-medium truncate text-slate-700">{bar.text}</span>
                      </div>
                    ))}
```

(e) Modal render (~line 1402): pass `availability={availability}` and `availabilityMissing={availabilityMissing}`.

(f) `AssignCoachModal` (line 1671): the signature gains `availability = [], availabilityMissing = false`. After `const slotsLeft = …` (and, if WORKTIME.1 has merged, after its `workingTime` state and `useEffect`, so no hook order changes):

```js
  // AVAIL.1 — each coach's rules, once per render.
  const rulesByProfile = new Map()
  for (const rule of availability || []) {
    if (!rule?.profile_id) continue
    if (!rulesByProfile.has(rule.profile_id)) rulesByProfile.set(rule.profile_id, [])
    rulesByProfile.get(rule.profile_id).push(rule)
  }
```

Under the `leaveMissing` note (and above WORKTIME.1's "Rest and weekly-hours check could not be completed." note, if present):

```jsx
          {!unavailableReason && availabilityMissing && (
            <p className="mb-2 text-[11px] px-2 py-1.5 rounded bg-amber-500/10 text-amber-700">{AVAILABILITY_NOT_FLAGGED_MESSAGE}</p>
          )}
```

In the row, after `const { clash, onLeave } = coachConflictsForBlock(…)` (and before WORKTIME.1's `const wt = …`, if present):

```js
                // AVAIL.1 — advisory like the two above: the row stays tickable.
                const unavailable = unavailableFor(rulesByProfile.get(s.id), block.block_date, block.start_time, block.end_time)
```

and directly after the `clash` badge's closing `)}` (before WORKTIME.1's `wt?.restGap` badge, if present), so the order reads leave, clash, unavailable, working time:

```jsx
                        {unavailable && (
                          <span
                            className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-700 whitespace-nowrap"
                            title={unavailable.map((r) => (r.note ? `${describeRule(r)} (${r.note})` : describeRule(r))).join('; ')}
                          >
                            Unavailable: {unavailableSummary(unavailable)}
                          </span>
                        )}
```

- [ ] **Step 3: Run, expect PASS, with the calendar's other suites**

Run: `npx vitest run src/components/ScheduleCalendar.availability.test.jsx src/components/ScheduleCalendar.assign-conflicts.test.jsx src/components/ScheduleCalendar.partial-load.test.jsx src/components/ScheduleCalendar.visibility.test.jsx src/components/ScheduleCalendar.a11y.test.jsx`
Expected: all passed (plus `ScheduleCalendar.working-time.test.jsx` if WORKTIME.1 has merged).
Run: `npm run check:guardrails` → exit 0 (the chips are `-500/10`/`-500/15` with `-700` text).

- [ ] **Step 4: Commit**

```bash
git add src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.availability.test.jsx
git commit -m "AVAIL.1b — manager week view shades unavailable coaches; picker badges them (advisory)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: "My availability" — the editor, the page, the tab

**Files:**
- Create: `src/components/AvailabilityEditor.jsx`, `src/components/AvailabilityEditor.test.jsx`
- Create: `src/app/(team)/schedule/availability/page.js`
- Modify: `src/components/ScheduleTabs.jsx`, `src/components/ScheduleTabs.test.jsx`

Where it lives: staff do their own schedule things under `/schedule/*` (`/schedule/time-off` is where leave is filed, `src/app/(team)/schedule/time-off/page.js`), not `/account` (customer-facing metadata and landing preferences, `src/app/account/layout.js`). So `/schedule/availability`, with a tab every signed-in staff member sees.

- [ ] **Step 1: Write the failing tests**

`src/components/AvailabilityEditor.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// AVAIL.1 — a coach edits their own availability on the web: loads it, adds
// weekly times and dates, is told what is wrong before a save, and the save
// sends exactly the lists on screen.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import AvailabilityEditor from './AvailabilityEditor.jsx'

const TODAY = '2026-09-25'
const MON = { kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:00', note: null }
const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

let putBody = null
beforeEach(() => {
  putBody = null
  global.fetch = vi.fn(async (url, options) => {
    if (options?.method === 'PUT') {
      putBody = JSON.parse(options.body)
      return ok({ success: true, data: { changed: true, weekly: [MON, { ...MON, weekday: 'tue', all_day: true, start_time: null, end_time: null }], dated: [] } })
    }
    return ok({ success: true, data: { weekly: [MON], dated: [] } })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('AvailabilityEditor', () => {
  it('shows what is saved', async () => {
    render(<AvailabilityEditor todayIso={TODAY} />)
    const day = await screen.findByLabelText('Day of the week')
    expect(day.value).toBe('mon')
    expect(screen.getByLabelText('From').value).toBe('09:00')
    expect(screen.getByLabelText('To').value).toBe('12:00')
    expect(screen.getByText(/Your managers can see your notes/)).toBeTruthy()
  })

  it('adds a weekly time and saves exactly the lists on screen', async () => {
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByLabelText('Day of the week')
    fireEvent.click(screen.getByRole('button', { name: 'Add a weekly time' }))
    const days = screen.getAllByLabelText('Day of the week')
    fireEvent.change(days[1], { target: { value: 'tue' } })
    fireEvent.click(screen.getAllByLabelText('All day')[1])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved. Your managers will get a notification.')
    expect(putBody).toEqual({
      weekly: [
        { weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00', note: null },
        { weekday: 'tue', all_day: true, start_time: null, end_time: null, note: null },
      ],
      dated: [],
    })
  })

  it('says what is wrong and does not save', async () => {
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByLabelText('Day of the week')
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '08:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('The end time must be after the start time')
    expect(putBody).toBeNull()
  })

  it('adds a date, one day, all day by default, starting today', async () => {
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByLabelText('Day of the week')
    fireEvent.click(screen.getByRole('button', { name: 'Add a date' }))
    expect(screen.getByLabelText('First day').value).toBe(TODAY)
    fireEvent.change(screen.getAllByLabelText('Note')[1], { target: { value: 'Wedding' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(putBody).not.toBeNull())
    expect(putBody.dated).toEqual([{ start_date: TODAY, end_date: TODAY, all_day: true, start_time: null, end_time: null, note: 'Wedding' }])
  })

  it("shows the server's issues when it refuses", async () => {
    global.fetch = vi.fn(async (url, options) => (options?.method === 'PUT'
      ? ok({ success: false, error: 'Invalid availability', issues: [{ path: 'dated.0', message: 'That date has passed' }] }, 400)
      : ok({ success: true, data: { weekly: [MON], dated: [] } })))
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByLabelText('Day of the week')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('That date has passed')
  })

  it('says so when it cannot load, instead of an empty editor', async () => {
    global.fetch = vi.fn(async () => ok({ success: false, error: 'Could not load your availability' }, 500))
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByText('Could not load your availability')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })
})
```

`ScheduleTabs.test.jsx`: the first test becomes

```js
  it('renders Schedule and Availability for a plain staffer with no grants', () => {
    render(<ScheduleTabs user={user()} />)
    const links = screen.getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual(['Schedule', 'Availability'])
    expect(links[0].getAttribute('href')).toBe('/schedule')
    expect(links[1].getAttribute('href')).toBe('/schedule/availability')
  })
```

and the master test's label list (line ~129) gains `'Availability'`.

Run: `npx vitest run src/components/AvailabilityEditor.test.jsx src/components/ScheduleTabs.test.jsx` → both fail.

- [ ] **Step 2: Implement the editor**

```jsx
'use client'

// AVAIL.1 — "My availability". A coach says when they CANNOT work: weekly
// times (a day and a window, or the whole day) and dates (a day or a range,
// all day or a window, with a note). Everything else counts as available.
// No approval; the managers at every studio the coach belongs to get one
// notification per save. The rules and the words for what is wrong are
// shared/availability.js's, the same the server applies.

import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import {
  AVAILABILITY_WEEKDAYS, AVAILABILITY_WEEKDAY_LABELS, AVAILABILITY_LIMITS, normaliseRule, ruleProblem,
} from '@shared/availability'
import { readJson } from './schedule/useScheduleData'

let keySeq = 0
const nextKey = () => ++keySeq

function toRow(rule) {
  return {
    key: nextKey(),
    kind: rule.kind,
    weekday: rule.weekday || 'mon',
    start_date: rule.start_date || '',
    end_date: rule.end_date || '',
    all_day: rule.all_day === true,
    start_time: rule.start_time || '',
    end_time: rule.end_time || '',
    note: rule.note || '',
  }
}
const rowsFrom = (data) => [...(data?.weekly || []), ...(data?.dated || [])].map(toRow)

export function rowToPayload(row) {
  const times = row.all_day
    ? { start_time: null, end_time: null }
    : { start_time: row.start_time || null, end_time: row.end_time || null }
  const note = row.note.trim() || null
  return row.kind === 'weekly'
    ? { weekday: row.weekday, all_day: row.all_day, ...times, note }
    : { start_date: row.start_date, end_date: row.end_date || row.start_date, all_day: row.all_day, ...times, note }
}
const rowProblem = (row, todayIso) => ruleProblem(normaliseRule({ ...rowToPayload(row), kind: row.kind }), { todayIso })

const inputClass = 'rounded-md border border-un1t-border bg-un1t-bg px-2 py-1.5 text-sm text-un1t-text'
const labelClass = 'flex flex-col text-xs text-un1t-subtle gap-1'

function RuleRow({ row, todayIso, showProblem, onChange, onRemove }) {
  const set = (patch) => onChange({ ...row, ...patch })
  const problem = showProblem ? rowProblem(row, todayIso) : null
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-end gap-3">
        {row.kind === 'weekly' ? (
          <label className={labelClass}>
            Day
            <select aria-label="Day of the week" className={inputClass} value={row.weekday} onChange={(e) => set({ weekday: e.target.value })}>
              {AVAILABILITY_WEEKDAYS.map((d) => <option key={d} value={d}>{AVAILABILITY_WEEKDAY_LABELS[d]}</option>)}
            </select>
          </label>
        ) : (
          <>
            <label className={labelClass}>
              First day
              <input aria-label="First day" type="date" min={todayIso} className={inputClass} value={row.start_date}
                onChange={(e) => set({ start_date: e.target.value, end_date: row.end_date && row.end_date >= e.target.value ? row.end_date : e.target.value })} />
            </label>
            <label className={labelClass}>
              Last day
              <input aria-label="Last day" type="date" min={row.start_date || todayIso} className={inputClass} value={row.end_date} onChange={(e) => set({ end_date: e.target.value })} />
            </label>
          </>
        )}
        <label className="flex items-center gap-1.5 text-sm text-un1t-text pb-1.5">
          <input aria-label="All day" type="checkbox" className="accent-un1t-text" checked={row.all_day} onChange={(e) => set({ all_day: e.target.checked })} />
          All day
        </label>
        {!row.all_day && (
          <>
            <label className={labelClass}>
              From
              <input aria-label="From" type="time" className={inputClass} value={row.start_time} onChange={(e) => set({ start_time: e.target.value })} />
            </label>
            <label className={labelClass}>
              To
              <input aria-label="To" type="time" className={inputClass} value={row.end_time} onChange={(e) => set({ end_time: e.target.value })} />
            </label>
          </>
        )}
        <label className={`${labelClass} grow min-w-[10rem]`}>
          Note (optional)
          <input aria-label="Note" type="text" maxLength={AVAILABILITY_LIMITS.noteChars} className={inputClass} value={row.note} onChange={(e) => set({ note: e.target.value })} />
        </label>
        <Button variant="ghost" size="sm" icon={Trash2} onClick={onRemove}>Remove</Button>
      </div>
      {problem && <p className="mt-1 text-xs text-red-700">{problem}</p>}
    </li>
  )
}

export default function AvailabilityEditor({ todayIso }) {
  const [rows, setRows] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [showProblems, setShowProblems] = useState(false)
  const [message, setMessage] = useState(null) // { tone: 'ok' | 'error', text }

  useEffect(() => {
    let live = true
    readJson('/api/schedule/availability')
      .then((body) => { if (live) setRows(rowsFrom(body.data)) })
      .catch((e) => { if (live) setLoadError(e?.message || 'Could not load your availability') })
    return () => { live = false }
  }, [])

  const update = (key, next) => setRows((prev) => prev.map((r) => (r.key === key ? next : r)))
  const remove = (key) => setRows((prev) => prev.filter((r) => r.key !== key))
  const add = (kind) => setRows((prev) => [...prev, kind === 'weekly'
    ? { key: nextKey(), kind, weekday: 'mon', start_date: '', end_date: '', all_day: false, start_time: '', end_time: '', note: '' }
    : { key: nextKey(), kind, weekday: 'mon', start_date: todayIso, end_date: todayIso, all_day: true, start_time: '', end_time: '', note: '' }])

  async function save() {
    setShowProblems(true)
    if (rows.some((r) => rowProblem(r, todayIso))) {
      setMessage({ tone: 'error', text: 'Fix the entries marked below, then save.' })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch('/api/schedule/availability', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weekly: rows.filter((r) => r.kind === 'weekly').map(rowToPayload),
          dated: rows.filter((r) => r.kind === 'dated').map(rowToPayload),
        }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.success) {
        const issues = Array.isArray(body?.issues) && body.issues.length ? body.issues.map((i) => i.message).join('. ') : null
        setMessage({ tone: 'error', text: issues || body?.error || `Could not save (${res.status}).` })
        return
      }
      setRows(rowsFrom(body.data))
      setShowProblems(false)
      setMessage({ tone: 'ok', text: body.data.changed ? 'Saved. Your managers will get a notification.' : 'Nothing changed.' })
    } catch {
      setMessage({ tone: 'error', text: 'Could not save. Check your connection and try again.' })
    } finally {
      setSaving(false)
    }
  }

  if (loadError) return <p className="text-sm text-red-700">{loadError}</p>
  if (!rows) return <p className="text-sm text-un1t-subtle">Loading your availability…</p>

  const section = (kind) => rows.filter((r) => r.kind === kind)
  const list = (kind) => (
    <ul className="divide-y divide-un1t-border">
      {section(kind).map((r) => (
        <RuleRow key={r.key} row={r} todayIso={todayIso} showProblem={showProblems} onChange={(next) => update(r.key, next)} onRemove={() => remove(r.key)} />
      ))}
    </ul>
  )
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-un1t-text">My availability</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Tell your managers when you can&apos;t work. Every other time counts as available. There is nothing to approve:
          your managers at each of your studios get a notification when you save. Your managers can see your notes.
          A time window stays within one day: it can&apos;t run past midnight.
        </p>
      </div>

      <Card title="Every week" actions={<Button variant="secondary" size="sm" icon={Plus} onClick={() => add('weekly')}>Add a weekly time</Button>}>
        {section('weekly').length === 0
          ? <p className="text-sm text-un1t-subtle">No weekly times. Add one for a day you can never work, or part of one.</p>
          : list('weekly')}
      </Card>

      <Card title="Dates" actions={<Button variant="secondary" size="sm" icon={Plus} onClick={() => add('dated')}>Add a date</Button>}>
        {section('dated').length === 0
          ? <p className="text-sm text-un1t-subtle">No dates. Add one for a day or a run of days you can&apos;t work.</p>
          : list('dated')}
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving}>Save</Button>
        {message && (
          <p role="status" className={`text-sm ${message.tone === 'ok' ? 'text-green-700' : 'text-red-700'}`}>{message.text}</p>
        )}
      </div>
    </div>
  )
}
```

(`Button` keeps its children while `loading`, so `Save` stays the accessible name; `type` defaults to `button`, `src/components/ui/Button.jsx:39`.)

- [ ] **Step 3: The page and the tab**

`src/app/(team)/schedule/availability/page.js`:

```js
// AVAIL.1 — "My availability": every signed-in staff member's own editor.
// Same gate as the other /schedule/* pages. Today is the Dublin business day
// (the server's rules use the same), passed down so the date pickers and the
// "that date has passed" check agree with the save.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { dublinTodayStr } from '@/lib/dublin-time'
import ScheduleTabs from '@/components/ScheduleTabs'
import AvailabilityEditor from '@/components/AvailabilityEditor'

export const dynamic = 'force-dynamic'

export default async function AvailabilityPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'schedule')) redirect('/')

  return (
    <div className="px-4 py-6 sm:p-8">
      <ScheduleTabs user={user} />
      <AvailabilityEditor todayIso={dublinTodayStr()} />
    </div>
  )
}
```

`src/components/ScheduleTabs.jsx`: add `CalendarX` to the `lucide-react` import and, as the SECOND entry of `tabs`:

```js
    // AVAIL.1 — every staff member's own availability, so no gate.
    { key: 'availability', label: 'Availability', icon: CalendarX, href: '/schedule/availability', show: true },
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run src/components/AvailabilityEditor.test.jsx src/components/ScheduleTabs.test.jsx`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/components/AvailabilityEditor.jsx src/components/AvailabilityEditor.test.jsx 'src/app/(team)/schedule/availability/page.js' src/components/ScheduleTabs.jsx src/components/ScheduleTabs.test.jsx
git commit -m "AVAIL.1b — My availability page under Schedule, with a tab for every staff member

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### AVAIL.1b gate, PR, changelog

- [ ] Rebase on `origin/main`; re-run the ScheduleCalendar suites if it moved.
- [ ] The 12-command CI mirror and `npm run build` (exactly as for 1a). Expected: all exit 0; the build lists `ƒ /schedule/availability`.
- [ ] Browser check on the Vercel PREVIEW (local dev has no database): `/schedule/availability` as a coach (load, add, save; the status line), and the week view as a manager with one rule saved (bar present, picker badge present, row tickable). At 390px the editor rows wrap and `document.documentElement.scrollWidth <= clientWidth`.
- [ ] PR: `gh pr create --base main --title "AVAIL.1b — My availability page; unavailable coaches shaded on the roster and badged in the picker"`.

**PR body points:** web only, no migration, **no OTA**; depends on AVAIL.1a (merged, mig 630 applied); the tab is visible to every staff member; manager-only shading and badge, advisory (a flagged coach is still assignable); the calendar's availability read is a seventh side slice, manager-only, and a failed read is named, never read as "everyone is free"; preview checks done; ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

**CHANGELOG row:**

```
| #<PR> | AVAIL.1b — My availability page; unavailable coaches shaded on the manager roster and badged in the picker | 2026-MM-DD. Web only, **no OTA**. `/schedule/availability` (new "Availability" tab for every staff member): weekly times and dates, all day or a window, optional note (managers see it), validated with shared/availability.js before a save. Manager week view: one "Firstname · Unavailable 9am–12pm" bar per coach per day beside the leave bars (skipped when a leave bar shows), notes in the title (`dayUnavailableBars`). Assign picker: "Unavailable: …" badge, advisory, row stays tickable. `useScheduleData` seventh slice, manager-only like spend; a failed read is a named partial error. |
```

---

### Review notes / open questions

1. **The index is wrong about OTA for 16.** AVAIL.1a changes four `shared/` files, which publishes an OTA. Harmless (one new toggle in phone settings); correct the index row when 1a merges.
2. **Default ON for staff and reception** (decision 9). Needed because `sendPushOnce` cannot pass a `locationId`; a staff-role default OFF would silence any owner who is `staff` somewhere. The toggle therefore shows on a plain coach's phone settings, where it does nothing. The cleaner fix is a `locationId`-aware `sendPushOnce` (per-studio opt-outs, PUSH-LOC.1); a small follow-up, not this PR.
3. **Tombstone:** `tombstone_staff_profile()` (mig 622) does not touch the new tables, so a permanently deleted coach's rules and notes stay (inert: no `profile_locations`, so no reader lists them). Notes may be personal. Follow-up: add both tables to the function's section 7 (delete the rules, null the notes in the change log). Richard's call whether that is wanted.
4. **Retention of `staff_availability_changes`** (before/after snapshots, notes included) is unbounded. ~14 active staff (read 25 Sep); no prune proposed. Say if a 12-month prune is wanted.
5. **Managers see notes** (decision 14). If Richard would rather notes be private to the coach, the studio read drops `note` and the bar/badge titles lose it; the change log keeps it.
6. **Only the coach can set their own availability.** A manager recording it on a coach's behalf (the LEAVE.2 "phoned in" case) is not built; it would need a `profile_id` body field, a manager gate and a notice to the coach.
7. **Picker scope:** the badge judges the BLOCK's times (`block.start_time/end_time`), not a coach's partial-shift override, because the picker assigns to the block. CANDIDATES.1 will rank on the same `unavailableFor`.
8. **The month view** shows no availability (brief: week view). GRID.1 (21) overlays it per coach.
9. **`time_off_requests` type `unavailable`** (39 live rows) still shows as leave until AVAIL.3 moves it. For a few weeks a coach may have both.
10. **Dated rule descriptions carry no year** ("3 Oct – 5 Oct"). Rules reach at most two years ahead; add the year when it differs from today's if that ever confuses.
11. **Notice body** names what was added and removed, capped at three each, en dash in times and no em dashes (the customer-copy rule, applied to staff copy for consistency).
12. **`check:location-scoping` cannot see queries inside `src/lib`** (`scripts/check-location-scoping.mjs:51-61`, the gap TPLCLONE.1 also notes). The studio read's scoping is the route's `assertLocationAccess` + role check plus the lib's `.eq('location_id', …)`, pinned by the route and lib tests rather than by the scanner. The staff tables themselves carry no `location_id`, so they are not tenant tables to the scanner at all.
13. **Admin shifts** (SHIFTTYPE.1) are shaded and badged like class shifts: availability is about the person, whatever the shift is.
