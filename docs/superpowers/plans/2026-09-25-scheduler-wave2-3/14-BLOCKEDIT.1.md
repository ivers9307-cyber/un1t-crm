## PR BLOCKEDIT.1: edit one shift (times, minimum, maximum) with a change-log row and a coach notice, and a coach-visible briefing note per shift

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager opens one shift on the web calendar and changes its start and end time, its minimum and maximum coaches, and a **briefing**: a short note written for the coaches on that shift. The change is saved immediately. On a published roster it is written to `roster_change_log` and every coach whose own hours moved is told, within quiet hours. Coaches read the briefing on the web (the shift dialog, a marker on the calendar card, and the Today roster) and on the phone (the Me list and the Manage-mode card). Coaches never edit it.

**Why:** Today `/api/schedule/blocks/[id]` is DELETE only. The only way to move one shift is to edit its template, which moves every future shift, or to override each coach one at a time, which leaves the block itself at the old time. There is also nowhere to tell the coaches on one shift something about it: `shift_blocks.notes` and `shift_assignments.notes` are a manager's working notes. The calendar feed strips them from coaches (`slimBlockForCoach`, `src/app/api/schedule/blocks/route.js:129`), and so does the `/shifts` feed for colleagues' rows (`slimShiftRowForCoach`, `src/lib/roster-read.js:163`).

**Depends on 13 SHIFTTYPE.1, now MERGED** (#1759, `fa7fedcb`, mig 628; DATECHECK.1 #1757 and WORKTIME.1 #1758 are on main too). Written against SHIFTTYPE's branch, then **every cited path and line re-verified against `origin/main` `fa7fedcb`**. If main moves before the build, find each anchor by the quoted text, not the number. From SHIFTTYPE.1 this PR uses:
- `adminMinimumRefusal(kind, minCoaches)` in `src/lib/shift-template-kind.js`. It returns `null`, or `{ status: 400, body: { success: false, error: 'admin_has_no_minimum', message } }` when kind is `admin` and the minimum SENT is anything but `undefined`/`null`/`0`.
- `shiftKindOf(row)` / `isAdminShift(row)` in `shared/shift-kind.js`. These read `row.kind ?? row.shift_templates.kind`, and anything unreadable counts as `class`.
- The `kind` column exists on `shift_templates` only (mig 628, D1). A block reads it through its `shift_templates` embed, so this PR embeds `shift_templates ( name, kind )`.

**Size / ships:** M. **Migration 629** + web deploy + **OTA**. `shared/shift-briefing.js`, `shared/dashboard-data.js`, `mobile/app/(staff)/(tabs)/schedule.jsx` and `mobile/components/schedule/BlockCard.jsx` are bundle paths. Merging publishes a phone update at 100%.

**DEPLOY ORDER (strict):**
1. **SHIFTTYPE.1 (#13) is merged and mig 628 is applied.** This PR reads `shift_templates.kind`.
2. **Apply mig 629 FIRST** (Supabase MCP `apply_migration` against **un1t-crm** `iyvtbjjxdggiadzwwvdj`, then `get_advisors`). The steps are under "Migration apply steps". Applied alone, 629 changes nothing: every `briefing` is NULL and no writer uses `block_edited` yet.
3. **Then merge.** The code names `shift_blocks.briefing` in the calendar feed, the `/shifts` feed, the Today roster (`shared/dashboard-data.js`, which the phone also runs directly against Supabase) and the editor. Without the column every one of those selects returns 400 (the ENROLFIX.1 class, CLAUDE.md). A Vercel preview of this branch runs against prod, so the preview is broken until 629 is applied.
4. A phone that has not taken the OTA never asks for `briefing`, so it behaves as today.

**Worktree:** a fresh worktree off `origin/main` (#13 is already there), branch `blockedit-1`. Confirm mig 628 is applied (`list_migrations`) before starting. Tests: `npx vitest run <file>`. Do NOT run the whole suite or `npm run build` until the PR gate (8GB machine).

**Rules that bite in this PR (read `CLAUDE.md` Invariants first):**
- **An `/api` route gets NO RLS.** The new PUT reads the block by id, then `assertLocationAccessOr404` (404 for a block outside the caller's studios), then `hasRoleAtLocation(user, block.location_id, MANAGER_ROLES)` (403). This is the DELETE handler's gate in the same file (`blocks/[id]/route.js:49-75`). The role that counts is the role AT the block's studio (SCHEDROLES.1), never `user.role`.
- **`MANAGER_ROLES` is `['master','owner','manager','head_coach']`** (`src/lib/schemas.js:193`). "Manager-level" means that set, as it does for every other schedule write.
- **A column named in a `.select()` is a claim about the schema.** Task 1 lands mig 629 first, so `check:select-columns` can resolve `briefing` in every later task.
- **A bare supabase write resolves, it does not throw.** Every write here destructures `error`, and the block UPDATE judges the rows it touched (`.select('id')` → zero rows = the block changed underneath us). Both new files are armed in `eslint.guardrails.config.mjs` (Task 7).
- **Removing a silent failure must never create a louder one.** A failed change-log row or a failed notice must never fail a save that already happened. They are logged, and the save still answers `success: true`.
- **Quiet hours gate the NOTICE, never the STATE** (memory: scheduler product review, COVERLOOP.1). The new time is saved the moment the manager presses Save. The coach's push waits for the 07:00–22:00 band at the studio (`src/lib/staff-push-hours.js`). A push only goes out when there is a later tick to send it: see D5.
- **An unregistered push category fails CLOSED.** This PR sends category `shift_adjusted`, which is registered (`src/lib/notifications-registry.js:241`, `notify_shift_adjusted` in `shared/permissions.js:716`). It is the bare name: `resolvePushAllowedIds` prepends `notify_` itself.
- **Mobile cannot import `src/lib`.** The briefing helper lives in `shared/` and mobile imports it as `shared/shift-briefing` (`check:mobile-imports`).
- **jsdom cannot see layout.** Component tests assert text, roles and presence only. A 390px check is a browser job.
- **The repo is PUBLIC.** Fixtures use `Coach A`, `Manager B`, `Sam Demo`.

---

### Decisions (made here, each justified)

**D1. `PUT /api/schedule/blocks/[id]` takes any of `start_time`, `end_time`, `min_coaches`, `max_coaches`, `briefing`, plus `allow_below_assigned`.** Omitted means unchanged. `briefing: null` or blank clears the briefing. A body that sends none of the five fields is a 400 `nothing_to_change`. A body whose values are all equal to what is stored returns 200 `{ unchanged: true }` and writes nothing, so re-saving an untouched form never logs or notifies. The rules live in a pure planner, `planBlockEdit` in `src/lib/block-edit.js`, which is table-tested.

**D2. Validation:**
- **End after start**: 400 `end_not_after_start`. The database already says so: `shift_blocks_time_order CHECK (end_time > start_time)` (`supabase/migrations/067_roster_v2_shift_blocks.sql:90`). No block crosses midnight.
- **Maximum at least the minimum**: 400 `min_above_max`, mirroring `shift_blocks_min_coaches_check` (mig 177).
- **Admin block with a minimum above 0**: 400 `admin_has_no_minimum`, through SHIFTTYPE's `adminMinimumRefusal(shiftKindOf(block), body.min_coaches)`. The editor does not send a minimum for an admin block.
- **Maximum below the live coaches already on the shift**: **409 `below_assigned` unless `allow_below_assigned: true`**. With the flag the save goes through and carries a warning. This mirrors the assign route, which refuses a coach past `max_coaches` with 409 unless `allow_over_capacity: true` (`blocks/[id]/assignments/route.js:21-23,191,336-347`). Nobody is unassigned by it. The check only runs when the maximum is what changed, so a shift that is already over its maximum (because a manager used `allow_over_capacity`) can still have its times edited.

**D3. The coach overrides: an override equal to the block's OLD time follows the block; any other override stays.** Judged per field (start and end separately), and only for a field whose block time changed.
- An assignment override is the coach's own window (`effectiveOverride`, `src/lib/roster-read.js:33`: the override wins, otherwise the block time). An override that EQUALS the block's time says nothing the block does not already say. The web editor never writes one (it saves "same as the block" as null, `ScheduleCalendar.jsx` `AssignmentRow.handleSave`), but other writers can: `upsertShiftAssignment` writes whatever it is given. If that override stayed, moving the block would silently leave that coach at the old time. So it is cleared (set to null) and the coach moves with the block.
- An override that DIFFERS from the old block time is a deliberate partial shift ("in at 10, covering the end"). It stays exactly as it was. The response carries `kept_overrides` and a warning naming each such coach and the hours they keep, so the manager sees who did not move. It is not refused even when it now falls outside the new window: the manager may intend it, and the warning says so.
- The clear is a guarded write: `.eq('id').eq('block_id').eq('<field>_override', <old value>)`. If it fails or matches nothing, that coach keeps the old override, the notice uses the window they really have (`toIfStuck`), and the warning says their hours could not be moved.
- `partial_reason` is never touched.

**D4. The change log.** Only a block on a **published** roster is logged. A draft edit reaches coaches through the first publish, which is the rule every other writer follows (`logRosterChange` no-ops for drafts, `src/lib/roster-change-log.js:32`).
- **Per coach whose own window moved**: one `time_changed` row with `details: { source: 'block_edit', from: {start_time, end_time}, to: {start_time, end_time} }`. `from` and `to` are that COACH's window, not the block's. A coach with a kept override on both moved fields did not move, so they get no row and no message. This is the template-edit row shape (`templates/[id]/route.js:285-290`), which CHANGELOG.1's drawer already prints as "Moved Coach A's Tue 15 Sep 6am shift to 7am–11am". Only `(template edited)` becomes `(shift edited)`.
- **Per edit (times, minimum, maximum or briefing)**: one coachless **`block_edited`** row. Its details are `{ source: 'block_edit', from?, to?, min_coaches?: {from,to}, max_coaches?: {from,to}, briefing?: 'added'|'changed'|'removed' }`. This row is why mig 629 widens the `action` CHECK (mig 236 allows only `assigned`, `unassigned` and `time_changed`). A minimum, a maximum or a briefing has no coach to hang a row on, and "Every change writes the change log" was the ask. **The briefing TEXT never goes into `details`.** Only the kind of change is recorded, so free text cannot reach the drawer through `details`, which is whitelisted by key AND value (`publicDetails`, `roster-change-log.js:135`).
- The `block_edited` row is **born stamped** (`notified_at = now()` in the INSERT). No coach is messaged about it, so the re-publish safety net (`collectUnnotifiedChanges`) must never collect it. `stampMeansTold` returns false for it, so the drawer shows no "told" state rather than a time nobody was told at. This is the rule-1 shape (mig 622) from `roster-change-format.js:40-81`.

**D5. Notices go out from the */5 push cron, never from the request.** The route writes the `time_changed` rows and sends nothing. A new arm, `runShiftTimeChangeNotices` (`src/lib/block-edit-notify.js`), runs on every tick of `/api/cron/send-push-reminders` (`*/5`) beside the shift-reminder arm. It messages each coach once, inside quiet hours, and stamps on delivery.
- **Why not push from the route, as the assignment PUT does:** a quiet-hours gate needs a later tick, or it loses the notice. `src/app/api/schedule/time-off/[id]/route.js:416-418` says so, and chose no gate for that reason. The cron IS the later tick. Having one sender also removes the race between a route send and a held send.
- **Latency is 0–5 minutes in band.** A manager edit at 23:30 is told from 07:00. The route answers `notice: { coaches, when: 'shortly' | 'morning' }` and the web toast says which, so a manager who moves a 06:30 shift at 23:30 knows to ring the coach.
- **One message per coach per shift, however many edits piled up.** It compares the OLDEST unsent row's `from` with the coach's window NOW, read live from the block and the coach's assignment. If they are equal (edited and put back), nobody is messaged.
- **Stamped with no message, and `details.notice = 'not_needed'`** (so the drawer shows no told time): the coach is no longer live on the shift, the shift was deleted (`block_id` is SET NULL), the net change is nothing, or the shift already started today.
- **Dedup is per row:** `notifyUsersOnce(db, 'shift_time_changed:<newest row id>', …)`. A later edit writes a new row, so it gets a new key and a new message. An opted-out coach or a coach with no device keeps the claim and is left UNSTAMPED for the re-publish safety net (NOTIFY.1's `optedOut` posture, `roster-change-notify.js:161-175`). Later ticks dedup instead of re-sending. The read covers rows at most **48 hours** old; anything older belongs to the re-publish safety net.
- **Past shift, or the manager is the coach**: the route stamps those rows at once. That is `stampMeansTold` rules 3 and 4: past date, and `self_change`.
- **Message:** title `Shift time changed`, body `Morning on Wed 30 Sep is now 10am–1pm (was 9am–12pm).` Category `shift_adjusted`, `data: { type: 'shift_adjusted', block_date, location_id }`. The phone already deep-links this type to that week (NOTIFY.1 D-C).

**D6. The briefing is `shift_blocks.briefing text`: at most 500 characters, never blank (a DB CHECK), NULL when absent.**
- The API trims it and turns blank into NULL (`normaliseBriefing` in `shared/shift-briefing.js`, one definition that web and phone share).
- **The DB CHECK exists because the API is not the only door.** `authenticated` holds table-level UPDATE and the `shift_blocks_upd` policy lets managers write any column from the browser. The same policy is why a coach cannot write it.
- Coaches READ it: the calendar feed's coach allow-list gains `briefing`, and the `/shifts` feed and the Today read carry it.
- **Every row of a published shift carries it, the coach's own row and colleagues' rows alike.** It is written for the coaches on that shift, so it is not a manager fact. The surfaces only DRAW it on the viewer's own shift (the Me list, Today, the dialog for a shift they are on) and on the manager's Manage card.
- **The phone is display only in this PR.**

**D7. Copying a week or month does NOT copy the briefing, in either mode.** A briefing is about one day ("fire drill at 10"), so repeating it next week would be wrong more often than right.
- The exact copy also could not do it consistently. `bulkUpsertShiftAssignments` only CREATES missing target blocks (`src/lib/roster-write.js:517-551`), and the nightly generator has usually created them already.
- So `roster-copy.js` and `roster-write.js` are untouched.
- A standing instruction that belongs on every week is a template field, and that is not built here (Review notes).

**D8. Past shifts can be edited** (an hours correction is legitimate: the shift really ran 9 to 1). They are logged like any other edit on a published roster, and never messaged (D5).

**D9. Concurrency.** The block UPDATE is guarded on the start, end, minimum and maximum it was read with. A zero-row result is a 409 `block_changed` ("This shift changed while you were editing it"), so two managers cannot silently overwrite each other's times. The briefing is not in the guard, because PostgREST cannot `eq` a NULL, so the last write wins for the briefing. The editor sends only the fields the manager actually changed, so an untouched field is never overwritten from a stale form.

---

### Files

| File | Change | OTA path? |
|---|---|---|
| `supabase/migrations/629_shift_block_briefing.sql` | Create | |
| `tests/migration-629-shift-block-briefing.test.js` | Create (PGlite replay) | |
| `shared/shift-briefing.js` | Create: `BRIEFING_MAX_LENGTH`, `normaliseBriefing`, `briefingOf` | **yes** |
| `shared/shift-briefing.test.js` | Create | yes (accepted no-op over-trigger, pinned in `tests/ota-trigger-paths.test.js`) |
| `src/lib/block-edit.js` | Create: `planBlockEdit`, `toHms`, `sameWindow`, `blockEditNoticeText` | |
| `src/lib/block-edit.test.js` | Create | |
| `src/lib/roster-change-log.js` | Modify: `BLOCK_EDITED_ACTION`, `logBlockEdit`; `publicDetails` whitelists `min_coaches`, `max_coaches`, `briefing`, `notice` | |
| `src/lib/roster-change-log.test.js` | Modify: new describes at the end | |
| `src/lib/roster-change-format.js` | Modify: `(shift edited)`, the `block_edited` sentence, `stampMeansTold` for `block_edited` and `notice: 'not_needed'`; header list | |
| `src/lib/roster-change-format.test.js` | Modify | |
| `src/lib/block-edit-notify.js` | Create: `planTimeChangeNotices`, `timeChangeMessage`, `runShiftTimeChangeNotices` | |
| `src/lib/block-edit-notify.test.js` | Create | |
| `src/app/api/schedule/blocks/[id]/route.js` | Modify: add `PUT` after `DELETE` (ends line 157); header comment | |
| `src/app/api/schedule/blocks/[id]/route.edit.test.js` | Create (keeps the 287-line DELETE suite untouched) | |
| `eslint.guardrails.config.mjs` | Modify: arm `no-unchecked-supabase-write` on the two new write paths | |
| `src/app/api/cron/send-push-reminders/route.js` | Modify: import (after line 44), the arm (after the shift arm's `catch`, line 395) | |
| `src/app/api/cron/send-push-reminders/route.test.js` | Modify: mock + describe | |
| `src/lib/roster-read.js` | Modify: `API_SHIFT_SELECT` (line 103) and `toApiShiftRow` (after line 128) carry `briefing` | |
| `src/lib/roster-read.test.js` | Modify | |
| `src/app/api/schedule/blocks/route.js` | Modify: `slimBlockForCoach` keeps `briefing` (after line 139) | |
| `src/app/api/schedule/blocks/route.test.js` | Modify | |
| `shared/dashboard-data.js` | Modify: `fetchDashboardShifts` select (line 103) + row (after line 122) | **yes** |
| `shared/dashboard-data.test.js` | Modify | yes (no-op over-trigger) |
| `src/lib/roster-card-model.js` | Modify: `hasBriefing` + hover title | |
| `src/lib/roster-card-model.test.js` | Modify | |
| `src/components/schedule/ShiftCard.jsx` | Modify: a "Briefing" word chip | |
| `src/components/schedule/ShiftCard.test.jsx` | Modify | |
| `src/components/schedule/BlockEditForm.jsx` | Create: the manager's edit form | |
| `src/components/schedule/BlockEditForm.test.jsx` | Create | |
| `src/components/ScheduleCalendar.jsx` | Modify: import, `handleBlockEdit`, `BlockDetailModal` shows the briefing + an Edit shift form | |
| `src/components/ScheduleCalendar.block-edit.test.jsx` | Create | |
| `src/components/dashboard/MonthRoster.jsx` | Modify: `WeekPanel` prints the briefing on a future day | |
| `src/components/dashboard/MonthRoster.briefing.test.jsx` | Create | |
| `mobile/app/(staff)/(tabs)/schedule.jsx` | Modify: import (after line 44), `ShiftRow` (after line 309) | **yes** |
| `mobile/components/schedule/BlockCard.jsx` | Modify: briefing under the time (after line 33) | **yes** |
| `src/lib/openapi.js` | Modify: `registerPath` PUT after the DELETE block (ends line 4425) | |
| `src/lib/openapi.test.js` | Modify | |
| `docs/roster-v2.md` | Modify: a section after "Shift kinds" (line 195) | |
| `docs/CHANGELOG.md` | One new row after `gh pr create` | |

`check:ota-paths` stays clean: no new top-level `mobile/` entry.

---

### Task 1: Migration 629 and its PGlite replay

**Files:** Create `supabase/migrations/629_shift_block_briefing.sql`, `tests/migration-629-shift-block-briefing.test.js`.

- [ ] **Step 1: Write the failing test**

```js
// tests/migration-629-shift-block-briefing.test.js
// BLOCKEDIT.1 — behavioural test for migration 629.
//
// Same reason as the 613/618/622/624/625/628 replays: there is no local
// Supabase stack, so without this the DDL gets its first execution on prod.
// Boots PGlite, recreates shift_blocks and roster_change_log as migs
// 067/177/236 left them (only what 629 touches or must coexist with), with
// Supabase's default table-level grants, applies the real 629 file, and proves
// the header's claims.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_629 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/629_shift_block_briefing.sql'),
  'utf8',
)

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const BLOCK = '50000000-0000-0000-0000-000000000001'
const COACH = '60000000-0000-0000-0000-000000000001'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY);
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    block_date date NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL,
    max_coaches smallint NOT NULL DEFAULT 15,
    min_coaches smallint NOT NULL DEFAULT 1,
    roster_id uuid,
    notes text,
    CONSTRAINT shift_blocks_time_order CHECK (end_time > start_time),
    CONSTRAINT shift_blocks_max_coaches_check CHECK (max_coaches BETWEEN 1 AND 50),
    CONSTRAINT shift_blocks_min_coaches_check CHECK (min_coaches >= 0 AND min_coaches <= max_coaches)
  );
  -- mig 236 verbatim for the columns and the INLINE action CHECK, which
  -- Postgres names roster_change_log_action_check.
  CREATE TABLE public.roster_change_log (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    block_id    uuid REFERENCES public.shift_blocks(id) ON DELETE SET NULL,
    block_date  date,
    actor_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    coach_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    action      text NOT NULL CHECK (action IN ('assigned', 'unassigned', 'time_changed')),
    details     jsonb NOT NULL DEFAULT '{}'::jsonb,
    notified_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_blocks, public.roster_change_log TO anon, authenticated;
  GRANT ALL ON public.shift_blocks, public.roster_change_log TO service_role;
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}');
  INSERT INTO public.profiles VALUES ('${COACH}');
  INSERT INTO public.shift_blocks (id, location_id, block_date, start_time, end_time)
    VALUES ('${BLOCK}', '${LOC}', '2026-09-30', '09:00', '12:00');
  INSERT INTO public.roster_change_log (location_id, block_id, coach_id, action)
    VALUES ('${LOC}', '${BLOCK}', '${COACH}', 'time_changed');
`

async function boot({ before = '' } = {}) {
  const pg = new PGlite()
  await pg.exec(BASE_SCHEMA)
  await pg.exec(SEED)
  if (before) await pg.exec(before)
  return pg
}

const ACTION_CHECKS = `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
  WHERE conrelid = 'public.roster_change_log'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%action%' ORDER BY 1`

async function inRollback(db, fn) {
  await db.exec('BEGIN')
  try { return await fn() } finally { await db.exec('ROLLBACK') }
}

let db
beforeAll(async () => {
  db = await boot()
  await db.exec(MIG_629)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 629 — shift_blocks.briefing', () => {
  it('is a nullable text column with no default, so every existing shift has no briefing', async () => {
    const { rows } = await db.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'shift_blocks' AND column_name = 'briefing'`)
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }])
    const { rows: b } = await db.query(`SELECT briefing FROM public.shift_blocks WHERE id = '${BLOCK}'`)
    expect(b).toEqual([{ briefing: null }])
  })

  it('takes up to 500 characters and refuses 501', async () => {
    await inRollback(db, async () => {
      await db.exec(`UPDATE public.shift_blocks SET briefing = repeat('a', 500) WHERE id = '${BLOCK}'`)
    })
    await inRollback(db, async () => {
      await expect(db.exec(`UPDATE public.shift_blocks SET briefing = repeat('a', 501) WHERE id = '${BLOCK}'`))
        .rejects.toThrow(/shift_blocks_briefing_shape/)
    })
  })

  it('refuses an empty or whitespace-only briefing (absent is NULL, never blank)', async () => {
    for (const blank of ["''", "'   '", "E'\\n\\t'"]) {
      await inRollback(db, async () => {
        await expect(db.exec(`UPDATE public.shift_blocks SET briefing = ${blank} WHERE id = '${BLOCK}'`))
          .rejects.toThrow(/shift_blocks_briefing_shape/)
      })
    }
  })

  it('changes no grant: the column rides the table-level grants', async () => {
    const { rows } = await db.query(`SELECT
      has_column_privilege('authenticated', 'public.shift_blocks', 'briefing', 'SELECT') AS auth_select,
      has_column_privilege('service_role',  'public.shift_blocks', 'briefing', 'UPDATE') AS svc_update`)
    expect(rows[0]).toEqual({ auth_select: true, svc_update: true })
  })
})

describe('migration 629 — roster_change_log.action gains block_edited', () => {
  it('accepts a coachless block_edited row, born stamped', async () => {
    await inRollback(db, async () => {
      const r = await db.query(`INSERT INTO public.roster_change_log (location_id, block_id, action, details, notified_at)
        VALUES ('${LOC}', '${BLOCK}', 'block_edited', '{"source":"block_edit"}', now()) RETURNING coach_id, action`)
      expect(r.rows).toEqual([{ coach_id: null, action: 'block_edited' }])
    })
  })

  it('still accepts the three old actions and still refuses anything else', async () => {
    await inRollback(db, async () => {
      for (const a of ['assigned', 'unassigned', 'time_changed']) {
        await db.exec(`INSERT INTO public.roster_change_log (location_id, coach_id, action) VALUES ('${LOC}', '${COACH}', '${a}')`)
      }
    })
    await inRollback(db, async () => {
      await expect(db.exec(`INSERT INTO public.roster_change_log (location_id, action) VALUES ('${LOC}', 'bogus')`))
        .rejects.toThrow(/roster_change_log_action_check/)
    })
  })

  it('leaves exactly ONE check on action, and it names block_edited', async () => {
    const { rows } = await db.query(ACTION_CHECKS)
    expect(rows.map((r) => r.conname)).toEqual(['roster_change_log_action_check'])
    expect(rows[0].def).toMatch(/block_edited/)
  })

  it('re-running the file is a no-op', async () => {
    await db.exec(MIG_629)
    expect((await db.query(ACTION_CHECKS)).rows).toHaveLength(1)
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'public.shift_blocks'::regclass AND conname = 'shift_blocks_briefing_shape'`)
    expect(rows[0].n).toBe(1)
  })
})

describe('the self-check aborts the WHOLE file', () => {
  it('when a second, differently named action CHECK exists, the DO block raises and nothing is applied', async () => {
    const other = await boot({
      before: `ALTER TABLE public.roster_change_log ADD CONSTRAINT roster_change_log_action_legacy
                 CHECK (action IN ('assigned', 'unassigned', 'time_changed'))`,
    })
    try {
      await expect(other.exec(MIG_629)).rejects.toThrow(/mig 629: expected ONE check on roster_change_log\.action/)
      await other.exec('ROLLBACK')
      const { rows } = await other.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'shift_blocks' AND column_name = 'briefing'`)
      expect(rows).toEqual([])
    } finally {
      await other.close()
    }
  })

  it('when a briefing column of another shape already exists, the DO block raises', async () => {
    const other = await boot({ before: "ALTER TABLE public.shift_blocks ADD COLUMN briefing text DEFAULT 'x'" })
    try {
      await expect(other.exec(MIG_629)).rejects.toThrow(/mig 629: shift_blocks\.briefing has the wrong shape/)
      await other.exec('ROLLBACK')
    } finally {
      await other.close()
    }
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** (`ENOENT` on the migration file)

```bash
npx vitest run tests/migration-629-shift-block-briefing.test.js
```

- [ ] **Step 3: Write the migration**

```sql
-- 629 — BLOCKEDIT.1: a coach-visible briefing on one shift block, and a
-- change-log action for editing a block.
--
-- NOT APPLIED YET. Apply BEFORE the BLOCKEDIT.1 code deploys: that code names
-- shift_blocks.briefing in PostgREST selects (the calendar feed, the phone's
-- /api/schedule/shifts read, the Today roster, the block editor) and inserts
-- roster_change_log rows with action 'block_edited'. A select naming a column
-- that does not exist is a 400 on every call. Applied alone this file changes
-- no behaviour: every briefing is NULL and no writer uses the new action yet.
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-629-shift-block-briefing.test.js), which runs this file
-- verbatim.
--
-- WHAT
--   1. shift_blocks.briefing  text NULL
--        shift_blocks_briefing_shape CHECK (briefing IS NULL OR
--          (char_length(briefing) <= 500 AND btrim(briefing) <> ''))
--      A note a manager writes for the coaches on THIS shift ("fire drill at
--      10", "cover the new-member intro"). Coaches read it and never write it.
--      It is SEPARATE from shift_blocks.notes and shift_assignments.notes,
--      which are a manager's working notes.
--   2. roster_change_log.action gains 'block_edited' (the CHECK is replaced):
--        roster_change_log_action_check CHECK (action IN
--          ('assigned','unassigned','time_changed','block_edited'))
--      One coachless row per edit of a PUBLISHED block (times, minimum,
--      maximum, briefing). coach_id is NULL on it; the column has been
--      nullable since mig 236. The writer stamps notified_at in the INSERT:
--      nobody is messaged about a row with no coach, so the re-publish safety
--      net (collectUnnotifiedChanges) must never pick it up. The briefing TEXT
--      is never written into details, only 'added' | 'changed' | 'removed'.
--
-- WHY A DB CHECK AS WELL AS THE API (briefing)
--   The API caps the briefing at 500 and turns blank into NULL, but it is not
--   the only door: `authenticated` holds UPDATE on shift_blocks (table-level
--   grant) and the mig 320/605 policy shift_blocks_upd lets any manager at the
--   location write any column through the browser's client. The CHECK makes
--   the cap true of the data. The same policy is why a COACH cannot write the
--   briefing through the browser: shift_blocks_upd is manager-only.
--
-- WHY REPLACE THE ACTION CHECK BY NAME, AND SELF-CHECK IT
--   Mig 236 declared the CHECK inline on the column, so Postgres named it
--   roster_change_log_action_check. If prod's name differed, DROP ... IF
--   EXISTS would do nothing and ADD would put a SECOND check beside the old
--   one, which would still refuse 'block_edited'. The self-check counts the
--   CHECKs that mention `action` and aborts unless exactly one exists and it
--   allows 'block_edited'. Pre-check (b) confirms the name before apply.
--
-- GRANTS: none changed. Neither table has a column-level GRANT or REVOKE in
--   any migration, so the new column carries the table-level privileges.
--   Pre-check (c) confirms that against the catalog, not this text (mig 153).
--
-- LOCKS: ADD COLUMN with no default is catalog-only. Each ADD CONSTRAINT scans
--   its table once (every briefing is NULL; roster_change_log is small).
--   ACCESS EXCLUSIVE for milliseconds each.
--
-- REPLAYING THIS FILE IS A NO-OP (IF NOT EXISTS; DROP IF EXISTS then ADD).
-- One explicit transaction, so a failed self-check leaves NOTHING applied
-- (the 613/614/618/622/624/628 convention).
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; run IMMEDIATELY before applying, stop if any
-- answer differs from "Expected")
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The column and the new constraint name are free:
--       SELECT column_name FROM information_schema.columns
--        WHERE table_schema='public' AND table_name='shift_blocks' AND column_name='briefing';
--       SELECT conname FROM pg_constraint
--        WHERE conrelid='public.shift_blocks'::regclass AND conname='shift_blocks_briefing_shape';
--     Expected: 0 rows, 0 rows.
-- (b) roster_change_log has exactly one CHECK on action, named as mig 236 left it:
--       SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--        WHERE conrelid='public.roster_change_log'::regclass AND contype='c' ORDER BY 1;
--     Expected: ONE row, roster_change_log_action_check
--       CHECK ((action = ANY (ARRAY['assigned'::text, 'unassigned'::text, 'time_changed'::text])))
--     If the name differs, STOP: the DROP would miss it and the self-check
--     would abort the apply (safe, but fix the file first).
-- (c) Grants are table-level only (KEEP THE OUTPUT for the rollback record):
--       SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--         FROM information_schema.table_privileges
--        WHERE table_schema='public' AND table_name IN ('shift_blocks','roster_change_log')
--          AND grantee IN ('anon','authenticated','service_role') GROUP BY 1,2 ORDER BY 1,2;
--       SELECT count(*) FROM information_schema.column_privileges c
--        WHERE c.table_schema='public' AND c.table_name IN ('shift_blocks','roster_change_log')
--          AND c.grantee IN ('anon','authenticated')
--          AND NOT EXISTS (
--            SELECT 1 FROM information_schema.table_privileges t
--             WHERE t.table_schema='public' AND t.table_name=c.table_name
--               AND t.grantee=c.grantee AND t.privilege_type=c.privilege_type);
--     Expected: authenticated holds at least SELECT on both tables; the
--     second query returns 0.
-- (d) What exists (information, not a gate; KEEP for the record):
--       SELECT action, count(*), count(*) FILTER (WHERE coach_id IS NULL) AS no_coach,
--              count(*) FILTER (WHERE notified_at IS NULL) AS unstamped
--         FROM public.roster_change_log GROUP BY 1 ORDER BY 1;
-- (e) list_migrations shows 628 and no 629.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (f) SELECT data_type, is_nullable, column_default FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='shift_blocks' AND column_name='briefing';
--     Expected: text | YES | NULL
-- (g) SELECT count(*) FILTER (WHERE briefing IS NOT NULL) FROM public.shift_blocks;
--     Expected: 0
-- (h) SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--      WHERE (conrelid='public.shift_blocks'::regclass AND conname='shift_blocks_briefing_shape')
--         OR (conrelid='public.roster_change_log'::regclass AND contype='c') ORDER BY 1;
--     Expected 2 rows:
--       roster_change_log_action_check  CHECK ((action = ANY (ARRAY['assigned'::text, 'unassigned'::text, 'time_changed'::text, 'block_edited'::text])))
--       shift_blocks_briefing_shape     CHECK (((briefing IS NULL) OR ((char_length(briefing) <= 500) AND (btrim(briefing) <> ''::text))))
-- (i) SELECT has_column_privilege('authenticated','public.shift_blocks','briefing','SELECT'),
--            has_column_privilege('service_role','public.shift_blocks','briefing','UPDATE');
--     Expected: true, true.
-- (j) The (d) query again. Expected: identical counts (no row was touched).
-- (k) get_advisors (security, then performance). Expected: nothing new.
--
-- ROLLBACK (forward-only repo; this is a NEW migration, never an edit here):
--   Revert the BLOCKEDIT.1 code FIRST and let it deploy: while that code is
--   live, dropping the column turns every select naming it into a 400.
--   Then, keeping any briefings managers wrote:
--     SELECT id, briefing FROM public.shift_blocks WHERE briefing IS NOT NULL;  -- save to the record
--     BEGIN;
--     ALTER TABLE public.shift_blocks DROP CONSTRAINT IF EXISTS shift_blocks_briefing_shape;
--     ALTER TABLE public.shift_blocks DROP COLUMN IF EXISTS briefing;
--     COMMIT;
--   Leave the widened action CHECK in place: it only ADDS a value, and
--   narrowing it back would first need every block_edited audit row deleted.

BEGIN;

ALTER TABLE public.shift_blocks
  ADD COLUMN IF NOT EXISTS briefing text;

ALTER TABLE public.shift_blocks DROP CONSTRAINT IF EXISTS shift_blocks_briefing_shape;
ALTER TABLE public.shift_blocks
  ADD CONSTRAINT shift_blocks_briefing_shape
  CHECK (briefing IS NULL OR (char_length(briefing) <= 500 AND btrim(briefing) <> ''));

COMMENT ON COLUMN public.shift_blocks.briefing IS
  'BLOCKEDIT.1 (mig 629): a note for the COACHES on this one shift, written by a manager (PUT /api/schedule/blocks/[id]); coaches read it on web and phone and never write it. At most 500 characters, never blank (NULL when absent). Separate from notes (a manager''s working note). Not copied by copy week/month.';

ALTER TABLE public.roster_change_log DROP CONSTRAINT IF EXISTS roster_change_log_action_check;
ALTER TABLE public.roster_change_log
  ADD CONSTRAINT roster_change_log_action_check
  CHECK (action IN ('assigned', 'unassigned', 'time_changed', 'block_edited'));

COMMENT ON COLUMN public.roster_change_log.action IS
  'assigned | unassigned | time_changed are per coach (coach_id set). block_edited (BLOCKEDIT.1, mig 629) is one coachless row per edit of a published shift block (times, minimum, maximum, briefing), stamped notified_at at insert because nobody is messaged about it.';

-- Self-check (the mig 153b habit: verify the catalog, not this text).
DO $$
DECLARE
  v_col record;
  v_shape int;
  v_action_checks int;
  v_action_def text;
BEGIN
  SELECT data_type, is_nullable, column_default INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'shift_blocks' AND column_name = 'briefing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 629: shift_blocks.briefing is missing';
  END IF;
  IF v_col.data_type <> 'text' OR v_col.is_nullable <> 'YES' OR v_col.column_default IS NOT NULL THEN
    RAISE EXCEPTION 'mig 629: shift_blocks.briefing has the wrong shape (type %, nullable %, default %); a column of that name existed before this file and ADD COLUMN IF NOT EXISTS kept it',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  END IF;

  SELECT count(*) INTO v_shape
    FROM pg_constraint
   WHERE conrelid = 'public.shift_blocks'::regclass
     AND contype = 'c' AND convalidated
     AND conname = 'shift_blocks_briefing_shape';
  IF v_shape <> 1 THEN
    RAISE EXCEPTION 'mig 629: shift_blocks_briefing_shape is missing or not validated';
  END IF;

  SELECT count(*), max(pg_get_constraintdef(oid)) INTO v_action_checks, v_action_def
    FROM pg_constraint
   WHERE conrelid = 'public.roster_change_log'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%action%';
  IF v_action_checks <> 1 OR v_action_def NOT LIKE '%block_edited%' THEN
    RAISE EXCEPTION 'mig 629: expected ONE check on roster_change_log.action allowing block_edited, found % (%)',
      v_action_checks, v_action_def;
  END IF;
END $$;

COMMIT;
```

- [ ] **Step 4: Run it, expect PASS**

```bash
npx vitest run tests/migration-629-shift-block-briefing.test.js
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/629_shift_block_briefing.sql tests/migration-629-shift-block-briefing.test.js
git commit -m "BLOCKEDIT.1 — mig 629: shift_blocks.briefing (coach-visible, max 500, never blank) and a block_edited change-log action

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `shared/shift-briefing.js`, one definition for web and phone (OTA path)

**Files:** Create `shared/shift-briefing.js`, `shared/shift-briefing.test.js`.

- [ ] **Step 1: Write the failing test**

```js
// shared/shift-briefing.test.js
import { describe, it, expect } from 'vitest'
import { BRIEFING_MAX_LENGTH, normaliseBriefing, briefingOf } from './shift-briefing'

describe('normaliseBriefing', () => {
  it('trims, and blank is null (the DB refuses blank: mig 629)', () => {
    expect(normaliseBriefing('  Fire drill at 10  ')).toBe('Fire drill at 10')
    expect(normaliseBriefing('')).toBeNull()
    expect(normaliseBriefing('   \n\t')).toBeNull()
  })

  it('anything that is not a string is null', () => {
    for (const v of [null, undefined, 0, {}, []]) expect(normaliseBriefing(v)).toBeNull()
  })

  it('keeps inner line breaks: a briefing can be a short list', () => {
    expect(normaliseBriefing('Bring:\n- bands\n- timer')).toBe('Bring:\n- bands\n- timer')
  })

  it('the cap is the database cap', () => {
    expect(BRIEFING_MAX_LENGTH).toBe(500)
  })
})

describe('briefingOf', () => {
  it('reads a row\'s top-level briefing, normalised (block, /shifts row and Today row alike)', () => {
    expect(briefingOf({ briefing: ' Cover the intro ' })).toBe('Cover the intro')
    expect(briefingOf({ briefing: null })).toBeNull()
    expect(briefingOf({})).toBeNull()
    expect(briefingOf(null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** (module not found)

```bash
npx vitest run shared/shift-briefing.test.js
```

- [ ] **Step 3: Implement**

```js
// shared/shift-briefing.js
// BLOCKEDIT.1 (mig 629) — the coach-visible BRIEFING on one shift block.
//
// A note a manager writes for the coaches on ONE shift ("fire drill at 10").
// Coaches read it (web calendar dialog + card marker + Today, phone Me list +
// Manage card); only a manager writes it, through PUT /api/schedule/blocks/[id].
// It is NOT shift_blocks.notes or shift_assignments.notes: those are a
// manager's working notes and stay out of coach surfaces.
//
// Every read carries it at the top level of the row as `briefing` (the
// /api/schedule/blocks block, the /api/schedule/shifts row, the Today row).
//
// Dependency-free: shared/ is the mobile seam and cannot import src/lib.

/** The database cap: CHECK shift_blocks_briefing_shape (mig 629). */
export const BRIEFING_MAX_LENGTH = 500

/**
 * Trimmed text, or null for blank / not a string. The database refuses a blank
 * briefing, so every writer normalises through here first.
 * @returns {string|null}
 */
export function normaliseBriefing(value) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t === '' ? null : t
}

/** A row's briefing, ready to draw (null = draw nothing). */
export function briefingOf(row) {
  return normaliseBriefing(row?.briefing)
}
```

- [ ] **Step 4: Run it, expect PASS.** Then `npm run check:ota-paths` (expected clean: `shared/**` is already a trigger path).

- [ ] **Step 5: Commit**

```bash
git add shared/shift-briefing.js shared/shift-briefing.test.js
git commit -m "BLOCKEDIT.1 — shared/shift-briefing: one definition of a shift's coach-visible briefing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `src/lib/block-edit.js`, the pure edit planner

**Files:** Create `src/lib/block-edit.js`, `src/lib/block-edit.test.js`.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/block-edit.test.js
// BLOCKEDIT.1 — what editing ONE shift block means. Pure; table-driven.
import { describe, it, expect } from 'vitest'
import { planBlockEdit, toHms, sameWindow, blockEditNoticeText } from './block-edit'

const coach = (id, name, over = {}) => ({
  id: `a-${id}`, profile_id: id, status: 'scheduled',
  start_time_override: null, end_time_override: null, profiles: { full_name: name }, ...over,
})
const block = (over = {}) => ({
  id: 'b1', location_id: 'loc-1', block_date: '2026-09-30',
  start_time: '09:00:00', end_time: '12:00:00', min_coaches: 1, max_coaches: 3, briefing: null,
  shift_templates: { name: 'Morning', kind: 'class' },
  shift_assignments: [coach('u1', 'Coach A')],
  ...over,
})

describe('toHms / sameWindow', () => {
  it('reads HH:MM and HH:MM:SS as the same time, anything else as null', () => {
    expect(toHms('09:00')).toBe('09:00:00')
    expect(toHms('09:00:00')).toBe('09:00:00')
    expect(toHms(null)).toBeNull()
    expect(toHms('9am')).toBeNull()
    expect(sameWindow({ start_time: '09:00', end_time: '12:00:00' }, { start_time: '09:00:00', end_time: '12:00' })).toBe(true)
  })
})

describe('planBlockEdit — refusals', () => {
  it('nothing editable in the body is a 400', () => {
    const p = planBlockEdit({ block: block(), body: { allow_below_assigned: true } })
    expect(p).toMatchObject({ ok: false, status: 400, body: { error: 'nothing_to_change' } })
  })

  it('an end at or before the start is a 400 (mirrors shift_blocks_time_order)', () => {
    expect(planBlockEdit({ block: block(), body: { end_time: '09:00' } }).body.error).toBe('end_not_after_start')
    expect(planBlockEdit({ block: block(), body: { start_time: '13:00' } }).body.error).toBe('end_not_after_start')
  })

  it('a minimum above the maximum is a 400', () => {
    expect(planBlockEdit({ block: block(), body: { min_coaches: 4 } }).body.error).toBe('min_above_max')
    expect(planBlockEdit({ block: block(), body: { max_coaches: 1, min_coaches: 2 } }).body.error).toBe('min_above_max')
  })

  it("an admin shift's minimum above 0 is SHIFTTYPE's 400; 0 and omitted are fine", () => {
    const admin = block({ min_coaches: 0, shift_templates: { name: 'Stock take', kind: 'admin' } })
    expect(planBlockEdit({ block: admin, body: { min_coaches: 1 } })).toMatchObject({ ok: false, status: 400, body: { error: 'admin_has_no_minimum' } })
    expect(planBlockEdit({ block: admin, body: { min_coaches: 0, max_coaches: 2 } }).ok).toBe(true)
    expect(planBlockEdit({ block: admin, body: { start_time: '08:00' } }).ok).toBe(true)
  })

  it('a maximum below the coaches on the shift is a 409 unless allowed, and then a warning', () => {
    const two = block({ shift_assignments: [coach('u1', 'Coach A'), coach('u2', 'Coach B')] })
    const refused = planBlockEdit({ block: two, body: { max_coaches: 1, min_coaches: 1 } })
    expect(refused).toMatchObject({ ok: false, status: 409, body: { error: 'below_assigned', assigned: 2 } })
    const allowed = planBlockEdit({ block: two, body: { max_coaches: 1, min_coaches: 1, allow_below_assigned: true } })
    expect(allowed.ok).toBe(true)
    expect(allowed.warnings.join(' ')).toMatch(/2 coaches are on this shift/)
  })

  it('cancelled rows are not on the shift, so they never count against the maximum', () => {
    const b = block({ shift_assignments: [coach('u1', 'Coach A'), coach('u2', 'Coach B', { status: 'cancelled' })] })
    expect(planBlockEdit({ block: b, body: { max_coaches: 1 } }).ok).toBe(true)
  })

  it('a shift already over its maximum can still have its TIMES edited', () => {
    const over = block({ max_coaches: 1, shift_assignments: [coach('u1', 'Coach A'), coach('u2', 'Coach B')] })
    expect(planBlockEdit({ block: over, body: { start_time: '08:00' } }).ok).toBe(true)
  })
})

describe('planBlockEdit — the patch', () => {
  it('equal values are a no-op: nothing to write, log or tell', () => {
    expect(planBlockEdit({ block: block(), body: { start_time: '09:00', max_coaches: 3, briefing: '  ' } }))
      .toEqual({ ok: true, unchanged: true })
  })

  it('writes only what changed, times in HH:MM:SS, the briefing trimmed', () => {
    const p = planBlockEdit({ block: block(), body: { start_time: '09:30', end_time: '12:00', briefing: ' Fire drill at 10 ' } })
    expect(p.patch).toEqual({ start_time: '09:30:00', briefing: 'Fire drill at 10' })
  })

  it('blank clears a briefing', () => {
    const p = planBlockEdit({ block: block({ briefing: 'Old' }), body: { briefing: '' } })
    expect(p.patch).toEqual({ briefing: null })
    expect(p.blockDetails).toEqual({ source: 'block_edit', briefing: 'removed' })
  })

  it('the block_edited details record what changed, never the briefing text', () => {
    const p = planBlockEdit({ block: block(), body: { start_time: '10:00', end_time: '13:00', min_coaches: 2, briefing: 'Secret-ish' } })
    expect(p.blockDetails).toEqual({
      source: 'block_edit',
      from: { start_time: '09:00:00', end_time: '12:00:00' },
      to: { start_time: '10:00:00', end_time: '13:00:00' },
      min_coaches: { from: 1, to: 2 },
      briefing: 'added',
    })
    expect(JSON.stringify(p.blockDetails)).not.toMatch(/Secret/)
  })
})

describe('planBlockEdit — coaches and their own hours (D3)', () => {
  it('a coach with no override moves with the shift', () => {
    const p = planBlockEdit({ block: block(), body: { start_time: '10:00', end_time: '13:00' } })
    expect(p.followUpdates).toEqual([])
    expect(p.affected).toEqual([{
      assignmentId: 'a-u1', coachId: 'u1',
      from: { start_time: '09:00:00', end_time: '12:00:00' },
      to: { start_time: '10:00:00', end_time: '13:00:00' },
      toIfStuck: { start_time: '10:00:00', end_time: '13:00:00' },
    }])
    expect(p.kept).toEqual([])
  })

  it('an override EQUAL to the old block time follows: it is cleared, guarded on its old value', () => {
    const b = block({ shift_assignments: [coach('u1', 'Coach A', { start_time_override: '09:00' })] })
    const p = planBlockEdit({ block: b, body: { start_time: '10:00' } })
    expect(p.followUpdates).toEqual([{
      assignmentId: 'a-u1', coachId: 'u1',
      patch: { start_time_override: null },
      expect: { start_time_override: '09:00' },
    }])
    expect(p.affected[0].to).toEqual({ start_time: '10:00:00', end_time: '12:00:00' })
    // If that write fails the coach still has 09:00, which is what they get told.
    expect(p.affected[0].toIfStuck).toEqual({ start_time: '09:00:00', end_time: '12:00:00' })
  })

  it('a DIFFERENT override stays, the coach is not affected, and the manager is told who kept their hours', () => {
    const b = block({ shift_assignments: [coach('u1', 'Coach A', { start_time_override: '10:30:00' })] })
    const p = planBlockEdit({ block: b, body: { start_time: '10:00' } })
    expect(p.followUpdates).toEqual([])
    expect(p.affected).toEqual([])
    expect(p.kept).toEqual([{ assignmentId: 'a-u1', coachId: 'u1', name: 'Coach A', window: { start_time: '10:30:00', end_time: '12:00:00' } }])
    expect(p.warnings.join(' ')).toMatch(/Coach A keeps their own hours \(10:30am–12pm\)/)
  })

  it('per field: a kept start override does not stop the END moving the coach', () => {
    const b = block({ shift_assignments: [coach('u1', 'Coach A', { start_time_override: '10:30:00' })] })
    const p = planBlockEdit({ block: b, body: { end_time: '13:00' } })
    expect(p.affected[0]).toMatchObject({ from: { start_time: '10:30:00', end_time: '12:00:00' }, to: { start_time: '10:30:00', end_time: '13:00:00' } })
    // The END changed and the coach has no end override: nothing kept.
    expect(p.kept).toEqual([])
  })

  it('a minimum, maximum or briefing edit moves nobody', () => {
    const p = planBlockEdit({ block: block(), body: { max_coaches: 4, briefing: 'x' } })
    expect(p.affected).toEqual([])
    expect(p.followUpdates).toEqual([])
  })
})

describe('blockEditNoticeText', () => {
  it('says when the coaches will be told, or nothing', () => {
    expect(blockEditNoticeText(null)).toBe('')
    expect(blockEditNoticeText({ coaches: 0, when: 'shortly' })).toBe('')
    expect(blockEditNoticeText({ coaches: 1, when: 'shortly' })).toBe('Saved. The coach on this shift will be told in the next few minutes.')
    expect(blockEditNoticeText({ coaches: 2, when: 'morning' })).toBe('Saved. The 2 coaches on this shift will be told after 7am (no notifications overnight).')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
npx vitest run src/lib/block-edit.test.js
```

- [ ] **Step 3: Implement**

```js
// src/lib/block-edit.js
// BLOCKEDIT.1 — what editing ONE shift block means, decided outside the route.
//
// PUT /api/schedule/blocks/[id] edits start/end time, min/max coaches and the
// coach-visible briefing of one shift_blocks row. Everything that DECIDES is
// here and pure; the route only reads, writes, logs and answers.
//
//   - end after start (shift_blocks_time_order, mig 067), max >= min (mig 177)
//   - an admin shift has no minimum (SHIFTTYPE.1: adminMinimumRefusal)
//   - a max below the live coaches already on it is a 409 unless the caller
//     sends allow_below_assigned (the assign route's allow_over_capacity rule)
//   - D3: a coach's override EQUAL to the block's OLD time follows the block
//     (cleared); any other override is a deliberate partial shift and stays
//   - equal values are a no-op: nothing is written, logged or told

import { liveAssignments } from './roster'
import { adminMinimumRefusal } from './shift-template-kind'
import { formatTimeRange12h } from './schedule-overlap'
import { shiftKindOf } from '@shared/shift-kind'
import { normaliseBriefing } from '@shared/shift-briefing'

export const BLOCK_EDIT_FIELDS = ['start_time', 'end_time', 'min_coaches', 'max_coaches', 'briefing']

/** 'HH:MM' or 'HH:MM:SS…' → 'HH:MM:SS'; null for anything else. Postgres `time` renders HH:MM:SS. */
export function toHms(t) {
  if (typeof t !== 'string') return null
  if (/^\d{2}:\d{2}$/.test(t)) return `${t}:00`
  if (/^\d{2}:\d{2}:\d{2}/.test(t)) return t.slice(0, 8)
  return null
}

/** Two { start_time, end_time } windows are the same time. */
export function sameWindow(a, b) {
  return toHms(a?.start_time) === toHms(b?.start_time) && toHms(a?.end_time) === toHms(b?.end_time)
}

function refuse(status, error, message, extra = {}) {
  return { ok: false, status, body: { success: false, error, message, ...extra } }
}

const coaches = (n) => `${n} ${n === 1 ? 'coach is' : 'coaches are'}`

/**
 * @param {object} args
 * @param {object} args.block  shift_blocks row with shift_templates(name, kind)
 *   and shift_assignments(id, profile_id, status, start/end_time_override, profiles(full_name))
 * @param {object} args.body   the validated PUT body
 */
export function planBlockEdit({ block, body = {} }) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
  if (!BLOCK_EDIT_FIELDS.some(has)) return refuse(400, 'nothing_to_change', 'Nothing to change.')

  const refusal = adminMinimumRefusal(shiftKindOf(block), has('min_coaches') ? body.min_coaches : undefined)
  if (refusal) return { ok: false, ...refusal }

  const prior = {
    start: toHms(block.start_time),
    end: toHms(block.end_time),
    min: block.min_coaches,
    max: block.max_coaches,
    briefing: normaliseBriefing(block.briefing),
  }
  const next = {
    start: has('start_time') ? toHms(body.start_time) : prior.start,
    end: has('end_time') ? toHms(body.end_time) : prior.end,
    min: has('min_coaches') ? body.min_coaches : prior.min,
    max: has('max_coaches') ? body.max_coaches : prior.max,
    briefing: has('briefing') ? normaliseBriefing(body.briefing) : prior.briefing,
  }
  if (!next.start || !next.end || next.end <= next.start) {
    return refuse(400, 'end_not_after_start', 'A shift must end after it starts.')
  }
  if (next.min > next.max) {
    return refuse(400, 'min_above_max', `The minimum (${next.min}) cannot be more than the maximum (${next.max}).`)
  }

  const changed = {
    start: next.start !== prior.start,
    end: next.end !== prior.end,
    min: next.min !== prior.min,
    max: next.max !== prior.max,
    briefing: next.briefing !== prior.briefing,
  }
  if (!Object.values(changed).some(Boolean)) return { ok: true, unchanged: true }
  const timesChanged = changed.start || changed.end

  const live = liveAssignments(block.shift_assignments)
  const warnings = []
  if (changed.max && next.max < live.length) {
    if (body.allow_below_assigned !== true) {
      return refuse(409, 'below_assigned',
        `${coaches(live.length)} on this shift, more than a maximum of ${next.max}. Remove someone first, or save anyway.`,
        { assigned: live.length })
    }
    warnings.push(`${coaches(live.length)} on this shift, above its new maximum of ${next.max}. Nobody was removed.`)
  }

  const patch = {}
  if (changed.start) patch.start_time = next.start
  if (changed.end) patch.end_time = next.end
  if (changed.min) patch.min_coaches = next.min
  if (changed.max) patch.max_coaches = next.max
  if (changed.briefing) patch.briefing = next.briefing

  const followUpdates = []
  const affected = []
  const kept = []
  if (timesChanged) {
    for (const a of live) {
      const sOv = toHms(a.start_time_override)
      const eOv = toHms(a.end_time_override)
      // D3 — an override equal to the OLD block time says nothing the block
      // did not; it follows. Judged per field, only where the block moved.
      const sFollows = changed.start && sOv !== null && sOv === prior.start
      const eFollows = changed.end && eOv !== null && eOv === prior.end
      const sKept = sFollows ? null : sOv
      const eKept = eFollows ? null : eOv
      const from = { start_time: sOv ?? prior.start, end_time: eOv ?? prior.end }
      const to = { start_time: sKept ?? next.start, end_time: eKept ?? next.end }
      // What the coach really works if clearing the override fails.
      const toIfStuck = { start_time: sOv ?? next.start, end_time: eOv ?? next.end }
      if (sFollows || eFollows) {
        followUpdates.push({
          assignmentId: a.id,
          coachId: a.profile_id,
          patch: { ...(sFollows ? { start_time_override: null } : {}), ...(eFollows ? { end_time_override: null } : {}) },
          // The RAW stored values, so the guarded UPDATE matches the row as read.
          expect: { ...(sFollows ? { start_time_override: a.start_time_override } : {}), ...(eFollows ? { end_time_override: a.end_time_override } : {}) },
        })
      }
      if (!sameWindow(from, to)) affected.push({ assignmentId: a.id, coachId: a.profile_id, from, to, toIfStuck })
      if ((changed.start && sKept !== null) || (changed.end && eKept !== null)) {
        kept.push({ assignmentId: a.id, coachId: a.profile_id, name: a.profiles?.full_name || 'A coach', window: to })
      }
    }
  }
  for (const k of kept) {
    warnings.push(`${k.name} keeps their own hours (${formatTimeRange12h(k.window.start_time, k.window.end_time)}), which did not move with the shift.`)
  }

  // D4 — the coachless block_edited row. What changed, never the briefing text.
  const blockDetails = { source: 'block_edit' }
  if (timesChanged) {
    blockDetails.from = { start_time: prior.start, end_time: prior.end }
    blockDetails.to = { start_time: next.start, end_time: next.end }
  }
  if (changed.min) blockDetails.min_coaches = { from: prior.min, to: next.min }
  if (changed.max) blockDetails.max_coaches = { from: prior.max, to: next.max }
  if (changed.briefing) {
    blockDetails.briefing = prior.briefing === null ? 'added' : next.briefing === null ? 'removed' : 'changed'
  }

  return { ok: true, unchanged: false, patch, next, changed, followUpdates, affected, kept, warnings, blockDetails }
}

/** The web toast's second half, from the PUT response's `notice`. '' when nobody is told. */
export function blockEditNoticeText(notice) {
  if (!notice || !(notice.coaches > 0)) return ''
  const who = notice.coaches === 1 ? 'The coach on this shift' : `The ${notice.coaches} coaches on this shift`
  return notice.when === 'morning'
    ? `Saved. ${who} will be told after 7am (no notifications overnight).`
    : `Saved. ${who} will be told in the next few minutes.`
}
```

- [ ] **Step 4: Run it, expect PASS.** Also under a second zone (no clock is read, but keep the habit):

```bash
npx vitest run src/lib/block-edit.test.js
TZ=America/Los_Angeles npx vitest run src/lib/block-edit.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/block-edit.js src/lib/block-edit.test.js
git commit -m "BLOCKEDIT.1 — pure edit planner: end after start, max >= min and >= coaches on it, admin has no minimum, an override equal to the old time follows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `roster-change-log.js`: the `block_edited` writer and the details whitelist

**Files:** Modify `src/lib/roster-change-log.js`, `src/lib/roster-change-log.test.js`.

- [ ] **Step 1: Write the failing tests** (append to `src/lib/roster-change-log.test.js`, and add `logBlockEdit`, `BLOCK_EDITED_ACTION` to its import list at lines 7-16)

```js
// BLOCKEDIT.1 — one coachless row per edit of a published block, born stamped.
describe('logBlockEdit', () => {
  it('writes one coachless block_edited row, stamped at insert', async () => {
    const captured = []
    const res = await logBlockEdit(mockDb(captured), {
      isPublished: true, locationId: 'loc-1', blockId: 'b1', blockDate: '2026-09-30', actorId: 'mgr',
      details: { source: 'block_edit', min_coaches: { from: 1, to: 2 } },
    })
    expect(res).toEqual({ logged: true, id: 'log-1' })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      location_id: 'loc-1', block_id: 'b1', block_date: '2026-09-30', actor_id: 'mgr',
      coach_id: null, action: BLOCK_EDITED_ACTION,
      details: { source: 'block_edit', min_coaches: { from: 1, to: 2 } },
    })
    expect(Number.isFinite(Date.parse(captured[0].notified_at))).toBe(true)
  })

  it('a draft block is not logged (drafts ride the first publish)', async () => {
    const captured = []
    expect(await logBlockEdit(mockDb(captured), { isPublished: false, locationId: 'loc-1', blockId: 'b1' }))
      .toEqual({ logged: false, reason: 'not_published' })
    expect(captured).toEqual([])
  })

  it('never throws: a failed insert is logged and reported', async () => {
    const res = await logBlockEdit(mockDb([], { insertResult: { data: null, error: { message: 'boom' } } }), {
      isPublished: true, locationId: 'loc-1', blockId: 'b1',
    })
    expect(res).toEqual({ logged: false, reason: 'error' })
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('shapeRosterChange — BLOCKEDIT.1 details', () => {
  const raw = (details, over = {}) => ({
    id: 'r1', action: 'block_edited', block_id: 'b1', block_date: '2026-09-30', actor_id: 'm', coach_id: null,
    details, notified_at: '2026-09-29T10:00:00Z', created_at: '2026-09-29T10:00:00Z',
    shift_blocks: { start_time: '10:00:00', end_time: '13:00:00', shift_templates: { name: 'Morning' } },
    coach: null, actor: { full_name: 'Manager B' }, ...over,
  })

  it('passes min/max as integer pairs, the briefing change by known value, and never free text', () => {
    const out = shapeRosterChange(raw({
      source: 'block_edit',
      from: { start_time: '09:00:00', end_time: '12:00:00' },
      to: { start_time: '10:00:00', end_time: '13:00:00' },
      min_coaches: { from: 1, to: 2 },
      max_coaches: { from: 3, to: 'lots' },
      briefing: 'added',
      briefing_text: 'Fire drill at 10',
    }))
    expect(out.details).toEqual({
      source: 'block_edit',
      from: { start_time: '09:00:00', end_time: '12:00:00' },
      to: { start_time: '10:00:00', end_time: '13:00:00' },
      min_coaches: { from: 1, to: 2 },
      max_coaches: { from: 3, to: null },
      briefing: 'added',
    })
    expect(JSON.stringify(out)).not.toMatch(/Fire drill/)
  })

  it('drops an unknown briefing value and keeps a known notice', () => {
    expect(shapeRosterChange(raw({ briefing: 'Bring bands' })).details).toEqual({})
    expect(shapeRosterChange(raw({ notice: 'not_needed' })).details).toEqual({ notice: 'not_needed' })
    expect(shapeRosterChange(raw({ notice: 'whatever' })).details).toEqual({})
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
npx vitest run src/lib/roster-change-log.test.js
```

- [ ] **Step 3: Implement.** In `src/lib/roster-change-log.js`:

(a) After `export const ROSTER_CHANGE_ACTIONS = ['assigned', 'unassigned', 'time_changed']` (line 14):

```js
// BLOCKEDIT.1 (mig 629) — one COACHLESS row per edit of a published block
// (times, minimum, maximum, briefing). Not in ROSTER_CHANGE_ACTIONS: that list
// is logRosterChange's, which requires a coach.
export const BLOCK_EDITED_ACTION = 'block_edited'
```

(b) After `logRosterChange` (ends line 53):

```js
/**
 * BLOCKEDIT.1 — record an edit to a PUBLISHED block that has no coach to hang
 * it on (min/max/briefing, and the block's own time change). Best-effort,
 * never throws.
 *
 * Born STAMPED: nobody is messaged about a coachless row, so the re-publish
 * safety net (collectUnnotifiedChanges) must never collect it, and the drawer
 * shows no told state for it (stampMeansTold, roster-change-format.js).
 * `details` must never carry the briefing TEXT, only what kind of change.
 */
export async function logBlockEdit(db, { isPublished, locationId, blockId, blockDate, actorId, details } = {}) {
  try {
    if (!isPublished) return { logged: false, reason: 'not_published' }
    if (!locationId || !blockId) return { logged: false, reason: 'missing' }
    const { data, error } = await db.from('roster_change_log').insert({
      location_id: locationId,
      block_id: blockId,
      block_date: blockDate || null,
      actor_id: actorId || null,
      coach_id: null,
      action: BLOCK_EDITED_ACTION,
      details: details || {},
      notified_at: new Date().toISOString(),
    }).select('id').single()
    if (error) {
      logWarn('roster-change-log', 'block edit insert failed', { err: error.message })
      return { logged: false, reason: 'error' }
    }
    return { logged: true, id: data.id }
  } catch (e) {
    logWarn('roster-change-log', 'block edit insert failed', { err: e?.message })
    return { logged: false, reason: 'error' }
  }
}
```

(c) Beside the other `DETAIL_*` constants (lines 117-125):

```js
// BLOCKEDIT.1 — a block edit's capacity change, as { from, to } integers
// (0..50, the shift_blocks CHECKs). Manager-only facts, and this read is
// manager-only (GET /api/schedule/change-log).
const DETAIL_COUNT_KEYS = ['min_coaches', 'max_coaches']
// The briefing passes as the KIND of change only, never its text.
const DETAIL_BRIEFING_VALUES = ['added', 'changed', 'removed']
// Stamped by the notice arm WITHOUT a message (block-edit-notify.js).
const DETAIL_NOTICES = ['not_needed']

function countOrNull(v) {
  return Number.isInteger(v) && v >= 0 && v <= 50 ? v : null
}
```

(d) In `publicDetails`, before `return out` (line 163):

```js
  for (const k of DETAIL_COUNT_KEYS) {
    if (isPlainObject(details[k])) out[k] = { from: countOrNull(details[k].from), to: countOrNull(details[k].to) }
  }
  if (DETAIL_BRIEFING_VALUES.includes(details.briefing)) out.briefing = details.briefing
  if (DETAIL_NOTICES.includes(details.notice)) out.notice = details.notice
```

- [ ] **Step 4: Run it, expect PASS** (and the pre-existing describes in the file stay green)

```bash
npx vitest run src/lib/roster-change-log.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-change-log.js src/lib/roster-change-log.test.js
git commit -m "BLOCKEDIT.1 — logBlockEdit: one coachless block_edited row per edit, born stamped; details whitelist min/max, briefing change kind, notice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The drawer reads block edits

**Files:** Modify `src/lib/roster-change-format.js`, `src/lib/roster-change-format.test.js`.

- [ ] **Step 1: Write the failing tests** (append to `src/lib/roster-change-format.test.js`; `row()` is the helper at the top of that file)

```js
// BLOCKEDIT.1
describe('rosterChangeSentence — block edits', () => {
  it("a coach moved by a shift edit reads like a template edit, labelled (shift edited)", () => {
    expect(rosterChangeSentence(row({
      action: 'time_changed', start_time: '07:00:00', end_time: '11:00:00',
      details: { source: 'block_edit', from: { start_time: '06:00:00', end_time: '10:00:00' }, to: { start_time: '07:00:00', end_time: '11:00:00' } },
    }))).toBe("Moved Coach A's Tue 15 Sep 6am shift to 7am–11am (shift edited)")
  })

  it('the coachless row lists what changed, naming the shift by its OLD time', () => {
    expect(rosterChangeSentence(row({
      action: 'block_edited', coach_name: null, start_time: '07:00:00',
      details: {
        source: 'block_edit',
        from: { start_time: '06:00:00', end_time: '10:00:00' }, to: { start_time: '07:00:00', end_time: '11:00:00' },
        min_coaches: { from: 1, to: 2 }, max_coaches: { from: 4, to: 3 }, briefing: 'added',
      },
    }))).toBe('Edited the Tue 15 Sep 6am Morning shift: times to 7am–11am, minimum 1 to 2, maximum 4 to 3, briefing added')
  })

  it('says only what it can read', () => {
    expect(rosterChangeSentence(row({ action: 'block_edited', details: { briefing: 'removed' } })))
      .toBe('Edited the Tue 15 Sep 6am Morning shift: briefing removed')
    expect(rosterChangeSentence(row({ action: 'block_edited', details: { min_coaches: { from: null, to: 2 } } })))
      .toBe('Edited the Tue 15 Sep 6am Morning shift')
    expect(rosterChangeSentence(row({ action: 'block_edited', block_date: null, details: {} })))
      .toBe('Edited a shift')
  })
})

describe('stampMeansTold — block edits', () => {
  it('a block_edited row has no told state: nobody is messaged about it', () => {
    const c = row({ action: 'block_edited', coach_name: null })
    expect(stampMeansTold(c)).toBe(false)
    expect(rosterChangeTold(c)).toBeNull()
  })

  it("a row the notice arm stamped without a message (notice: 'not_needed') has no told state", () => {
    const c = row({ action: 'time_changed', details: { source: 'block_edit', notice: 'not_needed' } })
    expect(stampMeansTold(c)).toBe(false)
  })

  it('a delivered block-edit notice is told', () => {
    const c = row({ action: 'time_changed', details: { source: 'block_edit', from: { start_time: '06:00:00', end_time: '10:00:00' }, to: { start_time: '07:00:00', end_time: '11:00:00' } } })
    expect(stampMeansTold(c)).toBe(true)
    expect(rosterChangeTold(c)).toBe('told 14:02')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
npx vitest run src/lib/roster-change-format.test.js
```

- [ ] **Step 3: Implement.** In `src/lib/roster-change-format.js`:

(a) Extend the header list "Every writer that stamps WITHOUT sending the coach a roster message" (lines 40-66) with two entries after item 4:

```js
//   6. BLOCKEDIT.1 (mig 629): action 'block_edited', a coachless row per edit
//      of a published shift, stamped in the INSERT by logBlockEdit. There is
//      no coach, so there is never a told state.
//   7. BLOCKEDIT.1: block-edit-notify.js stamps a 'time_changed' row it
//      decided NOT to send (coach no longer on the shift, shift gone or
//      started, net change nothing) and marks it details.notice =
//      'not_needed'.
```

(b) After `const REASON_NOTE = { … }` (line 38):

```js
const BRIEFING_NOTE = { added: 'briefing added', changed: 'briefing changed', removed: 'briefing removed' }
```

(c) `howNote` (line 126), first line of the body:

```js
  if (details?.source === 'block_edit') return ' (shift edited)'
```

(d) In `rosterChangeSentence`, directly before its last line, `` return `Changed ${coach}'s shift on ${when}` ``:

```js
  if (c.action === 'block_edited') {
    // The block has already moved, so its row start_time is the NEW one.
    // Name the shift by the time it USED to be, as the template edit does.
    const day = dayLabel(c.block_date)
    if (!day) return 'Edited a shift'
    const was = whenLabel(c.block_date, timeLabel(d.from?.start_time) ? d.from.start_time : c.start_time)
    const subject = `the ${was}${c.shift_name ? ` ${c.shift_name}` : ''} shift`
    const parts = []
    const toStart = timeLabel(d.to?.start_time)
    const toEnd = timeLabel(d.to?.end_time)
    if (toStart && toEnd) parts.push(`times to ${toStart}–${toEnd}`)
    for (const [key, word] of [['min_coaches', 'minimum'], ['max_coaches', 'maximum']]) {
      const pair = d[key]
      if (Number.isInteger(pair?.from) && Number.isInteger(pair?.to)) parts.push(`${word} ${pair.from} to ${pair.to}`)
    }
    const briefing = lookup(BRIEFING_NOTE, d.briefing)
    if (briefing) parts.push(briefing)
    return parts.length ? `Edited ${subject}: ${parts.join(', ')}` : `Edited ${subject}`
  }
```

(e) `stampMeansTold` (line 185), after `if (NO_MESSAGE_REASONS.includes(d.reason)) return false`:

```js
  if (c.action === 'block_edited') return false
  if (d.notice === 'not_needed') return false
```

- [ ] **Step 4: Run it, expect PASS, in both zones**

```bash
for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/roster-change-format.test.js; done
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-change-format.js src/lib/roster-change-format.test.js
git commit -m "BLOCKEDIT.1 — the change-log drawer reads shift edits: '(shift edited)', what changed on the shift, no told state for coachless or not-needed rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `src/lib/block-edit-notify.js`, the time-change notice arm

**Files:** Create `src/lib/block-edit-notify.js`, `src/lib/block-edit-notify.test.js`.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/block-edit-notify.test.js
// BLOCKEDIT.1 — telling coaches their published shift moved: once, inside
// quiet hours, from the */5 cron.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./push-dedup', () => ({ notifyUsersOnce: vi.fn() }))
vi.mock('./roster-change-log', () => ({ markChangesNotified: vi.fn(async () => {}) }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { notifyUsersOnce } = await import('./push-dedup')
const { markChangesNotified } = await import('./roster-change-log')
const { planTimeChangeNotices, timeChangeMessage, runShiftTimeChangeNotices } = await import('./block-edit-notify')

// Tue 29 Sep 2026, Dublin summer time (UTC+1).
const IN_BAND = Date.parse('2026-09-29T10:00:00Z')   // 11:00 Dublin
const QUIET = Date.parse('2026-09-29T21:30:00Z')     // 22:30 Dublin
const LOC = { id: 'loc-1', name: 'Studio North', timezone: 'Europe/Dublin' }

const blockEmbed = (over = {}) => ({
  start_time: '10:00:00', end_time: '13:00:00',
  shift_templates: { name: 'Morning' },
  shift_assignments: [{ profile_id: 'u1', status: 'scheduled', start_time_override: null, end_time_override: null }],
  ...over,
})
const row = (id, over = {}) => ({
  id, location_id: 'loc-1', block_id: 'b1', block_date: '2026-09-30', coach_id: 'u1',
  created_at: `2026-09-29T09:0${id.slice(-1)}:00Z`,
  details: { source: 'block_edit', from: { start_time: '09:00:00', end_time: '12:00:00' }, to: { start_time: '10:00:00', end_time: '13:00:00' } },
  shift_blocks: blockEmbed(),
  ...over,
})

describe('timeChangeMessage', () => {
  it('names the shift, the day, the new and the old time', () => {
    expect(timeChangeMessage({
      templateName: 'Morning', blockDate: '2026-09-30',
      from: { start_time: '09:00:00', end_time: '12:00:00' }, to: { start_time: '10:00:00', end_time: '13:00:00' },
    })).toEqual({ title: 'Shift time changed', body: 'Morning on Wed 30 Sep is now 10am–1pm (was 9am–12pm).' })
  })
})

describe('planTimeChangeNotices', () => {
  const opts = { todayStr: '2026-09-29', nowHHMMByLocation: { 'loc-1': '11:00' } }

  it('one message per coach per shift: oldest from, the window NOW, keyed on the newest row', () => {
    const r1 = row('r1', { details: { source: 'block_edit', from: { start_time: '08:00:00', end_time: '11:00:00' }, to: { start_time: '09:00:00', end_time: '12:00:00' } } })
    const r2 = row('r2')
    const { send, silent } = planTimeChangeNotices([r2, r1], opts)
    expect(silent).toEqual([])
    expect(send).toEqual([{
      key: 'shift_time_changed:r2', coachId: 'u1', locationId: 'loc-1', blockDate: '2026-09-30', templateName: 'Morning',
      from: { start_time: '08:00:00', end_time: '11:00:00' }, to: { start_time: '10:00:00', end_time: '13:00:00' },
      rowIds: ['r1', 'r2'],
    }])
  })

  it('edited and put back: no message, every row stamped not_needed', () => {
    const r = row('r1', { shift_blocks: blockEmbed({ start_time: '09:00:00', end_time: '12:00:00' }) })
    const { send, silent } = planTimeChangeNotices([r], opts)
    expect(send).toEqual([])
    expect(silent.map((s) => s.id)).toEqual(['r1'])
  })

  it('the coach is off the shift, or it was deleted: no message', () => {
    const off = row('r1', { shift_blocks: blockEmbed({ shift_assignments: [{ profile_id: 'u1', status: 'cancelled' }] }) })
    const gone = row('r2', { coach_id: 'u2', block_id: null, shift_blocks: null })
    expect(planTimeChangeNotices([off, gone], opts)).toEqual({ send: [], silent: [off, gone] })
  })

  it('a shift that has already started today: no message', () => {
    const today = row('r1', { block_date: '2026-09-29' })
    expect(planTimeChangeNotices([today], opts).send).toEqual([])
    expect(planTimeChangeNotices([today], { ...opts, nowHHMMByLocation: { 'loc-1': '09:59' } }).send).toHaveLength(1)
  })

  it("the coach's own override counts as their window now", () => {
    const r = row('r1', { shift_blocks: blockEmbed({ shift_assignments: [{ profile_id: 'u1', status: 'scheduled', start_time_override: '10:30:00', end_time_override: null }] }) })
    expect(planTimeChangeNotices([r], opts).send[0].to).toEqual({ start_time: '10:30:00', end_time: '13:00:00' })
  })
})

function makeDb({ rows = [], readError = null } = {}) {
  const captured = { reads: [], stamps: [] }
  const db = {
    captured,
    from(table) {
      if (table !== 'roster_change_log') throw new Error(`unexpected table ${table}`)
      return {
        select(cols) {
          const q = { calls: [['select', cols]] }
          for (const m of ['in', 'eq', 'is', 'gte', 'order', 'range']) q[m] = (...a) => { q.calls.push([m, ...a]); return q }
          q.then = (res, rej) => { captured.reads.push(q.calls); return Promise.resolve({ data: readError ? null : rows, error: readError }).then(res, rej) }
          return q
        },
        update(patch) {
          const u = { patch, calls: [] }
          for (const m of ['eq', 'is']) u[m] = (...a) => { u.calls.push([m, ...a]); return u }
          u.select = () => u
          u.then = (res, rej) => { captured.stamps.push(u); return Promise.resolve({ data: [{ id: 'x' }], error: null }).then(res, rej) }
          return u
        },
      }
    },
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  notifyUsersOnce.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0, emailed: 0, deduped: 0 })
})

describe('runShiftTimeChangeNotices', () => {
  it('in quiet hours it reads nothing and says so', async () => {
    const db = makeDb({ rows: [row('r1')] })
    const s = await runShiftTimeChangeNotices(db, { nowMs: QUIET, locations: [LOC] })
    expect(s.time_change_quiet).toBe(1)
    expect(db.captured.reads).toEqual([])
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('reads only unsent block-edit time changes at in-band studios, today onwards, last 48h', async () => {
    const db = makeDb({ rows: [] })
    await runShiftTimeChangeNotices(db, { nowMs: IN_BAND, locations: [LOC, { id: 'loc-x', timezone: 'Pacific/Auckland' }] })
    const calls = db.captured.reads[0]
    expect(calls).toContainEqual(['in', 'location_id', ['loc-1']])
    expect(calls).toContainEqual(['eq', 'action', 'time_changed'])
    expect(calls).toContainEqual(['eq', 'details->>source', 'block_edit'])
    expect(calls).toContainEqual(['is', 'notified_at', null])
    expect(calls).toContainEqual(['gte', 'block_date', '2026-09-29'])
    expect(calls).toContainEqual(['gte', 'created_at', '2026-09-27T10:00:00.000Z'])
  })

  it('sends shift_adjusted once per coach and stamps every row of the group on delivery', async () => {
    const db = makeDb({ rows: [row('r1'), row('r2')] })
    const s = await runShiftTimeChangeNotices(db, { nowMs: IN_BAND, locations: [LOC] })
    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    const [, key, ids, payload] = notifyUsersOnce.mock.calls[0]
    expect(key).toBe('shift_time_changed:r2')
    expect(ids).toEqual(['u1'])
    expect(payload).toMatchObject({
      title: 'Shift time changed', category: 'shift_adjusted',
      data: { type: 'shift_adjusted', block_date: '2026-09-30', location_id: 'loc-1' },
    })
    expect(markChangesNotified).toHaveBeenCalledWith(db, ['r1', 'r2'])
    expect(s.time_change_told).toBe(1)
  })

  it('opted out / deduped / failed: NOT stamped, so the re-publish safety net can still reach them', async () => {
    for (const [result, key] of [
      [{ sent: 0, skipped: 1, failed: 0, emailed: 0, deduped: 0 }, 'time_change_undelivered'],
      [{ sent: 0, skipped: 0, failed: 0, emailed: 0, deduped: 1 }, 'time_change_deduped'],
      [{ sent: 0, skipped: 0, failed: 1, emailed: 0, deduped: 0 }, 'time_change_send_failed'],
    ]) {
      vi.clearAllMocks()
      notifyUsersOnce.mockResolvedValue(result)
      const s = await runShiftTimeChangeNotices(makeDb({ rows: [row('r1')] }), { nowMs: IN_BAND, locations: [LOC] })
      expect(markChangesNotified).not.toHaveBeenCalled()
      expect(s[key]).toBe(1)
    }
  })

  it("a row it will not send is stamped with notice 'not_needed', guarded on still being unstamped", async () => {
    const r = row('r1', { shift_blocks: blockEmbed({ start_time: '09:00:00', end_time: '12:00:00' }) })
    const db = makeDb({ rows: [r] })
    const s = await runShiftTimeChangeNotices(db, { nowMs: IN_BAND, locations: [LOC] })
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    const stamp = db.captured.stamps[0]
    expect(stamp.patch.details).toEqual({ ...r.details, notice: 'not_needed' })
    expect(stamp.calls).toEqual([['eq', 'id', 'r1'], ['is', 'notified_at', null]])
    expect(s.time_change_not_needed).toBe(1)
  })

  it('a failed read is reported, not thrown, and sends nothing', async () => {
    const s = await runShiftTimeChangeNotices(makeDb({ readError: { message: 'column does not exist' } }), { nowMs: IN_BAND, locations: [LOC] })
    expect(s.time_change_read_failed).toBe(1)
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('one coach throwing does not stop the next', async () => {
    notifyUsersOnce.mockRejectedValueOnce(new Error('expo down'))
    const r2 = row('r2', { coach_id: 'u2', shift_blocks: blockEmbed({ shift_assignments: [{ profile_id: 'u2', status: 'scheduled' }] }) })
    const s = await runShiftTimeChangeNotices(makeDb({ rows: [row('r1'), r2] }), { nowMs: IN_BAND, locations: [LOC] })
    expect(notifyUsersOnce).toHaveBeenCalledTimes(2)
    expect(s.time_change_send_failed).toBe(1)
    expect(s.time_change_told).toBe(1)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
npx vitest run src/lib/block-edit-notify.test.js
```

- [ ] **Step 3: Implement**

```js
// src/lib/block-edit-notify.js
// BLOCKEDIT.1 — telling coaches that a PUBLISHED shift's time moved.
//
// THE RULE
//   - PUT /api/schedule/blocks/[id] writes one roster_change_log
//     'time_changed' row per coach whose OWN window moved (details
//     { source: 'block_edit', from, to }) and sends NOTHING itself.
//   - This arm, on every tick of the */5 send-push-reminders cron, tells
//     them. The notice is gated by staff QUIET HOURS (staff-push-hours.js:
//     07:00-22:00 at the studio); the STATE (the block's new time) was saved
//     the moment the manager pressed Save. Quiet hours gate the notice, never
//     the state, and a gate needs a later tick: this is that tick.
//   - ONE message per coach per shift however many edits piled up: the
//     OLDEST unsent row's `from` against the coach's window NOW (read live).
//     Net no change (edited and put back) = no message.
//   - Not sent, stamped with details.notice = 'not_needed' (the drawer then
//     shows no told time): the coach is no longer on the shift, the shift was
//     deleted, the net change is nothing, or it has already started today.
//   - Stamped only on DELIVERY (push or email fallback). Opted out, no
//     device, or a failed send: left UNSTAMPED for the re-publish safety net
//     (renotifyChangedCoaches); the per-row claim key stops this arm
//     re-sending on every tick, and a failed send releases its claim so the
//     next tick retries. Rows older than 48 hours are left to that net.
//
// Category shift_adjusted (NOTIFY.1 D-C): registered, email fallback,
// default-on for every role; the phone deep-links data.type 'shift_adjusted'
// + block_date to that week.

import { notifyUsersOnce } from './push-dedup'
import { markChangesNotified } from './roster-change-log'
import { formatShiftDate } from './roster-change-notify'
import { formatTimeRange12h } from './schedule-overlap'
import { inStaffPushHours, staffWallClockHHMM } from './staff-push-hours'
import { isLiveAssignment } from './roster'
import { toHms, sameWindow } from './block-edit'
import { dublinDayStr } from './dublin-time'
import { logWarn, logError } from './log'

export const TIME_CHANGE_SOURCE = 'block_edit'
export const TIME_CHANGE_WINDOW_MS = 48 * 60 * 60 * 1000
// PostgREST returns at most 1,000 rows per select (CLAUDE.md). A backlog that
// size means something upstream is broken; it is reported, and the rest is
// read on the next tick once these are stamped.
const PAGE = 1000

export function emptyTimeChangeSummary() {
  return {
    time_change_quiet: 0, time_change_rows: 0, time_change_told: 0, time_change_not_needed: 0,
    time_change_deduped: 0, time_change_undelivered: 0, time_change_send_failed: 0,
    time_change_stamp_failed: 0, time_change_read_failed: 0, time_change_read_capped: 0,
  }
}

/** Pure. The push / fallback-email copy. */
export function timeChangeMessage({ templateName, blockDate, from, to }) {
  const name = templateName || 'Your shift'
  return {
    title: 'Shift time changed',
    body: `${name} on ${formatShiftDate(blockDate)} is now ${formatTimeRange12h(to.start_time, to.end_time)} (was ${formatTimeRange12h(from.start_time, from.end_time)}).`,
  }
}

const byAge = (a, b) => (a.created_at === b.created_at
  ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  : (a.created_at < b.created_at ? -1 : 1))

/**
 * Pure. Unsent block-edit rows → what to send and what to stamp silently.
 * @param {Array<object>} rows  roster_change_log rows with the shift_blocks embed
 * @param {{ todayStr: string, nowHHMMByLocation: Record<string,string> }} opts
 */
export function planTimeChangeNotices(rows, { todayStr, nowHHMMByLocation = {} } = {}) {
  const groups = new Map()
  for (const r of rows || []) {
    const key = `${r.coach_id}|${r.block_id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const send = []
  const silent = []
  for (const list of groups.values()) {
    list.sort(byAge)
    const oldest = list[0]
    const newest = list[list.length - 1]
    const block = oldest.shift_blocks
    const mine = (block?.shift_assignments || [])
      .find((a) => a.profile_id === oldest.coach_id && isLiveAssignment(a))
    const from = oldest.details?.from
    if (!oldest.block_id || !block || !mine || !toHms(from?.start_time) || !toHms(from?.end_time)) {
      silent.push(...list)
      continue
    }
    const now = {
      start_time: toHms(mine.start_time_override || block.start_time),
      end_time: toHms(mine.end_time_override || block.end_time),
    }
    const nowHHMM = nowHHMMByLocation[oldest.location_id]
    const started = oldest.block_date === todayStr && Boolean(nowHHMM) && now.start_time.slice(0, 5) <= nowHHMM
    if (sameWindow(from, now) || started || oldest.block_date < todayStr) {
      silent.push(...list)
      continue
    }
    send.push({
      key: `shift_time_changed:${newest.id}`,
      coachId: oldest.coach_id,
      locationId: oldest.location_id,
      blockDate: oldest.block_date,
      templateName: block.shift_templates?.name || null,
      from: { start_time: toHms(from.start_time), end_time: toHms(from.end_time) },
      to: now,
      rowIds: list.map((r) => r.id),
    })
  }
  return { send, silent }
}

/**
 * The cron arm. Never throws for a read or a send; returns counters for the
 * cron's summary (a thrown error is caught by the cron and reported too).
 *
 * @param {object} db  service-role client
 * @param {{ nowMs?: number, locations?: Array<{id: string, timezone?: string|null}> }} opts
 */
export async function runShiftTimeChangeNotices(db, { nowMs = Date.now(), locations = [] } = {}) {
  const summary = emptyTimeChangeSummary()
  const inBand = (locations || []).filter((l) => l?.id && inStaffPushHours(nowMs, l.timezone))
  if (inBand.length === 0) {
    summary.time_change_quiet = 1
    return summary
  }
  const todayStr = dublinDayStr(nowMs)
  const nowHHMMByLocation = Object.fromEntries(inBand.map((l) => [l.id, staffWallClockHHMM(nowMs, l.timezone)]))

  const { data, error } = await db
    .from('roster_change_log')
    // Literal on purpose: check:select-columns only resolves literal selects.
    .select(`
      id, location_id, block_id, block_date, coach_id, details, created_at,
      shift_blocks!block_id (
        start_time, end_time,
        shift_templates ( name ),
        shift_assignments ( profile_id, status, start_time_override, end_time_override )
      )
    `)
    .in('location_id', inBand.map((l) => l.id))
    .eq('action', 'time_changed')
    .eq('details->>source', TIME_CHANGE_SOURCE)
    .is('notified_at', null)
    .gte('block_date', todayStr)
    .gte('created_at', new Date(nowMs - TIME_CHANGE_WINDOW_MS).toISOString())
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(0, PAGE - 1)
  if (error) {
    summary.time_change_read_failed = 1
    logError('block-edit-notify', 'time-change read failed', { err: error.message })
    return summary
  }
  const rows = data || []
  summary.time_change_rows = rows.length
  if (rows.length >= PAGE) {
    summary.time_change_read_capped = 1
    logWarn('block-edit-notify', 'time-change read hit the 1,000-row page; the rest waits for the next tick', {})
  }

  const { send, silent } = planTimeChangeNotices(rows, { todayStr, nowHHMMByLocation })

  const stampedAt = new Date(nowMs).toISOString()
  for (const r of silent) {
    const { data: done, error: stampErr } = await db
      .from('roster_change_log')
      .update({ notified_at: stampedAt, details: { ...(r.details || {}), notice: 'not_needed' } })
      .eq('id', r.id)
      .is('notified_at', null)
      .select('id')
    if (stampErr) {
      summary.time_change_stamp_failed++
      logWarn('block-edit-notify', 'not-needed stamp failed', { rowId: r.id, err: stampErr.message })
    } else if ((done || []).length > 0) {
      summary.time_change_not_needed++
    }
  }

  for (const n of send) {
    try {
      const { title, body } = timeChangeMessage(n)
      const result = await notifyUsersOnce(db, n.key, [n.coachId], {
        title,
        body,
        category: 'shift_adjusted',
        emailSubject: title,
        data: { type: 'shift_adjusted', block_date: n.blockDate, location_id: n.locationId },
      })
      const delivered = (result?.sent || 0) + (result?.emailed || 0) > 0
      if (delivered) {
        summary.time_change_told++
        await markChangesNotified(db, n.rowIds)
      } else if ((result?.deduped || 0) > 0) {
        summary.time_change_deduped++
      } else if ((result?.failed || 0) > 0) {
        summary.time_change_send_failed++
      } else {
        summary.time_change_undelivered++
      }
    } catch (e) {
      summary.time_change_send_failed++
      logWarn('block-edit-notify', 'time-change notice failed for coach', { coachId: n.coachId, err: e?.message })
    }
  }
  return summary
}
```

- [ ] **Step 4: Run it, expect PASS, in both zones**

```bash
for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/block-edit-notify.test.js; done
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/block-edit-notify.js src/lib/block-edit-notify.test.js
git commit -m "BLOCKEDIT.1 — time-change notice arm: one shift_adjusted message per coach per shift, inside quiet hours, stamped on delivery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `PUT /api/schedule/blocks/[id]`

**Files:** Modify `src/app/api/schedule/blocks/[id]/route.js`, `eslint.guardrails.config.mjs`. Create `src/app/api/schedule/blocks/[id]/route.edit.test.js`.

- [ ] **Step 1: Write the failing test**

```js
// src/app/api/schedule/blocks/[id]/route.edit.test.js
// BLOCKEDIT.1 — PUT /api/schedule/blocks/[id]: edit one shift.
// (The DELETE suite lives in route.test.js and is untouched.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: vi.fn((user) => (user.locations || []).map((l) => l.id)),
    assertLocationAccessOr404: real.assertLocationAccessOr404,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/shift-unassign', () => ({ logAndNotifyUnassignments: vi.fn() }))
let logSeq = 0
vi.mock('@/lib/roster-change-log', () => ({
  logRosterChange: vi.fn(async () => ({ logged: true, id: `log-${++logSeq}` })),
  logBlockEdit: vi.fn(async () => ({ logged: true, id: 'blk-log' })),
  markChangesNotified: vi.fn(async () => {}),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { logRosterChange, logBlockEdit, markChangesNotified } = await import('@/lib/roster-change-log')
const { PUT } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const MANAGER = { id: 'mgr-1', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } }
const on = (id, name, over = {}) => ({ id: `a-${id}`, profile_id: id, status: 'scheduled', start_time_override: null, end_time_override: null, profiles: { full_name: name }, ...over })
const BLOCK = {
  id: 'blk-1', location_id: LOC, template_id: 'tpl-1', block_date: '2026-09-30',
  start_time: '09:00:00', end_time: '12:00:00', min_coaches: 1, max_coaches: 3, briefing: null, roster_id: 'r1',
  rosters: { status: 'published' }, locations: { timezone: 'Europe/Dublin' },
  shift_templates: { name: 'Morning', kind: 'class' },
  shift_assignments: [on('u1', 'Coach A')],
}

// A chain whose every filter returns itself and whose await resolves `result`.
function chain(result, calls) {
  const b = {}
  for (const m of ['select', 'eq', 'is', 'in']) b[m] = (...a) => { calls.push([m, ...a]); return b }
  b.maybeSingle = () => Promise.resolve(result)
  b.then = (res, rej) => Promise.resolve(result).then(res, rej)
  return b
}

function makeDb({ block = BLOCK, readError = null, saveResult, followResult } = {}) {
  const captured = { read: [], save: [], savePatch: null, follows: [] }
  return {
    captured,
    from(table) {
      if (table === 'shift_blocks') {
        return {
          select: (cols) => { captured.readSelect = cols; return chain({ data: readError ? null : block, error: readError }, captured.read) },
          update: (patch) => {
            captured.savePatch = patch
            return chain(saveResult ?? { data: [{ id: block.id, ...patch }], error: null }, captured.save)
          },
        }
      }
      if (table === 'shift_assignments') {
        return {
          update: (patch) => {
            const calls = []
            captured.follows.push({ patch, calls })
            return chain(followResult ?? { data: [{ id: 'x' }], error: null }, calls)
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const req = (body) => ({ json: () => Promise.resolve(body), headers: { get: () => '' } })
const params = { params: Promise.resolve({ id: 'blk-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  logSeq = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-29T10:00:00Z')) // 11:00 Dublin, inside the band
  getCurrentUser.mockResolvedValue(MANAGER)
})
afterEach(() => { vi.useRealTimers() })

describe('PUT /api/schedule/blocks/[id] — who may', () => {
  it('403s someone who manages nowhere, before reading anything', async () => {
    getCurrentUser.mockResolvedValue({ id: 's', role: 'staff', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'staff' } })
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ start_time: '10:00' }), params)).status).toBe(403)
    expect(db.captured.readSelect).toBeUndefined()
  })

  it('404s an unknown block and a block at a studio the caller is not at, writing nothing', async () => {
    let db = makeDb({ block: null })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ start_time: '10:00' }), params)).status).toBe(404)
    db = makeDb({ block: { ...BLOCK, location_id: 'b0000000-0000-0000-0000-000000000002' } })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ start_time: '10:00' }), params)).status).toBe(404)
    expect(db.captured.savePatch).toBeNull()
  })

  it("403s a manager elsewhere who is only staff at the block's studio (SCHEDROLES.1)", async () => {
    const LOC_B = 'b0000000-0000-0000-0000-000000000002'
    getCurrentUser.mockResolvedValue({ id: 'h', role: 'manager', profileRole: 'staff', locations: [{ id: LOC }, { id: LOC_B }], rolesByLocation: { [LOC]: 'staff', [LOC_B]: 'manager' } })
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ start_time: '10:00' }), params)).status).toBe(403)
    expect(db.captured.savePatch).toBeNull()
  })

  it('a failed read is a 503 to retry, never a 404', async () => {
    createServerClient.mockReturnValue(makeDb({ readError: { message: 'timeout' } }))
    const res = await PUT(req({ start_time: '10:00' }), params)
    expect(res.status).toBe(503)
  })

  it('reads the kind, the studio clock and the coaches in ONE literal select', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await PUT(req({ start_time: '10:00' }), params)
    expect(db.captured.readSelect).toMatch(/shift_templates \( name, kind \)/)
    expect(db.captured.readSelect).toMatch(/locations:location_id \( timezone \)/)
    expect(db.captured.readSelect).toMatch(/briefing/)
  })
})

describe('PUT /api/schedule/blocks/[id] — refusals come from the planner', () => {
  it('400 end before start, 400 min above max, 400 admin minimum, 409 below the coaches on it', async () => {
    createServerClient.mockReturnValue(makeDb())
    expect((await (await PUT(req({ end_time: '08:00' }), params)).json()).error).toBe('end_not_after_start')
    expect((await (await PUT(req({ min_coaches: 5 }), params)).json()).error).toBe('min_above_max')
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, min_coaches: 0, shift_templates: { name: 'Ops', kind: 'admin' } } }))
    const admin = await PUT(req({ min_coaches: 1 }), params)
    expect(admin.status).toBe(400)
    expect((await admin.json()).error).toBe('admin_has_no_minimum')
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, shift_assignments: [on('u1', 'Coach A'), on('u2', 'Coach B')] } }))
    const below = await PUT(req({ max_coaches: 1, min_coaches: 1 }), params)
    expect(below.status).toBe(409)
    expect((await below.json()).error).toBe('below_assigned')
  })

  it('an unchanged body writes and logs nothing', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const body = await (await PUT(req({ start_time: '09:00', max_coaches: 3 }), params)).json()
    expect(body).toMatchObject({ success: true, unchanged: true })
    expect(db.captured.savePatch).toBeNull()
    expect(logBlockEdit).not.toHaveBeenCalled()
  })
})

describe('PUT /api/schedule/blocks/[id] — the write', () => {
  it('guards the UPDATE on the times and capacity it read, scoped to the studio', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await PUT(req({ start_time: '10:00', end_time: '13:00' }), params)
    expect(db.captured.savePatch).toEqual({ start_time: '10:00:00', end_time: '13:00:00' })
    expect(db.captured.save).toEqual(expect.arrayContaining([
      ['eq', 'id', 'blk-1'], ['eq', 'location_id', LOC],
      ['eq', 'start_time', '09:00:00'], ['eq', 'end_time', '12:00:00'],
      ['eq', 'min_coaches', 1], ['eq', 'max_coaches', 3],
    ]))
  })

  it('a zero-row UPDATE means someone else changed it: 409, nothing logged', async () => {
    createServerClient.mockReturnValue(makeDb({ saveResult: { data: [], error: null } }))
    const res = await PUT(req({ start_time: '10:00' }), params)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('block_changed')
    expect(logBlockEdit).not.toHaveBeenCalled()
    expect(logRosterChange).not.toHaveBeenCalled()
  })

  it('a CHECK refusal is a 400 the editor can show, not a 500', async () => {
    createServerClient.mockReturnValue(makeDb({ saveResult: { data: null, error: { code: '23514', message: 'violates check constraint' } } }))
    expect((await PUT(req({ briefing: 'x' }), params)).status).toBe(400)
  })

  it('clears an override equal to the old block time, guarded on its old value', async () => {
    const db = makeDb({ block: { ...BLOCK, shift_assignments: [on('u1', 'Coach A', { start_time_override: '09:00:00' })] } })
    createServerClient.mockReturnValue(db)
    await PUT(req({ start_time: '10:00' }), params)
    expect(db.captured.follows).toHaveLength(1)
    expect(db.captured.follows[0].patch).toEqual({ start_time_override: null })
    expect(db.captured.follows[0].calls).toEqual(expect.arrayContaining([
      ['eq', 'id', 'a-u1'], ['eq', 'block_id', 'blk-1'], ['eq', 'start_time_override', '09:00:00'],
    ]))
  })

  it("an override that could not follow: saved anyway, the coach is logged at the time they really have, and a warning says so", async () => {
    const db = makeDb({
      block: { ...BLOCK, shift_assignments: [on('u1', 'Coach A', { start_time_override: '09:00:00' })] },
      followResult: { data: [], error: null },
    })
    createServerClient.mockReturnValue(db)
    const body = await (await PUT(req({ start_time: '10:00', end_time: '13:00' }), params)).json()
    expect(body.success).toBe(true)
    expect(body.warning).toMatch(/Coach A/)
    expect(logRosterChange.mock.calls[0][1].details.to).toEqual({ start_time: '09:00:00', end_time: '13:00:00' })
  })
})

describe('PUT /api/schedule/blocks/[id] — change log and notice (published only)', () => {
  it('published: one block_edited row, one time_changed row per moved coach, notice "shortly" in band', async () => {
    createServerClient.mockReturnValue(makeDb())
    const body = await (await PUT(req({ start_time: '10:00', end_time: '13:00', min_coaches: 2 }), params)).json()
    expect(logBlockEdit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      isPublished: true, locationId: LOC, blockId: 'blk-1', blockDate: '2026-09-30', actorId: 'mgr-1',
      details: expect.objectContaining({ source: 'block_edit', min_coaches: { from: 1, to: 2 } }),
    }))
    expect(logRosterChange).toHaveBeenCalledTimes(1)
    expect(logRosterChange.mock.calls[0][1]).toMatchObject({
      isPublished: true, action: 'time_changed', coachId: 'u1', actorId: 'mgr-1', blockId: 'blk-1',
      details: { source: 'block_edit', from: { start_time: '09:00:00', end_time: '12:00:00' }, to: { start_time: '10:00:00', end_time: '13:00:00' } },
    })
    expect(markChangesNotified).not.toHaveBeenCalled()
    expect(body.notice).toEqual({ coaches: 1, when: 'shortly' })
  })

  it('in quiet hours the save still lands; the notice says morning', async () => {
    vi.setSystemTime(new Date('2026-09-29T22:30:00Z')) // 23:30 Dublin
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const body = await (await PUT(req({ start_time: '10:00' }), params)).json()
    expect(db.captured.savePatch).toEqual({ start_time: '10:00:00' })
    expect(body.notice).toEqual({ coaches: 1, when: 'morning' })
  })

  it('a draft block is saved but not logged and nobody is told (drafts ride the first publish)', async () => {
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, rosters: { status: 'draft' } } }))
    const body = await (await PUT(req({ start_time: '10:00' }), params)).json()
    expect(body.success).toBe(true)
    expect(logBlockEdit).not.toHaveBeenCalled()
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(body.notice).toBeUndefined()
  })

  it('a past shift, or the manager moving their own shift: logged, stamped at once, nobody told', async () => {
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, block_date: '2026-09-28' } }))
    let body = await (await PUT(req({ start_time: '10:00' }), params)).json()
    expect(markChangesNotified).toHaveBeenCalledWith(expect.anything(), ['log-1'])
    expect(body.notice).toBeUndefined()

    vi.clearAllMocks()
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, shift_assignments: [on('mgr-1', 'Manager B')] } }))
    body = await (await PUT(req({ start_time: '10:00' }), params)).json()
    expect(markChangesNotified).toHaveBeenCalledTimes(1)
    expect(body.notice).toBeUndefined()
  })

  it('a coach who kept their own hours is not logged and is named in the warning', async () => {
    createServerClient.mockReturnValue(makeDb({ block: { ...BLOCK, shift_assignments: [on('u1', 'Coach A', { start_time_override: '10:30:00' })] } }))
    const body = await (await PUT(req({ start_time: '10:00' }), params)).json()
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(body.kept_overrides).toEqual([{ assignment_id: 'a-u1', profile_id: 'u1' }])
    expect(body.warning).toMatch(/Coach A keeps their own hours/)
  })

  it('a briefing-only edit logs block_edited and tells nobody', async () => {
    createServerClient.mockReturnValue(makeDb())
    const body = await (await PUT(req({ briefing: 'Fire drill at 10' }), params)).json()
    expect(body.data.briefing).toBe('Fire drill at 10')
    expect(logBlockEdit.mock.calls[0][1].details).toEqual({ source: 'block_edit', briefing: 'added' })
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(body.notice).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** (`PUT` is not exported)

```bash
npx vitest run 'src/app/api/schedule/blocks/[id]/route.edit.test.js'
```

- [ ] **Step 3: Implement.** In `src/app/api/schedule/blocks/[id]/route.js`:

(a) Header: change line 1 to `// /api/schedule/blocks/[id] — DELETE, PUT` and append to the header comment (after line 37):

```js
//
// BLOCKEDIT.1 — PUT edits ONE shift: start/end time, min/max coaches and the
// coach-visible briefing (mig 629). The rules are in src/lib/block-edit.js
// (planBlockEdit). Same gate as DELETE: manager AT the block's studio, 404
// outside the caller's studios. On a PUBLISHED roster every edit writes a
// coachless `block_edited` change-log row, and each coach whose own hours moved
// gets a `time_changed` row that the */5 notice arm (src/lib/block-edit-notify.js)
// turns into ONE message inside quiet hours. The route itself sends nothing.
```

(b) Replace the import block (lines 39-45) with:

```js
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { MANAGER_ROLES, timeOfDay } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'
import { isLiveAssignment } from '@/lib/roster'
import { logAndNotifyUnassignments } from '@/lib/shift-unassign'
import { logRosterChange, logBlockEdit, markChangesNotified } from '@/lib/roster-change-log'
import { planBlockEdit, sameWindow } from '@/lib/block-edit'
import { TIME_CHANGE_SOURCE } from '@/lib/block-edit-notify'
import { inStaffPushHours } from '@/lib/staff-push-hours'
import { dublinTodayStr } from '@/lib/dublin-time'
import { BRIEFING_MAX_LENGTH } from '@shared/shift-briefing'
import { logWarn } from '@/lib/log'
```

(c) Append after the DELETE handler (after line 157):

```js
// BLOCKEDIT.1 — every field optional; omitted = unchanged. briefing: null or
// blank clears it. allow_below_assigned is the assign route's
// allow_over_capacity in reverse: a max under the coaches already on it.
const BlockEditSchema = z.object({
  start_time: timeOfDay.optional(),
  end_time: timeOfDay.optional(),
  min_coaches: z.number().int().min(0).max(50).optional(),
  max_coaches: z.number().int().min(1).max(50).optional(),
  briefing: z.string().max(BRIEFING_MAX_LENGTH).nullable().optional(),
  allow_below_assigned: z.boolean().optional(),
})

// Literal on purpose: check:select-columns only resolves literal selects.
// kind — SHIFTTYPE.1 (an admin shift has no minimum); locations.timezone —
// the studio clock the quiet-hours answer is read in.
const BLOCK_EDIT_SELECT = `
  id, location_id, template_id, block_date, start_time, end_time, min_coaches, max_coaches, briefing, roster_id,
  rosters:roster_id ( status ),
  locations:location_id ( timezone ),
  shift_templates ( name, kind ),
  shift_assignments ( id, profile_id, status, start_time_override, end_time_override, profiles:profile_id ( full_name ) )
`

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, BlockEditSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { data: block, error: readErr } = await db
    .from('shift_blocks')
    .select(BLOCK_EDIT_SELECT)
    .eq('id', params.id)
    .maybeSingle()
  if (readErr) {
    // Not a 404: a failed read must not tell the manager the shift is gone.
    logWarn('schedule-blocks', 'block edit: could not read the block', { blockId: params.id, err: readErr })
    return NextResponse.json({ success: false, error: 'Could not read this shift. Try again.', transient: true }, { status: 503 })
  }
  if (!block) {
    return NextResponse.json({ success: false, error: 'Block not found' }, { status: 404 })
  }
  const notHere = assertLocationAccessOr404(user, block.location_id)
  if (notHere) return notHere
  if (!hasRoleAtLocation(user, block.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const plan = planBlockEdit({ block, body: validation.data })
  if (!plan.ok) return NextResponse.json(plan.body, { status: plan.status })
  if (plan.unchanged) {
    return NextResponse.json({ success: true, unchanged: true, data: {
      id: block.id, start_time: block.start_time, end_time: block.end_time,
      min_coaches: block.min_coaches, max_coaches: block.max_coaches, briefing: block.briefing ?? null,
    } })
  }

  // 1. The block, guarded on what was read (D9): a concurrent edit is a 409,
  //    never a silent overwrite. A zero-row UPDATE is not an error in
  //    PostgREST, so the rows are judged.
  const { data: saved, error: saveErr } = await db
    .from('shift_blocks')
    .update(plan.patch)
    .eq('id', block.id)
    .eq('location_id', block.location_id)
    .eq('start_time', block.start_time)
    .eq('end_time', block.end_time)
    .eq('min_coaches', block.min_coaches)
    .eq('max_coaches', block.max_coaches)
    .select('id, start_time, end_time, min_coaches, max_coaches, briefing')
  if (saveErr) {
    if (saveErr.code === '23514') {
      return NextResponse.json({
        success: false, error: 'check_failed',
        message: 'That does not fit the rules for a shift: the end must be after the start, the minimum no more than the maximum, and a briefing at most 500 characters.',
      }, { status: 400 })
    }
    logWarn('schedule-blocks', 'block edit: update failed', { blockId: block.id, err: saveErr })
    return NextResponse.json({ success: false, error: saveErr.message }, { status: 500 })
  }
  if (!saved || saved.length === 0) {
    return NextResponse.json({
      success: false, error: 'block_changed',
      message: 'This shift changed while you were editing it. Close it, open it again and retry.',
    }, { status: 409 })
  }

  // 2. D3 — overrides equal to the OLD block time follow it. Guarded on the
  //    old value. A failure keeps that coach at the old override: the block
  //    edit stands, the coach is logged at the window they really have, and
  //    the manager is told.
  const stuck = new Set()
  for (const f of plan.followUpdates) {
    let q = db.from('shift_assignments').update(f.patch).eq('id', f.assignmentId).eq('block_id', block.id)
    for (const [col, val] of Object.entries(f.expect)) q = q.eq(col, val)
    const { data: moved, error: moveErr } = await q.select('id')
    if (moveErr || !moved || moved.length === 0) {
      stuck.add(f.assignmentId)
      logWarn('schedule-blocks', 'block edit: an override did not follow the shift', {
        blockId: block.id, assignmentId: f.assignmentId, err: moveErr || 'no row matched',
      })
    }
  }
  const warnings = [...plan.warnings]
  const stuckNames = (block.shift_assignments || [])
    .filter((a) => stuck.has(a.id))
    .map((a) => a.profiles?.full_name || 'A coach')
  if (stuckNames.length > 0) {
    warnings.push(`${stuckNames.join(', ')} still ${stuckNames.length === 1 ? 'has' : 'have'} the old hours: their own times could not be moved with the shift. Adjust them in the coach's row.`)
  }
  const affected = plan.affected
    .map((a) => (stuck.has(a.assignmentId) ? { ...a, to: a.toIfStuck } : a))
    .filter((a) => !sameWindow(a.from, a.to))

  // 3. D4/D5 — change log, published only. Best-effort: a lost audit row never
  //    fails a save that already happened.
  let notice = null
  if (block.rosters?.status === 'published') {
    await logBlockEdit(db, {
      isPublished: true, locationId: block.location_id, blockId: block.id,
      blockDate: block.block_date, actorId: user.id, details: plan.blockDetails,
    })
    const logged = []
    for (const a of affected) {
      const r = await logRosterChange(db, {
        isPublished: true,
        locationId: block.location_id,
        action: 'time_changed',
        coachId: a.coachId,
        actorId: user.id,
        blockId: block.id,
        blockDate: block.block_date,
        details: { source: TIME_CHANGE_SOURCE, from: a.from, to: a.to },
      })
      if (r?.logged) logged.push({ id: r.id, coachId: a.coachId })
    }
    // Nobody to tell: a shift already in the past, or the manager moved their
    // own shift. Stamped now so the notice arm and the re-publish safety net
    // leave them alone (stampMeansTold rules 3 and 4).
    const past = block.block_date < dublinTodayStr()
    const silentIds = logged.filter((r) => past || r.coachId === user.id).map((r) => r.id)
    if (silentIds.length > 0) await markChangesNotified(db, silentIds)
    const toTell = logged.length - silentIds.length
    if (toTell > 0) {
      notice = { coaches: toTell, when: inStaffPushHours(Date.now(), block.locations?.timezone) ? 'shortly' : 'morning' }
    }
  }

  return NextResponse.json({
    success: true,
    data: saved[0],
    ...(notice ? { notice } : {}),
    ...(plan.kept.length > 0 ? { kept_overrides: plan.kept.map((k) => ({ assignment_id: k.assignmentId, profile_id: k.coachId })) } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  })
}
```

`isLiveAssignment` stays imported for DELETE (line 105).

(d) `eslint.guardrails.config.mjs`: append two entries to the end of the `no-unchecked-supabase-write` `files` array (the array that contains `'src/app/api/whatsapp/templates/route.js'`):

```js
      // BLOCKEDIT.1 — the shift editor and its notice arm. Every write judges
      // its error (and the block UPDATE its rows) from day one.
      'src/app/api/schedule/blocks/[[]id]/route.js',
      'src/lib/block-edit-notify.js',
```

The `[[]id]` escape is there because ESLint's `files` entries are minimatch globs, and a bare `[id]` is a character class. If the repo's existing bracketed entries (grep `\[\[\]` in that file) use another form, copy that form. Confirm the path matches: `npx eslint -c eslint.guardrails.config.mjs --print-config 'src/app/api/schedule/blocks/[id]/route.js' | grep -c no-unchecked-supabase-write` should print a non-zero count.

- [ ] **Step 4: Run it, expect PASS; the DELETE suite stays green**

```bash
npx vitest run 'src/app/api/schedule/blocks/[id]/'
npm run check:guardrails
npm run check:select-columns
npm run check:route-guards
npm run check:location-scoping
```

Expected:
- `check:guardrails` is clean, and the two armed files have no findings.
- `check:select-columns` resolves `briefing` (mig 629), `kind` (mig 628) and `locations.timezone`.
- `check:route-guards` and `check:location-scoping` are unchanged: the file already has `getCurrentUser(` and `assertLocationAccessOr404(`, and every write is `.eq('location_id')`- or `block_id`-scoped.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/schedule/blocks/[id]/route.js' 'src/app/api/schedule/blocks/[id]/route.edit.test.js' eslint.guardrails.config.mjs
git commit -m "BLOCKEDIT.1 — PUT /api/schedule/blocks/[id]: edit one shift's times, min/max and briefing; guarded write, overrides at the old time follow, change log + time_changed rows on a published roster

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The notice arm rides the */5 push cron

**Files:** Modify `src/app/api/cron/send-push-reminders/route.js`, `src/app/api/cron/send-push-reminders/route.test.js`.

- [ ] **Step 1: Write the failing test.** In `route.test.js`:

(a) After the `vi.mock('@/lib/shift-reminders', …)` line (29):

```js
vi.mock('@/lib/block-edit-notify', () => ({ runShiftTimeChangeNotices: vi.fn() }))
```

(b) After `const { runShiftReminders } = await import('@/lib/shift-reminders')` (line 32):

```js
const { runShiftTimeChangeNotices } = await import('@/lib/block-edit-notify')
```

(c) In `beforeEach`, after the `runShiftReminders.mockResolvedValue(…)`:

```js
  runShiftTimeChangeNotices.mockResolvedValue({ time_change_rows: 1, time_change_told: 1 })
```

(d) Append:

```js
// BLOCKEDIT.1 — the time-change notice arm: the later tick that lets quiet
// hours gate a shift-edit notice without losing it.
describe('GET /api/cron/send-push-reminders — time-change arm', () => {
  it('runs with the tick clock and the location rows, and reports its counters', async () => {
    const before = Date.now()
    const body = await (await GET(req())).json()
    expect(runShiftTimeChangeNotices).toHaveBeenCalledTimes(1)
    const [db, opts] = runShiftTimeChangeNotices.mock.calls[0]
    expect(db).toBe(fakeDb)
    expect(opts.locations).toEqual(LOCATIONS)
    expect(opts.nowMs).toBeGreaterThanOrEqual(before)
    expect(body.time_change_told).toBe(1)
  })

  it('a throwing arm is visible in the response, costs the shift arm nothing, and the heartbeat still stamps', async () => {
    runShiftTimeChangeNotices.mockRejectedValue(new Error('select 400'))
    const body = await (await GET(req())).json()
    expect(body.time_change_arm_failed).toBe(1)
    expect(runShiftReminders).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('send-push-reminders')
    expect(logError).toHaveBeenCalledWith('cron-push-reminders', 'time-change block threw', expect.anything())
  })

  it('a throwing SHIFT arm still lets the time-change arm run', async () => {
    runShiftReminders.mockRejectedValue(new Error('boom'))
    await GET(req())
    expect(runShiftTimeChangeNotices).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
npx vitest run src/app/api/cron/send-push-reminders/route.test.js
```

- [ ] **Step 3: Implement.** In `src/app/api/cron/send-push-reminders/route.js`:

(a) After `import { runShiftReminders } from '@/lib/shift-reminders'` (line 44):

```js
import { runShiftTimeChangeNotices } from '@/lib/block-edit-notify'
```

(b) Directly after the shift arm's `catch { … }` block (ends line 395), before `// quiet_hours alone is not news`:

```js
  // ----------------------- SHIFT TIME CHANGES -----------------------
  // BLOCKEDIT.1 — a manager moved a PUBLISHED shift (PUT /api/schedule/blocks/
  // [id]); each coach whose own hours moved has an unsent roster_change_log
  // row. This arm is the later tick that lets quiet hours gate that notice
  // without losing it: one message per coach per shift, 07:00-22:00 at the
  // studio. The rule lives in src/lib/block-edit-notify.js. Isolated like the
  // arms above: its failure costs nothing else, and is VISIBLE in the response.
  try {
    Object.assign(summary, await runShiftTimeChangeNotices(db, { nowMs, locations: locations || [] }))
  } catch (err) {
    summary.time_change_arm_failed = 1
    logError('cron-push-reminders', 'time-change block threw', { err })
  }
```

The `quiet_hours` exception in the `logInfo` filter below stays as it is. `time_change_quiet` is 1 on every overnight tick too, so add it to that filter:

```js
  if (Object.entries(summary).some(([k, v]) => k !== 'quiet_hours' && k !== 'time_change_quiet' && (Array.isArray(v) ? v.length > 0 : v > 0))) {
```

- [ ] **Step 4: Run it, expect PASS** (the pre-existing shift-arm describes stay green)

```bash
npx vitest run src/app/api/cron/send-push-reminders/route.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/send-push-reminders/route.js src/app/api/cron/send-push-reminders/route.test.js
git commit -m "BLOCKEDIT.1 — the */5 push cron runs the time-change notice arm, isolated and visible on failure

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Coach-facing reads carry the briefing

**Files:** Modify `src/lib/roster-read.js` + test, `src/app/api/schedule/blocks/route.js` + test, `shared/dashboard-data.js` + test (**OTA path**).

- [ ] **Step 1: Write the failing tests**

(a) `src/lib/roster-read.test.js`: add `slimShiftRowForCoach` to the import on line 5, then append:

```js
// BLOCKEDIT.1 — the briefing is a block fact written FOR coaches: the /shifts
// feed carries it, and the coach projection keeps it on every row.
describe('briefing (BLOCKEDIT.1)', () => {
  const assignment = (id, profileId, briefing) => ({
    id, profile_id: profileId, status: 'scheduled', notes: 'mgr note', partial_reason: null,
    start_time_override: null, end_time_override: null, assigned_by: 'mgr', updated_at: 't',
    shift_blocks: {
      location_id: 'loc1', template_id: 't1', block_date: '2026-06-08', start_time: '09:00:00', end_time: '10:00:00',
      notes: 'blk', briefing, roster_id: 'r1', rosters: { status: 'published' },
      shift_templates: { id: 't1', name: 'AM', start_time: '09:00:00', end_time: '10:00:00', role_label: 'Coach' },
    },
    profiles: { id: profileId, full_name: 'Coach A', email: 'a@x.ie', avatar_url: null, role: 'staff' },
  })

  it('asks for shift_blocks.briefing and puts it on the row (null when absent)', async () => {
    const selects = []
    const db = makeDb({ data: [assignment('a1', 'p1', 'Fire drill at 10'), assignment('a2', 'p2', null)], error: null })
    const from = db.from
    db.from = (t) => { const b = from(t); const sel = b.select; b.select = function (c) { selects.push(c); return sel.call(this) }; return b }
    const { rows } = await fetchApiShiftRows(db, { locationIds: ['loc1'] })
    expect(selects[0]).toMatch(/shift_blocks!inner \(\s*location_id, template_id, block_date, start_time, end_time, notes, briefing, roster_id/)
    expect(rows.map((r) => r.briefing)).toEqual(['Fire drill at 10', null])
  })

  it("slimShiftRowForCoach keeps the briefing on the coach's own row AND a colleague's", () => {
    const row = { profile_id: 'p2', notes: 'n', partial_reason: 'x', briefing: 'Fire drill at 10', profiles: { id: 'p2', full_name: 'B', email: 'b@x.ie' } }
    expect(slimShiftRowForCoach(row, 'p2').briefing).toBe('Fire drill at 10')
    const colleague = slimShiftRowForCoach(row, 'someone-else')
    expect(colleague.briefing).toBe('Fire drill at 10')
    expect(colleague.notes).toBeNull()
  })
})
```

(b) `src/app/api/schedule/blocks/route.test.js`: append:

```js
// BLOCKEDIT.1 — the coach allow-list gains the briefing, and only the briefing:
// block notes stay manager-only.
describe('GET /api/schedule/blocks — briefing (BLOCKEDIT.1)', () => {
  const WITH_BRIEFING = { ...PUBLISHED_BLOCK, briefing: 'Fire drill at 10' }

  it("keeps the briefing in a coach's slim shape, and still no notes or capacity", async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' } })
    createServerClient.mockReturnValue(buildDb([WITH_BRIEFING]))
    const body = await (await GET(req())).json()
    expect(body.data[0].briefing).toBe('Fire drill at 10')
    expect('notes' in body.data[0]).toBe(false)
    expect('max_coaches' in body.data[0]).toBe(false)
  })

  it('a block with no briefing reads null for a coach, not undefined', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' } })
    createServerClient.mockReturnValue(buildDb([PUBLISHED_BLOCK]))
    const body = await (await GET(req())).json()
    expect(body.data[0].briefing).toBeNull()
  })

  it('a manager gets it through the unchanged `*`', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' } })
    createServerClient.mockReturnValue(buildDb([WITH_BRIEFING]))
    expect((await (await GET(req())).json()).data[0].briefing).toBe('Fire drill at 10')
  })
})
```

(c) `shared/dashboard-data.test.js`: inside the describe that defines `makePersonalDb` and `block(…)` (lines 377-403), add:

```js
  // BLOCKEDIT.1 — Today (web) and the phone's personal dashboard read the
  // coach's own shifts here; each row carries its shift's briefing.
  it("asks for the block's briefing and carries it on each row", async () => {
    const selects = []
    const base = makePersonalDb({
      shift_assignments: {
        data: [{ id: 'pub', profile_id: 'p1', start_time_override: null, end_time_override: null, status: 'scheduled', shift_blocks: { ...block('published'), briefing: 'Fire drill at 10' } }],
        error: null,
      },
    })
    const db = {
      from(table) {
        const b = base.from(table)
        const sel = b.select
        b.select = function (cols) { selects.push([table, cols]); return sel.call(this) }
        return b
      },
    }
    const res = await fetchPersonalDashboardData(db, 'p1')
    expect(selects.find(([t]) => t === 'shift_assignments')[1]).toMatch(/shift_blocks!inner \( block_date, start_time, end_time, briefing,/)
    expect(res.data.monthShifts[0].briefing).toBe('Fire drill at 10')
  })
```

- [ ] **Step 2: Run them, expect FAIL**

```bash
npx vitest run src/lib/roster-read.test.js src/app/api/schedule/blocks/route.test.js shared/dashboard-data.test.js
```

- [ ] **Step 3: Implement**

(a) `src/lib/roster-read.js`, `API_SHIFT_SELECT` line 103:

```js
    location_id, template_id, block_date, start_time, end_time, notes, briefing, roster_id,
```

and in `toApiShiftRow`, after `notes: a.notes ?? b.notes ?? null,` (line 128):

```js
    // BLOCKEDIT.1 (mig 629) — written FOR the coaches on this shift, so it is
    // on every row and slimShiftRowForCoach keeps it (its spread does).
    briefing: b.briefing ?? null,
```

Add one line to the `slimShiftRowForCoach` doc comment (line 150): `The briefing (BLOCKEDIT.1) is a coach fact and passes on every row.`

(b) `src/app/api/schedule/blocks/route.js`, `slimBlockForCoach`, after `rosters: block.rosters,` (line 139):

```js
    // BLOCKEDIT.1 (mig 629) — the one block text a coach DOES read: written
    // for them. `notes` stays out (a manager's working note).
    briefing: block.briefing ?? null,
```

(c) `shared/dashboard-data.js`, the `fetchDashboardShifts` select (line 103):

```js
      shift_blocks!inner ( block_date, start_time, end_time, briefing, location_id, roster_id, rosters:roster_id ( status ), shift_templates ( name, start_time, end_time ), locations:location_id ( id, name ) )${profileSelect}
```

and after `block_end_time: block.end_time ?? null,` (line 122):

```js
      // BLOCKEDIT.1 (mig 629) — the shift's coach-visible briefing.
      briefing: block.briefing ?? null,
```

This select also runs on the PHONE, straight against Supabase as `authenticated`. That needs the column to exist (mig 629 is applied before merge) and `authenticated` to hold SELECT on it. Pre-check (c) and post-check (i) prove the SELECT grant. The rows are the coach's own published shifts, which `shift_blocks_select` (mig 614) already lets them read.

- [ ] **Step 4: Run them, expect PASS**

```bash
npx vitest run src/lib/roster-read.test.js src/app/api/schedule/blocks/route.test.js shared/dashboard-data.test.js
npm run check:select-columns
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-read.js src/lib/roster-read.test.js src/app/api/schedule/blocks/route.js src/app/api/schedule/blocks/route.test.js shared/dashboard-data.js shared/dashboard-data.test.js
git commit -m "BLOCKEDIT.1 — the /shifts feed, the calendar feed (coach allow-list) and the Today read carry the shift briefing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The calendar card shows that a shift has a briefing

**Files:** Modify `src/lib/roster-card-model.js` + test, `src/components/schedule/ShiftCard.jsx` + test.

- [ ] **Step 1: Write the failing tests**

(a) `src/lib/roster-card-model.test.js`, append:

```js
describe('shiftCardModel — briefing (BLOCKEDIT.1)', () => {
  it('says a shift has a briefing, for a manager and a coach alike, and never copies the text', () => {
    for (const isManager of [true, false]) {
      const m = shiftCardModel(block({ briefing: 'Fire drill at 10' }), [coach('u2', 'Coach A')], null, { isManager })
      expect(m.hasBriefing).toBe(true)
      expect(m.hoverTitle).toMatch(/Has a briefing/)
      expect(JSON.stringify(m)).not.toMatch(/Fire drill/)
    }
  })

  it('no briefing (or a blank one) is no marker', () => {
    expect(shiftCardModel(block(), [], null).hasBriefing).toBe(false)
    expect(shiftCardModel(block({ briefing: '  ' }), [], null).hasBriefing).toBe(false)
  })
})
```

(b) `src/components/schedule/ShiftCard.test.jsx`, append:

```js
describe('ShiftCard — briefing marker (BLOCKEDIT.1)', () => {
  it('shows a Briefing word when the shift has one, and not otherwise', () => {
    const withIt = shiftCardModel({ ...BLOCK, briefing: 'Fire drill at 10' }, [on('u2', 'Coach A')], null, { isManager: false })
    const { unmount } = render(<ShiftCard model={withIt} dayLabel="Monday 21 September" onActivate={() => {}} />)
    expect(screen.getByTestId('shift-briefing').textContent).toBe('Briefing')
    unmount()
    const without = shiftCardModel(BLOCK, [on('u2', 'Coach A')], null, { isManager: false })
    render(<ShiftCard model={without} dayLabel="Monday 21 September" onActivate={() => {}} />)
    expect(screen.queryByTestId('shift-briefing')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them, expect FAIL**

```bash
npx vitest run src/lib/roster-card-model.test.js src/components/schedule/ShiftCard.test.jsx
```

- [ ] **Step 3: Implement**

(a) `src/lib/roster-card-model.js`: add after the `shift-kind` import (line 22):

```js
import { briefingOf } from '../../shared/shift-briefing'
```

In `shiftCardModel`, after `const kindLabel = …` (line 56):

```js
  // BLOCKEDIT.1 — whether the shift carries a coach briefing. The TEXT stays
  // out of the model: the card only says one exists; the dialog shows it.
  const hasBriefing = Boolean(briefingOf(block))
```

In the `hoverTitle` array, after `kindLabel,` (line 100): `hasBriefing ? 'Has a briefing' : null,`. In the returned object, after `kindLabel,` (line 114): `hasBriefing,`.

Update the "COACH BOUNDARY" header (lines 10-14) with one sentence: `The briefing (BLOCKEDIT.1) is written for coaches; the model carries only that one exists.`

(b) `src/components/schedule/ShiftCard.jsx`: after the SHIFTTYPE `model.kindLabel` chip:

```jsx
      {/* BLOCKEDIT.1 — the shift has a note for its coaches; the dialog shows it. */}
      {model.hasBriefing && (
        <div
          data-testid="shift-briefing"
          className="mt-1 inline-flex items-center rounded bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-medium text-blue-700"
        >
          Briefing
        </div>
      )}
```

- [ ] **Step 4: Run them, expect PASS**; `npm run check:guardrails` (chip contrast: `bg-blue-500/10 text-blue-700` is the house recipe).

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-card-model.js src/lib/roster-card-model.test.js src/components/schedule/ShiftCard.jsx src/components/schedule/ShiftCard.test.jsx
git commit -m "BLOCKEDIT.1 — the calendar card says a shift has a briefing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The web editor in the shift dialog

**Files:** Create `src/components/schedule/BlockEditForm.jsx` + test. Modify `src/components/ScheduleCalendar.jsx`. Create `src/components/ScheduleCalendar.block-edit.test.jsx`.

- [ ] **Step 1: Write the failing tests**

(a) `src/components/schedule/BlockEditForm.test.jsx`:

```jsx
// @vitest-environment jsdom
// BLOCKEDIT.1 — the manager's form for one shift. Text, roles and payloads
// only (memory `jsdom-cannot-see-layout`).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import BlockEditForm from './BlockEditForm'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const BLOCK = {
  id: 'b1', start_time: '09:00:00', end_time: '12:00:00', min_coaches: 1, max_coaches: 3, briefing: null,
  shift_templates: { name: 'Morning', kind: 'class' },
}

async function save() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save shift' })) })
}

describe('BlockEditForm', () => {
  it("starts from the shift's own values", () => {
    render(<BlockEditForm block={{ ...BLOCK, briefing: 'Old note' }} onSave={vi.fn()} onDone={vi.fn()} />)
    expect(screen.getByLabelText('Start').value).toBe('09:00')
    expect(screen.getByLabelText('End').value).toBe('12:00')
    expect(screen.getByLabelText('Minimum coaches').value).toBe('1')
    expect(screen.getByLabelText('Maximum coaches').value).toBe('3')
    expect(screen.getByLabelText('Briefing for the coaches').value).toBe('Old note')
    expect(screen.getByText('8/500')).toBeTruthy()
  })

  it('sends only what changed', async () => {
    const onSave = vi.fn(async () => ({ ok: true }))
    const onDone = vi.fn()
    render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '09:30' } })
    fireEvent.change(screen.getByLabelText('Briefing for the coaches'), { target: { value: 'Fire drill at 10' } })
    await save()
    expect(onSave).toHaveBeenCalledWith({ start_time: '09:30', briefing: 'Fire drill at 10' })
    expect(onDone).toHaveBeenCalled()
  })

  it('nothing changed: closes without a request', async () => {
    const onSave = vi.fn()
    const onDone = vi.fn()
    render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={onDone} />)
    await save()
    expect(onSave).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
  })

  it('emptying the briefing clears it (sends null)', async () => {
    const onSave = vi.fn(async () => ({ ok: true }))
    render(<BlockEditForm block={{ ...BLOCK, briefing: 'Old note' }} onSave={onSave} onDone={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Briefing for the coaches'), { target: { value: '   ' } })
    await save()
    expect(onSave).toHaveBeenCalledWith({ briefing: null })
  })

  it('an admin shift has no minimum field to send', () => {
    render(<BlockEditForm block={{ ...BLOCK, min_coaches: 0, shift_templates: { name: 'Ops', kind: 'admin' } }} onSave={vi.fn()} onDone={vi.fn()} />)
    expect(screen.queryByLabelText('Minimum coaches')).toBeNull()
    expect(screen.getByText('Admin shifts have no minimum.')).toBeTruthy()
  })

  it('below the coaches on it: asks, and resends with allow_below_assigned on yes', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const onSave = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'below_assigned', error: '2 coaches are on this shift, more than a maximum of 1.' })
      .mockResolvedValueOnce({ ok: true })
    const onDone = vi.fn()
    render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('Maximum coaches'), { target: { value: '1' } })
    await save()
    expect(onSave).toHaveBeenLastCalledWith({ max_coaches: 1, allow_below_assigned: true })
    expect(onDone).toHaveBeenCalled()
  })

  it('shows the server refusal inline and stays open', async () => {
    const onSave = vi.fn(async () => ({ ok: false, error: 'A shift must end after it starts.' }))
    const onDone = vi.fn()
    render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '08:00' } })
    await save()
    expect(screen.getByRole('alert').textContent).toBe('A shift must end after it starts.')
    expect(onDone).not.toHaveBeenCalled()
  })
})
```

(b) `src/components/ScheduleCalendar.block-edit.test.jsx`, modelled on the `ScheduleCalendar.a11y.test.jsx` harness (lines 14-130 there: the `next/navigation` mock, `vi.setConfig({ testTimeout: 20000 })`, `isoToday`/`isoMonday`, `cardButton`):

```jsx
// @vitest-environment jsdom
// BLOCKEDIT.1 — the shift dialog: everyone reads the briefing; a manager
// edits the shift. Semantics only (memory `jsdom-cannot-see-layout`).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace() {} }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(),
}))

import ScheduleCalendar from '@/components/ScheduleCalendar'

vi.setConfig({ testTimeout: 20000 })

function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const today = iso(new Date())
const monday = (() => { const d = new Date(); const day = d.getDay(); d.setDate(d.getDate() - day + (day === 0 ? -6 : 1)); return iso(d) })()
const BLOCK_DATE = monday > today ? monday : today

const TEMPLATE = { id: 't1', name: 'Morning', start_time: '09:00', end_time: '12:00', color: '#3B82F6', active: true, max_coaches: 3 }
const BLOCK = {
  id: 'b1', location_id: 'loc1', block_date: BLOCK_DATE, template_id: 't1',
  start_time: '09:00', end_time: '12:00', min_coaches: 1, max_coaches: 3,
  briefing: 'Fire drill at 10', rosters: { status: 'published' },
  shift_templates: TEMPLATE,
  shift_assignments: [{ id: 'a1', profile_id: 'u2', status: 'confirmed', start_time_override: null, end_time_override: null, profiles: { full_name: 'Sam Demo' } }],
}
const STAFF = [
  { id: 'u1', full_name: 'Casey Manager', role: 'manager', active: true, profile_locations: [{ location_id: 'loc1' }] },
  { id: 'u2', full_name: 'Sam Demo', role: 'coach', active: true, profile_locations: [{ location_id: 'loc1' }] },
]
const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const COACH = { id: 'u2', role: 'coach', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

function mockFetch() {
  return vi.fn((url, init) => {
    const body = init?.method === 'PUT'
      ? { success: true, data: { id: 'b1' }, notice: { coaches: 1, when: 'shortly' } }
      : url.includes('/api/schedule/blocks') ? { success: true, data: [BLOCK] }
        : url.includes('/api/schedule/templates') ? { success: true, data: [TEMPLATE] }
          : url.includes('/api/staff') ? { success: true, data: STAFF }
            : url.includes('/api/schedule/time-off') ? { success: true, data: [] }
              : url.includes('/holidays') ? { success: true, data: [] }
                : url.includes('contractor-spend') ? { success: true, data: null }
                  // The a11y suite's default (the publish dry run); copy any branch it gained since.
                  : { success: true, impact: { blockCount: 1, periodProjectedEur: 0, monthProjectedTotalEur: 0, monthlyBudgetEur: 0, overBudget: false } }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
  })
}

async function openShift(user) {
  global.fetch = mockFetch()
  await act(async () => { render(<ScheduleCalendar user={user} />) })
  fireEvent.click(screen.getByRole('button', { name: /^Manage .*Morning shift,/ }))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('shift dialog — briefing and edit (BLOCKEDIT.1)', () => {
  it('a coach reads the briefing and gets no edit control', async () => {
    await openShift(COACH)
    expect(screen.getByTestId('block-briefing').textContent).toMatch(/Fire drill at 10/)
    expect(screen.queryByRole('button', { name: 'Edit shift' })).toBeNull()
  })

  it('a manager edits the shift: PUT to the block, only the changed field, then a toast', async () => {
    await openShift(MANAGER)
    fireEvent.click(screen.getByRole('button', { name: 'Edit shift' }))
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '09:30' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save shift' })) })
    const put = global.fetch.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(put[0]).toBe('/api/schedule/blocks/b1')
    expect(JSON.parse(put[1].body)).toEqual({ start_time: '09:30' })
    expect(await screen.findByText('Saved. The coach on this shift will be told in the next few minutes.')).toBeTruthy()
  })

  it('while the form is open a backdrop click does not throw it away', async () => {
    await openShift(MANAGER)
    fireEvent.click(screen.getByRole('button', { name: 'Edit shift' }))
    expect(screen.getByRole('form', { name: 'Edit shift' })).toBeTruthy()
    // Modal's dismissOnBackdrop is false while editing (ROSTER-FIX.6b-7 pattern);
    // Escape still closes, which the a11y suite pins for the dialog.
  })
})
```

- [ ] **Step 2: Run them, expect FAIL**

```bash
npx vitest run src/components/schedule/BlockEditForm.test.jsx src/components/ScheduleCalendar.block-edit.test.jsx
```

- [ ] **Step 3: Implement**

(a) `src/components/schedule/BlockEditForm.jsx`:

```jsx
'use client'
// BLOCKEDIT.1 — the manager's editor for ONE shift inside BlockDetailModal:
// start/end, min/max coaches, and the briefing its coaches read.
//
// Sends ONLY the fields the manager changed (D9: a field nobody touched is
// never overwritten from a stale form). The server owns every rule
// (src/lib/block-edit.js); this form shows its refusal inline. A max below the
// coaches already on the shift is a 409 the manager may override, the same
// "are you sure" the assign flow gives for a full shift.

import { useState } from 'react'
import { BRIEFING_MAX_LENGTH } from '@shared/shift-briefing'
import { isAdminShift } from '@shared/shift-kind'

const hhmm = (t) => String(t || '').slice(0, 5)
const inputCls = 'mt-1 w-full rounded-md border border-un1t-border bg-un1t-surface px-2 py-1.5 text-sm text-un1t-text'
const labelCls = 'block text-[11px] font-semibold uppercase tracking-wider text-un1t-subtle'

export default function BlockEditForm({ block, onSave, onDone }) {
  const admin = isAdminShift(block)
  const initial = {
    start: hhmm(block.start_time),
    end: hhmm(block.end_time),
    min: String(block.min_coaches ?? 0),
    max: String(block.max_coaches ?? 1),
    briefing: block.briefing || '',
  }
  const [start, setStart] = useState(initial.start)
  const [end, setEnd] = useState(initial.end)
  const [min, setMin] = useState(initial.min)
  const [max, setMax] = useState(initial.max)
  const [briefing, setBriefing] = useState(initial.briefing)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function changedFields() {
    const out = {}
    if (start !== initial.start) out.start_time = start
    if (end !== initial.end) out.end_time = end
    if (!admin && min !== initial.min) out.min_coaches = Number(min)
    if (max !== initial.max) out.max_coaches = Number(max)
    if (briefing.trim() !== initial.briefing.trim()) out.briefing = briefing.trim() === '' ? null : briefing
    return out
  }

  async function send(payload) {
    setSaving(true)
    setError(null)
    const result = await onSave(payload)
    setSaving(false)
    if (result?.ok) { onDone(); return }
    if (result?.code === 'below_assigned' && !payload.allow_below_assigned) {
      if (confirm(`${result.error}\n\nSave anyway? Nobody is removed from the shift.`)) {
        await send({ ...payload, allow_below_assigned: true })
      }
      return
    }
    setError(result?.error || 'Could not save this shift')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const payload = changedFields()
    if (Object.keys(payload).length === 0) { onDone(); return }
    await send(payload)
  }

  return (
    <form aria-label="Edit shift" onSubmit={handleSubmit} className="mb-4 space-y-3 rounded-md border border-un1t-border bg-un1t-bg/40 p-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls} htmlFor="block-edit-start">Start</label>
          <input id="block-edit-start" type="time" required value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="block-edit-end">End</label>
          <input id="block-edit-end" type="time" required value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {admin ? (
          <p className="self-end text-xs text-un1t-subtle">Admin shifts have no minimum.</p>
        ) : (
          <div>
            <label className={labelCls} htmlFor="block-edit-min">Minimum coaches</label>
            <input id="block-edit-min" type="number" min={0} max={50} value={min} onChange={(e) => setMin(e.target.value)} className={inputCls} />
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="block-edit-max">Maximum coaches</label>
          <input id="block-edit-max" type="number" min={1} max={50} value={max} onChange={(e) => setMax(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div>
        <label className={labelCls} htmlFor="block-edit-briefing">Briefing for the coaches</label>
        <textarea
          id="block-edit-briefing"
          rows={3}
          maxLength={BRIEFING_MAX_LENGTH}
          value={briefing}
          onChange={(e) => setBriefing(e.target.value)}
          className={inputCls}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-un1t-subtle">
        <span>Every coach on this shift can read this.</span>
        <span>{briefing.length}/{BRIEFING_MAX_LENGTH}</span>
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} disabled={saving} className="text-xs px-3 py-2 rounded-md border border-un1t-border text-un1t-text hover:bg-un1t-bg disabled:opacity-50">
          Cancel
        </button>
        <button type="submit" disabled={saving} className="text-xs px-3 py-2 rounded-md bg-blue-500/20 text-blue-700 border border-blue-500/40 hover:bg-blue-500/30 font-medium disabled:opacity-50">
          {saving ? 'Saving…' : 'Save shift'}
        </button>
      </div>
    </form>
  )
}
```

(b) `src/components/ScheduleCalendar.jsx`:

- Import, after `import ShiftCard from './schedule/ShiftCard'` (line 83):

```js
import BlockEditForm from './schedule/BlockEditForm'
import { blockEditNoticeText } from '@/lib/block-edit'
import { briefingOf } from '@shared/shift-briefing'
```

- After `handlePartialSave` (starts line 636, ends line 666):

```js
  // BLOCKEDIT.1 — one shift's times, min/max and briefing. Returns
  // { ok } | { ok: false, error, code } for BlockEditForm to show inline;
  // a saved edit refreshes the calendar and says who will be told, and when.
  async function handleBlockEdit(blockId, payload) {
    let res
    let data
    try {
      res = await fetch(`/api/schedule/blocks/${blockId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      data = await res.json().catch(() => ({}))
    } catch {
      return { ok: false, error: 'Network error, please try again' }
    }
    if (res.ok && data.success) {
      await refreshAfterMutation()
      const told = blockEditNoticeText(data.notice)
      if (data.warning) showToast([data.warning, told].filter(Boolean).join(' '), 'warning')
      else showToast(told || 'Shift saved.', 'success')
      return { ok: true }
    }
    return { ok: false, error: data.message || data.error || 'Could not save this shift', code: data.error }
  }
```

- The `<BlockDetailModal … />` render (line 1438): add the prop `onEditBlock={handleBlockEdit}`.

- `BlockDetailModal` (line 2409): add `onEditBlock` to the destructured props. After `const anyRowEditing = editingRowIds.size > 0` (line 2428) add:

```js
  // BLOCKEDIT.1 — the shift editor is a half-filled form too.
  const [editingBlock, setEditingBlock] = useState(false)
  const briefing = briefingOf(block)
```

and change the Modal's `dismissOnBackdrop={!anyRowEditing}` to `dismissOnBackdrop={!anyRowEditing && !editingBlock}`.

- Between the sub-header `</div>` and `{/* Assigned coaches */}`:

```jsx
        {/* BLOCKEDIT.1 — the briefing, for everyone who can open this shift
            (a coach reaches this dialog for their own shift). */}
        {isManager && editingBlock ? (
          <BlockEditForm block={block} onSave={(payload) => onEditBlock(block.id, payload)} onDone={() => setEditingBlock(false)} />
        ) : briefing ? (
          <div data-testid="block-briefing" className="mb-4 rounded-md border border-un1t-border bg-un1t-bg/40 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-un1t-subtle">Briefing</div>
            <p className="mt-1 whitespace-pre-line text-sm text-un1t-text">{briefing}</p>
          </div>
        ) : null}
```

- In the action footer, in front of the `isManager &&` Delete button, and inside the same right-hand group:

```jsx
          {isManager && !editingBlock && (
            <button
              type="button"
              onClick={() => setEditingBlock(true)}
              className="text-xs bg-un1t-surface text-un1t-text border border-un1t-border hover:bg-un1t-bg px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5"
            >
              <Pencil size={12} aria-hidden="true" /> Edit shift
            </button>
          )}
```

Wrap the Edit and Delete buttons in `<div className="flex items-center gap-2">…</div>`, so that `justify-between` keeps "Add coach" on the left. `Pencil` is already imported (line 26).

- [ ] **Step 4: Run them, expect PASS, together with the existing whole-calendar suites**

```bash
npx vitest run src/components/schedule/BlockEditForm.test.jsx src/components/ScheduleCalendar.block-edit.test.jsx src/components/ScheduleCalendar.a11y.test.jsx src/components/ScheduleCalendar.visibility.test.jsx
npm run check:guardrails
```

`check:guardrails` checks that every in-form button has a `type`, and that no dead `un1t-*` token or low-contrast chip is used.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/BlockEditForm.jsx src/components/schedule/BlockEditForm.test.jsx src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.block-edit.test.jsx
git commit -m "BLOCKEDIT.1 — the shift dialog shows the briefing to everyone and gives a manager an Edit shift form

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Today (web) prints the briefing on the coach's own shift

**Files:** Modify `src/components/dashboard/MonthRoster.jsx`. Create `src/components/dashboard/MonthRoster.briefing.test.jsx`.

- [ ] **Step 1: Write the failing test**

```jsx
// @vitest-environment jsdom
// BLOCKEDIT.1 — Today's week list prints each future shift's briefing.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import MonthRoster from './MonthRoster'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
afterEach(() => cleanup())

const shift = (date, briefing) => ({
  id: `s-${date}`, status: 'scheduled', shift_date: date, location_id: 'loc-1',
  start_time_override: null, end_time_override: null, block_start_time: '09:00:00', block_end_time: '12:00:00',
  shift_templates: { name: 'Morning', start_time: '09:00:00', end_time: '12:00:00' }, briefing,
})

function renderWeek(startIso, shifts) {
  render(<MonthRoster weeks={[]} monthLabel="" monthSummary="" weekPanels={[{ title: 'This week', startIso, endIso: startIso, shifts }]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Week' }))
}

describe('MonthRoster — briefing (BLOCKEDIT.1)', () => {
  it('prints a future shift\'s briefing under its time', () => {
    renderWeek('2099-06-08', [shift('2099-06-10', 'Fire drill at 10')])
    expect(screen.getByTestId('shift-briefing-line').textContent).toMatch(/Fire drill at 10/)
  })

  it('prints nothing for a shift with none, or a past one', () => {
    renderWeek('2099-06-08', [shift('2099-06-10', null)])
    expect(screen.queryByTestId('shift-briefing-line')).toBeNull()
    cleanup()
    renderWeek('2000-01-03', [shift('2000-01-05', 'Old news')])
    expect(screen.queryByTestId('shift-briefing-line')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
npx vitest run src/components/dashboard/MonthRoster.briefing.test.jsx
```

- [ ] **Step 3: Implement.** In `src/components/dashboard/MonthRoster.jsx`:
- Import `import { briefingOf } from '@shared/shift-briefing'` after the `pickLocationColor` import.
- In `WeekPanel`, directly after the `<div className={\`text-xs flex items-center gap-1.5 flex-wrap …\`}>…</div>` time line (the one that renders `{shiftTime(s)} · {roundHours(shiftHours(s))}h`), still inside the per-shift `<div key={s.id}>`:

```jsx
                      {/* BLOCKEDIT.1 — the manager's note for the coaches on this shift. */}
                      {!day.isPast && briefingOf(s) && (
                        <p data-testid="shift-briefing-line" className="mt-0.5 text-xs text-un1t-text whitespace-pre-line">
                          <span className="font-semibold">Briefing: </span>{briefingOf(s)}
                        </p>
                      )}
```

- [ ] **Step 4: Run it, expect PASS** (together with `MonthRoster.adjust.test.jsx`)

```bash
npx vitest run src/components/dashboard/
```

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/MonthRoster.jsx src/components/dashboard/MonthRoster.briefing.test.jsx
git commit -m "BLOCKEDIT.1 — Today's week list prints the briefing on a coach's own future shift

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The phone shows the briefing (display only; OTA paths)

**Files:** Modify `mobile/app/(staff)/(tabs)/schedule.jsx`, `mobile/components/schedule/BlockCard.jsx`.

There is no RN component test runner (memory `phone-mail-reader`: decisions go in `mobile/lib/` or `shared/`). The decision here is `briefingOf`, which Task 2 pins, so this task is pure rendering, verified by `check:mobile-imports` and `check:mobile-lint`.

- [ ] **Step 1: `mobile/app/(staff)/(tabs)/schedule.jsx`**

After `import { timeOffLeaveLabel } from 'shared/time-off'` (line 44):

```js
import { briefingOf } from 'shared/shift-briefing'
```

In `ShiftRow` (the Me list's card, line 249), after the `{shift.notes && (…)}` block (lines 307-309):

```jsx
      {/* BLOCKEDIT.1 — the manager's note for the coaches on this shift
          (GET /api/schedule/shifts carries it on every row). */}
      {briefingOf(shift) ? (
        <View className="flex-row items-start mt-1.5">
          <Ionicons name="document-text-outline" size={13} color="#64748B" />
          <Text className="text-xs text-un1t-text ml-1 flex-1">{briefingOf(shift)}</Text>
        </View>
      ) : null}
```

This uses a ternary, never `&&`: a non-null empty string rendered bare outside `<Text>` crashes React Native, and `briefingOf` guarantees null or a non-empty string anyway.

- [ ] **Step 2: `mobile/components/schedule/BlockCard.jsx`** (Manage mode, manager)

Import after line 7 (the `schedule-manage` import, which now also brings `emptyBlockText`):

```js
import { briefingOf } from 'shared/shift-briefing'
```

In the component, after `const fill = …` (line 19): `const briefing = briefingOf(block)`. After the time row's closing `</View>` (line 33, directly before `{coaches.length === 0 ? (`):

```jsx
      {/* BLOCKEDIT.1 — the shift's briefing, as its coaches read it. Edited on the web. */}
      {briefing ? (
        <View className="flex-row items-start mb-2">
          <Ionicons name="document-text-outline" size={13} color="#64748B" />
          <Text className="text-[12px] text-un1t-text ml-1 flex-1" numberOfLines={3}>{briefing}</Text>
        </View>
      ) : null}
```

- [ ] **Step 3: Verify**

```bash
npm run check:mobile-imports && npm run check:mobile-lint && npm run check:ota-paths
```

Expected: all clean. `briefingOf` is a real export of `shared/shift-briefing.js`, and no new top-level `mobile/` entry was added.

- [ ] **Step 4: Commit**

```bash
git add 'mobile/app/(staff)/(tabs)/schedule.jsx' mobile/components/schedule/BlockCard.jsx
git commit -m "BLOCKEDIT.1 — phone: the Me list and the Manage card show a shift's briefing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: OpenAPI and the roster doc

**Files:** Modify `src/lib/openapi.js`, `src/lib/openapi.test.js`, `docs/roster-v2.md`.

- [ ] **Step 1: Failing test** (append inside the `describe('getOpenApiSpec', …)` in `src/lib/openapi.test.js`)

```js
  it('documents PUT /api/schedule/blocks/{id} (BLOCKEDIT.1), its 400/409 codes and the briefing', () => {
    const op = spec.paths['/api/schedule/blocks/{id}'].put
    expect(op.tags).toContain('Schedule')
    expect(op.security).toContainEqual({ CookieAuth: [] })
    for (const code of ['200', '400', '403', '404', '409', '503']) expect(op.responses).toHaveProperty(code)
    expect(op.description).toMatch(/briefing/)
    expect(op.description).toMatch(/quiet hours/)
    // The DELETE on the same path is still there.
    expect(spec.paths['/api/schedule/blocks/{id}'].delete).toBeTruthy()
  })
```

- [ ] **Step 2: Implement.** In `src/lib/openapi.js`, after the DELETE `registerPath` for `/api/schedule/blocks/{id}` (starts line 4411, ends line 4425):

```js
registry.registerPath({
  method: 'put',
  path: '/api/schedule/blocks/{id}',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Edit one shift: times, minimum and maximum coaches, and the coach briefing (manager-only)',
  description: "BLOCKEDIT.1. Every field optional; omitted = unchanged; briefing null or blank clears it (at most 500 characters; mig 629). Refuses: end not after start (400 end_not_after_start), minimum above maximum (400 min_above_max), a minimum on an admin shift (400 admin_has_no_minimum), a maximum below the live coaches already on it (409 below_assigned, unless allow_below_assigned: true, which saves with a warning), and a shift changed by someone else since it was read (409 block_changed). A coach's own start/end override equal to the shift's OLD time moves with it; any other override stays and is listed in kept_overrides with a warning. On a PUBLISHED roster the edit writes a change-log row, and each coach whose own hours moved gets a time_changed row; the */5 push cron tells them once, only inside staff quiet hours (07:00-22:00 at the studio). `notice.when` is 'shortly' or 'morning'. Nothing is logged or sent for a draft. Manager role AT the shift's studio; a shift outside the caller's studios is a 404.",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      min_coaches: z.number().int().optional(),
      max_coaches: z.number().int().optional(),
      briefing: z.string().nullable().optional(),
      allow_below_assigned: z.boolean().optional(),
    }) } } },
  },
  responses: {
    200: { description: 'Saved (or `unchanged: true`); `notice`, `kept_overrides` and `warning` when they apply' },
    400: { description: 'Validation error or a rule above', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: "Forbidden — needs a manager role at the shift's studio", content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Shift not found', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'below_assigned, or block_changed', content: { 'application/json': { schema: ErrorResponse } } },
    503: { description: 'The shift could not be read; retry', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 3: `docs/roster-v2.md`**, append after the "Shift kinds" section:

```md
## Editing one shift and the briefing (BLOCKEDIT.1, mig 629, 2026-09)

- `PUT /api/schedule/blocks/[id]` edits one shift's start/end, min/max coaches and **briefing**. Rules: `src/lib/block-edit.js` (`planBlockEdit`). Manager at the shift's studio; 404 outside the caller's studios.
- **Overrides:** a coach's override equal to the shift's OLD time moves with it (cleared); any other override is a deliberate partial shift and stays (the response names who kept their hours).
- **Change log (published only):** one coachless `block_edited` row per edit (born stamped: nobody is messaged about it; `details` never holds the briefing text), and one `time_changed` row, `details.source = 'block_edit'`, per coach whose own hours moved.
- **Notice:** the route sends nothing. `runShiftTimeChangeNotices` (`src/lib/block-edit-notify.js`) on the */5 `send-push-reminders` cron tells each coach once, inside staff quiet hours, stamped on delivery. Not needed (off the shift, put back, started) = stamped with `details.notice = 'not_needed'`.
- **Briefing:** `shift_blocks.briefing`, ≤ 500 characters, never blank (DB CHECK). Written by managers for the coaches on that shift. Separate from `notes` (manager-only). Read on the web shift dialog, the calendar card ("Briefing"), Today's week list, the phone Me list and the Manage card. Not copied by copy week/month.
```

- [ ] **Step 4: Run, expect PASS**

```bash
npx vitest run src/lib/openapi.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js docs/roster-v2.md
git commit -m "BLOCKEDIT.1 — OpenAPI for PUT /api/schedule/blocks/{id}; roster doc

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine).

- [ ] **Focused tests, both zones for the date/time code:**

```bash
npx vitest run tests/migration-629-shift-block-briefing.test.js shared/shift-briefing.test.js \
  src/lib/block-edit.test.js src/lib/block-edit-notify.test.js src/lib/roster-change-log.test.js \
  src/lib/roster-change-format.test.js 'src/app/api/schedule/blocks/' src/app/api/cron/send-push-reminders/route.test.js \
  src/lib/roster-read.test.js shared/dashboard-data.test.js src/lib/roster-card-model.test.js \
  src/components/schedule/ src/components/ScheduleCalendar.block-edit.test.jsx src/components/dashboard/ src/lib/openapi.test.js
for tz in Europe/Dublin America/Los_Angeles; do
  TZ=$tz npx vitest run src/lib/block-edit-notify.test.js src/lib/roster-change-format.test.js 'src/app/api/schedule/blocks/[id]/route.edit.test.js'
done
```

- [ ] **The 12-command CI mirror (CLAUDE.md "Build, test & ship"):**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0, and vitest reports `0 failed`.
- `check:select-columns` resolves `shift_blocks.briefing` (mig 629) in `roster-read.js`, `blocks/[id]/route.js` and `block-edit-notify.js`. It also resolves `details` as the root of `details->>source`, and `locations.timezone`. `shared/dashboard-data.js` is outside its scan, and Task 9's test pins that select instead.
- `check:guardrails` is clean, with the two newly armed files at zero findings.
- `check:mobile-parity` is untouched (no permission key; category `shift_adjusted` is already registered).
- `check:ota-paths` is clean.
- `check:rls-restrictive` is untouched (no policy in 629).

- [ ] **The build:**

```bash
npm run build
```

Expected: `✓ Compiled successfully`. This is the only check that catches a bad `@shared/shift-briefing`, `@/lib/block-edit` or `@/lib/block-edit-notify` import.

- [ ] **Independent review** (standing rule). Point the reviewer at:
  - D3 (overrides follow only at the old time), D5 (the cron is the only sender), D4 (the born-stamped `block_edited` row), and the migration's self-check.
  - `planTimeChangeNotices`'s silent cases, against `stampMeansTold`.
  - The dialog and editor in a browser at 390px and at the 980px week floor, and the phone Me list with a long briefing (memory `jsdom-cannot-see-layout`). Use a Vercel preview **after** 629 is applied. 🔴 A preview writes to the prod DB, so edit only a test shift on a DRAFT week, and say so first.

---

### Migration apply steps (after review is approved, BEFORE merge)

The operator is the orchestrating session, acting under Richard's 25 Sep merge authority.

1. `list_projects` → confirm `iyvtbjjxdggiadzwwvdj` is **un1t-crm**, not the sentinel project. `list_migrations` → confirm that 628 is there and 629 is not.
2. Run pre-checks **(a)–(d)** from the migration header with `execute_sql`. Stop if any answer differs from "Expected". In particular (b) must name `roster_change_log_action_check`.
3. Write the rollback record to the scratchpad (`<scratchpad>/mig-629-rollback.md`): the outputs of (c) and (d), plus the ROLLBACK block from the header, noting "revert code first; save any briefings before dropping the column".
4. `apply_migration` with name `629_shift_block_briefing` and the file's contents verbatim.
5. Run post-checks **(f)–(j)**, then `get_advisors` type `security`, then type `performance`. Expected: nothing new.
6. Only now: rebase the branch, wait for **Test & lint** and **Next build** to go green on the final rebase, and merge.
7. After merge, watch the EAS Update run (`eas-update.yml`). One phone update at a time: do not merge the next OTA PR (22 ICSFEED.1 is the batch-4 partner) until this run is green. Then on prod, open a published week as a manager, confirm the dialog shows **Edit shift**, and confirm that a coach's view shows no edit control. Do NOT edit a live published shift to test the notice. The first real notice is Richard's, or it happens on a shift he names.

### PR

**Title:** `BLOCKEDIT.1 — edit one shift (times, minimum, maximum) with a change-log row and a coach notice, and a coach-visible briefing (mig 629)`

**Body must say, in this order:**
1. **Depends on SHIFTTYPE.1 (#13, mig 628).** It reads `shift_templates.kind` and uses `adminMinimumRefusal`.
2. **Migration 629 is applied BEFORE merge** (steps above). The code names `shift_blocks.briefing` in selects, including one the phone runs directly, and without the column they return 400. The Vercel preview is broken until 629 is applied.
3. **🔴 This merge publishes an OTA at 100%.** `shared/shift-briefing.js`, `shared/dashboard-data.js`, `mobile/app/(staff)/(tabs)/schedule.jsx` and `mobile/components/schedule/BlockCard.jsx` are bundle paths. The phone change is display only: a briefing line on the Me list and on the Manage card.
4. The endpoint and its refusals (D1, D2). Mirroring assign: a max below the coaches on the shift is a 409 unless the manager confirms.
5. D3: overrides follow only when they equal the old block time. Anyone who kept their hours is named.
6. D4 and D5: the change log (per coach `time_changed`, coachless born-stamped `block_edited`, never the briefing text). **Notices go out from the */5 cron inside quiet hours: the state is saved at once, the notice is gated.** One message per coach per shift.
7. D6 and D7: the briefing is coach-visible and manager-written (DB CHECK, browser UPDATE policy is manager-only), and it is not copied by copy week/month.
8. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit another row: `merge=union` duplicates an edited row.

```
| #<PR> | BLOCKEDIT.1 — edit one shift (times, minimum, maximum) with a change-log row and a coach notice, and a coach-visible briefing | 2026-09-2x. **Mig 629 (applied before merge) + OTA.** `PUT /api/schedule/blocks/[id]` (manager AT the shift's studio, 404 outside): end after start, max ≥ min, admin has no minimum (SHIFTTYPE's `adminMinimumRefusal`), max below the live coaches = 409 `below_assigned` unless `allow_below_assigned` (assign's capacity rule in reverse); UPDATE guarded on the times/capacity read (409 `block_changed`). A coach override equal to the OLD time follows the shift; others stay and are named. Published only: coachless `block_edited` row (mig 629 widens the action CHECK; born stamped; details never hold the briefing text) + one `time_changed` row (`source: 'block_edit'`) per coach whose own hours moved. The route sends nothing: `runShiftTimeChangeNotices` on the */5 `send-push-reminders` cron sends one `shift_adjusted` message per coach per shift inside quiet hours, stamped on delivery; put back / off the shift / started = stamped `notice: 'not_needed'`. `shift_blocks.briefing` (≤500, never blank, DB CHECK) shown on the web dialog, card marker, Today week list, phone Me list and Manage card; `slimBlockForCoach` gains it, block `notes` stay manager-only; not copied by copy week/month. Web edit form in the shift dialog; phone display only. |
```

---

### Review notes / open questions

1. **Quiet hours can mean "told after the shift started".** A shift moved EARLIER overnight (edited at 23:30, from 08:00 to 06:30) is only messaged from 07:00. By then it has started, so it is stamped `not_needed` with no message. This is the SHIFTREMIND.1 accepted consequence, applied to a manager's edit. The web toast says "will be told after 7am", so the manager knows to phone. If Richard wants a manager's own late edit exempt from quiet hours (it is a human's deliberate action, like the time-off notices, `time-off/[id]/route.js:416-418`), it is one line in the arm: skip `inStaffPushHours` when the row is less than 5 minutes old. Not done, because the index's standing rule says quiet hours gate the notice.
2. **Block notes DO reach a coach's own phone row today.** `toApiShiftRow` sets `notes: a.notes ?? b.notes` (`src/lib/roster-read.js:128`), and `slimShiftRowForCoach` keeps `notes` on the viewer's OWN row, so `shift_blocks.notes` appears under the coach's shift on the phone (`schedule.jsx:307-309`). The calendar feed strips block notes for coaches (`slimBlockForCoach`). The two coach surfaces disagree about block notes. This PR does not change that, because the briefing is a separate column either way. Worth deciding once briefings exist: probably `notes: a.notes ?? null` for a coach, so the manager's block note stops leaking and the briefing is the only block text a coach reads.
3. **Copy does not carry the briefing (D7).** If Richard wants a standing weekly instruction, that is a template field (`shift_templates.briefing`) that the generator copies onto new blocks. It is small, but it is a new migration and a writer audit (SHIFTTYPE D1's list).
4. **Past shifts can be edited (D8).** This is right for correcting hours. Payroll and contractor spend read the new time. Nothing refuses an edit to a shift inside an already-invoiced period. If that matters, a later check against `contractor_invoices` periods belongs here.
5. **A kept override that now falls outside the new window is warned, not refused (D3).** Example: a coach's own start is 10:00 and the shift moves to 13:00–16:00. The coach's window is then 10:00–16:00. The warning names them. Refusing would block the common case of moving a shift while one coach covers a different part of it.
6. **No DB guarantee that an admin block has no minimum.** Kind lives on the template (SHIFTTYPE D1), so a block CHECK cannot see it. The API refuses, and the calendar and staffing ignore an admin block's minimum anyway. A pre-628 admin block with a stale minimum keeps it until a manager saves a minimum of 0. The editor does not show a minimum for admin shifts, so it never re-sends the stale one.
7. **The notice arm has no heartbeat row of its own.** It rides `send-push-reminders`, and its failures are visible in the response (`time_change_arm_failed`, `time_change_read_failed`). HEARTBEAT.1 (#31) gives the shift-reminder arm its own row with an "is this arm healthy" predicate in `src/lib/cron-arm-health.js`. The same pattern can take this arm in a small follow-up. Rebase note: if #31 merges first, the cron's shift-arm block will have changed shape, so put this arm after it and keep its own `try/catch`.
8. **The 48-hour window.** A row the arm cannot deliver for 48 hours (a Postmark and Expo outage) is left to the re-publish safety net. Its claim is released on a failed send, so each tick retries until then.
9. **A briefing change is not pushed.** A coach sees it the next time they open the schedule. Pushing every wording tweak would be noise, and a briefing that must be read before the shift is a message, not a note. Richard may want a "tell the coaches" tick box later.
10. **The phone's iPad week grid** (`ShiftCard` in `schedule.jsx:89`, used by `WeekGridView`) does not show the briefing. The iPhone Me list (`ShiftRow`) and Manage mode do. It is a one-line follow-up if tablets are used by coaches.
11. **Phone editing** is out of scope, because the brief makes the phone display only in this PR. The phone Manage mode could reuse `PUT /api/schedule/blocks/[id]` as is: the API needs nothing more.
12. **ICSFEED.1 (#22)** is this PR's batch partner and will build calendar events from published shifts. It could put the briefing in the event DESCRIPTION. Decide there. It is coach-visible text, so it is allowed.
13. **SHIFTREMIND interplay.** A coach already reminded for a run keeps that reminder. The time-change notice carries the new time. SHIFTREMIND's ledger keys on the first assignment of a run, not on the time, so no second reminder fires. This is consistent with its "the shift_adjusted push has told the coach" rule.
14. **Concurrency on the briefing (D9).** Two managers editing only the briefing at once: the last write wins. Every other field is guarded.
