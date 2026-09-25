## PR SNAPSHOT.1 — every publish keeps a record of what it published, so a manager can compare "as published", "as rostered now" and "as arrived"

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a roster is published (POST `/api/schedule/rosters`, or an owner approving a draft), store an immutable snapshot of what that publish put live: every shift block in the period (date, template, kind, times, minimum, maximum) and every live coach on it (who, effective window). A manager-only read `GET /api/schedule/rosters/[id]/compare` then answers, per shift and per coach: the published window, the current window, the arrival stamp, and a change class (unchanged / moved / added after publish / removed after publish) with an advisory "no arrival recorded" flag on ended shifts, plus totals (published hours, hours now, arrivals). The web view is a "Published vs now" view inside the existing "Changes since publish" dialog.

**Why:** 00-INDEX Wave 3 PR 32 ("the roster as the source of truth"). Today the roster only has one tense: `shift_blocks` + `shift_assignments` are overwritten in place, and `roster_change_log` (mig 236) records edits to published rosters one at a time but never what the whole week looked like when coaches were told. So "was Saturday short when we published it, or did it go short afterwards?" and "how many hours did we publish against how many we ended up rostering?" have no answer.

**Architecture:** One migration (634) adds `roster_publish_snapshots`: one row per published `rosters` row, the snapshot as `jsonb`, service role only, and immutable (no UPDATE privilege for anyone but the owner, and a trigger that refuses the owner too). One pure model, `src/lib/roster-compare.js`, builds the snapshot from block rows and compares a snapshot with the live rows and arrival stamps. One IO module, `src/lib/roster-snapshot.js`, reads the period's blocks (paged past the 1,000-row cap), writes the snapshot best-effort after the publish has tagged its blocks, and loads a comparison. Both publish routes call the writer; a new detail route serves the comparison; a client-safe word module plus one component render it in the change-log dialog.

**Tech Stack:** Next.js 16 route handlers, Supabase Postgres (PGlite for the migration replay), Vitest (node + jsdom), React client components.

**Size / ships:** M. **Migration 634** (reserved in 00-INDEX) + web deploy. **No OTA**: nothing under `mobile/` or `shared/` changes.

**DEPLOY ORDER:**
1. **Apply mig 634 BEFORE merge** (steps at the end; the CLAUDE.md rule: migration before the code that depends on it). Alone it changes nothing: a new, empty, service-role-only table.
2. **Then merge.** If the order ever slips, nothing breaks for coaches: the snapshot write fails, is logged with `logError`, retried once, and the publish carries on exactly as today (D2). Only the compare view errors until the table exists.

**Batch 7 pairing:** rides beside 33 QUALS.1. This PR touches `src/components/ScheduleCalendar.jsx` in two places only (the `openChangeLog` object and the drawer's props), so rebase after whichever of 14 BLOCKEDIT.1 / 33 QUALS.1 has landed and re-find both anchors by text.

---

### What was found (verified against `origin/main` at `07d66939`, #1762)

**There is no publish transaction to join.** A publish is a sequence of separate PostgREST calls with hand-written compensation, in both publish paths:
- `src/app/api/schedule/rosters/route.js` POST: trim straddlers (330), release swallowed rosters (339), INSERT the `rosters` row (390-394), capture newly published blocks (428-435), TAG every block in the period with the roster id (439-444; a failure returns a 201 partial success at 445-485), supersede swallowed rosters (490-500), tidy trimmed remnants (510-518), notify (521-541).
- `src/app/api/schedule/rosters/[id]/approve/route.js` POST: trim (203), release (212), FLIP the draft to published (236-249), capture (272-289), TAG (292-297; partial success at 298-334), supersede (339-348), tidy (356-364), notify (368-388).
- Every other `rosters` write (`src/lib/roster-publish.js` 876, 988, 1005, 1075, 1169, 1220, 1312, 1359, 1373) trims, supersedes, shrinks or restores an EXISTING roster; none publishes. `src/app/api/schedule/rosters/[id]/reject/route.js:81` deletes a DRAFT (which never published).
So "inside the publish transaction" would mean moving the whole publish into one SQL function: a rewrite of the most-reviewed code in the scheduler, not this PR. See D2.

**Every publish inserts a NEW `rosters` row.** POST always inserts (route.js:390); approve flips a draft that has never been published. A re-publish of the same week inserts a new row and supersedes the old one (ROSTER-SUPERSEDE.1, `status='superseded'`, `superseded_by`). So a roster row is published at most once, and "the same week published three times" is three rows. That decides the table's key (D3).

**What a publish publishes = every block in the period at the location.** The tag at route.js:439-444 is `UPDATE shift_blocks SET roster_id = <new> WHERE location_id = … AND block_date BETWEEN period_start AND period_end`, with no other filter. So the snapshot reads the same set, by date range, and is taken AFTER the tag succeeds (D2).

**Schema facts the snapshot and the comparison rest on:**
- `shift_blocks` (mig 067): `UNIQUE (location_id, template_id, block_date)`; `CHECK (end_time > start_time)` so no block crosses midnight; `min_coaches` (mig 177), `max_coaches`. `shift_templates.kind` `'class' | 'admin'` (mig 628, `shiftKindOf` in `shared/shift-kind.js:31`).
- The slot key `(template_id, block_date)` is also what a deleted slot is recorded on (`shift_block_removals`, mig 613) and has a helper, `slotKey()` (`src/lib/roster.js:281`).
- `shift_assignments`: `UNIQUE (block_id, profile_id)`; status `scheduled|confirmed|completed|cancelled|swapped` (mig 337); only `cancelled` is dead (`isLiveAssignment`, `src/lib/roster.js:440`). A swap rewrites `profile_id` on the same row. Overrides `start_time_override` / `end_time_override` (mig 099/100) CAN make a window whose end is before its start; payroll wraps it past midnight (`shiftHours`, `src/lib/payroll.js:44-61`).
- Effective window = override, else the BLOCK's own time, never the template (`effectiveShiftStart/End`, `shared/roster-month.js:46-56`; the mig 604/622 COALESCE).
- Arrival: `shift_assignments.arrived_at` + `arrival_source` (mig 609; mig 610 backfilled the old stamps). The attendance report (`src/app/api/attendance/route.js:105-146`) reads `arrived_at` and carries an arrival onto a back-to-back shift with `inferContinuousArrivals` (`src/lib/staff-attendance.js:245`, 60-minute gap). This PR uses exactly that definition.
- Wall clock to UTC, DST-exact, with `'24:00'` as the next midnight: `wallInstant(dateIso, time, tz)` (`src/lib/staff-calendar-feed.js:55`), over `wallMsInTz` (`src/lib/tz-time.js:202`). `resolveTz` (`tz-time.js:119`) falls back to Europe/Dublin. `locations.timezone` exists.
- `payroll.timeToHours` (`src/lib/payroll.js:25-34`) refuses hour 24, so payroll counts a shift ending `'24:00'` as **0 hours**. Found while planning; out of scope; listed as a follow-up.

**The change-log dialog is PERIOD-based, the compare route is ROSTER-based.** `RosterChangeLogDrawer` (`src/components/schedule/RosterChangeLogDrawer.jsx`) is opened from the Published chip with `{ start, end, label }` (`src/components/ScheduleCalendar.jsx:575-581`) and rendered at 1530-1538. The blocks feed (`src/app/api/schedule/blocks/route.js:60-62`) returns `roster_id` and `rosters:roster_id(status)` on every block, so the calendar already knows which published rosters the period on screen sits on. A Mon-Sun week can straddle two month rosters, so the view handles more than one.

**The drawer's tests pin one fetch on open** (`RosterChangeLogDrawer.test.jsx`: "asks for exactly the studio and period on screen, once"). The comparison therefore loads only when the manager switches to it.

**Access pattern to copy:** `src/app/api/schedule/blocks/[id]/route.js:47-75`: `hasRoleAtAnyLocation(user, MANAGER_ROLES)` → 403; read the row by id → 404; `assertLocationAccessOr404(user, row.location_id)` → 404 for an outsider; `hasRoleAtLocation(user, row.location_id, MANAGER_ROLES)` → 403 for a member without the role. Masters get every location in `user.locations` (`src/lib/auth.js:412-418`). `check:location-scoping` counts `assertLocationAccessOr404(` as scoping evidence (`scripts/check-location-scoping.mjs:92-100`).

**Migration style to copy:** mig 632 (`supabase/migrations/632_staff_calendar_feeds.sql`): header with WHAT/WHY/ACCESS/LOCKS, pre- and post-apply checks, rollback, one transaction, a `DO $$` self-check against the catalog, RLS on with no policies, browser grants revoked. PGlite replay: `tests/migration-632-staff-calendar-feeds.test.js`.

---

### Decisions (made here, each justified)

**D1. One `jsonb` document per publish, not normalised rows.** Size: Stillorgan runs ~40 blocks a week at ~1.3 live coaches each; a block serialises to ~260 bytes and a coach to ~130, so a week is ~17 KB and a month ~75 KB before TOAST compression (repetitive keys compress 3-4×). Two studios publishing weekly-to-monthly is well under 10 MB a year. Against normalised tables (`…_blocks` + `…_coaches`):
- **Atomic by construction.** One INSERT of one row is all-or-nothing. Two tables are two PostgREST calls with no transaction between them (the same gap D2 is about), so a half-written snapshot would be possible and would read as "shifts removed after publish".
- **Immutability is one trigger on one table.**
- **It is only ever read whole**, one roster at a time, by one route. No query ever needs "every snapshot containing coach X".
- **Denormalised copies are the point**: template name and kind are frozen as they were published (a template renamed or re-kinded later must not rewrite history, and kind lives on the template, 00-INDEX default 13).
`format_version` (smallint, today 1) says how to read the document; `block_count` / `assignment_count` sit beside it so a list never parses the JSON, and a CHECK keeps `block_count` equal to the array's length.

**D2. Written AFTER the publish has tagged its blocks, best-effort, never blocking the publish.** CLAUDE.md: *"Removing a silent failure must NEVER create a louder one … log loudly and structurally (`logError`) → accept a duplicate or a retry → only fail closed when proceeding would do something actively harmful and irreversible."* A missing snapshot is a gap in a manager's comparison view. Failing the publish over it would leave coaches untold about their week and the manager re-publishing (which re-notifies). Proceeding is harmless and reversible (the next publish writes a new snapshot), so:
- `writePublishSnapshot` never throws, retries its INSERT once, treats a unique violation on the retry as "the first attempt landed", and reports a failure with `logError('roster-snapshot', …)` carrying `roster_id` and `location_id`;
- the routes call it after the tag succeeded and before the supersede sweep, inside a second `try/catch`;
- nothing is added to the publish response: like ROSTERTIDY.1's remnant sweep (route.js:508-509, "Log-only on failure … the operator has nothing to act on"), a manager cannot fix a lost snapshot from the publish dialog;
- the compare view says so honestly (`missing_reason: 'not_saved'`) instead of showing an empty comparison.
On a tag failure (the 201/200 partial-success exits) no snapshot is written: those blocks are not on the new roster, so it did not publish them, and the warning already tells the manager to publish again, which will snapshot. The read runs a few milliseconds after the tag, so an edit landing in that gap would be recorded as published; accepted.

**D3. One snapshot per `rosters` row: `UNIQUE (roster_id)`.** Every publish and every re-publish inserts its own `rosters` row (found above), so "a snapshot on every re-publish" is simply one per row, and the retry in D2 is idempotent against the unique key. The brief's `version int` becomes **`format_version`** (the shape of the document). "Which publish of this week is this?" is answered by the `publishes` list the compare route returns (every snapshot at the studio overlapping the window, newest first), and `?against=<snapshot id>` compares with any of them (the first publish of the week, say). Open question 1.

**D4. Immutable, enforced twice.** `service_role` gets `SELECT, INSERT` only (Supabase's default `ALL` is revoked from it first), so a route cannot UPDATE, DELETE or TRUNCATE a snapshot even by mistake. A `BEFORE UPDATE` trigger refuses the table owner too (dashboard edits, a hand-run script). DELETE only happens by cascade: `roster_id → rosters ON DELETE CASCADE` (only a rejected DRAFT is ever deleted, and drafts have no snapshot) and `location_id → locations ON DELETE CASCADE`. Referential actions run as the table owner, so the cascade needs no DELETE grant.

**D5. `published_by` is a plain uuid, no foreign key.** A staff profile is never deleted (CLAUDE.md), `rosters.published_by` already carries the FK, and an FK here would add one more hand-listed dependency on `profiles` (the mig 622 lesson: "Never hand-list FKs into profiles"). An `ON DELETE SET NULL` would also be an UPDATE the immutability trigger refuses.

**D6. No names in the snapshot, only profile ids.** Names are read at compare time. A tombstone keeps `full_name` (mig 622), so a departed coach still reads by name; storing names in `jsonb` would put PII where the tombstone's stripping can never reach.

**D7. Matching.** A block is matched on its slot `(template_id, block_date)`, not its id, so a block deleted and re-created for the same slot is the same shift. A coach is matched on `profile_id` within the slot. A swap therefore reads as the giver "removed after publish" and the taker "added after publish", which is exactly the difference between who was published and who is rostered.

**D8. Hours are wall-clock, like payroll.** A window's hours are its wall-clock length, wrapping past midnight when the end is before the start (`payroll.shiftHours`'s rule), so the compare totals agree with every other hours figure in the product, including across a DST change (00:30-03:30 on 29 Mar 2026 counts 3h here and in payroll). One deliberate difference: `'24:00'` is midnight here (payroll counts that shift 0h; follow-up).

**D9. "Ended" and "no arrival" are judged on real instants in the studio's timezone** (`wallInstant`, DST-exact). An end before the start ends on the next day. **"No arrival recorded" is advisory and never called a no-show**: 00-INDEX holds late and no-show alerts because arrival stamps exist for about 19% of shifts. The flag is a prompt to check, nothing alerts anyone, and the totals say "Arrival recorded for N of M ended shifts" with that caveat beside it.

**D10. Arrival = `arrived_at`, plus the attendance report's back-to-back carry-over.** Same definition as `src/app/api/attendance/route.js`. A `staff_attendance_events` row matched to an assignment whose `arrived_at` is empty is NOT read (mig 610 backfilled `arrived_at` from those; open question 5).

**D11. No backfill.** A snapshot of an old publish rebuilt from today's rows would be exactly the "as finally rostered" view pretending to be "as published". Rosters published before deploy have none; the view says "Published vs now is available for rosters published from <date of the studio's first snapshot>", or "starts with the next publish at this studio" when there is none yet. The date is read from the data, so no constant has to be edited at merge.

**D12. Manager-only, web-only, no permission key.** Gate = `MANAGER_ROLES` AT the roster's studio (the change-log route's gate, `src/app/api/schedule/change-log/route.js:46-87`). Drafts answer 409 (nothing was published). Superseded rosters are comparable (they were published). No `WEB_PERMISSIONS` key, so `check:mobile-parity` is untouched. Hours and names only; no rate, cost or contracted-hours column is selected.

**D13. The web view lives in the change-log dialog, behind a two-button switch** ("Changes" | "Published vs now"), shown only when the period has at least one published roster. The comparison loads on first switch (the dialog's one-fetch-on-open test stays true). Unchanged shifts are hidden by default behind a "Show unchanged shifts" box, so a quiet week reads "Every shift is as it was published." One section per published roster the period sits on, at most four.

---

### Files

| Path | Change | Responsibility |
|---|---|---|
| `supabase/migrations/634_roster_publish_snapshots.sql` | Create | The table, its CHECKs, immutability trigger, grants, self-check |
| `tests/migration-634-roster-publish-snapshots.test.js` | Create | PGlite replay of the real file |
| `src/lib/roster-compare.js` | Create | PURE: `hhmm`, `windowHours`, `effectiveWindow`, `buildPublishSnapshot`, `clipWindow`, `compareSnapshot` |
| `src/lib/roster-compare.test.js` | Create | The model, incl. DST, overnight, `24:00`, added/removed, swap, re-published twice |
| `src/lib/roster-snapshot.js` | Create | IO: `loadWindowBlocks` (paged), `writePublishSnapshot` (best-effort), `loadRosterComparison` |
| `src/lib/roster-snapshot.test.js` | Create | IO against a recording fake client |
| `src/app/api/schedule/rosters/route.js` | Modify (import ~47-48; insert after the tag block ending line 485) | Snapshot after a publish |
| `src/app/api/schedule/rosters/route.test.js` | Modify | Snapshot wiring cases |
| `src/app/api/schedule/rosters/[id]/approve/route.js` | Modify (import ~42; insert after the tag block ending line 334) | Snapshot after an approval |
| `src/app/api/schedule/rosters/[id]/approve/route.test.js` | Modify | Snapshot wiring cases |
| `src/app/api/schedule/rosters/[id]/compare/route.js` | Create | `GET` compare, manager-only |
| `src/app/api/schedule/rosters/[id]/compare/route.test.js` | Create | Gate, validation, pass-through |
| `src/lib/roster-compare-format.js` | Create | PURE, client-safe words: labels, sentences, which rosters a period sits on |
| `src/lib/roster-compare-format.test.js` | Create | |
| `src/components/schedule/RosterCompareSection.jsx` | Create | The "Published vs now" view |
| `src/components/schedule/RosterCompareSection.test.jsx` | Create | jsdom: states, fetch URLs, filtering, baseline switch |
| `src/components/schedule/RosterChangeLogDrawer.jsx` | Modify (whole file shown) | The two-button switch; `rosterIds` prop |
| `src/components/schedule/RosterChangeLogDrawer.test.jsx` | Modify (append) | Switch cases |
| `src/components/ScheduleCalendar.jsx` | Modify (import after line 72; `openChangeLog` 575-581; drawer props 1531-1538) | Pass the period's published roster ids |
| `src/lib/openapi.js` | Modify (after the `/api/schedule/rosters/{id}/reject` registration) | Register the route |
| `src/lib/openapi.test.js` | Modify (append one `it`) | |
| `eslint.guardrails.config.mjs` | Modify (`no-unchecked-supabase-write` files, after `'src/lib/staff-calendar-feed-server.js',`) | Arm the new IO + route |
| `docs/roster-v2.md` | Modify (append) | Section "Publish snapshots" |
| `docs/CHANGELOG.md` | Modify (after `gh pr create`) | One row |

---

### Task 1: Migration 634 and its PGlite replay

**Files:**
- Create: `supabase/migrations/634_roster_publish_snapshots.sql`
- Create: `tests/migration-634-roster-publish-snapshots.test.js`

- [ ] **Step 1: Write the failing replay test** at `tests/migration-634-roster-publish-snapshots.test.js`:

```js
// SNAPSHOT.1 — behavioural test for migration 634, against the REAL file.
//
// Same reason as the 613/618/622/624/628/632 replays: there is no local
// Supabase stack, so without this the DDL would get its first execution on
// prod. Boots PGlite, recreates the three API roles and Supabase's DEFAULT
// privileges (every new table and function in public is granted to anon,
// authenticated and service_role), applies the real 634 file, and proves the
// header's claims: browser roles hold nothing, the service role can only
// SELECT and INSERT, and nobody (the owner included) can rewrite a snapshot.
// (PGlite's db.exec runs SQL text; it is not child_process.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_634 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/634_roster_publish_snapshots.sql'),
  'utf8',
)

const LOC = '20000000-0000-0000-0000-000000000001'
const R1 = '30000000-0000-0000-0000-000000000001'
const R2 = '30000000-0000-0000-0000-000000000002'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  -- What Supabase does for every table and function created in public. The
  -- migration must undo it itself.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.rosters (
    id uuid PRIMARY KEY,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'published'
  );
  INSERT INTO public.locations (id) VALUES ('${LOC}');
  INSERT INTO public.rosters (id, location_id) VALUES ('${R1}', '${LOC}'), ('${R2}', '${LOC}');
`

function snapshotJson(blocks) {
  return JSON.stringify({
    v: 1,
    period_start: '2026-09-14',
    period_end: '2026-09-20',
    blocks: Array.from({ length: blocks }, (_, i) => ({ slot: `t${i}|2026-09-14`, coaches: [] })),
  })
}

function insertSql(rosterId, { blocks = 1, blockCount = blocks, snapshot = snapshotJson(blocks), periodEnd = '2026-09-20' } = {}) {
  return `INSERT INTO public.roster_publish_snapshots
      (roster_id, location_id, period_start, period_end, published_at, block_count, assignment_count, snapshot)
    VALUES ('${rosterId}', '${LOC}', '2026-09-14', '${periodEnd}', now(), ${blockCount}, 0, '${snapshot}'::jsonb)`
}

let db
beforeAll(async () => {
  db = new PGlite()
  await db.exec(BASE_SCHEMA)
  await db.exec(MIG_634)
}, 60_000)

afterAll(async () => { await db?.close() })

async function inTx(fn) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}

async function asRole(role, fn) {
  await db.exec(`SET ROLE ${role}`)
  try { return await fn() } finally { await db.exec('RESET ROLE') }
}

describe('migration 634 — roster_publish_snapshots', () => {
  it('has exactly the documented shape', async () => {
    const { rows } = await db.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'roster_publish_snapshots' ORDER BY column_name`)
    expect(rows).toEqual([
      { column_name: 'assignment_count', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'block_count', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'format_version', data_type: 'smallint', is_nullable: 'NO' },
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'location_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'period_end', data_type: 'date', is_nullable: 'NO' },
      { column_name: 'period_start', data_type: 'date', is_nullable: 'NO' },
      { column_name: 'published_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'published_by', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'roster_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'snapshot', data_type: 'jsonb', is_nullable: 'NO' },
    ])
  })

  it('has RLS on and NO policies', async () => {
    const rls = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.roster_publish_snapshots'::regclass`)
    expect(rls.rows).toEqual([{ relrowsecurity: true }])
    const pol = await db.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'public.roster_publish_snapshots'::regclass`)
    expect(pol.rows).toEqual([{ n: 0 }])
  })

  it('takes every privilege away from anon and authenticated, despite the default grants', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const { rows } = await db.query(`SELECT has_table_privilege($1, 'public.roster_publish_snapshots', $2) AS ok`, [role, priv])
        expect(rows[0].ok, `${role} still holds ${priv}`).toBe(false)
      }
    }
  })

  it('leaves the service role SELECT and INSERT, and nothing that could rewrite or remove a row', async () => {
    for (const [priv, want] of [['SELECT', true], ['INSERT', true], ['UPDATE', false], ['DELETE', false], ['TRUNCATE', false]]) {
      const { rows } = await db.query(`SELECT has_table_privilege('service_role', 'public.roster_publish_snapshots', $1) AS ok`, [priv])
      expect(rows[0].ok, `service_role ${priv}`).toBe(want)
    }
  })

  it('the service role writes and reads a snapshot', async () => {
    await inTx(async () => {
      await asRole('service_role', async () => {
        await db.exec(insertSql(R1, { blocks: 2 }))
        const { rows } = await db.query(`SELECT block_count, format_version, jsonb_array_length(snapshot->'blocks') AS n
          FROM public.roster_publish_snapshots WHERE roster_id = '${R1}'`)
        expect(rows).toEqual([{ block_count: 2, format_version: 1, n: 2 }])
      })
    })
  })

  it('the browser role is refused outright, not shown an empty table', async () => {
    await asRole('authenticated', async () => {
      await expect(db.query('SELECT * FROM public.roster_publish_snapshots')).rejects.toThrow(/permission denied/)
    })
  })

  it('the service role cannot rewrite a snapshot (no UPDATE privilege)', async () => {
    await inTx(async () => {
      await db.exec(insertSql(R1))
      await asRole('service_role', async () => {
        await expect(db.exec(`UPDATE public.roster_publish_snapshots SET block_count = 0 WHERE roster_id = '${R1}'`))
          .rejects.toThrow(/permission denied/)
      })
    })
  })

  it('the owner cannot rewrite one either: the trigger refuses every UPDATE', async () => {
    await inTx(async () => {
      await db.exec(insertSql(R1))
      await expect(db.exec(`UPDATE public.roster_publish_snapshots SET published_by = NULL WHERE roster_id = '${R1}'`))
        .rejects.toThrow(/immutable/)
    })
  })

  it('one snapshot per roster row', async () => {
    await inTx(async () => {
      await db.exec(insertSql(R1))
      await expect(db.exec(insertSql(R1))).rejects.toThrow(/roster_publish_snapshots_roster_id_key/)
    })
    await inTx(async () => {
      await db.exec(insertSql(R1))
      await db.exec(insertSql(R2))
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.roster_publish_snapshots`)
      expect(rows).toEqual([{ n: 2 }])
    })
  })

  it('refuses a document whose block list does not match block_count, or is not an object with a blocks array', async () => {
    await expect(db.exec(insertSql(R1, { blocks: 2, blockCount: 3 }))).rejects.toThrow(/roster_publish_snapshots_shape_check/)
    await expect(db.exec(insertSql(R1, { blockCount: 0, snapshot: '[]' }))).rejects.toThrow(/roster_publish_snapshots_shape_check/)
    await expect(db.exec(insertSql(R1, { blockCount: 0, snapshot: '{"blocks":{}}' }))).rejects.toThrow(/roster_publish_snapshots_shape_check/)
  })

  it('refuses a period that ends before it starts', async () => {
    await expect(db.exec(insertSql(R1, { periodEnd: '2026-09-13' }))).rejects.toThrow(/roster_publish_snapshots_period_check/)
  })

  it('goes with its roster (a rejected draft is deleted by the service role; the cascade needs no DELETE grant)', async () => {
    await inTx(async () => {
      await db.exec(insertSql(R2))
      await asRole('service_role', async () => {
        await db.exec(`DELETE FROM public.rosters WHERE id = '${R2}'`)
      })
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.roster_publish_snapshots`)
      expect(rows).toEqual([{ n: 0 }])
    })
  })

  it('the trigger function is not callable by the browser roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await db.query(
        `SELECT has_function_privilege($1, 'public.roster_publish_snapshots_refuse_update()', 'EXECUTE') AS ok`, [role])
      expect(rows[0].ok, `${role} can execute the trigger function`).toBe(false)
    }
  })

  it('re-running the file is a no-op', async () => {
    await db.exec(MIG_634)
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgrelid = 'public.roster_publish_snapshots'::regclass AND NOT tgisinternal`)
    expect(rows).toEqual([{ n: 1 }])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/migration-634-roster-publish-snapshots.test.js`
Expected: FAIL, `ENOENT: no such file or directory … 634_roster_publish_snapshots.sql`.

- [ ] **Step 3: Write the migration** at `supabase/migrations/634_roster_publish_snapshots.sql`:

```sql
-- 634 — SNAPSHOT.1: an immutable record of what each roster publish published.
--
-- NOT APPLIED YET. Apply BEFORE the SNAPSHOT.1 code deploys. Applied alone this
-- file changes no behaviour: a new, empty table nothing else reads. If the code
-- ever deploys first, nothing breaks for coaches: the snapshot write fails, is
-- logged (logError 'roster-snapshot') and the publish carries on unchanged; only
-- GET /api/schedule/rosters/[id]/compare errors until this exists. Behaviour is
-- proven ahead of apply by a PGlite replay
-- (tests/migration-634-roster-publish-snapshots.test.js), which runs this file
-- verbatim.
--
-- WHAT
--   public.roster_publish_snapshots — ONE row per published rosters row.
--     id               uuid PK
--     roster_id        uuid NOT NULL UNIQUE → rosters(id) ON DELETE CASCADE
--     location_id      uuid NOT NULL → locations(id) ON DELETE CASCADE
--     period_start/end date NOT NULL (the period the publish covered)
--     published_at     timestamptz NOT NULL (copied from the rosters row)
--     published_by     uuid (copied from the rosters row; no FK, see WHY)
--     format_version   smallint NOT NULL DEFAULT 1 (the document's shape)
--     block_count      int NOT NULL = jsonb_array_length(snapshot->'blocks')
--     assignment_count int NOT NULL (live coaches across those blocks)
--     snapshot         jsonb NOT NULL: { v, period_start, period_end, blocks: [
--                        { slot, block_id, date, template_id, template_name,
--                          kind, start, end, min, max,
--                          coaches: [{ assignment_id, profile_id, start, end,
--                                      overridden }] } ] }
--     created_at       timestamptz NOT NULL DEFAULT now()
--
-- WHY ONE jsonb DOCUMENT (not normalised rows)
--   ~40 blocks a week x ~1.3 coaches is ~17 KB a week, ~75 KB a month before
--   TOAST compression; two studios stay well under 10 MB a year. One INSERT of
--   one row is atomic, where two tables would be two PostgREST calls with no
--   transaction between them (a half-written snapshot would read as "shifts
--   removed after publish"). It is only ever read whole, one roster at a time.
--   Template name and kind are copied in on purpose: history must not change
--   when a template is renamed or re-kinded.
--
-- WHY UNIQUE (roster_id)
--   Every publish and every re-publish inserts its OWN rosters row (POST
--   /api/schedule/rosters inserts; approve flips a draft that never published;
--   a re-publish supersedes the old row). So one snapshot per row IS one per
--   publish, and the writer's single retry is idempotent against this key.
--
-- WHY IMMUTABLE, TWICE
--   service_role gets SELECT and INSERT only (Supabase's default ALL is revoked
--   first), so no route can UPDATE, DELETE or TRUNCATE a snapshot. A BEFORE
--   UPDATE trigger refuses the owner as well (dashboard edits, hand-run SQL).
--   Rows leave only by cascade: a deleted rosters row (only a rejected DRAFT is
--   ever deleted, and a draft has no snapshot) or a deleted location.
--   Referential actions run as the table owner, so the cascade needs no DELETE
--   grant.
--
-- WHY published_by HAS NO FK
--   rosters.published_by carries the FK already; staff profiles are never
--   deleted (tombstoned, mig 622); and an FK here would be one more hand-listed
--   dependency on profiles, whose ON DELETE SET NULL would be an UPDATE the
--   trigger refuses. No names are stored: names are read at compare time, so a
--   tombstone's PII stripping never has to reach into jsonb.
--
-- ACCESS: service role only. RLS on with NO policies, browser privileges
--   revoked (the fence is the table, not columns: mig 153/153b). Expected
--   advisor note afterwards: INFO rls_enabled_no_policy on this table, exactly
--   as widget_tokens (607) and staff_calendar_feeds (632) carry. By design.
--
-- LOCKS: CREATE TABLE / INDEX / FUNCTION / TRIGGER on a new table only. The FKs
--   to rosters and locations take a brief SHARE ROW EXCLUSIVE lock on those two
--   for the instant of the CREATE; no rows are scanned.
--
-- REPLAYING THIS FILE IS A NO-OP (IF NOT EXISTS; CREATE OR REPLACE FUNCTION;
-- DROP TRIGGER IF EXISTS + CREATE; REVOKE/GRANT/COMMENT are idempotent). One
-- explicit transaction, so a failed self-check leaves NOTHING applied.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; run IMMEDIATELY before applying, stop if any
-- answer differs from "Expected")
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The names are free:
--       SELECT to_regclass('public.roster_publish_snapshots') AS t,
--              to_regprocedure('public.roster_publish_snapshots_refuse_update()') AS f;
--     Expected: t = NULL, f = NULL.
-- (b) The FK targets are what the file assumes:
--       SELECT table_name, data_type FROM information_schema.columns
--        WHERE table_schema='public' AND column_name='id' AND table_name IN ('rosters','locations')
--        ORDER BY 1;
--     Expected: locations uuid, rosters uuid.
-- (c) Supabase's default privileges on new public tables and functions
--     (information; KEEP the output for the rollback record):
--       SELECT pg_get_userbyid(defaclrole) AS owner, defaclobjtype, defaclacl
--         FROM pg_default_acl WHERE defaclnamespace = 'public'::regnamespace;
--     Expected: rows granting anon, authenticated and service_role.
-- (d) list_migrations shows no 634.
-- (e) Size sanity (information): a month of blocks and live coaches per studio.
--       SELECT b.location_id, count(DISTINCT b.id) AS blocks,
--              count(a.id) FILTER (WHERE a.status <> 'cancelled') AS live_coaches
--         FROM public.shift_blocks b
--         LEFT JOIN public.shift_assignments a ON a.block_id = b.id
--        WHERE b.block_date BETWEEN '2026-09-01' AND '2026-09-30'
--        GROUP BY 1;
--     Expected: a few hundred at most per studio (D1's arithmetic holds).
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (f) SELECT column_name, data_type, is_nullable FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='roster_publish_snapshots' ORDER BY 1;
--     Expected 12 rows: assignment_count integer NO, block_count integer NO,
--     created_at timestamptz NO, format_version smallint NO, id uuid NO,
--     location_id uuid NO, period_end date NO, period_start date NO,
--     published_at timestamptz NO, published_by uuid YES, roster_id uuid NO,
--     snapshot jsonb NO.
-- (g) SELECT relrowsecurity FROM pg_class WHERE oid = 'public.roster_publish_snapshots'::regclass;
--     Expected: true.
--     SELECT count(*) FROM pg_policy WHERE polrelid = 'public.roster_publish_snapshots'::regclass;
--     Expected: 0.
-- (h) SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--       FROM information_schema.table_privileges
--      WHERE table_schema='public' AND table_name='roster_publish_snapshots' GROUP BY 1 ORDER BY 1;
--     Expected: postgres (owner) holds everything; service_role exactly
--     INSERT,SELECT; NO row for anon or authenticated.
-- (i) SELECT conname FROM pg_constraint
--      WHERE conrelid = 'public.roster_publish_snapshots'::regclass AND contype <> 'n' ORDER BY 1;
--     Expected 8: roster_publish_snapshots_counts_check,
--     roster_publish_snapshots_format_version_check,
--     roster_publish_snapshots_location_id_fkey,
--     roster_publish_snapshots_period_check, roster_publish_snapshots_pkey,
--     roster_publish_snapshots_roster_id_fkey,
--     roster_publish_snapshots_roster_id_key,
--     roster_publish_snapshots_shape_check.
-- (j) SELECT tgname, tgenabled FROM pg_trigger
--      WHERE tgrelid = 'public.roster_publish_snapshots'::regclass AND NOT tgisinternal;
--     Expected: roster_publish_snapshots_immutable | O.
-- (k) SELECT count(*) FROM public.roster_publish_snapshots;   Expected: 0.
-- (l) get_advisors (security, then performance). Expected: INFO
--     rls_enabled_no_policy on roster_publish_snapshots (by design, see
--     ACCESS); possibly INFO unused_index on the new index until the first
--     compare; nothing else new. function_search_path_mutable must NOT appear
--     for roster_publish_snapshots_refuse_update (it pins search_path = '').
--
-- AFTER THE FIRST REAL PUBLISH post-deploy (read-only):
--   SELECT s.roster_id, s.block_count, s.assignment_count, pg_column_size(s.snapshot) AS bytes,
--          (SELECT count(*) FROM public.shift_blocks b
--            WHERE b.location_id = s.location_id
--              AND b.block_date BETWEEN s.period_start AND s.period_end) AS blocks_now
--     FROM public.roster_publish_snapshots s ORDER BY s.created_at DESC LIMIT 5;
--   Expected: block_count = blocks_now (unless someone edited the week since),
--   bytes in the tens of KB.
--
-- ROLLBACK (forward-only repo; this is a NEW migration, never an edit here):
--   Revert the SNAPSHOT.1 code FIRST and let it deploy. Then:
--     BEGIN;
--       DROP TABLE IF EXISTS public.roster_publish_snapshots;
--       DROP FUNCTION IF EXISTS public.roster_publish_snapshots_refuse_update();
--     COMMIT;
--   Every snapshot is lost for good (they cannot be rebuilt: that is the point
--   of them). Usually unnecessary: the table is inert without the code.

BEGIN;

CREATE TABLE IF NOT EXISTS public.roster_publish_snapshots (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  roster_id        uuid        NOT NULL,
  location_id      uuid        NOT NULL,
  period_start     date        NOT NULL,
  period_end       date        NOT NULL,
  published_at     timestamptz NOT NULL,
  published_by     uuid,
  format_version   smallint    NOT NULL DEFAULT 1,
  block_count      integer     NOT NULL,
  assignment_count integer     NOT NULL,
  snapshot         jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roster_publish_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT roster_publish_snapshots_roster_id_key UNIQUE (roster_id),
  CONSTRAINT roster_publish_snapshots_roster_id_fkey
    FOREIGN KEY (roster_id) REFERENCES public.rosters(id) ON DELETE CASCADE,
  CONSTRAINT roster_publish_snapshots_location_id_fkey
    FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE CASCADE,
  CONSTRAINT roster_publish_snapshots_period_check CHECK (period_end >= period_start),
  CONSTRAINT roster_publish_snapshots_format_version_check CHECK (format_version >= 1),
  CONSTRAINT roster_publish_snapshots_counts_check CHECK (block_count >= 0 AND assignment_count >= 0),
  -- CASE, not AND: Postgres does not promise to evaluate AND left to right, and
  -- jsonb_array_length raises on anything that is not an array.
  CONSTRAINT roster_publish_snapshots_shape_check CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND CASE WHEN jsonb_typeof(snapshot -> 'blocks') = 'array'
             THEN jsonb_array_length(snapshot -> 'blocks') = block_count
             ELSE false END
  )
);

-- The compare route's two studio-wide reads: the studio's first snapshot
-- (ORDER BY published_at LIMIT 1) and the publishes overlapping a window. The
-- leading location_id also covers the location FK; roster_id is covered by its
-- UNIQUE index.
CREATE INDEX IF NOT EXISTS roster_publish_snapshots_location_published_idx
  ON public.roster_publish_snapshots (location_id, published_at);

CREATE OR REPLACE FUNCTION public.roster_publish_snapshots_refuse_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'roster_publish_snapshots rows are immutable (SNAPSHOT.1, mig 634): a publish snapshot records what was published and is never rewritten'
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION public.roster_publish_snapshots_refuse_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS roster_publish_snapshots_immutable ON public.roster_publish_snapshots;
CREATE TRIGGER roster_publish_snapshots_immutable
  BEFORE UPDATE ON public.roster_publish_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.roster_publish_snapshots_refuse_update();

ALTER TABLE public.roster_publish_snapshots ENABLE ROW LEVEL SECURITY;

-- Deliberately NO policies (see ACCESS in the header).
REVOKE ALL ON public.roster_publish_snapshots FROM anon, authenticated;
REVOKE ALL ON public.roster_publish_snapshots FROM service_role;
GRANT SELECT, INSERT ON public.roster_publish_snapshots TO service_role;

-- Self-check (the mig 153b habit: verify the catalog, not this text).
-- CREATE TABLE IF NOT EXISTS silently KEEPS a same-named table of another
-- shape; a RAISE here aborts the transaction, so nothing half-applies.
DO $$
DECLARE
  v_cols  text;
  v_bad   text;
  v_cons  int;
  v_trig  int;
BEGIN
  SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'roster_publish_snapshots';
  IF v_cols IS DISTINCT FROM
     'assignment_count:integer:NO,block_count:integer:NO,created_at:timestamp with time zone:NO,format_version:smallint:NO,id:uuid:NO,location_id:uuid:NO,period_end:date:NO,period_start:date:NO,published_at:timestamp with time zone:NO,published_by:uuid:YES,roster_id:uuid:NO,snapshot:jsonb:NO' THEN
    RAISE EXCEPTION 'mig 634: roster_publish_snapshots has the wrong shape (%); a table of that name existed before this file and CREATE TABLE IF NOT EXISTS kept it', v_cols;
  END IF;

  SELECT count(*) INTO v_cons
    FROM pg_constraint
   WHERE conrelid = 'public.roster_publish_snapshots'::regclass
     AND conname IN ('roster_publish_snapshots_pkey', 'roster_publish_snapshots_roster_id_key',
                     'roster_publish_snapshots_roster_id_fkey', 'roster_publish_snapshots_location_id_fkey',
                     'roster_publish_snapshots_period_check', 'roster_publish_snapshots_format_version_check',
                     'roster_publish_snapshots_counts_check', 'roster_publish_snapshots_shape_check');
  IF v_cons <> 8 THEN
    RAISE EXCEPTION 'mig 634: expected 8 constraints on roster_publish_snapshots, found %', v_cons;
  END IF;

  SELECT count(*) INTO v_trig
    FROM pg_trigger
   WHERE tgrelid = 'public.roster_publish_snapshots'::regclass
     AND tgname = 'roster_publish_snapshots_immutable'
     AND NOT tgisinternal AND tgenabled = 'O';
  IF v_trig <> 1 THEN
    RAISE EXCEPTION 'mig 634: the immutability trigger is missing or disabled';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.roster_publish_snapshots'::regclass) THEN
    RAISE EXCEPTION 'mig 634: RLS is not enabled on roster_publish_snapshots';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.roster_publish_snapshots'::regclass) THEN
    RAISE EXCEPTION 'mig 634: roster_publish_snapshots must carry NO policies (service role only)';
  END IF;

  SELECT string_agg(r || ':' || p, ',' ORDER BY r, p) INTO v_bad
    FROM unnest(ARRAY['anon', 'authenticated']) AS r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
   WHERE has_table_privilege(r, 'public.roster_publish_snapshots', p);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 634: browser roles still hold %', v_bad;
  END IF;

  IF NOT (has_table_privilege('service_role', 'public.roster_publish_snapshots', 'SELECT')
      AND has_table_privilege('service_role', 'public.roster_publish_snapshots', 'INSERT')) THEN
    RAISE EXCEPTION 'mig 634: service_role lacks SELECT or INSERT';
  END IF;
  SELECT string_agg(p, ',' ORDER BY p) INTO v_bad
    FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p
   WHERE has_table_privilege('service_role', 'public.roster_publish_snapshots', p);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 634: service_role still holds % on an immutable table', v_bad;
  END IF;
END $$;

COMMENT ON TABLE public.roster_publish_snapshots IS
  'SNAPSHOT.1 (mig 634): what each roster publish published: every shift block in the period (date, template, kind, times, min/max) and every live coach on it (profile id, effective window), as one jsonb document per rosters row. Written once, after the publish tagged its blocks; immutable (service_role SELECT/INSERT only, UPDATE refused by trigger). Service role only. Read by GET /api/schedule/rosters/[id]/compare.';
COMMENT ON COLUMN public.roster_publish_snapshots.format_version IS
  'Shape of the snapshot document (1 = { v, period_start, period_end, blocks: [...] }). Readers refuse a version newer than they know.';
COMMENT ON COLUMN public.roster_publish_snapshots.published_by IS
  'Copied from rosters.published_by at publish time. No FK on purpose (profiles are tombstoned, never deleted; see the migration header).';

COMMIT;
```

- [ ] **Step 4: Run the replay to see it pass**

Run: `npx vitest run tests/migration-634-roster-publish-snapshots.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Prove the migration-replaying checks still parse the tree**

Run: `npm run check:select-columns && npm run check:rls-restrictive && npm run check:location-scoping`
Expected: all three exit 0. (Nothing queries the table yet; this proves the new CREATE TABLE parses, and that the new tenant table, which carries `location_id`, has no unscoped reader.)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/634_roster_publish_snapshots.sql tests/migration-634-roster-publish-snapshots.test.js
git commit -m "SNAPSHOT.1 — mig 634: roster_publish_snapshots, one immutable jsonb record per publish (service role SELECT/INSERT only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The pure model, part 1: windows and the snapshot document

**Files:**
- Create: `src/lib/roster-compare.js`
- Create: `src/lib/roster-compare.test.js`

- [ ] **Step 1: Write the failing tests** at `src/lib/roster-compare.test.js`:

```js
// src/lib/roster-compare.test.js
// SNAPSHOT.1 — the comparison model. Pure: every clock and zone is passed in.
// Run it under TZ=Europe/Dublin AND a US zone (CLAUDE.md date rule); nothing
// here may depend on the host's zone.

import { describe, it, expect } from 'vitest'
import {
  hhmm, windowHours, effectiveWindow, buildPublishSnapshot, SNAPSHOT_FORMAT_VERSION,
} from './roster-compare'
import { shiftHours } from './payroll'

const WEEK = ['2026-09-14', '2026-09-20']

// A Morning block on Tue 15 Sep 06:00-07:00. The TEMPLATE says 09:00-10:00 on
// purpose: a window must never fall back to it.
function blk(over = {}) {
  return {
    id: 'b-am-15',
    template_id: 't-am',
    block_date: '2026-09-15',
    start_time: '06:00:00',
    end_time: '07:00:00',
    min_coaches: 1,
    max_coaches: 2,
    shift_templates: { name: 'Morning', kind: 'class', start_time: '09:00:00', end_time: '10:00:00' },
    shift_assignments: [],
    ...over,
  }
}

function asg(pid, over = {}) {
  return {
    id: `a-${pid}`,
    profile_id: pid,
    status: 'scheduled',
    start_time_override: null,
    end_time_override: null,
    arrived_at: null,
    profiles: { full_name: `Coach ${pid.toUpperCase()}` },
    ...over,
  }
}

describe('hhmm', () => {
  it('reads Postgres time text as HH:MM and refuses anything else', () => {
    expect(hhmm('06:00:00')).toBe('06:00')
    expect(hhmm('06:30')).toBe('06:30')
    expect(hhmm('23:59:59.5')).toBe('23:59')
    expect(hhmm('24:00:00')).toBe('24:00')
    expect(hhmm('24:30')).toBeNull()
    expect(hhmm('6:00')).toBeNull()
    expect(hhmm(null)).toBeNull()
    expect(hhmm('late')).toBeNull()
  })
})

describe('windowHours', () => {
  it('counts wall-clock hours, wrapping past midnight, exactly as payroll does', () => {
    for (const [start, end] of [['06:00', '07:00'], ['06:15', '07:45'], ['18:00', '01:00'], ['00:30', '03:30']]) {
      expect(windowHours({ start, end }), `${start}-${end}`).toBe(shiftHours({ start_time: start, end_time: end }))
    }
    expect(windowHours({ start: '18:00', end: '01:00' })).toBe(7)
  })

  it("reads a '24:00' end as midnight", () => {
    expect(windowHours({ start: '22:00', end: '24:00' })).toBe(2)
    // payroll.timeToHours refuses hour 24, so payroll counts this 0h. Pinned
    // so the day someone fixes payroll, this line tells them to delete it
    // (the follow-up in 32-SNAPSHOT.1.md).
    expect(shiftHours({ start_time: '22:00', end_time: '24:00' })).toBe(0)
  })

  it('is 0 for an unreadable window, never NaN', () => {
    expect(windowHours({ start: null, end: '07:00' })).toBe(0)
    expect(windowHours({ start: '06:00', end: 'late' })).toBe(0)
    expect(windowHours(null)).toBe(0)
  })
})

describe('effectiveWindow', () => {
  it("is the coach's override, else the block's own time, never the template", () => {
    const b = blk()
    expect(effectiveWindow(asg('a'), b)).toEqual({ start: '06:00', end: '07:00' })
    expect(effectiveWindow(asg('a', { start_time_override: '06:30:00' }), b)).toEqual({ start: '06:30', end: '07:00' })
    expect(effectiveWindow(asg('a', { end_time_override: '06:45:00' }), b)).toEqual({ start: '06:00', end: '06:45' })
  })
})

describe('buildPublishSnapshot', () => {
  it('records each block and each LIVE coach with their window; a cancelled coach was not published', () => {
    const { snapshot, blockCount, assignmentCount } = buildPublishSnapshot({
      periodStart: WEEK[0],
      periodEnd: WEEK[1],
      blocks: [blk({
        shift_assignments: [
          asg('b'),
          asg('a', { start_time_override: '06:30:00' }),
          asg('c', { status: 'cancelled' }),
          asg('d', { status: 'swapped' }),
        ],
      })],
    })
    expect(blockCount).toBe(1)
    expect(assignmentCount).toBe(3)
    expect(snapshot).toEqual({
      v: SNAPSHOT_FORMAT_VERSION,
      period_start: '2026-09-14',
      period_end: '2026-09-20',
      blocks: [{
        slot: 't-am|2026-09-15',
        block_id: 'b-am-15',
        date: '2026-09-15',
        template_id: 't-am',
        template_name: 'Morning',
        kind: 'class',
        start: '06:00',
        end: '07:00',
        min: 1,
        max: 2,
        coaches: [
          { assignment_id: 'a-a', profile_id: 'a', start: '06:30', end: '07:00', overridden: true },
          { assignment_id: 'a-b', profile_id: 'b', start: '06:00', end: '07:00', overridden: false },
          { assignment_id: 'a-d', profile_id: 'd', start: '06:00', end: '07:00', overridden: false },
        ],
      }],
    })
  })

  it('keeps only the period, in date then start order, and records each kind', () => {
    const { snapshot, blockCount } = buildPublishSnapshot({
      periodStart: WEEK[0],
      periodEnd: WEEK[1],
      blocks: [
        blk({ id: 'x', template_id: 't-pm', start_time: '18:00:00', end_time: '19:00:00', shift_templates: { name: 'Evening', kind: 'class' } }),
        blk({ id: 'y', template_id: 't-desk', block_date: '2026-09-14', start_time: '09:00:00', end_time: '13:00:00', min_coaches: 0, shift_templates: { name: 'Front desk', kind: 'admin' } }),
        blk(),
        blk({ id: 'z', block_date: '2026-09-21' }),
      ],
    })
    expect(blockCount).toBe(3)
    expect(snapshot.blocks.map((b) => [b.date, b.start, b.kind, b.template_name])).toEqual([
      ['2026-09-14', '09:00', 'admin', 'Front desk'],
      ['2026-09-15', '06:00', 'class', 'Morning'],
      ['2026-09-15', '18:00', 'class', 'Evening'],
    ])
  })

  it('survives a JSON round trip unchanged: what jsonb stores is what is read back', () => {
    const { snapshot } = buildPublishSnapshot({ periodStart: WEEK[0], periodEnd: WEEK[1], blocks: [blk({ shift_assignments: [asg('a')] })] })
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
  })

  it('an empty period is an empty snapshot, not an error', () => {
    expect(buildPublishSnapshot({ periodStart: WEEK[0], periodEnd: WEEK[1], blocks: [] })).toEqual({
      snapshot: { v: 1, period_start: '2026-09-14', period_end: '2026-09-20', blocks: [] },
      blockCount: 0,
      assignmentCount: 0,
    })
  })

  it('carries no pay: no rate, cost or salary anywhere in the document', () => {
    const { snapshot } = buildPublishSnapshot({ periodStart: WEEK[0], periodEnd: WEEK[1], blocks: [blk({ shift_assignments: [asg('a')] })] })
    expect(JSON.stringify(snapshot)).not.toMatch(/rate|cost|salary|eur/i)
  })
})
```

Task 3 appends to this same file and reuses `blk`, `asg` and `WEEK`.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/lib/roster-compare.test.js`
Expected: FAIL, `Failed to resolve import "./roster-compare"`.

- [ ] **Step 3: Write the implementation** at `src/lib/roster-compare.js`:

```js
// src/lib/roster-compare.js
// SNAPSHOT.1 — "as published" vs "as finally rostered" vs "as arrived". PURE:
// no IO, every clock and zone is an argument.
//
// THREE VIEWS OF ONE ROSTER
//   as published        roster_publish_snapshots.snapshot (mig 634), written
//                       once when the roster was published and never again.
//   as finally rostered the live shift_blocks + shift_assignments.
//   as arrived          shift_assignments.arrived_at (ARRIVAL.1, mig 609),
//                       carried onto a back-to-back shift exactly as the
//                       attendance report does (inferContinuousArrivals).
//
// MATCHING. A block is matched on its SLOT, (template_id, block_date): the
// unique key shift_blocks carries (mig 067) and the key a deleted slot is
// recorded on (mig 613). Never on its id, so a block deleted and made again for
// the same slot reads as the same shift. A coach is matched on profile_id
// within the slot (unique per block, mig 067). A swap rewrites the
// assignment's profile_id, so the giver reads "removed" and the taker "added":
// that IS the difference between who was published and who is rostered.
//
// WINDOWS. A coach's window is their override, else the BLOCK's own time,
// never the template (the mig 604/622 COALESCE; shared/roster-month.js).
// Hours are WALL-CLOCK minutes, wrapping past midnight when the end is before
// the start, which is payroll.shiftHours's rule, so these totals agree with
// every other hours figure (a shift across a DST change counts its wall-clock
// length there too). One deliberate difference: '24:00' is midnight here;
// payroll.timeToHours refuses hour 24 and counts such a shift 0h.
//
// ENDED / NO ARRIVAL are judged on real instants in the studio's zone
// (wallInstant: DST-exact, '24:00' = the next midnight; an end before the start
// ends on the next day). "No arrival recorded" is ADVISORY: arrival stamps
// exist for a minority of shifts, so it is a prompt to check, never a
// no-show, and nothing here alerts anyone.
//
// NEVER PAY. Times, hours, profile ids, names and arrival stamps only.

import { isLiveAssignment, slotKey } from './roster'
import { shiftKindOf } from '@shared/shift-kind'

export const SNAPSHOT_FORMAT_VERSION = 1

/** 'HH:MM[:SS[.f]]' -> 'HH:MM'; '24:00:00' -> '24:00'; anything else -> null. */
export function hhmm(t) {
  const m = String(t ?? '').match(/^([01]\d|2[0-4]):([0-5]\d)(?::\d{2}(?:\.\d+)?)?$/)
  if (!m) return null
  if (m[1] === '24' && m[2] !== '00') return null
  return `${m[1]}:${m[2]}`
}

function minutesOf(t) {
  const v = hhmm(t)
  if (!v) return null
  return Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5))
}

/** Wall-clock hours of { start, end }, wrapping past midnight. 0 when unreadable. */
export function windowHours(win) {
  const s = minutesOf(win?.start)
  const e = minutesOf(win?.end)
  if (s == null || e == null) return 0
  let d = e - s
  if (d < 0) d += 24 * 60
  return d / 60
}

/** A coach's window on a block: their override, else the block's own time. */
export function effectiveWindow(assignment, block) {
  return {
    start: hhmm(assignment?.start_time_override) || hhmm(block?.start_time),
    end: hhmm(assignment?.end_time_override) || hhmm(block?.end_time),
  }
}

// One shift_blocks row (with shift_templates(name, kind) and
// shift_assignments(...) embedded) -> the snapshot's block shape. Used for the
// published side at publish time AND for the live side at compare time, so the
// two can never be normalised differently.
export function normaliseBlock(b) {
  const coaches = (b.shift_assignments || [])
    .filter((a) => a && a.profile_id && isLiveAssignment(a))
    .map((a) => ({
      assignment_id: a.id ?? null,
      profile_id: a.profile_id,
      ...effectiveWindow(a, b),
      overridden: Boolean(a.start_time_override || a.end_time_override),
    }))
    .sort((x, y) => String(x.profile_id).localeCompare(String(y.profile_id)))
  return {
    slot: slotKey(b.template_id, b.block_date),
    block_id: b.id ?? null,
    date: String(b.block_date).slice(0, 10),
    template_id: b.template_id,
    template_name: b.shift_templates?.name ?? null,
    kind: shiftKindOf(b),
    start: hhmm(b.start_time),
    end: hhmm(b.end_time),
    min: b.min_coaches ?? null,
    max: b.max_coaches ?? null,
    coaches,
  }
}

function snapshotBlockOrder(x, y) {
  return String(x.date).localeCompare(String(y.date))
    || String(x.start ?? '').localeCompare(String(y.start ?? ''))
    || String(x.template_name ?? '').localeCompare(String(y.template_name ?? ''))
    || String(x.slot).localeCompare(String(y.slot))
}

/**
 * The document stored in roster_publish_snapshots.snapshot.
 *
 * @param {{ periodStart: string, periodEnd: string, blocks: object[] }} args
 *   blocks: shift_blocks rows at the location, as loadWindowBlocks returns them
 * @returns {{ snapshot: object, blockCount: number, assignmentCount: number }}
 */
export function buildPublishSnapshot({ periodStart, periodEnd, blocks }) {
  const out = (blocks || [])
    .filter((b) => b && b.template_id && b.block_date)
    .filter((b) => {
      const d = String(b.block_date).slice(0, 10)
      return d >= periodStart && d <= periodEnd
    })
    .map(normaliseBlock)
    .sort(snapshotBlockOrder)
  return {
    snapshot: { v: SNAPSHOT_FORMAT_VERSION, period_start: periodStart, period_end: periodEnd, blocks: out },
    blockCount: out.length,
    assignmentCount: out.reduce((n, b) => n + b.coaches.length, 0),
  }
}
```

- [ ] **Step 4: Run to see it pass, in two zones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/roster-compare.test.js && TZ=America/New_York npx vitest run src/lib/roster-compare.test.js`
Expected: PASS twice (10 tests each).

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-compare.js src/lib/roster-compare.test.js
git commit -m "SNAPSHOT.1 — roster-compare: effective windows, wall-clock hours, and the snapshot document (pure)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The pure model, part 2: comparing a snapshot with the live roster and the arrivals

**Files:**
- Modify: `src/lib/roster-compare.js` (append)
- Modify: `src/lib/roster-compare.test.js` (append)

- [ ] **Step 1: Append the failing tests** to `src/lib/roster-compare.test.js`. Add `clipWindow, compareSnapshot` to the existing import from `./roster-compare` (the import line becomes `hhmm, windowHours, effectiveWindow, buildPublishSnapshot, clipWindow, compareSnapshot, SNAPSHOT_FORMAT_VERSION,`), then append:

```js
// ── compareSnapshot ───────────────────────────────────────────────────────

const AFTER_WEEK = Date.UTC(2026, 8, 25, 12) // Fri 25 Sep 12:00Z: every shift in WEEK has ended

function snap(blocks, [from, to] = WEEK) {
  return buildPublishSnapshot({ periodStart: from, periodEnd: to, blocks }).snapshot
}

function cmp(snapshot, current, extra = {}) {
  return compareSnapshot({ snapshot, currentBlocks: current, nowMs: AFTER_WEEK, tz: 'Europe/Dublin', ...extra })
}

function coach(result, date, pid) {
  for (const b of result.blocks) {
    if (b.date !== date) continue
    const r = b.coaches.find((c) => c.profile_id === pid)
    if (r) return r
  }
  return undefined
}

function changes(result) {
  return Object.fromEntries(result.blocks.flatMap((b) => b.coaches.map((c) => [c.profile_id, c.change])))
}

// An Evening block on the same Tuesday.
function pm(over = {}) {
  return blk({
    id: 'b-pm-15', template_id: 't-pm', start_time: '18:00:00', end_time: '19:00:00',
    shift_templates: { name: 'Evening', kind: 'class' }, ...over,
  })
}

describe('clipWindow', () => {
  const s = { period_start: '2026-09-14', period_end: '2026-09-20' }
  it('is the published period when nothing narrower is asked', () => {
    expect(clipWindow(s, null, null)).toEqual({ from: '2026-09-14', to: '2026-09-20' })
  })
  it('narrows to the period asked, never past the published one', () => {
    expect(clipWindow(s, '2026-09-17', '2026-09-30')).toEqual({ from: '2026-09-17', to: '2026-09-20' })
    expect(clipWindow(s, '2026-09-01', '2026-09-15')).toEqual({ from: '2026-09-14', to: '2026-09-15' })
  })
  it('is null when the two do not overlap', () => {
    expect(clipWindow(s, '2026-10-01', '2026-10-07')).toBeNull()
  })
})

describe('compareSnapshot — change classes', () => {
  it('nothing changed: every coach unchanged, hours equal', () => {
    const blocks = [blk({ shift_assignments: [asg('a'), asg('b')] })]
    const r = cmp(snap(blocks), blocks)
    expect(r.window).toEqual({ from: '2026-09-14', to: '2026-09-20' })
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({ change: 'unchanged', staffing_changed: false, template_name: 'Morning', kind: 'class' })
    expect(r.blocks[0].coaches.map((c) => [c.name, c.change])).toEqual([['Coach A', 'unchanged'], ['Coach B', 'unchanged']])
    expect(r.totals).toMatchObject({
      published_shifts: 2, current_shifts: 2, published_hours: 2, current_hours: 2, hours_delta: 0,
      unchanged: 2, moved: 0, added: 0, removed: 0,
    })
  })

  it("a coach whose window changed after publish is 'moved', with both windows", () => {
    const pub = [blk({ shift_assignments: [asg('a')] })]
    const now = [blk({ shift_assignments: [asg('a', { start_time_override: '06:30:00' })] })]
    expect(coach(cmp(snap(pub), now), '2026-09-15', 'a')).toMatchObject({
      change: 'moved', published: { start: '06:00', end: '07:00' }, current: { start: '06:30', end: '07:00' },
    })
  })

  it('a block moved after publish moves every coach on it, and the block says so', () => {
    const pub = [blk({ shift_assignments: [asg('a')] })]
    const now = [blk({ start_time: '07:00:00', end_time: '08:00:00', shift_assignments: [asg('a')] })]
    const r = cmp(snap(pub), now)
    expect(r.blocks[0]).toMatchObject({
      change: 'moved',
      published: { start: '06:00', end: '07:00' },
      current: { start: '07:00', end: '08:00' },
    })
    expect(r.blocks[0].coaches[0].change).toBe('moved')
    expect(r.totals.blocks_moved).toBe(1)
  })

  it('a minimum or maximum changed after publish is flagged on the block, times unchanged', () => {
    const r = cmp(snap([blk()]), [blk({ min_coaches: 2, max_coaches: 3 })])
    expect(r.blocks[0]).toMatchObject({
      change: 'unchanged', staffing_changed: true,
      published: { min: 1, max: 2 }, current: { min: 2, max: 3 },
    })
    expect(r.totals.blocks_staffing_changed).toBe(1)
  })

  it('coaches added and removed after publish; a cancelled assignment reads as removed', () => {
    const pub = [blk({ shift_assignments: [asg('a'), asg('b')] })]
    const now = [blk({ shift_assignments: [asg('a'), asg('b', { status: 'cancelled' }), asg('c')] })]
    const r = cmp(snap(pub), now)
    expect(coach(r, '2026-09-15', 'b')).toMatchObject({ change: 'removed', current: null, name: 'Coach B' })
    expect(coach(r, '2026-09-15', 'c')).toMatchObject({ change: 'added', published: null, current: { start: '06:00', end: '07:00' } })
    expect(r.totals).toMatchObject({ added: 1, removed: 1, unchanged: 1 })
  })

  it('a swap reads as the giver removed and the taker added', () => {
    const pub = [blk({ shift_assignments: [asg('a')] })]
    // A swap rewrites profile_id on the SAME row and marks it swapped.
    const now = [blk({ shift_assignments: [asg('b', { id: 'a-a', status: 'swapped' })] })]
    expect(changes(cmp(snap(pub), now))).toEqual({ a: 'removed', b: 'added' })
  })

  it('a block removed after publish, and one added after publish', () => {
    const pub = [blk({ shift_assignments: [asg('a')] }), pm()]
    const now = [blk({
      id: 'b-sat', template_id: 't-sat', block_date: '2026-09-19', start_time: '09:00:00', end_time: '10:00:00',
      shift_templates: { name: 'Saturday', kind: 'class' }, shift_assignments: [asg('c')],
    })]
    const r = cmp(snap(pub), now)
    const byName = Object.fromEntries(r.blocks.map((b) => [b.template_name, b]))
    expect(byName.Morning).toMatchObject({ change: 'removed', current: null })
    expect(byName.Morning.coaches[0]).toMatchObject({ profile_id: 'a', change: 'removed' })
    expect(byName.Evening).toMatchObject({ change: 'removed', coaches: [] })
    expect(byName.Saturday).toMatchObject({ change: 'added', published: null })
    expect(byName.Saturday.coaches[0]).toMatchObject({ profile_id: 'c', change: 'added' })
    expect(r.totals).toMatchObject({ blocks_removed: 2, blocks_added: 1 })
  })

  it('a block deleted and made again for the same slot (new ids) is the same shift', () => {
    const r = cmp(
      snap([blk({ shift_assignments: [asg('a')] })]),
      [blk({ id: 'b-new', shift_assignments: [asg('a', { id: 'a-new' })] })],
    )
    expect(r.blocks[0].change).toBe('unchanged')
    expect(coach(r, '2026-09-15', 'a').change).toBe('unchanged')
  })

  it('hours: published against now, and the difference', () => {
    const pub = [
      blk({ shift_assignments: [asg('a'), asg('b')] }),
      pm({ end_time: '20:00:00', shift_assignments: [asg('a')] }),
    ]
    const now = [
      blk({ shift_assignments: [asg('a', { end_time_override: '06:30:00' })] }),
      pm({ end_time: '20:00:00', shift_assignments: [asg('a'), asg('c')] }),
    ]
    // published: a 1h + b 1h + a 2h = 4h; now: a 0.5h + a 2h + c 2h = 4.5h
    expect(cmp(snap(pub), now).totals).toMatchObject({
      published_shifts: 3, published_hours: 4, current_shifts: 3, current_hours: 4.5, hours_delta: 0.5,
    })
  })

  it('names a coach who is no longer on the roster from the names map, else null', () => {
    const pub = [blk({ shift_assignments: [asg('a'), asg('z')] })]
    const now = [blk({ shift_assignments: [asg('a')] })]
    expect(coach(cmp(snap(pub), now, { names: { z: 'Zoe' } }), '2026-09-15', 'z').name).toBe('Zoe')
    expect(coach(cmp(snap(pub), now), '2026-09-15', 'z').name).toBeNull()
  })

  it('orders shifts by date, then start', () => {
    const blocks = [pm({ shift_assignments: [asg('a')] }), blk({ shift_assignments: [asg('a')] }), blk({ id: 'b-14', block_date: '2026-09-14' })]
    expect(cmp(snap(blocks), blocks).blocks.map((b) => `${b.date} ${(b.current || b.published).start}`))
      .toEqual(['2026-09-14 06:00', '2026-09-15 06:00', '2026-09-15 18:00'])
  })

  it('carries no pay', () => {
    const blocks = [blk({ shift_assignments: [asg('a')] })]
    expect(JSON.stringify(cmp(snap(blocks), blocks))).not.toMatch(/rate|cost|salary|eur/i)
  })
})

describe('compareSnapshot — the window', () => {
  it('narrows both sides to the period on screen, clipped to what was published', () => {
    const blocks = [blk({ shift_assignments: [asg('a')] }), blk({ id: 'b-19', block_date: '2026-09-19', shift_assignments: [asg('b')] })]
    const r = cmp(snap(blocks), blocks, { from: '2026-09-17', to: '2026-09-30' })
    expect(r.window).toEqual({ from: '2026-09-17', to: '2026-09-20' })
    expect(r.blocks.map((b) => b.date)).toEqual(['2026-09-19'])
    expect(r.totals.published_shifts).toBe(1)
  })

  it('a window that misses the published period is null, with nothing in it', () => {
    const r = cmp(snap([blk()]), [blk()], { from: '2026-10-01', to: '2026-10-07' })
    expect(r.window).toBeNull()
    expect(r.blocks).toEqual([])
    expect(r.totals.published_shifts).toBe(0)
  })
})

describe('compareSnapshot — as arrived (advisory)', () => {
  it("an arrival stamp is shown in the studio's own time", () => {
    const now = [blk({ shift_assignments: [asg('a', { arrived_at: '2026-09-15T04:58:00Z' })] })]
    expect(coach(cmp(snap(now), now), '2026-09-15', 'a')).toMatchObject({
      arrived_at: '2026-09-15T04:58:00.000Z', arrived_local: '05:58', arrival_inferred: false,
      ended: true, no_show_candidate: false,
    })
  })

  it('an ended shift with no arrival is a no-show CANDIDATE; a back-to-back shift inherits the arrival', () => {
    const blocks = [
      blk({ shift_assignments: [asg('a', { arrived_at: '2026-09-15T04:55:00Z' }), asg('b')] }),
      blk({
        id: 'b-mid', template_id: 't-mid', start_time: '07:00:00', end_time: '08:00:00',
        shift_templates: { name: 'Midmorning', kind: 'class' }, shift_assignments: [asg('a', { id: 'a-a2' })],
      }),
    ]
    const r = cmp(snap(blocks), blocks)
    const [am, mid] = r.blocks
    expect(am.coaches.find((c) => c.profile_id === 'b')).toMatchObject({ ended: true, arrived_at: null, no_show_candidate: true })
    expect(mid.coaches[0]).toMatchObject({ arrival_inferred: true, arrived_local: '05:55', no_show_candidate: false })
    expect(r.totals).toMatchObject({ ended: 3, arrived: 2, arrived_inferred: 1, no_show_candidates: 1 })
  })

  it('a shift that has not ended is never a candidate, and a removed coach never is', () => {
    const period = ['2026-09-14', '2026-09-30']
    const pub = [blk({ block_date: '2026-09-28', shift_assignments: [asg('a'), asg('b')] })]
    const now = [blk({ block_date: '2026-09-28', shift_assignments: [asg('a')] })]
    const r = cmp(snap(pub, period), now)
    expect(coach(r, '2026-09-28', 'a')).toMatchObject({ ended: false, no_show_candidate: false })
    expect(coach(r, '2026-09-28', 'b')).toMatchObject({ change: 'removed', ended: false, no_show_candidate: false })
    expect(r.totals.ended).toBe(0)
  })
})

describe('compareSnapshot — clocks', () => {
  it("judges 'ended' on the studio's clock across the spring change (29 Mar 2026: 07:00 IST is 06:00Z)", () => {
    const b = [blk({ block_date: '2026-03-29', shift_assignments: [asg('a')] })]
    const s = snap(b, ['2026-03-23', '2026-03-29'])
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 2, 29, 5, 59) }), '2026-03-29', 'a').ended).toBe(false)
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 2, 29, 6, 0) }), '2026-03-29', 'a').ended).toBe(true)
  })

  it('and in winter 07:00 is 07:00Z', () => {
    const b = [blk({ block_date: '2026-11-02', shift_assignments: [asg('a')] })]
    const s = snap(b, ['2026-11-02', '2026-11-08'])
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 10, 2, 6, 30) }), '2026-11-02', 'a').ended).toBe(false)
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 10, 2, 7, 0) }), '2026-11-02', 'a').ended).toBe(true)
  })

  it('counts a shift across the spring change at its wall-clock length, as payroll does', () => {
    const b = [blk({ block_date: '2026-03-29', start_time: '00:30:00', end_time: '03:30:00', shift_assignments: [asg('a')] })]
    expect(cmp(snap(b, ['2026-03-23', '2026-03-29']), b).totals.current_hours).toBe(3)
  })

  it('an overnight window (end before start) counts past midnight and ends the next morning', () => {
    const b = [blk({ start_time: '18:00:00', end_time: '23:00:00', shift_assignments: [asg('a', { end_time_override: '01:00:00' })] })]
    const s = snap(b)
    expect(cmp(s, b).totals.current_hours).toBe(7)
    // 01:00 on Wed 16 Sep, Irish Standard (summer) Time, is 00:00Z.
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 8, 15, 23, 59) }), '2026-09-15', 'a').ended).toBe(false)
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 8, 16, 0, 0) }), '2026-09-15', 'a').ended).toBe(true)
  })

  it("a '24:00' end is the next midnight", () => {
    const b = [blk({ start_time: '22:00:00', end_time: '24:00:00', shift_assignments: [asg('a')] })]
    const s = snap(b)
    expect(cmp(s, b).totals.current_hours).toBe(2)
    // Midnight starting Wed 16 Sep is 23:00Z on the 15th.
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 8, 15, 22, 59) }), '2026-09-15', 'a').ended).toBe(false)
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 8, 15, 23, 0) }), '2026-09-15', 'a').ended).toBe(true)
  })

  it('an unknown studio zone falls back to Dublin rather than throwing', () => {
    const b = [blk({ shift_assignments: [asg('a', { arrived_at: '2026-09-15T04:58:00Z' })] })]
    expect(coach(cmp(snap(b), b, { tz: 'Mars/Olympus' }), '2026-09-15', 'a').arrived_local).toBe('05:58')
  })
})

describe('compareSnapshot — re-published twice', () => {
  // Publish 1: A on the Morning, B on the Evening.
  // Then A moves to 06:30 and C joins the Morning. Publish 2.
  // Then B is taken off the Evening and D joins it. Nobody publishes again.
  const p1 = [blk({ shift_assignments: [asg('a')] }), pm({ shift_assignments: [asg('b')] })]
  const p2 = [blk({ shift_assignments: [asg('a', { start_time_override: '06:30:00' }), asg('c')] }), pm({ shift_assignments: [asg('b')] })]
  const now = [
    blk({ shift_assignments: [asg('a', { start_time_override: '06:30:00' }), asg('c')] }),
    pm({ shift_assignments: [asg('b', { status: 'cancelled' }), asg('d')] }),
  ]
  const s1 = snap(p1)
  const s2 = snap(p2)

  it('against the FIRST publish: everything since it', () => {
    expect(changes(cmp(s1, now))).toEqual({ a: 'moved', b: 'removed', c: 'added', d: 'added' })
  })

  it('against the LATEST publish: only what changed since it', () => {
    expect(changes(cmp(s2, now))).toEqual({ a: 'unchanged', b: 'removed', c: 'unchanged', d: 'added' })
  })

  it('each snapshot is its own record: publish 2 against publish 1 shows exactly its edits', () => {
    expect(changes(cmp(s1, p2))).toEqual({ a: 'moved', b: 'unchanged', c: 'added' })
  })
})
```

- [ ] **Step 2: Run to see the new tests fail**

Run: `npx vitest run src/lib/roster-compare.test.js`
Expected: FAIL, `clipWindow is not a function` / `compareSnapshot is not a function` (Task 2's tests still pass).

- [ ] **Step 3: Append the implementation** to `src/lib/roster-compare.js`. First extend the imports at the top of the file to:

```js
import { isLiveAssignment, slotKey } from './roster'
import { shiftKindOf } from '@shared/shift-kind'
import { wallInstant } from './staff-calendar-feed'
import { resolveTz } from './tz-time'
import { addDaysISO } from './dublin-time'
import { inferContinuousArrivals, arrivalToTimeOnly } from './staff-attendance'
```

Then append:

```js
export const COMPARE_CHANGES = Object.freeze(['unchanged', 'moved', 'added', 'removed'])

/** The published period narrowed to [from, to]; null when they do not overlap. */
export function clipWindow(snapshot, from, to) {
  const lo = from && from > snapshot.period_start ? from : snapshot.period_start
  const hi = to && to < snapshot.period_end ? to : snapshot.period_end
  return lo <= hi ? { from: lo, to: hi } : null
}

function sameWindow(a, b) {
  return (a?.start ?? null) === (b?.start ?? null) && (a?.end ?? null) === (b?.end ?? null)
}

function changeOf(was, now) {
  if (!was) return 'added'
  if (!now) return 'removed'
  return sameWindow(was, now) ? 'unchanged' : 'moved'
}

// The instant a window ends in `tz`: an end before the start is the next day's
// wall clock ('24:00' compares after every start, and wallInstant reads it as
// the next midnight).
function endInstant(date, win, tz) {
  if (!win?.start || !win?.end) return null
  const endDate = win.end < win.start ? addDaysISO(date, 1) : date
  return wallInstant(endDate, win.end, tz)
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function emptyTotals() {
  return {
    published_shifts: 0, published_hours: 0,
    current_shifts: 0, current_hours: 0, hours_delta: 0,
    unchanged: 0, moved: 0, added: 0, removed: 0,
    ended: 0, arrived: 0, arrived_inferred: 0, no_show_candidates: 0,
    blocks_added: 0, blocks_removed: 0, blocks_moved: 0, blocks_staffing_changed: 0,
  }
}

function coachOrder(x, y) {
  return String(x.name ?? '￿').localeCompare(String(y.name ?? '￿'))
    || String(x.profile_id).localeCompare(String(y.profile_id))
}

function compareBlockOrder(x, y) {
  const xs = (x.current || x.published)?.start ?? ''
  const ys = (y.current || y.published)?.start ?? ''
  return String(x.date).localeCompare(String(y.date))
    || String(xs).localeCompare(String(ys))
    || String(x.template_name ?? '').localeCompare(String(y.template_name ?? ''))
    || String(x.slot).localeCompare(String(y.slot))
}

/**
 * A snapshot against the live roster and its arrival stamps.
 *
 * @param {object} args
 * @param {object} args.snapshot       roster_publish_snapshots.snapshot (format 1)
 * @param {object[]} args.currentBlocks live shift_blocks rows (loadWindowBlocks shape,
 *                                      assignments embedded with arrived_at and profiles(full_name))
 * @param {string|null} [args.from]    YYYY-MM-DD; narrows the window
 * @param {string|null} [args.to]
 * @param {number} args.nowMs          what "ended" is judged against
 * @param {string|null} [args.tz]      locations.timezone; unknown -> Europe/Dublin
 * @param {Record<string,string>} [args.names]  profile_id -> full_name for coaches
 *                                      not on the live roster any more
 * @returns {{ window: {from,to}|null, blocks: object[], totals: object }}
 */
export function compareSnapshot({ snapshot, currentBlocks, from = null, to = null, nowMs = Date.now(), tz = null, names = {} }) {
  const zone = resolveTz(tz)
  const totals = emptyTotals()
  const window = snapshot ? clipWindow(snapshot, from, to) : null
  if (!window) return { window: null, blocks: [], totals }
  const inWindow = (d) => d >= window.from && d <= window.to

  const published = new Map()
  for (const b of snapshot.blocks || []) if (inWindow(b.date)) published.set(b.slot, b)

  const current = new Map()
  const arrivals = new Map() // `${slot}|${profile_id}` -> arrived_at of the LIVE assignment
  const nameOf = { ...names }
  for (const raw of currentBlocks || []) {
    if (!raw?.template_id || !raw?.block_date) continue
    const b = normaliseBlock(raw)
    if (!inWindow(b.date)) continue
    current.set(b.slot, b)
    for (const a of raw.shift_assignments || []) {
      if (!a?.profile_id) continue
      // Any embedded row names its coach, cancelled or not: a removed coach
      // still reads by name.
      if (a.profiles?.full_name && !nameOf[a.profile_id]) nameOf[a.profile_id] = a.profiles.full_name
      if (isLiveAssignment(a) && a.arrived_at) arrivals.set(`${b.slot}|${a.profile_id}`, a.arrived_at)
    }
  }

  const blocks = []
  const timed = [] // rows on the live roster, for the arrival carry-over
  for (const slot of new Set([...published.keys(), ...current.keys()])) {
    const p = published.get(slot) || null
    const c = current.get(slot) || null
    const block = {
      slot,
      date: (c || p).date,
      template_name: c?.template_name ?? p?.template_name ?? null,
      kind: (c || p).kind,
      published: p ? { start: p.start, end: p.end, min: p.min, max: p.max } : null,
      current: c ? { start: c.start, end: c.end, min: c.min, max: c.max } : null,
      change: changeOf(p, c),
      staffing_changed: Boolean(p && c && (p.min !== c.min || p.max !== c.max)),
      coaches: [],
    }
    const was = new Map((p?.coaches || []).map((x) => [x.profile_id, x]))
    const now = new Map((c?.coaches || []).map((x) => [x.profile_id, x]))
    for (const pid of new Set([...was.keys(), ...now.keys()])) {
      const w = was.get(pid) || null
      const n = now.get(pid) || null
      const row = {
        profile_id: pid,
        name: nameOf[pid] ?? null,
        published: w ? { start: w.start, end: w.end } : null,
        current: n ? { start: n.start, end: n.end } : null,
        change: changeOf(w, n),
        arrived_at: null,
        arrived_local: null,
        arrival_inferred: false,
        ended: false,
        no_show_candidate: false,
      }
      if (n) {
        const arrivedMs = Date.parse(arrivals.get(`${slot}|${pid}`) || '')
        timed.push({
          row,
          profileId: pid,
          blockDate: c.date,
          scheduledAt: wallInstant(c.date, n.start, zone),
          scheduledEndAt: endInstant(c.date, n, zone),
          arrivalAt: Number.isFinite(arrivedMs) ? arrivedMs : null,
        })
      }
      block.coaches.push(row)
    }
    block.coaches.sort(coachOrder)
    blocks.push(block)
  }

  // The attendance report's rule: a shift with no stamp inherits the same
  // coach's previous shift's arrival that day when the gap is at most an hour.
  // Returned in input order.
  inferContinuousArrivals(timed).forEach((r, i) => {
    const row = timed[i].row
    row.ended = Number.isFinite(r.scheduledEndAt) && r.scheduledEndAt <= nowMs
    if (Number.isFinite(r.arrivalAt)) {
      row.arrived_at = new Date(r.arrivalAt).toISOString()
      row.arrived_local = (arrivalToTimeOnly(r.arrivalAt, zone) || '').slice(0, 5) || null
      row.arrival_inferred = Boolean(r.arrivalInferred)
    }
    row.no_show_candidate = row.ended && !row.arrived_at
  })

  blocks.sort(compareBlockOrder)

  for (const b of blocks) {
    if (b.change === 'added') totals.blocks_added += 1
    else if (b.change === 'removed') totals.blocks_removed += 1
    else if (b.change === 'moved') totals.blocks_moved += 1
    if (b.staffing_changed) totals.blocks_staffing_changed += 1
    for (const r of b.coaches) {
      totals[r.change] += 1
      if (r.published) {
        totals.published_shifts += 1
        totals.published_hours += windowHours(r.published)
      }
      if (r.current) {
        totals.current_shifts += 1
        totals.current_hours += windowHours(r.current)
      }
      if (r.ended) {
        totals.ended += 1
        if (r.arrived_at) {
          totals.arrived += 1
          if (r.arrival_inferred) totals.arrived_inferred += 1
        } else {
          totals.no_show_candidates += 1
        }
      }
    }
  }
  totals.published_hours = round2(totals.published_hours)
  totals.current_hours = round2(totals.current_hours)
  totals.hours_delta = round2(totals.current_hours - totals.published_hours)

  return { window, blocks, totals }
}
```

- [ ] **Step 4: Run to see it pass, in two zones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/roster-compare.test.js && TZ=America/New_York npx vitest run src/lib/roster-compare.test.js`
Expected: PASS twice (39 tests each: Task 2's 10 plus these 29).

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-compare.js src/lib/roster-compare.test.js
git commit -m "SNAPSHOT.1 — roster-compare: a snapshot against the live roster and its arrival stamps (slot matching, DST, overnight, re-published twice)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: IO part 1: read the period's blocks, write the snapshot (best-effort)

**Files:**
- Create: `src/lib/roster-snapshot.js`
- Create: `src/lib/roster-snapshot.test.js`

- [ ] **Step 1: Write the failing tests** at `src/lib/roster-snapshot.test.js`:

```js
// src/lib/roster-snapshot.test.js
// SNAPSHOT.1 — the IO around roster_publish_snapshots, against a recording
// fake client. The fake answers every awaited chain through `handler(q)`,
// where q = { table, ops: [[op, ...args], …] }; a handler that throws makes
// the await reject (a dropped connection, a PostgREST 5xx).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { logError, logWarn } = await import('./log')
const { writePublishSnapshot, loadWindowBlocks, SNAPSHOT_BLOCK_PAGE } = await import('./roster-snapshot')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const ROSTER = {
  id: 'r-1', location_id: LOC, status: 'published',
  period_start: '2026-09-14', period_end: '2026-09-20',
  published_at: '2026-09-12T13:02:00+00:00', published_by: 'mgr-1',
}

function fakeDb(handler) {
  const log = []
  return {
    log,
    from(table) {
      const q = { table, ops: [] }
      log.push(q)
      const b = {}
      for (const op of ['select', 'insert', 'eq', 'gte', 'lte', 'in', 'order', 'range', 'limit', 'maybeSingle']) {
        b[op] = (...args) => { q.ops.push([op, ...args]); return b }
      }
      b.then = (onF, onR) => Promise.resolve().then(() => handler(q)).then(onF, onR)
      return b
    },
  }
}

const opsOf = (q, name) => q.ops.filter(([op]) => op === name)
const insertsOf = (db) => db.log.filter((q) => opsOf(q, 'insert').length > 0).map((q) => opsOf(q, 'insert')[0][1])

function block(i, over = {}) {
  return {
    id: `b${i}`, block_date: '2026-09-15', template_id: `t${i}`,
    start_time: '06:00:00', end_time: '07:00:00', min_coaches: 1, max_coaches: 2,
    shift_templates: { name: 'Morning', kind: 'class' }, shift_assignments: [], ...over,
  }
}

beforeEach(() => {
  logError.mockClear()
  logWarn.mockClear()
})

describe('loadWindowBlocks', () => {
  it('pages past the 1,000-row cap in a stable order, scoped to the studio and the dates', async () => {
    const all = Array.from({ length: SNAPSHOT_BLOCK_PAGE + 1 }, (_, i) => block(i))
    const db = fakeDb((q) => {
      const [[, lo, hi]] = opsOf(q, 'range')
      return { data: all.slice(lo, hi + 1), error: null }
    })
    const { blocks, error } = await loadWindowBlocks(db, { locationId: LOC, from: '2026-09-14', to: '2026-09-20' })
    expect(error).toBeNull()
    expect(blocks).toHaveLength(SNAPSHOT_BLOCK_PAGE + 1)
    expect(db.log.map((q) => opsOf(q, 'range')[0])).toEqual([['range', 0, 999], ['range', 1000, 1999]])
    for (const q of db.log) {
      expect(q.table).toBe('shift_blocks')
      expect(q.ops).toContainEqual(['eq', 'location_id', LOC])
      expect(q.ops).toContainEqual(['gte', 'block_date', '2026-09-14'])
      expect(q.ops).toContainEqual(['lte', 'block_date', '2026-09-20'])
      expect(opsOf(q, 'order').map(([, col]) => col)).toEqual(['block_date', 'id'])
    }
  })

  it('a failed page is an error, never a short roster', async () => {
    const db = fakeDb(() => ({ data: null, error: { message: 'timeout' } }))
    await expect(loadWindowBlocks(db, { locationId: LOC, from: '2026-09-14', to: '2026-09-20' }))
      .resolves.toEqual({ blocks: null, error: { message: 'timeout' } })
  })
})

describe('writePublishSnapshot', () => {
  it("reads the roster's period and inserts one snapshot row", async () => {
    const db = fakeDb((q) => {
      if (q.table === 'shift_blocks') {
        return { data: [block(1, { shift_assignments: [{ id: 'a1', profile_id: 'p1', status: 'scheduled' }] }), block(2)], error: null }
      }
      if (q.table === 'roster_publish_snapshots') return { data: null, error: null }
      throw new Error(`unexpected table ${q.table}`)
    })
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: true })
    const [row] = insertsOf(db)
    expect(insertsOf(db)).toHaveLength(1)
    expect(row).toMatchObject({
      roster_id: 'r-1', location_id: LOC, period_start: '2026-09-14', period_end: '2026-09-20',
      published_at: '2026-09-12T13:02:00+00:00', published_by: 'mgr-1',
      format_version: 1, block_count: 2, assignment_count: 1,
    })
    expect(row.snapshot.blocks).toHaveLength(2)
    expect(row.snapshot.blocks[0].coaches[0]).toMatchObject({ profile_id: 'p1', start: '06:00', end: '07:00' })
    const read = db.log.find((q) => q.table === 'shift_blocks')
    expect(read.ops).toContainEqual(['gte', 'block_date', '2026-09-14'])
    expect(read.ops).toContainEqual(['lte', 'block_date', '2026-09-20'])
    expect(logError).not.toHaveBeenCalled()
  })

  it('retries a failed insert once', async () => {
    let attempts = 0
    const db = fakeDb((q) => {
      if (q.table === 'shift_blocks') return { data: [block(1)], error: null }
      attempts += 1
      return attempts === 1 ? { data: null, error: { code: '57014', message: 'statement timeout' } } : { data: null, error: null }
    })
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: true })
    expect(insertsOf(db)).toHaveLength(2)
    expect(logError).not.toHaveBeenCalled()
  })

  it('a duplicate on the retry means the first attempt landed and only its answer was lost', async () => {
    let attempts = 0
    const db = fakeDb((q) => {
      if (q.table === 'shift_blocks') return { data: [block(1)], error: null }
      attempts += 1
      if (attempts === 1) throw new Error('fetch failed')
      return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "roster_publish_snapshots_roster_id_key"' } }
    })
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: true, duplicate: true })
  })

  it('two failures: logged loudly with the roster, reported, never thrown', async () => {
    const db = fakeDb((q) => (q.table === 'shift_blocks'
      ? { data: [block(1)], error: null }
      : { data: null, error: { code: '42P01', message: 'relation "public.roster_publish_snapshots" does not exist' } }))
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: false, reason: 'insert_failed' })
    expect(insertsOf(db)).toHaveLength(2)
    expect(logError).toHaveBeenCalledWith(
      'roster-snapshot',
      expect.stringMatching(/not saved/),
      expect.objectContaining({ roster_id: 'r-1', location_id: LOC }),
    )
  })

  it('a failed block read inserts nothing and logs', async () => {
    const db = fakeDb((q) => (q.table === 'shift_blocks' ? { data: null, error: { message: 'boom' } } : { data: null, error: null }))
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: false, reason: 'read_failed' })
    expect(insertsOf(db)).toHaveLength(0)
    expect(logError).toHaveBeenCalledWith('roster-snapshot', expect.stringMatching(/block read failed/), expect.objectContaining({ roster_id: 'r-1' }))
  })

  it('an incomplete roster row is refused without a query', async () => {
    const db = fakeDb(() => { throw new Error('should not query') })
    await expect(writePublishSnapshot(db, { id: 'r-1' })).resolves.toEqual({ saved: false, reason: 'bad_roster' })
    expect(db.log).toHaveLength(0)
    expect(logError).toHaveBeenCalled()
  })

  it('falls back to now for a missing published_at rather than refusing (the column is NOT NULL)', async () => {
    const db = fakeDb((q) => (q.table === 'shift_blocks' ? { data: [], error: null } : { data: null, error: null }))
    await writePublishSnapshot(db, { ...ROSTER, published_at: null })
    expect(Number.isFinite(Date.parse(insertsOf(db)[0].published_at))).toBe(true)
  })

  it('never throws, even when the client itself throws', async () => {
    const db = { from() { throw new Error('client gone') } }
    await expect(writePublishSnapshot(db, ROSTER)).resolves.toEqual({ saved: false, reason: 'threw' })
    expect(logError).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/lib/roster-snapshot.test.js`
Expected: FAIL, `Failed to resolve import "./roster-snapshot"`.

- [ ] **Step 3: Write the implementation** at `src/lib/roster-snapshot.js`:

```js
// src/lib/roster-snapshot.js
// SNAPSHOT.1 — the IO around roster_publish_snapshots (mig 634). The rules
// live in the pure src/lib/roster-compare.js; this file only reads and writes.
//
// WRITE (writePublishSnapshot) is BEST-EFFORT and NEVER THROWS. A publish is a
// chain of separate PostgREST writes with no transaction to join (see
// src/app/api/schedule/rosters/route.js), and CLAUDE.md's rule is that removing
// a silent failure must never create a louder one: failing a publish over a
// lost audit record would leave coaches untold about their week. So: one
// retry, a unique violation on the retry = the first attempt landed, and a
// failure is logged with logError (module 'roster-snapshot', roster_id,
// location_id) and returned, never thrown. The compare view then says the
// snapshot "could not be saved at the time" instead of comparing against
// nothing.
//
// READS page past the 1,000-row cap with a stable order (CLAUDE.md), and every
// read is scoped to the roster's location_id. Service role only; the caller
// has already checked the manager's access to that location.

import { buildPublishSnapshot, SNAPSHOT_FORMAT_VERSION } from './roster-compare'
import { logError } from './log'

export const SNAPSHOT_BLOCK_PAGE = 1000

/**
 * Every shift block at a studio in [from, to], with its template's name and
 * kind and every assignment (arrival stamp and name included). Paged.
 *
 * @returns {Promise<{ blocks: object[]|null, error: object|null }>}
 */
export async function loadWindowBlocks(db, { locationId, from, to }) {
  const blocks = []
  for (let offset = 0; ; offset += SNAPSHOT_BLOCK_PAGE) {
    const { data, error } = await db
      .from('shift_blocks')
      .select(`
        id, block_date, template_id, start_time, end_time, min_coaches, max_coaches,
        shift_templates(name, kind),
        shift_assignments(id, profile_id, status, start_time_override, end_time_override, arrived_at, profiles:profile_id(full_name))
      `)
      .eq('location_id', locationId)
      .gte('block_date', from)
      .lte('block_date', to)
      .order('block_date', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + SNAPSHOT_BLOCK_PAGE - 1)
    if (error) return { blocks: null, error }
    const page = data || []
    blocks.push(...page)
    if (page.length < SNAPSHOT_BLOCK_PAGE) break
  }
  return { blocks, error: null }
}

/**
 * Record what a publish published. Call AFTER the publish has tagged the
 * period's blocks with the roster's id, and only then.
 *
 * @param {object} roster  the rosters row as the publish wrote it:
 *                         { id, location_id, period_start, period_end, published_at, published_by }
 * @returns {Promise<{ saved: true, duplicate?: true } | { saved: false, reason: string }>}
 */
export async function writePublishSnapshot(db, roster) {
  const meta = { roster_id: roster?.id ?? null, location_id: roster?.location_id ?? null }
  try {
    if (!roster?.id || !roster?.location_id || !roster?.period_start || !roster?.period_end) {
      logError('roster-snapshot', 'publish snapshot not saved: the roster row is incomplete', meta)
      return { saved: false, reason: 'bad_roster' }
    }

    const { blocks, error: readErr } = await loadWindowBlocks(db, {
      locationId: roster.location_id,
      from: roster.period_start,
      to: roster.period_end,
    })
    if (readErr) {
      logError('roster-snapshot', 'publish snapshot not saved: block read failed', { ...meta, err: readErr })
      return { saved: false, reason: 'read_failed' }
    }

    const built = buildPublishSnapshot({ periodStart: roster.period_start, periodEnd: roster.period_end, blocks })
    const row = {
      roster_id: roster.id,
      location_id: roster.location_id,
      period_start: roster.period_start,
      period_end: roster.period_end,
      // Both publish paths stamp published_at; the fallback only keeps a NOT
      // NULL column from turning a missing stamp into a lost snapshot.
      published_at: roster.published_at || new Date().toISOString(),
      published_by: roster.published_by ?? null,
      format_version: SNAPSHOT_FORMAT_VERSION,
      block_count: built.blockCount,
      assignment_count: built.assignmentCount,
      snapshot: built.snapshot,
    }

    let lastErr = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { error } = await db.from('roster_publish_snapshots').insert(row)
        if (!error) return { saved: true }
        // UNIQUE (roster_id): a retry that meets its own first attempt.
        if (attempt > 1 && error.code === '23505') return { saved: true, duplicate: true }
        lastErr = error
      } catch (e) {
        lastErr = e
      }
    }
    logError('roster-snapshot', 'publish snapshot not saved: insert failed twice', { ...meta, err: lastErr })
    return { saved: false, reason: 'insert_failed' }
  } catch (e) {
    logError('roster-snapshot', 'publish snapshot not saved: threw', { ...meta, err: e })
    return { saved: false, reason: 'threw' }
  }
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/lib/roster-snapshot.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-snapshot.js src/lib/roster-snapshot.test.js
git commit -m "SNAPSHOT.1 — roster-snapshot: paged period read and a best-effort snapshot write (one retry, logError, never throws)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: IO part 2: load a comparison

**Files:**
- Modify: `src/lib/roster-snapshot.js` (append; extend imports)
- Modify: `src/lib/roster-snapshot.test.js` (append; extend imports)

- [ ] **Step 1: Append the failing tests.** In `src/lib/roster-snapshot.test.js` change the import line to

```js
const { writePublishSnapshot, loadWindowBlocks, loadRosterComparison, SNAPSHOT_BLOCK_PAGE } = await import('./roster-snapshot')
const { buildPublishSnapshot } = await import('./roster-compare')
```

then append:

```js
// ── loadRosterComparison ─────────────────────────────────────────────────

const NOW = Date.UTC(2026, 8, 25, 12)

const PUBLISHED_BLOCKS = [block(1, {
  shift_assignments: [
    { id: 'a1', profile_id: 'p1', status: 'scheduled' },
    { id: 'a2', profile_id: 'p2', status: 'scheduled' },
  ],
})]

const SNAP_ROW = {
  id: 's-1', roster_id: 'r-1', location_id: LOC,
  period_start: '2026-09-14', period_end: '2026-09-20',
  published_at: '2026-09-12T13:02:00+00:00', published_by: 'mgr-1', format_version: 1,
  snapshot: buildPublishSnapshot({ periodStart: '2026-09-14', periodEnd: '2026-09-20', blocks: PUBLISHED_BLOCKS }).snapshot,
}

// p1 still on, p2 gone; p1's name comes from the live embed.
const LIVE_BLOCKS = [block(1, {
  shift_assignments: [{ id: 'a1', profile_id: 'p1', status: 'scheduled', arrived_at: null, profiles: { full_name: 'Coach One' } }],
})]

function compareDb({
  location = { id: LOC, timezone: 'Europe/Dublin' },
  own = SNAP_ROW,
  against = null,
  first = { published_at: SNAP_ROW.published_at },
  publishes = [SNAP_ROW],
  blocks = LIVE_BLOCKS,
  names = [{ id: 'p2', full_name: 'Coach Two' }, { id: 'mgr-1', full_name: 'Manager M' }],
  fail = {},
} = {}) {
  return fakeDb((q) => {
    const eqCols = opsOf(q, 'eq').map(([, col]) => col)
    const selected = opsOf(q, 'select')[0]?.[1]
    if (q.table === 'locations') return fail.location ? { data: null, error: fail.location } : { data: location, error: null }
    if (q.table === 'roster_publish_snapshots') {
      if (eqCols.includes('roster_id')) return fail.own ? { data: null, error: fail.own } : { data: own, error: null }
      if (eqCols.includes('id')) return { data: against, error: null }
      if (selected === 'published_at') return { data: first, error: null }
      return fail.publishes ? { data: null, error: fail.publishes } : { data: publishes, error: null }
    }
    if (q.table === 'shift_blocks') return fail.blocks ? { data: null, error: fail.blocks } : { data: blocks, error: null }
    if (q.table === 'profiles') return fail.names ? { data: null, error: fail.names } : { data: names, error: null }
    throw new Error(`unexpected table ${q.table}`)
  })
}

const ROSTER_FOR_COMPARE = { ...ROSTER }

describe('loadRosterComparison', () => {
  it("compares the roster's own snapshot with the live roster, for the window asked", async () => {
    const db = compareDb()
    const out = await loadRosterComparison(db, { roster: ROSTER_FOR_COMPARE, from: '2026-09-15', to: '2026-09-16', nowMs: NOW })
    expect(out.error).toBeUndefined()
    const d = out.data
    expect(d.roster).toEqual({ id: 'r-1', status: 'published', period_start: '2026-09-14', period_end: '2026-09-20', published_at: ROSTER.published_at })
    expect(d.window).toEqual({ from: '2026-09-15', to: '2026-09-16' })
    expect(d.baseline).toEqual({
      snapshot_id: 's-1', roster_id: 'r-1', published_at: SNAP_ROW.published_at,
      period_start: '2026-09-14', period_end: '2026-09-20', published_by_name: 'Manager M',
    })
    expect(d.missing_reason).toBeNull()
    expect(d.snapshots_began_at).toBe(SNAP_ROW.published_at)
    expect(d.publishes).toEqual([{ snapshot_id: 's-1', roster_id: 'r-1', published_at: SNAP_ROW.published_at, period_start: '2026-09-14', period_end: '2026-09-20' }])
    expect(d.blocks[0].coaches.map((c) => [c.name, c.change])).toEqual([['Coach One', 'unchanged'], ['Coach Two', 'removed']])
    expect(d.totals).toMatchObject({ unchanged: 1, removed: 1, published_shifts: 2, current_shifts: 1 })

    // The live read is the WINDOW, not the whole roster period.
    const live = db.log.find((q) => q.table === 'shift_blocks')
    expect(live.ops).toContainEqual(['gte', 'block_date', '2026-09-15'])
    expect(live.ops).toContainEqual(['lte', 'block_date', '2026-09-16'])
    // Names are read only for people the live embed does not already name.
    const names = db.log.find((q) => q.table === 'profiles')
    expect(opsOf(names, 'in')[0][2].sort()).toEqual(['mgr-1', 'p2'])
    // Every snapshot read is pinned to the roster's studio.
    for (const q of db.log.filter((x) => x.table === 'roster_publish_snapshots')) {
      expect(q.ops).toContainEqual(['eq', 'location_id', LOC])
    }
  })

  it('compares against another publish at the same studio when asked', async () => {
    const earlier = { ...SNAP_ROW, id: 's-0', roster_id: 'r-0', published_at: '2026-09-10T08:00:00+00:00' }
    const db = compareDb({ against: earlier })
    const out = await loadRosterComparison(db, { roster: ROSTER_FOR_COMPARE, againstId: 's-0', nowMs: NOW })
    expect(out.data.baseline).toMatchObject({ snapshot_id: 's-0', roster_id: 'r-0' })
    const q = db.log.find((x) => x.table === 'roster_publish_snapshots' && opsOf(x, 'eq').some(([, c]) => c === 'id'))
    expect(q.ops).toContainEqual(['eq', 'id', 's-0'])
    expect(q.ops).toContainEqual(['eq', 'location_id', LOC])
  })

  it('an against snapshot that is not at this studio (or does not exist) is not found', async () => {
    const out = await loadRosterComparison(compareDb({ against: null }), { roster: ROSTER_FOR_COMPARE, againstId: 's-x', nowMs: NOW })
    expect(out).toEqual({ notFound: true })
  })

  it('a roster published before the studio\'s first snapshot: before_snapshots, with the date, and no live read', async () => {
    const db = compareDb({ own: null, first: { published_at: '2026-09-26T08:00:00+00:00' }, publishes: [] })
    const out = await loadRosterComparison(db, { roster: ROSTER_FOR_COMPARE, nowMs: NOW })
    expect(out.data).toMatchObject({
      baseline: null, missing_reason: 'before_snapshots', snapshots_began_at: '2026-09-26T08:00:00+00:00',
      window: null, blocks: [], totals: null,
    })
    expect(db.log.some((q) => q.table === 'shift_blocks')).toBe(false)
  })

  it('no snapshot at the studio at all: before_snapshots, date null', async () => {
    const out = await loadRosterComparison(compareDb({ own: null, first: null, publishes: [] }), { roster: ROSTER_FOR_COMPARE, nowMs: NOW })
    expect(out.data).toMatchObject({ missing_reason: 'before_snapshots', snapshots_began_at: null })
  })

  it('published after snapshots began but none saved: not_saved', async () => {
    const out = await loadRosterComparison(
      compareDb({ own: null, first: { published_at: '2026-09-01T08:00:00+00:00' } }),
      { roster: ROSTER_FOR_COMPARE, nowMs: NOW },
    )
    expect(out.data.missing_reason).toBe('not_saved')
  })

  it('a failed read is an error, logged, never an empty comparison', async () => {
    for (const key of ['location', 'own', 'publishes', 'blocks']) {
      logError.mockClear()
      const out = await loadRosterComparison(compareDb({ fail: { [key]: { message: `${key} down` } } }), { roster: ROSTER_FOR_COMPARE, nowMs: NOW })
      expect(out.error, key).toEqual({ message: `${key} down` })
      expect(out.data, key).toBeUndefined()
      expect(logError, key).toHaveBeenCalledWith('roster-snapshot', expect.any(String), expect.objectContaining({ roster_id: 'r-1' }))
    }
  })

  it('a failed names read degrades to unknown names, logged; the comparison still answers', async () => {
    const out = await loadRosterComparison(compareDb({ fail: { names: { message: 'names down' } } }), { roster: ROSTER_FOR_COMPARE, nowMs: NOW })
    expect(out.data.blocks[0].coaches.find((c) => c.profile_id === 'p2').name).toBeNull()
    expect(out.data.baseline.published_by_name).toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })

  it('a snapshot written by newer code is refused rather than misread', async () => {
    const out = await loadRosterComparison(compareDb({ own: { ...SNAP_ROW, format_version: 2 } }), { roster: ROSTER_FOR_COMPARE, nowMs: NOW })
    expect(out.error).toBeTruthy()
    expect(out.data).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to see the new tests fail**

Run: `npx vitest run src/lib/roster-snapshot.test.js`
Expected: FAIL, `loadRosterComparison is not a function` (Task 4's tests still pass).

- [ ] **Step 3: Append the implementation.** In `src/lib/roster-snapshot.js` change the imports to

```js
import { buildPublishSnapshot, clipWindow, compareSnapshot, SNAPSHOT_FORMAT_VERSION } from './roster-compare'
import { logError, logWarn } from './log'
```

then append:

```js
export const COMPARE_PUBLISHES_LISTED = 20
const NAME_CHUNK = 200

const SNAPSHOT_COLUMNS = 'id, roster_id, location_id, period_start, period_end, published_at, published_by, format_version, snapshot'

/**
 * Everything GET /api/schedule/rosters/[id]/compare returns. The caller has
 * loaded the roster and checked the manager's access to roster.location_id;
 * every read here is pinned to that location.
 *
 * @param {object} args
 * @param {object} args.roster     { id, location_id, status, period_start, period_end, published_at }
 * @param {string|null} [args.againstId]  compare with this snapshot instead of the roster's own
 * @param {string|null} [args.from]       YYYY-MM-DD window (the period on screen)
 * @param {string|null} [args.to]
 * @param {number} args.nowMs
 * @returns {Promise<{ data: object } | { notFound: true } | { error: object }>}
 */
export async function loadRosterComparison(db, { roster, againstId = null, from = null, to = null, nowMs = Date.now() }) {
  const meta = { roster_id: roster.id, location_id: roster.location_id }
  const fail = (what, err) => {
    logError('roster-snapshot', `compare: ${what}`, { ...meta, err })
    return { error: err || { message: what } }
  }

  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, timezone')
    .eq('id', roster.location_id)
    .maybeSingle()
  if (locErr) return fail('location read failed', locErr)

  let baseline = null
  if (againstId) {
    const { data, error } = await db
      .from('roster_publish_snapshots')
      .select(SNAPSHOT_COLUMNS)
      .eq('id', againstId)
      .eq('location_id', roster.location_id)
      .maybeSingle()
    if (error) return fail('snapshot read failed', error)
    if (!data) return { notFound: true }
    baseline = data
  } else {
    const { data, error } = await db
      .from('roster_publish_snapshots')
      .select(SNAPSHOT_COLUMNS)
      .eq('roster_id', roster.id)
      .eq('location_id', roster.location_id)
      .maybeSingle()
    if (error) return fail('snapshot read failed', error)
    baseline = data || null
  }
  if (baseline && Number(baseline.format_version) > SNAPSHOT_FORMAT_VERSION) {
    return fail(`snapshot format ${baseline.format_version} is newer than this code reads`, null)
  }

  // The studio's first snapshot: the date the view names for older rosters.
  const { data: first, error: firstErr } = await db
    .from('roster_publish_snapshots')
    .select('published_at')
    .eq('location_id', roster.location_id)
    .order('published_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (firstErr) return fail('first-snapshot read failed', firstErr)
  const snapshotsBeganAt = first?.published_at ?? null

  // Every publish at this studio overlapping the window, newest first: the
  // "compare with" choices (the first publish of the week, say).
  const askFrom = from || roster.period_start
  const askTo = to || roster.period_end
  const { data: pubs, error: pubsErr } = await db
    .from('roster_publish_snapshots')
    .select('id, roster_id, published_at, period_start, period_end')
    .eq('location_id', roster.location_id)
    .lte('period_start', askTo)
    .gte('period_end', askFrom)
    .order('published_at', { ascending: false })
    .limit(COMPARE_PUBLISHES_LISTED)
  if (pubsErr) return fail('publish list read failed', pubsErr)
  const publishes = (pubs || []).map((p) => ({
    snapshot_id: p.id, roster_id: p.roster_id, published_at: p.published_at,
    period_start: p.period_start, period_end: p.period_end,
  }))

  const rosterSummary = {
    id: roster.id, status: roster.status,
    period_start: roster.period_start, period_end: roster.period_end,
    published_at: roster.published_at ?? null,
  }

  if (!baseline) {
    // No backfill (D11): a roster published before the studio's first
    // snapshot never had one; after it, one should have been written and was
    // not (the write failed and was logged at the time).
    const publishedMs = Date.parse(roster.published_at || '')
    const beganMs = Date.parse(snapshotsBeganAt || '')
    const before = !Number.isFinite(beganMs) || !Number.isFinite(publishedMs) || publishedMs < beganMs
    return {
      data: {
        roster: rosterSummary, window: null, baseline: null,
        missing_reason: before ? 'before_snapshots' : 'not_saved',
        snapshots_began_at: snapshotsBeganAt, publishes, blocks: [], totals: null,
      },
    }
  }

  const window = clipWindow(baseline.snapshot, from, to)
  let current = []
  if (window) {
    const { blocks, error: curErr } = await loadWindowBlocks(db, { locationId: roster.location_id, from: window.from, to: window.to })
    if (curErr) return fail('current blocks read failed', curErr)
    current = blocks
  }

  // Names for coaches the live embed does not already name (removed since
  // publish), plus whoever published. A failed read costs names, not the view.
  const namedNow = new Set(current.flatMap((b) => (b.shift_assignments || [])
    .filter((a) => a?.profiles?.full_name).map((a) => a.profile_id)))
  const wanted = new Set()
  for (const b of baseline.snapshot.blocks || []) {
    if (!window || b.date < window.from || b.date > window.to) continue
    for (const c of b.coaches || []) if (!namedNow.has(c.profile_id)) wanted.add(c.profile_id)
  }
  if (baseline.published_by) wanted.add(baseline.published_by)
  const names = {}
  const ids = [...wanted]
  for (let i = 0; i < ids.length; i += NAME_CHUNK) {
    const { data, error } = await db.from('profiles').select('id, full_name').in('id', ids.slice(i, i + NAME_CHUNK))
    if (error) {
      logWarn('roster-snapshot', 'compare: names read failed; showing the comparison without them', { ...meta, err: error })
      break
    }
    for (const p of data || []) names[p.id] = p.full_name
  }

  const result = compareSnapshot({
    snapshot: baseline.snapshot, currentBlocks: current, from, to, nowMs, tz: location?.timezone ?? null, names,
  })

  return {
    data: {
      roster: rosterSummary,
      window: result.window,
      baseline: {
        snapshot_id: baseline.id, roster_id: baseline.roster_id, published_at: baseline.published_at,
        period_start: baseline.period_start, period_end: baseline.period_end,
        published_by_name: baseline.published_by ? (names[baseline.published_by] ?? null) : null,
      },
      missing_reason: null,
      snapshots_began_at: snapshotsBeganAt,
      publishes,
      blocks: result.blocks,
      totals: result.totals,
    },
  }
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/lib/roster-snapshot.test.js src/lib/roster-compare.test.js`
Expected: PASS (roster-snapshot 19 tests, roster-compare 39).

- [ ] **Step 5: Prove the column names against the schema**

Run: `npm run check:select-columns`
Expected: exit 0. It resolves `shift_blocks(id, block_date, template_id, start_time, end_time, min_coaches, max_coaches)`, the `shift_templates(name, kind)` and `shift_assignments(…, arrived_at, profiles:profile_id(full_name))` embeds, `locations(id, timezone)`, `profiles(id, full_name)` and every `roster_publish_snapshots` column against migrations 067/099/100/177/609/628/634. `SNAPSHOT_COLUMNS` is a constant, so that one select is outside the checker's reach (it only reads literals); its names are pinned by the mig 634 replay's shape test instead.

- [ ] **Step 6: Commit**

```bash
git add src/lib/roster-snapshot.js src/lib/roster-snapshot.test.js
git commit -m "SNAPSHOT.1 — roster-snapshot: load a comparison (own or chosen baseline, publishes list, honest missing reasons, names degrade not fail)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Both publish paths write the snapshot, after the tag, never failing the publish

**Files:**
- Modify: `src/app/api/schedule/rosters/route.js` (imports at 47-48; insert between the end of the `if (tagErr) { … }` block at line 485 and the `// ROSTER-SUPERSEDE.1 — phase 2` comment at 487)
- Modify: `src/app/api/schedule/rosters/route.test.js`
- Modify: `src/app/api/schedule/rosters/[id]/approve/route.js` (imports at 28 and 42; insert between the end of the `if (tagErr) { … }` block at line 334 and the `// ROSTER-SUPERSEDE.1 — phase 2` comment at 336)
- Modify: `src/app/api/schedule/rosters/[id]/approve/route.test.js`

- [ ] **Step 1: Write the failing POST tests.** In `src/app/api/schedule/rosters/route.test.js`:

(a) Replace the `@/lib/log` mock line (currently `vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn() }))`) with:

```js
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn(), logError: vi.fn() }))
// SNAPSHOT.1 — the snapshot writer is its own module with its own tests
// (src/lib/roster-snapshot.test.js); here only WHEN it is called matters.
vi.mock('@/lib/roster-snapshot', () => ({ writePublishSnapshot: vi.fn(() => Promise.resolve({ saved: true })) }))
```

(b) After the line `const { logWarn } = await import('@/lib/log')`, add:

```js
const { writePublishSnapshot } = await import('@/lib/roster-snapshot')
```

(c) Append at the end of the file:

```js
// SNAPSHOT.1 — every publish records what it published, AFTER its blocks are
// tagged, and a snapshot that fails never fails the publish (CLAUDE.md: never
// create a louder failure).
describe('POST /api/schedule/rosters — publish snapshot (SNAPSHOT.1)', () => {
  beforeEach(() => {
    writePublishSnapshot.mockReset()
    writePublishSnapshot.mockResolvedValue({ saved: true })
  })

  it('writes one snapshot with the roster row the publish inserted', async () => {
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)
    const res = await publish()
    expect(res.status).toBe(201)
    expect(writePublishSnapshot).toHaveBeenCalledTimes(1)
    const [dbArg, roster] = writePublishSnapshot.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(roster).toMatchObject({
      id: 'roster-new', location_id: LOC_1, period_start: '2026-05-04', period_end: '2026-05-10',
      status: 'published', published_by: 'owner-1',
    })
    expect(typeof roster.published_at).toBe('string')
  })

  it('writes it before the coaches are re-notified (the record is of the publish, not of what came after)', async () => {
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)
    await publish()
    const { renotifyChangedCoaches } = await import('@/lib/roster-notify')
    expect(writePublishSnapshot.mock.invocationCallOrder[0]).toBeLessThan(renotifyChangedCoaches.mock.invocationCallOrder[0])
  })

  it('a failed block tagging writes no snapshot: those blocks were not published by this roster', async () => {
    const { db } = buildDb({ tagError: { message: 'deadlock detected' } })
    createServerClient.mockReturnValue(db)
    const res = await publish()
    expect(res.status).toBe(201)
    expect(writePublishSnapshot).not.toHaveBeenCalled()
  })

  it('a dry run writes no snapshot', async () => {
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)
    const res = await publish({ dry_run: true })
    expect(res.status).toBe(200)
    expect(writePublishSnapshot).not.toHaveBeenCalled()
  })

  it('a manager over budget makes a DRAFT, and a draft writes no snapshot', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-1', role: 'manager', locations: [{ id: LOC_1 }], rolesByLocation: { [LOC_1]: 'manager' } })
    projectPublishImpact.mockResolvedValue({ ...UNDER_BUDGET, overBudget: true, overrunEur: 50 })
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)
    const res = await publish()
    expect(res.status).toBe(202)
    expect(writePublishSnapshot).not.toHaveBeenCalled()
  })

  it('a snapshot that is not saved leaves the publish exactly as it was: 201, no warning', async () => {
    writePublishSnapshot.mockResolvedValue({ saved: false, reason: 'insert_failed' })
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)
    const res = await publish()
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.warning).toBeUndefined()
  })

  it('even a writer that throws past its own guard never fails the publish', async () => {
    writePublishSnapshot.mockRejectedValue(new Error('boom'))
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)
    const res = await publish()
    expect(res.status).toBe(201)
    expect((await res.json()).success).toBe(true)
  })
})
```

- [ ] **Step 2: Write the failing approve tests.** In `src/app/api/schedule/rosters/[id]/approve/route.test.js`:

(a) Replace the `@/lib/log` mock line with the same two mocks as Step 1 (a):

```js
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn(), logError: vi.fn() }))
// SNAPSHOT.1 — only WHEN the writer is called matters here.
vi.mock('@/lib/roster-snapshot', () => ({ writePublishSnapshot: vi.fn(() => Promise.resolve({ saved: true })) }))
```

(b) After `const { logWarn } = await import('@/lib/log')`, add:

```js
const { writePublishSnapshot } = await import('@/lib/roster-snapshot')
```

(c) Append at the end of the file:

```js
// SNAPSHOT.1 — approving IS publishing, so it records what it published too.
describe('POST /api/schedule/rosters/[id]/approve — publish snapshot (SNAPSHOT.1)', () => {
  beforeEach(() => {
    writePublishSnapshot.mockReset()
    writePublishSnapshot.mockResolvedValue({ saved: true })
  })

  it('writes one snapshot with the roster as the approval flipped it', async () => {
    const { db } = buildDb({ roster: draft(), publishedRosters: [] })
    createServerClient.mockReturnValue(db)
    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    expect(writePublishSnapshot).toHaveBeenCalledTimes(1)
    const [dbArg, roster] = writePublishSnapshot.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(roster).toMatchObject({ id: 'roster-1', location_id: 'loc-1', status: 'published', period_start: '2026-05-04', period_end: '2026-05-10' })
  })

  it('a failed block tagging writes no snapshot', async () => {
    const { db } = buildDb({ roster: draft(), tagError: { message: 'deadlock detected' } })
    createServerClient.mockReturnValue(db)
    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    expect(writePublishSnapshot).not.toHaveBeenCalled()
  })

  it('a refused approval (not a draft) writes no snapshot', async () => {
    const { db } = buildDb({ roster: draft({ status: 'published' }) })
    createServerClient.mockReturnValue(db)
    const res = await POST({}, PROPS)
    expect(res.status).toBe(409)
    expect(writePublishSnapshot).not.toHaveBeenCalled()
  })

  it('a writer that throws never fails the approval', async () => {
    writePublishSnapshot.mockRejectedValue(new Error('boom'))
    const { db } = buildDb({ roster: draft(), publishedRosters: [] })
    createServerClient.mockReturnValue(db)
    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.warning).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run src/app/api/schedule/rosters/route.test.js 'src/app/api/schedule/rosters/[id]/approve/route.test.js'`
Expected: FAIL on the new `describe` blocks only (`expected "spy" to be called 1 times, but got 0 times`); every existing test still passes.

- [ ] **Step 4: Wire POST.** In `src/app/api/schedule/rosters/route.js`:

(a) Replace the import `import { logWarn } from '@/lib/log'` (line 48) with:

```js
import { logWarn, logError } from '@/lib/log'
import { writePublishSnapshot } from '@/lib/roster-snapshot'
```

(b) Immediately after the closing `}` of the `if (tagErr) { … }` block (line 485) and before the comment `// ROSTER-SUPERSEDE.1 — phase 2, and it has to be AFTER the re-tag above:`, insert:

```js
    // SNAPSHOT.1 — record what this publish published (mig 634), now that
    // every block in the period carries this roster's id. BEST-EFFORT BY
    // DESIGN: this publish is a chain of PostgREST writes with no transaction
    // to join, and failing it over a lost audit record would leave coaches
    // untold about their week (CLAUDE.md: never create a louder failure).
    // writePublishSnapshot never throws, retries once and logs a failure with
    // logError; this try/catch is the second fence, not the first. Nothing is
    // added to the response: the manager has nothing to act on (the compare
    // view says "could not be saved at the time" instead).
    try {
      await writePublishSnapshot(db, roster)
    } catch (e) {
      logError('rosters', 'publish snapshot threw past its own guard', { err: e, roster_id: roster.id })
    }

```

- [ ] **Step 5: Wire approve.** In `src/app/api/schedule/rosters/[id]/approve/route.js`:

(a) Replace `import { logWarn } from '@/lib/log'` (line 42) with:

```js
import { logWarn, logError } from '@/lib/log'
import { writePublishSnapshot } from '@/lib/roster-snapshot'
```

(b) Immediately after the closing `}` of the `if (tagErr) { … }` block (line 334) and before `// ROSTER-SUPERSEDE.1 — phase 2, AFTER the re-tag:`, insert:

```js
  // SNAPSHOT.1 — approving IS publishing: record what it published (mig
  // 634), now that the period's blocks carry this roster's id. Best-effort,
  // exactly as in POST /api/schedule/rosters: nothing may fail an approval
  // that already landed.
  try {
    await writePublishSnapshot(db, updated)
  } catch (e) {
    logError('rosters/approve', 'publish snapshot threw past its own guard', { err: e, roster_id: roster.id })
  }

```

- [ ] **Step 6: Run to see them pass**

Run: `npx vitest run src/app/api/schedule/rosters/route.test.js 'src/app/api/schedule/rosters/[id]/approve/route.test.js'`
Expected: PASS, including every pre-existing test.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/schedule/rosters/route.js src/app/api/schedule/rosters/route.test.js 'src/app/api/schedule/rosters/[id]/approve/route.js' 'src/app/api/schedule/rosters/[id]/approve/route.test.js'
git commit -m "SNAPSHOT.1 — publish and approve write the snapshot after the tag; a lost snapshot never fails a publish

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `GET /api/schedule/rosters/[id]/compare`

**Files:**
- Create: `src/app/api/schedule/rosters/[id]/compare/route.js`
- Create: `src/app/api/schedule/rosters/[id]/compare/route.test.js`

- [ ] **Step 1: Write the failing tests** at `src/app/api/schedule/rosters/[id]/compare/route.test.js`:

```js
// SNAPSHOT.1 — GET /api/schedule/rosters/[id]/compare. The comparison itself
// is tested in src/lib/roster-snapshot.test.js and roster-compare.test.js;
// this pins the gate (the blocks/[id] shape: a manager somewhere, 404 for an
// outsider, 403 for a member without the role there), the query checks, and
// that a failure is never passed off as an empty comparison.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    // REAL: membership (404) and the role at the roster's studio (403) are under test.
    assertLocationAccessOr404: real.assertLocationAccessOr404,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/roster-snapshot', () => ({ loadRosterComparison: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { loadRosterComparison } = await import('@/lib/roster-snapshot')
const { GET } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const OTHER = 'a0000000-0000-0000-0000-000000000002'
const RID = 'c0000000-0000-0000-0000-000000000001'
const SID = 'd0000000-0000-0000-0000-000000000001'
const ROSTER = {
  id: RID, location_id: LOC, status: 'published', period_start: '2026-09-14', period_end: '2026-09-20',
  published_at: '2026-09-12T13:02:00+00:00', published_by: 'mgr-1',
}
const MANAGER = { id: 'mgr-1', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } }
const DATA = { roster: { id: RID }, baseline: { snapshot_id: SID }, blocks: [], totals: {} }

function props(id = RID) {
  return { params: Promise.resolve({ id }) }
}
function get(query = '') {
  return new Request(`http://localhost/api/schedule/rosters/${RID}/compare${query}`)
}
function rosterDb({ roster = ROSTER, error = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {
        select: (cols) => { q.ops.push(['select', cols]); return b },
        eq: (c, v) => { q.ops.push(['eq', c, v]); return b },
        maybeSingle: () => Promise.resolve({ data: error ? null : roster, error }),
      }
      return b
    },
  }
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  loadRosterComparison.mockReset()
  getCurrentUser.mockResolvedValue(MANAGER)
  loadRosterComparison.mockResolvedValue({ data: DATA })
})

describe('GET /api/schedule/rosters/[id]/compare', () => {
  it('answers a manager at the studio with the comparison, for the window asked', async () => {
    const db = rosterDb()
    createServerClient.mockReturnValue(db)
    const res = await GET(get('?from=2026-09-15&to=2026-09-16'), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: DATA })
    expect(db.calls[0].table).toBe('rosters')
    expect(db.calls[0].ops).toContainEqual(['eq', 'id', RID])
    const [dbArg, args] = loadRosterComparison.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(args).toMatchObject({ roster: ROSTER, againstId: null, from: '2026-09-15', to: '2026-09-16' })
    expect(Number.isFinite(args.nowMs)).toBe(true)
  })

  it('passes a chosen baseline through', async () => {
    createServerClient.mockReturnValue(rosterDb())
    await GET(get(`?against=${SID}`), props())
    expect(loadRosterComparison.mock.calls[0][1]).toMatchObject({ againstId: SID, from: null, to: null })
  })

  it('no manager role anywhere: 403 before any read', async () => {
    getCurrentUser.mockResolvedValue({ ...MANAGER, rolesByLocation: { [LOC]: 'staff' } })
    const res = await GET(get(), props())
    expect(res.status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('no session: 403', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get(), props())).status).toBe(403)
  })

  it('refuses a date that is not real, a reversed range and a malformed baseline id', async () => {
    createServerClient.mockReturnValue(rosterDb())
    expect((await GET(get('?from=2026-02-30'), props())).status).toBe(400)
    expect((await GET(get('?from=2026-09-20&to=2026-09-14'), props())).status).toBe(400)
    expect((await GET(get('?against=not-a-uuid'), props())).status).toBe(400)
    expect(loadRosterComparison).not.toHaveBeenCalled()
  })

  it('a malformed roster id is simply not found', async () => {
    const res = await GET(get(), props('nope'))
    expect(res.status).toBe(404)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('an unknown roster: 404', async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: null }))
    expect((await GET(get(), props())).status).toBe(404)
  })

  it('a failed roster read is a 500, never a 404', async () => {
    createServerClient.mockReturnValue(rosterDb({ error: { message: 'timeout' } }))
    expect((await GET(get(), props())).status).toBe(500)
  })

  it("a roster at another studio is indistinguishable from a missing one: 404", async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: { ...ROSTER, location_id: OTHER } }))
    getCurrentUser.mockResolvedValue({ ...MANAGER, rolesByLocation: { [LOC]: 'manager' } })
    const res = await GET(get(), props())
    expect(res.status).toBe(404)
    expect(loadRosterComparison).not.toHaveBeenCalled()
  })

  it('a member of the studio who is not a manager THERE: 403', async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: { ...ROSTER, location_id: OTHER } }))
    getCurrentUser.mockResolvedValue({
      ...MANAGER,
      locations: [{ id: LOC }, { id: OTHER }],
      rolesByLocation: { [LOC]: 'manager', [OTHER]: 'staff' },
    })
    expect((await GET(get(), props())).status).toBe(403)
    expect(loadRosterComparison).not.toHaveBeenCalled()
  })

  it('a master reaches any studio', async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: { ...ROSTER, location_id: OTHER } }))
    getCurrentUser.mockResolvedValue({ id: 'm', profileRole: 'master', locations: [{ id: LOC }, { id: OTHER }], rolesByLocation: {} })
    expect((await GET(get(), props())).status).toBe(200)
  })

  it('a draft published nothing: 409', async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: { ...ROSTER, status: 'draft' } }))
    expect((await GET(get(), props())).status).toBe(409)
    expect(loadRosterComparison).not.toHaveBeenCalled()
  })

  it('a superseded roster was published, so it can be compared', async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: { ...ROSTER, status: 'superseded' } }))
    expect((await GET(get(), props())).status).toBe(200)
  })

  it('a chosen baseline that is not at this studio: 404', async () => {
    createServerClient.mockReturnValue(rosterDb())
    loadRosterComparison.mockResolvedValue({ notFound: true })
    expect((await GET(get(`?against=${SID}`), props())).status).toBe(404)
  })

  it('a failed comparison read is a 500, never an empty comparison', async () => {
    createServerClient.mockReturnValue(rosterDb())
    loadRosterComparison.mockResolvedValue({ error: { message: 'down' } })
    const res = await GET(get(), props())
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run 'src/app/api/schedule/rosters/[id]/compare/route.test.js'`
Expected: FAIL, `Failed to resolve import "./route.js"`.

- [ ] **Step 3: Write the route** at `src/app/api/schedule/rosters/[id]/compare/route.js`:

```js
// src/app/api/schedule/rosters/[id]/compare/route.js
// SNAPSHOT.1 — GET /api/schedule/rosters/[id]/compare
//
// A published (or since superseded) roster as it was PUBLISHED (its
// roster_publish_snapshots row, mig 634), as it is ROSTERED NOW (the live
// shift_blocks + shift_assignments) and as ARRIVED (arrived_at, with the
// attendance report's back-to-back carry-over). Per shift and per coach: both
// windows, the change (unchanged / moved / added / removed after publish), the
// arrival, and an ADVISORY "no arrival recorded" flag on ended shifts. Nothing
// here alerts anyone.
//
// Gate (the blocks/[id] shape): a manager role somewhere, else 403; the
// roster by id, else 404; an outsider to the roster's studio gets 404 (the id
// is not confirmed); a member without a manager role THERE gets 403. This
// route is service-role: that gate and the location pins inside
// loadRosterComparison are the whole tenant boundary.
//
// Query:
//   from, to   optional YYYY-MM-DD real dates, the period on screen; clipped to
//              the published period
//   against    optional snapshot id at the same studio to compare with instead
//              of this roster's own (the first publish of the week, say)
//
// Names, times, hours and arrival stamps only. Never a rate or a cost.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, realIsoDate, MANAGER_ROLES } from '@/lib/schemas'
import { loadRosterComparison } from '@/lib/roster-snapshot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  from: realIsoDate.optional(),
  to: realIsoDate.optional(),
  against: uuidLike.optional(),
})

function fail(status, error) {
  return NextResponse.json({ success: false, error }, { status })
}

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) return fail(403, 'Unauthorized')

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    against: url.searchParams.get('against') || undefined,
  })
  if (!parsed.success) {
    return fail(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }
  const { from, to, against } = parsed.data
  if (from && to && to < from) return fail(400, 'to must be on or after from')

  // A malformed id is simply not a roster: 404, never Postgres's 22P02 text.
  if (!uuidLike.safeParse(params.id).success) return fail(404, 'Roster not found')

  const db = createServerClient()
  const { data: roster, error: rosterErr } = await db
    .from('rosters')
    .select('id, location_id, status, period_start, period_end, published_at, published_by')
    .eq('id', params.id)
    .maybeSingle()
  if (rosterErr) return fail(500, 'The roster could not be read')
  if (!roster) return fail(404, 'Roster not found')

  const notHere = assertLocationAccessOr404(user, roster.location_id)
  if (notHere) return notHere
  if (!hasRoleAtLocation(user, roster.location_id, MANAGER_ROLES)) return fail(403, 'Forbidden')

  if (roster.status === 'draft') {
    return fail(409, 'This roster is a draft waiting for approval, so nothing has been published to compare.')
  }

  const result = await loadRosterComparison(db, {
    roster,
    againstId: against ?? null,
    from: from ?? null,
    to: to ?? null,
    nowMs: Date.now(),
  })
  if (result.notFound) return fail(404, 'Snapshot not found')
  // A failed read is a 500, never an empty comparison: "nothing changed" would
  // be a lie. loadRosterComparison has already logged it.
  if (result.error || !result.data) return fail(500, 'The comparison could not be read')
  return NextResponse.json({ success: true, data: result.data })
}
```

- [ ] **Step 4: Run to see it pass, then the route checks**

Run: `npx vitest run 'src/app/api/schedule/rosters/[id]/compare/route.test.js' && npm run check:route-guards && npm run check:location-scoping`
Expected: 15 tests PASS; both checks exit 0 (`getCurrentUser` is the guard; `assertLocationAccessOr404(` is scoping evidence for the `rosters` read).

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/schedule/rosters/[id]/compare/route.js' 'src/app/api/schedule/rosters/[id]/compare/route.test.js'
git commit -m "SNAPSHOT.1 — GET /api/schedule/rosters/[id]/compare: manager-only, 404 for outsiders, 409 for drafts, 500 never an empty comparison

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The words (pure, client-safe)

**Files:**
- Create: `src/lib/roster-compare-format.js`
- Create: `src/lib/roster-compare-format.test.js`

- [ ] **Step 1: Write the failing tests** at `src/lib/roster-compare-format.test.js`:

```js
// src/lib/roster-compare-format.test.js
// SNAPSHOT.1 — the "Published vs now" words. Pure; run under two host zones.

import { describe, it, expect } from 'vitest'
import {
  COMPARE_CHANGE_LABELS, COMPARE_CHANGE_CHIP, dayLabel, periodLabel, publishedLabel, windowLabel,
  hoursLabel, deltaLabel, totalsSentence, changeCountsSentence, arrivalSentence, compareRowSummary,
  arrivalLabel, blockChangeNotes, missingSnapshotMessage, publishOptionLabel, publishedRosterIdsIn,
  visibleCompareBlocks,
} from './roster-compare-format'

const row = (over = {}) => ({
  profile_id: 'p1', name: 'Coach A', change: 'unchanged',
  published: { start: '06:00', end: '07:00' }, current: { start: '06:00', end: '07:00' },
  arrived_at: null, arrived_local: null, arrival_inferred: false, ended: true, no_show_candidate: false, ...over,
})

describe('labels', () => {
  it('names every change class, with a house-rule chip for each', () => {
    expect(COMPARE_CHANGE_LABELS).toEqual({
      unchanged: 'Unchanged', moved: 'Moved', added: 'Added after publish', removed: 'Removed after publish',
    })
    for (const cls of Object.values(COMPARE_CHANGE_CHIP)) expect(cls).toMatch(/^bg-[a-z]+-500\/10 text-[a-z]+-700$/)
  })

  it('days, periods and publish instants, whatever the host zone', () => {
    expect(dayLabel('2026-09-15')).toBe('Tue 15 Sep')
    expect(dayLabel('nope')).toBe('')
    expect(periodLabel('2026-09-14', '2026-09-20')).toBe('Mon 14 Sep – Sun 20 Sep')
    expect(periodLabel('2026-09-14', '2026-09-14')).toBe('Mon 14 Sep')
    // BST in September, GMT in December.
    expect(publishedLabel('2026-09-12T13:02:00Z')).toBe('Sat 12 Sep, 14:02')
    expect(publishedLabel('2026-12-01T09:05:00+00:00')).toBe('Tue 1 Dec, 09:05')
    expect(publishedLabel(null)).toBe('')
  })

  it('windows and hours', () => {
    expect(windowLabel({ start: '06:00', end: '07:00' })).toBe('06:00–07:00')
    expect(windowLabel(null)).toBe('—')
    expect(hoursLabel(3)).toBe('3.0h')
    expect(hoursLabel(1.25)).toBe('1.3h')
    expect(deltaLabel(-1.5)).toBe('−1.5h')
    expect(deltaLabel(2)).toBe('+2.0h')
    expect(deltaLabel(0.04)).toBe('no change')
  })
})

describe('sentences', () => {
  const t = {
    published_shifts: 3, published_hours: 3, current_shifts: 2, current_hours: 1.5, hours_delta: -1.5,
    unchanged: 1, moved: 1, added: 0, removed: 1, ended: 2, arrived: 1, arrived_inferred: 0, no_show_candidates: 1,
  }

  it('totals: published hours against now', () => {
    expect(totalsSentence(t)).toBe('Published 3.0h · now 1.5h (−1.5h)')
  })

  it('change counts name only what happened', () => {
    expect(changeCountsSentence(t)).toBe('1 moved · 1 removed after publish')
    expect(changeCountsSentence({ ...t, moved: 0, removed: 0 })).toBe('No coach changes since this publish')
  })

  it('arrivals count ended shifts only, and say when one was carried over', () => {
    expect(arrivalSentence(t)).toBe('Arrival recorded for 1 of 2 ended shifts')
    expect(arrivalSentence({ ...t, ended: 1, arrived: 1, arrived_inferred: 1 }))
      .toBe('Arrival recorded for 1 of 1 ended shift (1 carried from the shift before)')
    expect(arrivalSentence({ ...t, ended: 0 })).toBeNull()
    expect(arrivalSentence(null)).toBeNull()
  })

  it('a row says what happened to that coach', () => {
    expect(compareRowSummary(row({ change: 'moved', current: { start: '06:30', end: '07:00' } }))).toBe('06:00–07:00 → 06:30–07:00')
    expect(compareRowSummary(row({ change: 'removed', current: null }))).toBe('was 06:00–07:00')
    expect(compareRowSummary(row({ change: 'added', published: null }))).toBe('now 06:00–07:00')
    expect(compareRowSummary(row())).toBe('06:00–07:00')
  })

  it("arrival: the time, a carried arrival, 'no arrival recorded' only once ended, else nothing", () => {
    expect(arrivalLabel(row({ arrived_local: '05:58' }))).toBe('Arrived 05:58')
    expect(arrivalLabel(row({ arrived_local: '05:55', arrival_inferred: true }))).toBe('Arrived 05:55 (on site from the shift before)')
    expect(arrivalLabel(row({ no_show_candidate: true }))).toBe('No arrival recorded')
    expect(arrivalLabel(row({ ended: false }))).toBeNull()
  })

  it('block notes: moved, added, removed, and a changed minimum or maximum', () => {
    const b = { change: 'unchanged', staffing_changed: false, published: { start: '06:00', end: '07:00', min: 1, max: 2 }, current: { start: '06:00', end: '07:00', min: 1, max: 2 } }
    expect(blockChangeNotes(b)).toEqual([])
    expect(blockChangeNotes({ ...b, change: 'moved' })).toEqual(['Shift moved from 06:00–07:00'])
    expect(blockChangeNotes({ ...b, change: 'added', published: null })).toEqual(['Shift added after publish'])
    expect(blockChangeNotes({ ...b, change: 'removed', current: null })).toEqual(['Shift removed after publish'])
    expect(blockChangeNotes({ ...b, staffing_changed: true, current: { ...b.current, min: 2, max: 3 } }))
      .toEqual(['Coaches needed 1–2, now 2–3'])
  })
})

describe('missing snapshots (no backfill)', () => {
  it('before snapshots began at this studio: names the first date', () => {
    expect(missingSnapshotMessage({ missing_reason: 'before_snapshots', snapshots_began_at: '2026-09-26T08:00:00+00:00' }))
      .toBe('Published vs now is available for rosters published from Sat 26 Sep. This roster was published before then.')
  })
  it('no snapshot at the studio yet', () => {
    expect(missingSnapshotMessage({ missing_reason: 'before_snapshots', snapshots_began_at: null }))
      .toBe('Published vs now starts with the next publish at this studio. Rosters published before it have no record of what was published.')
  })
  it('one should exist and was not saved', () => {
    expect(missingSnapshotMessage({ missing_reason: 'not_saved' })).toMatch(/could not be saved at the time/)
  })
})

describe('publishOptionLabel', () => {
  it('names the publish, its period, and which one is this roster', () => {
    const p = { snapshot_id: 's1', roster_id: 'r1', published_at: '2026-09-12T13:02:00Z', period_start: '2026-09-14', period_end: '2026-09-20' }
    expect(publishOptionLabel(p, 'r1')).toBe('Sat 12 Sep, 14:02 · Mon 14 Sep – Sun 20 Sep (this roster)')
    expect(publishOptionLabel(p, 'r2')).toBe('Sat 12 Sep, 14:02 · Mon 14 Sep – Sun 20 Sep')
  })
})

describe('publishedRosterIdsIn', () => {
  it('the published rosters the period sits on, earliest first; drafts, superseded and out-of-period blocks ignored', () => {
    const blocks = [
      { block_date: '2026-09-30', roster_id: 'r-oct', rosters: { status: 'published' } },
      { block_date: '2026-09-28', roster_id: 'r-sep', rosters: { status: 'published' } },
      { block_date: '2026-09-29', roster_id: 'r-sep', rosters: { status: 'published' } },
      { block_date: '2026-09-29', roster_id: 'r-old', rosters: { status: 'superseded' } },
      { block_date: '2026-09-29', roster_id: null, rosters: null },
      { block_date: '2026-10-05', roster_id: 'r-next', rosters: { status: 'published' } },
    ]
    expect(publishedRosterIdsIn(blocks, '2026-09-28', '2026-10-04')).toEqual(['r-sep', 'r-oct'])
    expect(publishedRosterIdsIn([], '2026-09-28', '2026-10-04')).toEqual([])
    expect(publishedRosterIdsIn(null, '2026-09-28', '2026-10-04')).toEqual([])
  })
})

describe('visibleCompareBlocks', () => {
  const quiet = { slot: 'q', change: 'unchanged', staffing_changed: false, coaches: [row()] }
  const busy = { slot: 'b', change: 'unchanged', staffing_changed: false, coaches: [row(), row({ profile_id: 'p2', change: 'moved' })] }
  const flagged = { slot: 'f', change: 'unchanged', staffing_changed: false, coaches: [row({ no_show_candidate: true })] }
  const gone = { slot: 'g', change: 'removed', staffing_changed: false, coaches: [] }

  it('hides unchanged shifts and unchanged coaches by default; keeps flags and block changes', () => {
    const out = visibleCompareBlocks([quiet, busy, flagged, gone], false)
    expect(out.map((b) => b.slot)).toEqual(['b', 'f', 'g'])
    expect(out[0].coaches.map((c) => c.profile_id)).toEqual(['p2'])
  })

  it('shows everything when asked', () => {
    expect(visibleCompareBlocks([quiet, busy], true).map((b) => [b.slot, b.coaches.length])).toEqual([['q', 1], ['b', 2]])
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/lib/roster-compare-format.test.js`
Expected: FAIL, `Failed to resolve import "./roster-compare-format"`.

- [ ] **Step 3: Write the implementation** at `src/lib/roster-compare-format.js`:

```js
// src/lib/roster-compare-format.js
// SNAPSHOT.1 — the words for the "Published vs now" view. PURE and client-safe:
// no imports and no IO. Calendar dates are built from their parts (the host
// zone cannot move them); publish instants are read in Europe/Dublin through
// Intl's NUMERIC parts, which do not vary with the ICU month-name data.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MINUS = '−'

export const COMPARE_CHANGE_LABELS = Object.freeze({
  unchanged: 'Unchanged',
  moved: 'Moved',
  added: 'Added after publish',
  removed: 'Removed after publish',
})

// House chip rule: -500/10 background, -700 text.
export const COMPARE_CHANGE_CHIP = Object.freeze({
  unchanged: 'bg-slate-500/10 text-slate-700',
  moved: 'bg-amber-500/10 text-amber-700',
  added: 'bg-blue-500/10 text-blue-700',
  removed: 'bg-red-500/10 text-red-700',
})

export const ARRIVAL_CAVEAT =
  'Arrival stamps come from phone check-ins and door taps and are missing for many shifts, so "No arrival recorded" is a prompt to check, not a no-show.'

/** '2026-09-15' -> 'Tue 15 Sep'; '' for anything else. */
export function dayLabel(dateIso) {
  const m = String(dateIso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  return `${DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${d} ${MONTHS[mo - 1]}`
}

export function periodLabel(start, end) {
  return start === end ? dayLabel(start) : `${dayLabel(start)} – ${dayLabel(end)}`
}

const DUBLIN_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function dublinParts(iso) {
  const ms = Date.parse(iso || '')
  if (!Number.isFinite(ms)) return null
  const p = {}
  for (const { type, value } of DUBLIN_PARTS.formatToParts(new Date(ms))) p[type] = value
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` }
}

/** A publish instant as the studio reads it: 'Sat 12 Sep, 14:02'. */
export function publishedLabel(iso) {
  const p = dublinParts(iso)
  return p ? `${dayLabel(p.date)}, ${p.time}` : ''
}

export function windowLabel(w) {
  return w?.start && w?.end ? `${w.start}–${w.end}` : '—'
}

export function hoursLabel(h) {
  return `${(Math.round((Number(h) || 0) * 10) / 10).toFixed(1)}h`
}

export function deltaLabel(h) {
  const n = Math.round((Number(h) || 0) * 10) / 10
  if (n === 0) return 'no change'
  return `${n > 0 ? '+' : MINUS}${Math.abs(n).toFixed(1)}h`
}

export function totalsSentence(t) {
  return `Published ${hoursLabel(t?.published_hours)} · now ${hoursLabel(t?.current_hours)} (${deltaLabel(t?.hours_delta)})`
}

export function changeCountsSentence(t) {
  const parts = [
    [t?.moved, 'moved'],
    [t?.added, 'added after publish'],
    [t?.removed, 'removed after publish'],
  ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`)
  return parts.length ? parts.join(' · ') : 'No coach changes since this publish'
}

export function arrivalSentence(t) {
  if (!t || !t.ended) return null
  const base = `Arrival recorded for ${t.arrived} of ${t.ended} ended shift${t.ended === 1 ? '' : 's'}`
  return t.arrived_inferred ? `${base} (${t.arrived_inferred} carried from the shift before)` : base
}

export function compareRowSummary(r) {
  if (r.change === 'moved') return `${windowLabel(r.published)} → ${windowLabel(r.current)}`
  if (r.change === 'removed') return `was ${windowLabel(r.published)}`
  if (r.change === 'added') return `now ${windowLabel(r.current)}`
  return windowLabel(r.current)
}

export function arrivalLabel(r) {
  if (r.arrived_local) return r.arrival_inferred ? `Arrived ${r.arrived_local} (on site from the shift before)` : `Arrived ${r.arrived_local}`
  if (r.no_show_candidate) return 'No arrival recorded'
  return null
}

export function blockChangeNotes(b) {
  const notes = []
  if (b.change === 'moved') notes.push(`Shift moved from ${windowLabel(b.published)}`)
  if (b.change === 'added') notes.push('Shift added after publish')
  if (b.change === 'removed') notes.push('Shift removed after publish')
  if (b.staffing_changed && b.published && b.current) {
    notes.push(`Coaches needed ${b.published.min}–${b.published.max}, now ${b.current.min}–${b.current.max}`)
  }
  return notes
}

/** No backfill (SNAPSHOT.1 D11): why there is nothing to compare. */
export function missingSnapshotMessage({ missing_reason: reason, snapshots_began_at: beganAt } = {}) {
  if (reason === 'not_saved') {
    return 'The record of this publish could not be saved at the time, so there is nothing to compare it with. The next publish of this period will be recorded.'
  }
  const began = dublinParts(beganAt)
  if (began) {
    return `Published vs now is available for rosters published from ${dayLabel(began.date)}. This roster was published before then.`
  }
  return 'Published vs now starts with the next publish at this studio. Rosters published before it have no record of what was published.'
}

export function publishOptionLabel(p, rosterId) {
  const base = `${publishedLabel(p.published_at)} · ${periodLabel(p.period_start, p.period_end)}`
  return p.roster_id === rosterId ? `${base} (this roster)` : base
}

/**
 * The published rosters the period's shifts sit on, earliest first: what the
 * change-log dialog compares. Reads the blocks feed rows the calendar already
 * holds (`roster_id` + `rosters: { status }`), so it costs no request.
 */
export function publishedRosterIdsIn(blocks, from, to) {
  const firstDay = new Map()
  for (const b of blocks || []) {
    if (!b?.roster_id || b.rosters?.status !== 'published') continue
    if (b.block_date < from || b.block_date > to) continue
    const seen = firstDay.get(b.roster_id)
    if (!seen || b.block_date < seen) firstDay.set(b.roster_id, b.block_date)
  }
  return [...firstDay.entries()]
    .sort((x, y) => x[1].localeCompare(y[1]) || x[0].localeCompare(y[0]))
    .map(([id]) => id)
}

function quietCoach(r) {
  return r.change === 'unchanged' && !r.no_show_candidate
}

/** Unchanged shifts and coaches hidden unless asked for. */
export function visibleCompareBlocks(blocks, showUnchanged) {
  if (showUnchanged) return blocks || []
  return (blocks || []).flatMap((b) => {
    const coaches = (b.coaches || []).filter((r) => !quietCoach(r))
    const blockNews = b.change !== 'unchanged' || b.staffing_changed
    return blockNews || coaches.length > 0 ? [{ ...b, coaches }] : []
  })
}
```

- [ ] **Step 4: Run to see it pass, in two zones**

Run: `TZ=Europe/Dublin npx vitest run src/lib/roster-compare-format.test.js && TZ=America/New_York npx vitest run src/lib/roster-compare-format.test.js`
Expected: PASS twice.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-compare-format.js src/lib/roster-compare-format.test.js
git commit -m "SNAPSHOT.1 — roster-compare-format: the Published-vs-now words, the no-backfill messages, the period's published rosters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `RosterCompareSection`, the "Published vs now" view

**Files:**
- Create: `src/components/schedule/RosterCompareSection.jsx`
- Create: `src/components/schedule/RosterCompareSection.test.jsx`

- [ ] **Step 1: Write the failing tests** at `src/components/schedule/RosterCompareSection.test.jsx`:

```jsx
// src/components/schedule/RosterCompareSection.test.jsx
// @vitest-environment jsdom
//
// SNAPSHOT.1 — the Published-vs-now view. The words are pinned in
// src/lib/roster-compare-format.test.js; this is the wiring: what it asks for,
// and what it shows for each answer. jsdom has no layout, so only text, roles
// and presence are asserted (the 390px and scroll checks are browser checks
// in the PR). No fake timers here.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react'
import RosterCompareSection from './RosterCompareSection.jsx'

const coachRow = (over = {}) => ({
  profile_id: 'p1', name: 'Coach A', change: 'unchanged',
  published: { start: '06:00', end: '07:00' }, current: { start: '06:00', end: '07:00' },
  arrived_at: null, arrived_local: null, arrival_inferred: false, ended: true, no_show_candidate: false, ...over,
})

const PUB = { snapshot_id: 's1', roster_id: 'r1', published_at: '2026-09-12T13:02:00Z', period_start: '2026-09-14', period_end: '2026-09-20' }

const DATA = {
  roster: { id: 'r1', status: 'published', period_start: '2026-09-14', period_end: '2026-09-20', published_at: PUB.published_at },
  window: { from: '2026-09-14', to: '2026-09-20' },
  baseline: { ...PUB, published_by_name: 'Manager M' },
  missing_reason: null,
  snapshots_began_at: PUB.published_at,
  publishes: [PUB],
  blocks: [
    {
      slot: 't1|2026-09-15', date: '2026-09-15', template_name: 'Morning', kind: 'class', change: 'unchanged', staffing_changed: false,
      published: { start: '06:00', end: '07:00', min: 1, max: 2 }, current: { start: '06:00', end: '07:00', min: 1, max: 2 },
      coaches: [
        coachRow({ change: 'moved', current: { start: '06:30', end: '07:00' }, no_show_candidate: true }),
        coachRow({ profile_id: 'p2', name: 'Coach B', arrived_at: '2026-09-15T04:58:00.000Z', arrived_local: '05:58' }),
      ],
    },
    {
      slot: 't2|2026-09-16', date: '2026-09-16', template_name: 'Evening', kind: 'class', change: 'removed', staffing_changed: false,
      published: { start: '18:00', end: '19:00', min: 1, max: 2 }, current: null,
      coaches: [coachRow({ profile_id: 'p3', name: 'Coach C', change: 'removed', published: { start: '18:00', end: '19:00' }, current: null, ended: false })],
    },
  ],
  totals: {
    published_shifts: 3, published_hours: 3, current_shifts: 2, current_hours: 1.5, hours_delta: -1.5,
    unchanged: 1, moved: 1, added: 0, removed: 1, ended: 2, arrived: 1, arrived_inferred: 0, no_show_candidates: 1,
    blocks_added: 0, blocks_removed: 1, blocks_moved: 0, blocks_staffing_changed: 0,
  },
}

const MISSING = {
  ...DATA, window: null, baseline: null, missing_reason: 'before_snapshots',
  snapshots_began_at: '2026-09-26T08:00:00+00:00', publishes: [], blocks: [], totals: null,
}

const answer = (status, body) => vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))
const props = { rosterIds: ['r1'], from: '2026-09-14', to: '2026-09-20' }
const urls = () => global.fetch.mock.calls.map((c) => String(c[0]))

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('RosterCompareSection', () => {
  it('asks for each published roster, for the period on screen', async () => {
    global.fetch = answer(200, { success: true, data: DATA })
    render(<RosterCompareSection {...props} rosterIds={['r1', 'r2']} />)
    await screen.findAllByTestId('roster-compare-totals')
    expect(urls().sort()).toEqual([
      '/api/schedule/rosters/r1/compare?from=2026-09-14&to=2026-09-20',
      '/api/schedule/rosters/r2/compare?from=2026-09-14&to=2026-09-20',
    ])
  })

  it('prints the hours, the change counts, and the arrivals with their caveat', async () => {
    global.fetch = answer(200, { success: true, data: DATA })
    render(<RosterCompareSection {...props} />)
    expect((await screen.findByTestId('roster-compare-totals')).textContent).toBe('Published 3.0h · now 1.5h (−1.5h)')
    expect(screen.getByText('1 moved · 1 removed after publish')).toBeTruthy()
    const arrival = screen.getByText(/Arrival recorded for 1 of 2 ended shifts/)
    expect(arrival.textContent).toMatch(/a prompt to check, not a no-show/)
    expect(screen.getByText(/Compared with the publish of Sat 12 Sep, 14:02 by Manager M/)).toBeTruthy()
  })

  it('lists only what changed; unchanged coaches appear when asked', async () => {
    global.fetch = answer(200, { success: true, data: DATA })
    render(<RosterCompareSection {...props} />)
    const list = await screen.findByTestId('roster-compare-list')
    let rows = within(list).getAllByTestId('roster-compare-coach')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Coach A.*06:00–07:00 → 06:30–07:00.*Moved.*No arrival recorded/),
      expect.stringMatching(/Coach C.*was 18:00–19:00.*Removed after publish/),
    ])
    expect(within(list).getByText('Shift removed after publish')).toBeTruthy()
    expect(screen.queryByText('Coach B')).toBeNull()

    fireEvent.click(screen.getByLabelText('Show unchanged shifts'))
    rows = within(screen.getByTestId('roster-compare-list')).getAllByTestId('roster-compare-coach')
    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.textContent.includes('Coach B')).textContent).toMatch(/Arrived 05:58/)
  })

  it('a week exactly as published says so', async () => {
    const quiet = { ...DATA, blocks: [{ ...DATA.blocks[0], coaches: [coachRow({ arrived_local: '05:58', arrived_at: 'x' })] }] }
    global.fetch = answer(200, { success: true, data: quiet })
    render(<RosterCompareSection {...props} />)
    expect(await screen.findByText('Every shift is as it was published.')).toBeTruthy()
  })

  it('a roster with no snapshot says why, and is not an error', async () => {
    global.fetch = answer(200, { success: true, data: MISSING })
    render(<RosterCompareSection {...props} />)
    expect((await screen.findByTestId('roster-compare-missing')).textContent)
      .toBe('Published vs now is available for rosters published from Sat 26 Sep. This roster was published before then.')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('roster-compare-totals')).toBeNull()
  })

  it('a failed read is an ERROR, never "every shift is as it was published"', async () => {
    global.fetch = answer(500, { success: false, error: 'The comparison could not be read' })
    render(<RosterCompareSection {...props} />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be read/)
    expect(screen.queryByText('Every shift is as it was published.')).toBeNull()
  })

  it('a dropped connection is an error in words an operator can read', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    render(<RosterCompareSection {...props} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Network error, could not load the comparison.')
  })

  it('with several publishes of the period, choosing another re-reads against it', async () => {
    const earlier = { ...PUB, snapshot_id: 's0', roster_id: 'r0', published_at: '2026-09-10T08:00:00Z' }
    global.fetch = answer(200, { success: true, data: { ...DATA, publishes: [PUB, earlier] } })
    render(<RosterCompareSection {...props} />)
    const select = await screen.findByLabelText('Compare with')
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Sat 12 Sep, 14:02 · Mon 14 Sep – Sun 20 Sep (this roster)',
      'Thu 10 Sep, 09:00 · Mon 14 Sep – Sun 20 Sep',
    ])
    fireEvent.change(select, { target: { value: 's0' } })
    await waitFor(() => expect(urls()).toContain('/api/schedule/rosters/r1/compare?from=2026-09-14&to=2026-09-20&against=s0'))
  })

  it('offers no choice when there is only one publish', async () => {
    global.fetch = answer(200, { success: true, data: DATA })
    render(<RosterCompareSection {...props} />)
    await screen.findByTestId('roster-compare-totals')
    expect(screen.queryByLabelText('Compare with')).toBeNull()
  })

  it('nothing in the period is published: says so and reads nothing', () => {
    global.fetch = vi.fn()
    render(<RosterCompareSection {...props} rosterIds={[]} />)
    expect(screen.getByText(/Nothing in this period is on a published roster/)).toBeTruthy()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('reads at most four rosters, and says so', async () => {
    global.fetch = answer(200, { success: true, data: DATA })
    render(<RosterCompareSection {...props} rosterIds={['a', 'b', 'c', 'd', 'e']} />)
    await screen.findAllByTestId('roster-compare-totals')
    expect(global.fetch).toHaveBeenCalledTimes(4)
    expect(screen.getByText(/Showing the first 4 of 5 rosters/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/components/schedule/RosterCompareSection.test.jsx`
Expected: FAIL, `Failed to resolve import "./RosterCompareSection.jsx"`.

- [ ] **Step 3: Write the component** at `src/components/schedule/RosterCompareSection.jsx`:

```jsx
// src/components/schedule/RosterCompareSection.jsx
'use client'

// SNAPSHOT.1 — "Published vs now", inside the change-log dialog. One section
// per published roster the period on screen sits on (a Mon-Sun week can
// straddle two month rosters), each reading
// GET /api/schedule/rosters/[id]/compare for that period.
//
// Four states that must never be confused: loading, an ERROR, a roster with
// no snapshot (published before snapshots began, or not saved at the time),
// and a real comparison. Only the last can say "Every shift is as it was
// published". "No arrival recorded" is advisory and worded that way.

import { useEffect, useState } from 'react'
import { readJson } from './useScheduleData'
import {
  COMPARE_CHANGE_LABELS, COMPARE_CHANGE_CHIP, ARRIVAL_CAVEAT,
  dayLabel, periodLabel, publishedLabel, windowLabel,
  totalsSentence, changeCountsSentence, arrivalSentence,
  compareRowSummary, arrivalLabel, blockChangeNotes,
  missingSnapshotMessage, publishOptionLabel, visibleCompareBlocks,
} from '@/lib/roster-compare-format'

export const MAX_COMPARE_ROSTERS = 4

export default function RosterCompareSection({ rosterIds, from, to }) {
  const [showUnchanged, setShowUnchanged] = useState(false)
  const all = rosterIds || []
  const ids = all.slice(0, MAX_COMPARE_ROSTERS)

  if (ids.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-un1t-subtle">
        Nothing in this period is on a published roster, so there is nothing to compare.
      </p>
    )
  }

  return (
    <div data-testid="roster-compare-section">
      <p className="text-xs text-un1t-subtle mb-2">
        What was published, against who is rostered now and who arrived. Nothing here alerts anyone.
      </p>
      <label className="inline-flex items-center gap-2 text-xs text-un1t-text mb-3">
        <input
          type="checkbox"
          checked={showUnchanged}
          onChange={(e) => setShowUnchanged(e.target.checked)}
        />
        Show unchanged shifts
      </label>
      <div className="space-y-4">
        {ids.map((id) => (
          <RosterCompareOne key={id} rosterId={id} from={from} to={to} showUnchanged={showUnchanged} />
        ))}
      </div>
      {all.length > ids.length && (
        <p className="text-xs text-un1t-subtle mt-2">
          Showing the first {ids.length} of {all.length} rosters in this period. Pick a shorter period to see the rest.
        </p>
      )}
    </div>
  )
}

function RosterCompareOne({ rosterId, from, to, showUnchanged }) {
  const [against, setAgainst] = useState(null)
  // Starts in `loading`, so the effect never sets state synchronously.
  const [state, setState] = useState({ loading: true, error: null, data: null })

  useEffect(() => {
    // Effect-scoped generation guard: an answer for a baseline or period that
    // is no longer the one asked for writes nothing.
    let cancelled = false
    async function load() {
      try {
        const qs = new URLSearchParams({ from, to })
        if (against) qs.set('against', against)
        const body = await readJson(`/api/schedule/rosters/${rosterId}/compare?${qs.toString()}`)
        if (cancelled) return
        setState({ loading: false, error: null, data: body.data || null })
      } catch (e) {
        if (cancelled) return
        const message = e instanceof TypeError || !e?.message
          ? 'Network error, could not load the comparison.'
          : e.message
        setState((s) => ({ loading: false, error: message, data: s.data }))
      }
    }
    load()
    return () => { cancelled = true }
  }, [rosterId, from, to, against])

  // The previous answer stays on screen while the new one loads, so the select
  // the manager just used keeps its focus.
  function chooseBaseline(snapshotId) {
    setState((s) => ({ ...s, loading: true, error: null }))
    setAgainst(snapshotId || null)
  }

  const { loading, error, data } = state
  const headingId = `roster-compare-${rosterId}`
  return (
    <section
      aria-labelledby={headingId}
      data-testid="roster-compare"
      className="rounded-md border border-un1t-border p-3"
    >
      <h3 id={headingId} className="text-sm font-medium text-un1t-text">
        {data?.roster ? `Roster ${periodLabel(data.roster.period_start, data.roster.period_end)}` : 'Roster'}
      </h3>
      {loading && !data && <div className="py-3 text-sm text-un1t-subtle">Loading the comparison…</div>}
      {loading && data && <div className="text-xs text-un1t-subtle" aria-live="polite">Updating…</div>}
      {!loading && error && (
        <div role="alert" className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {!error && data && (
        <CompareBody data={data} rosterId={rosterId} showUnchanged={showUnchanged} onChooseBaseline={chooseBaseline} />
      )}
    </section>
  )
}

function CompareBody({ data, rosterId, showUnchanged, onChooseBaseline }) {
  if (!data.baseline) {
    return (
      <p data-testid="roster-compare-missing" className="mt-2 text-sm text-un1t-subtle">
        {missingSnapshotMessage(data)}
      </p>
    )
  }
  const t = data.totals
  const shown = visibleCompareBlocks(data.blocks, showUnchanged)
  const arrival = arrivalSentence(t)
  const selectId = `roster-compare-against-${rosterId}`
  return (
    <div className="mt-1">
      <div className="text-xs text-un1t-subtle">
        Compared with the publish of {publishedLabel(data.baseline.published_at)}
        {data.baseline.published_by_name ? ` by ${data.baseline.published_by_name}` : ''}
      </div>
      {(data.publishes || []).length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <label htmlFor={selectId} className="text-un1t-subtle">Compare with</label>
          <select
            id={selectId}
            value={data.baseline.snapshot_id}
            onChange={(e) => onChooseBaseline(e.target.value)}
            className="max-w-full rounded-md border border-un1t-border bg-un1t-surface px-2 py-1 text-xs text-un1t-text"
          >
            {data.publishes.map((p) => (
              <option key={p.snapshot_id} value={p.snapshot_id}>{publishOptionLabel(p, rosterId)}</option>
            ))}
          </select>
        </div>
      )}
      <div data-testid="roster-compare-totals" className="mt-2 text-sm text-un1t-text">{totalsSentence(t)}</div>
      <div className="text-xs text-un1t-subtle">{changeCountsSentence(t)}</div>
      {arrival && <div className="mt-1 text-xs text-un1t-subtle">{arrival}. {ARRIVAL_CAVEAT}</div>}

      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-un1t-subtle">
          {showUnchanged ? 'No shifts in this period.' : 'Every shift is as it was published.'}
        </p>
      ) : (
        <ul data-testid="roster-compare-list" className="mt-3 divide-y divide-un1t-border">
          {shown.map((b) => (
            <li key={b.slot} className="py-2">
              <div className="text-sm text-un1t-text">
                {dayLabel(b.date)} · {windowLabel(b.current || b.published)} · {b.template_name || 'Shift'}
              </div>
              {blockChangeNotes(b).map((note) => (
                <div key={note} className="text-[11px] text-amber-700">{note}</div>
              ))}
              {b.coaches.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {b.coaches.map((r) => {
                    const arrivalText = arrivalLabel(r)
                    return (
                      <li
                        key={r.profile_id}
                        data-testid="roster-compare-coach"
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                      >
                        <span className="text-un1t-text">{r.name || 'Name unavailable'}</span>
                        <span className="text-un1t-subtle">{compareRowSummary(r)}</span>
                        <span className={`px-1.5 py-0.5 rounded font-medium ${COMPARE_CHANGE_CHIP[r.change]}`}>
                          {COMPARE_CHANGE_LABELS[r.change]}
                        </span>
                        {arrivalText && (
                          <span
                            className={`px-1.5 py-0.5 rounded font-medium ${r.no_show_candidate ? 'bg-amber-500/10 text-amber-700' : 'bg-green-500/10 text-green-700'}`}
                          >
                            {arrivalText}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/components/schedule/RosterCompareSection.test.jsx`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/RosterCompareSection.jsx src/components/schedule/RosterCompareSection.test.jsx
git commit -m "SNAPSHOT.1 — RosterCompareSection: published vs now per roster, changes only by default, choose an earlier publish

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The change-log dialog gets the switch; the calendar passes the period's rosters

**Files:**
- Modify: `src/components/schedule/RosterChangeLogDrawer.jsx` (whole file below)
- Modify: `src/components/schedule/RosterChangeLogDrawer.test.jsx` (append)
- Modify: `src/components/ScheduleCalendar.jsx` (import after line 72; `openChangeLog` at 575-581; drawer props at 1531-1538)
- Modify: `src/components/ScheduleCalendar.visibility.test.jsx` (append one `it` inside `describe('changes since publish (CHANGELOG.1)')`)

- [ ] **Step 1: Write the failing dialog tests.** Append to `src/components/schedule/RosterChangeLogDrawer.test.jsx`:

```jsx
// SNAPSHOT.1 — the dialog's second view. Opening it still reads ONE thing
// (the change log); the comparison is read on first switch.
describe('RosterChangeLogDrawer — Published vs now (SNAPSHOT.1)', () => {
  const MISSING = {
    roster: { id: 'r1', status: 'published', period_start: '2026-09-14', period_end: '2026-09-20', published_at: '2026-09-12T13:02:00Z' },
    window: null, baseline: null, missing_reason: 'before_snapshots', snapshots_began_at: null,
    publishes: [], blocks: [], totals: null,
  }
  const byUrl = () => vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).startsWith('/api/schedule/change-log')
      ? { success: true, data: { changes: [], truncated: false } }
      : { success: true, data: MISSING }),
  }))

  it('offers no comparison when nothing in the period is on a published roster', async () => {
    global.fetch = byUrl()
    render(<RosterChangeLogDrawer {...props} />)
    await screen.findByText(/No changes since this was published/)
    expect(screen.queryByRole('button', { name: 'Published vs now' })).toBeNull()
  })

  it('switches to the comparison, which reads each roster for the period; switching back reads nothing again', async () => {
    global.fetch = byUrl()
    render(<RosterChangeLogDrawer {...props} rosterIds={['r1']} />)
    await screen.findByText(/No changes since this was published/)
    expect(global.fetch).toHaveBeenCalledTimes(1)

    const compare = screen.getByRole('button', { name: 'Published vs now' })
    const changesBtn = screen.getByRole('button', { name: 'Changes' })
    expect(changesBtn.getAttribute('aria-pressed')).toBe('true')
    expect(compare.getAttribute('aria-pressed')).toBe('false')

    await act(async () => { compare.click() })
    expect(compare.getAttribute('aria-pressed')).toBe('true')
    await screen.findByTestId('roster-compare-missing')
    expect(global.fetch.mock.calls.map((c) => String(c[0])))
      .toContain('/api/schedule/rosters/r1/compare?from=2026-09-14&to=2026-09-20')

    await act(async () => { changesBtn.click() })
    expect(await screen.findByText(/No changes since this was published/)).toBeTruthy()
    expect(global.fetch.mock.calls.filter((c) => String(c[0]).startsWith('/api/schedule/change-log'))).toHaveLength(1)
  })

  it('the switch buttons are typed buttons, so they can never submit anything', async () => {
    global.fetch = byUrl()
    render(<RosterChangeLogDrawer {...props} rosterIds={['r1']} />)
    await screen.findByText(/No changes since this was published/)
    for (const name of ['Changes', 'Published vs now']) {
      expect(screen.getByRole('button', { name }).getAttribute('type')).toBe('button')
    }
  })
})
```

- [ ] **Step 2: Write the failing calendar test.** In `src/components/ScheduleCalendar.visibility.test.jsx`, inside `describe('changes since publish (CHANGELOG.1)', …)`, after the `'a partly published week opens it too'` test, add:

```jsx
  // SNAPSHOT.1 — the calendar already holds each block's roster_id, so the
  // dialog is told which published rosters the week sits on at no cost.
  it('offers Published vs now for the rosters the week sits on, and reads that roster for the week', async () => {
    await renderCalendar({ blocks: [{ ...SHORT_BLOCK, roster_id: 'r1' }, { ...OK_BLOCK, roster_id: 'r1' }] })
    fireEvent.click(screen.getByTestId('publication-status'))
    const dialog = await screen.findByRole('dialog')
    const compare = within(dialog).getByRole('button', { name: 'Published vs now' })
    await act(async () => { fireEvent.click(compare) })
    const sunday = new Date(`${isoMonday()}T00:00:00`)
    sunday.setDate(sunday.getDate() + 6)
    await waitFor(() => expect(global.fetch.mock.calls.map(([u]) => String(u)))
      .toContain(`/api/schedule/rosters/r1/compare?from=${isoMonday()}&to=${iso(sunday)}`))
  })
```

(The file's `mockFetch` answers any `/api/schedule/rosters` GET with the drafts list, so the section renders its missing-snapshot text; only the request is asserted here. `act`, `waitFor`, `within`, `fireEvent`, `isoMonday` and `iso` are already imported or defined in that file.)

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run src/components/schedule/RosterChangeLogDrawer.test.jsx src/components/ScheduleCalendar.visibility.test.jsx`
Expected: FAIL on the four new tests (`Unable to find role="button" and name "Published vs now"`); every existing test passes.

- [ ] **Step 4: Replace `src/components/schedule/RosterChangeLogDrawer.jsx`** with:

```jsx
// src/components/schedule/RosterChangeLogDrawer.jsx
'use client'

// CHANGELOG.1 — "Changes since publish". Opened from the schedule's Published
// chip. Reads GET /api/schedule/change-log for the period on screen and prints
// each edit as a sentence (src/lib/roster-change-format.js).
//
// Three states that must never be confused: loading, an ERROR, and a genuinely
// empty period. An error is rendered as an error; "No changes" is only ever
// said about a read that succeeded.
//
// SNAPSHOT.1 — and "Published vs now". When the period's shifts sit on at
// least one published roster (`rosterIds`, from the blocks the calendar
// already holds), a two-button switch shows RosterCompareSection instead of
// the change list. The comparison is read on first switch, so opening the
// dialog still reads exactly one thing.

import { useEffect, useState } from 'react'
import Modal from '@/components/ui/Modal'
import {
  rosterChangeSentence, rosterChangeTold, rosterChangeByline, ROSTER_CHANGE_LOG_MAX_ROWS,
} from '@/lib/roster-change-format'
import { readJson } from './useScheduleData'
import RosterCompareSection from './RosterCompareSection'

function switchCls(on) {
  return `px-3 py-1.5 ${on ? 'bg-un1t-surface text-un1t-text font-medium' : 'text-un1t-subtle hover:text-un1t-text'} focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent`
}

export default function RosterChangeLogDrawer({ locationId, periodStart, periodEnd, periodLabel, rosterIds = [], onClose, restoreFocusRef }) {
  // Starts in `loading`, so the effect below never sets state synchronously.
  const [state, setState] = useState({ loading: true, error: null, changes: [], truncated: false })
  // SNAPSHOT.1 — 'changes' | 'compare'.
  const [view, setView] = useState('changes')

  useEffect(() => {
    // The generation guard in its effect-scoped form: a response for a period
    // that is no longer the one on screen (or for a drawer that has closed)
    // writes nothing.
    let cancelled = false
    async function load() {
      try {
        // readJson is the schedule screen's one reader: it THROWS on anything
        // that is not a success, in words an operator can act on. A dead
        // session reads as signed out whether it arrives as a 401 or, as in
        // production, as a followed redirect to /login (200 + HTML); a 403
        // keeps the server's own sentence.
        const body = await readJson(`/api/schedule/change-log?location_id=${locationId}&from=${periodStart}&to=${periodEnd}`)
        if (cancelled) return
        setState({ loading: false, error: null, changes: body.data?.changes || [], truncated: Boolean(body.data?.truncated) })
      } catch (e) {
        if (cancelled) return
        // ROSTER-FIX.6a — fetch rejects with a TypeError when the connection
        // drops, and its message ("Failed to fetch") is not for an operator.
        // Everything readJson throws itself is a plain Error written for one.
        const message = e instanceof TypeError || !e?.message
          ? 'Network error, could not load the changes.'
          : e.message
        setState({ loading: false, error: message, changes: [], truncated: false })
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId, periodStart, periodEnd])

  const { loading, error, changes, truncated } = state
  const untold = changes.filter((c) => !c.notified_at).length
  const canCompare = (rosterIds || []).length > 0

  return (
    <Modal
      open
      onClose={onClose}
      title="Changes since publish"
      size="lg"
      restoreFocusRef={restoreFocusRef}
      footer={(
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 rounded-md text-sm border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30"
        >
          Close
        </button>
      )}
    >
      <div>
        <div className="text-xs text-un1t-subtle mb-3">{periodLabel}</div>

        {canCompare && (
          <div role="group" aria-label="Show" className="mb-3 inline-flex overflow-hidden rounded-md border border-un1t-border text-xs">
            <button type="button" aria-pressed={view === 'changes'} onClick={() => setView('changes')} className={switchCls(view === 'changes')}>
              Changes
            </button>
            <button type="button" aria-pressed={view === 'compare'} onClick={() => setView('compare')} className={`border-l border-un1t-border ${switchCls(view === 'compare')}`}>
              Published vs now
            </button>
          </div>
        )}

        {view === 'compare' ? (
          <RosterCompareSection rosterIds={rosterIds} from={periodStart} to={periodEnd} />
        ) : (
          <>
            {loading && (
              <div className="text-center py-6 text-sm text-un1t-subtle">Loading changes…</div>
            )}

            {!loading && error && (
              <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700">
                {error}
              </div>
            )}

            {!loading && !error && changes.length === 0 && (
              <div className="py-6 text-center">
                <div className="text-sm text-un1t-text">No changes since this was published.</div>
                <p className="text-xs text-un1t-subtle mt-1">
                  Only edits to shifts on a published roster are recorded here. Edits to a week that is not published yet are part of its first publish.
                </p>
              </div>
            )}

            {!loading && !error && changes.length > 0 && (
              <>
                <div data-testid="roster-change-summary" className="text-xs text-un1t-subtle mb-2">
                  {changes.length} change{changes.length === 1 ? '' : 's'}
                  {untold > 0 && (
                    <span className="text-amber-700"> · {untold} not told yet. Publish again to tell them.</span>
                  )}
                </div>
                {/* A scrolling box with nothing focusable inside cannot be scrolled
                    from the keyboard, so the box itself takes focus and a name.

                    ONE scroller, not two. Modal's body scrolls too, and a fixed
                    60vh list inside it double-scrolled on a short viewport. The cap
                    is the viewport minus everything else the dialog stacks: 2rem
                    of backdrop padding, the header and footer bars (~3.1rem and
                    ~3.6rem), the body's 2rem of padding, and the period, summary
                    and cut-short lines above and below the list (~5rem). 17rem
                    leaves a little slack, so the body never needs its own scroll
                    while the list has room; min-h keeps a usable list on a very
                    short screen, where the body scrolling is the lesser evil.
                    SNAPSHOT.1 — the switch row adds ~2.5rem when it shows. */}
                <div
                  role="region"
                  aria-label="Changes, newest first"
                  tabIndex={0}
                  className={`${canCompare ? 'max-h-[calc(100vh-19.5rem)]' : 'max-h-[calc(100vh-17rem)]'} min-h-[6rem] overflow-y-auto rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent`}
                >
                  <ul data-testid="roster-change-list" className="divide-y divide-un1t-border">
                    {changes.map((c) => {
                    // null = stamped, but the stamp does not mean anybody was told
                    // (stampMeansTold): no chip, rather than a time nobody was told at.
                    const told = rosterChangeTold(c)
                    return (
                      <li key={c.id} className="py-2">
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-sm text-un1t-text">
                            {rosterChangeSentence(c)}
                            {c.shift_name ? <span className="text-un1t-subtle"> · {c.shift_name}</span> : null}
                          </span>
                          {told && (
                            <span
                              data-testid="roster-change-told"
                              className={`flex-shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded ${c.notified_at ? 'bg-green-500/10 text-green-700' : 'bg-amber-500/10 text-amber-700'}`}
                            >
                              {told}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-un1t-subtle mt-0.5">{rosterChangeByline(c)}</div>
                      </li>
                    )
                  })}
                  </ul>
                </div>
                {truncated && (
                  <p className="text-xs text-un1t-subtle mt-2">Showing the most recent {ROSTER_CHANGE_LOG_MAX_ROWS.toLocaleString('en-IE')}. Pick a shorter period to see older ones.</p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
```

(If BLOCKEDIT.1 has merged first and changed this file, apply the same three edits to its version instead: the `rosterIds = []` prop and `view` state; the switch after the period line; the `view === 'compare' ? … : (<> …existing body… </>)` wrap and the conditional `max-h`. BLOCKEDIT.1's branch does not touch this file today.)

- [ ] **Step 5: Wire the calendar.** In `src/components/ScheduleCalendar.jsx`:

(a) After `import RosterChangeLogDrawer from './schedule/RosterChangeLogDrawer'` (line 72), add:

```js
import { publishedRosterIdsIn } from '@/lib/roster-compare-format'
```

(b) Replace the `openChangeLog` body (575-581):

```js
  const openChangeLog = () => {
    setChangeLog({
      start: visiblePeriodStart,
      end: visiblePeriodEnd,
      label: viewType === 'month' ? monthLabel : weekLabel,
    })
  }
```

with:

```js
  const openChangeLog = () => {
    setChangeLog({
      start: visiblePeriodStart,
      end: visiblePeriodEnd,
      label: viewType === 'month' ? monthLabel : weekLabel,
      // SNAPSHOT.1 — the published rosters this period's shifts sit on, for
      // the dialog's Published vs now view. Read from the blocks already held.
      rosterIds: publishedRosterIdsIn(blocks, visiblePeriodStart, visiblePeriodEnd),
    })
  }
```

(c) In the drawer's JSX (1531-1538), add one prop after `periodLabel={changeLog.label}`:

```jsx
          rosterIds={changeLog.rosterIds}
```

- [ ] **Step 6: Run to see them pass**

Run: `npx vitest run src/components/schedule/RosterChangeLogDrawer.test.jsx src/components/ScheduleCalendar.visibility.test.jsx src/components/schedule/RosterCompareSection.test.jsx`
Expected: PASS, every existing test included ("asks for exactly the studio and period on screen, once" still passes: the comparison is not read until the switch).

- [ ] **Step 7: Lint the touched UI**

Run: `npx eslint src/components/schedule/RosterChangeLogDrawer.jsx src/components/schedule/RosterCompareSection.jsx src/components/ScheduleCalendar.jsx && npm run check:guardrails`
Expected: exit 0 (every `<button>` typed; chips on the `-500/10` + `-700` rule; no dead `un1t-*` token).

- [ ] **Step 8: Commit**

```bash
git add src/components/schedule/RosterChangeLogDrawer.jsx src/components/schedule/RosterChangeLogDrawer.test.jsx src/components/ScheduleCalendar.jsx src/components/ScheduleCalendar.visibility.test.jsx
git commit -m "SNAPSHOT.1 — the change-log dialog gains Published vs now for the rosters the period sits on

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: OpenAPI, the guardrail arm, and the roster doc

**Files:**
- Modify: `src/lib/openapi.js` (after the `path: '/api/schedule/rosters/{id}/reject'` registration, which ends just before the next `registry.registerPath({` at ~4806)
- Modify: `src/lib/openapi.test.js` (append one `it` inside `describe('getOpenApiSpec', …)`, after the calendar-feed `it` at ~363-379)
- Modify: `eslint.guardrails.config.mjs` (`no-unchecked-supabase-write` `files`, after `'src/lib/staff-calendar-feed-server.js',` at line 300)
- Modify: `docs/roster-v2.md` (append after the "Calendar subscription (ICSFEED.1 …)" section)

- [ ] **Step 1: Write the failing spec test.** Append inside `describe('getOpenApiSpec', …)` in `src/lib/openapi.test.js`:

```js
  // SNAPSHOT.1 — published vs now vs arrived, manager-only.
  it('documents the roster comparison', () => {
    const op = spec.paths['/api/schedule/rosters/{id}/compare']?.get
    expect(op, 'missing GET /api/schedule/rosters/{id}/compare').toBeTruthy()
    expect(op.tags).toContain('Schedule')
    expect(op.security).toContainEqual({ CookieAuth: [] })
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '400', '403', '404', '409', '500']))
    expect(op.description).toMatch(/advisory/i)
    expect(op.description).toMatch(/never a rate or a cost/i)
  })
```

Run: `npx vitest run src/lib/openapi.test.js`
Expected: this one `it` fails (`missing GET /api/schedule/rosters/{id}/compare`).

- [ ] **Step 2: Register the path** in `src/lib/openapi.js`, directly after the reject registration's closing `})`:

```js
// SNAPSHOT.1 — a roster as published (mig 634 snapshot), as rostered now, and
// as arrived. Manager-only; advisory.
registry.registerPath({
  method: 'get',
  path: '/api/schedule/rosters/{id}/compare',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'A published roster as published, as rostered now, and as arrived (manager-only)',
  description: "Compares the snapshot written when this roster was published (roster_publish_snapshots, mig 634; one per publish, immutable, taken after the publish tagged its blocks) with the live shift blocks and assignments, and with arrival stamps (shift_assignments.arrived_at, carried onto a back-to-back shift as the attendance report does). Query: from and to (optional real YYYY-MM-DD dates, the period on screen, clipped to the published period); against (optional snapshot id at the same studio, to compare with another publish of the period, such as the first). Returns roster, window, baseline (snapshot_id, roster_id, published_at, period, published_by_name), publishes (every snapshot at the studio overlapping the window, newest first, at most 20), blocks (per shift: published and current times and minimum/maximum, change unchanged | moved | added | removed, staffing_changed; per coach: name, published and current windows, change, arrived_at, arrived_local, arrival_inferred, ended, no_show_candidate) and totals (published and current shifts and wall-clock hours, hours_delta, counts per change, ended, arrived, no_show_candidates). no_show_candidate is ADVISORY (an ended shift with no arrival stamp; stamps exist for a minority of shifts) and nothing alerts anyone. A roster with no snapshot answers 200 with baseline null and missing_reason 'before_snapshots' (published before the studio's first snapshot, snapshots_began_at says when that was; there is no backfill) or 'not_saved' (the write failed at the time and was logged). Manager-only (master, owner, manager, head_coach AT the roster's studio): an outsider gets 404, a member without the role there 403. Names, times, hours and arrival stamps only, never a rate or a cost.",
  request: {
    params: z.object({ id: uuidLike }),
    query: z.object({ from: isoDate.optional(), to: isoDate.optional(), against: uuidLike.optional() }),
  },
  responses: {
    200: { description: '{ success, data: { roster, window, baseline, missing_reason, snapshots_began_at, publishes, blocks, totals } }' },
    400: { description: 'from or to not a real date, to before from, or a malformed against id', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — needs a manager role at the roster\'s location', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Roster not found (or at a studio outside your assignments), or the against snapshot is not at this studio', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'The roster is a draft: nothing was published', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'The comparison could not be read (never answered as an empty comparison)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

(`isoDate`, `uuidLike`, `z` and `ErrorResponse` are already in scope in `openapi.js`: `isoDate` is used at line ~498, `uuidLike` by the approve/reject registrations.)

Run: `npx vitest run src/lib/openapi.test.js`
Expected: PASS.

- [ ] **Step 3: Arm the write rule on the new IO.** In `eslint.guardrails.config.mjs`, after `'src/lib/staff-calendar-feed-server.js',` (line 300), add:

```js
      // SNAPSHOT.1 — the publish snapshot write (best-effort by contract, one
      // retry, logError) and the comparison route. Best-effort writes are
      // exactly the shape that reads as handled and is not. Born clean, armed
      // on arrival. `*` stands for the [id] segment (a bracket is a glob
      // character class).
      'src/lib/roster-snapshot.js',
      'src/app/api/schedule/rosters/*/compare/**',
```

Run: `npm run check:guardrails`
Expected: exit 0.

- [ ] **Step 4: Document it.** Append to `docs/roster-v2.md`:

```markdown
## Publish snapshots (SNAPSHOT.1, mig 634, 2026-09)

Every publish (POST `/api/schedule/rosters`, or an owner approving a draft)
writes one row to `roster_publish_snapshots`: the period's shift blocks (slot
`template_id|date`, template name and kind, times, minimum, maximum) and each
block's live coaches (profile id, effective window: override, else the block's
own time), as one `jsonb` document with `format_version` 1. One row per
`rosters` row (`UNIQUE (roster_id)`): every publish and re-publish inserts its
own roster row, so this is one per publish.

- **When:** after the publish has tagged the period's blocks, before the
  supersede sweep and the notifications. Not on a draft, not on a dry run,
  not when the tag failed (those blocks were not published by this roster).
- **Never blocks a publish:** `writePublishSnapshot` (`src/lib/roster-snapshot.js`)
  never throws, retries its insert once, and logs a failure with
  `logError('roster-snapshot', …)`. There is no publish transaction to join
  (the publish is a chain of PostgREST writes), and a lost audit record must
  not cost coaches their notification.
- **Immutable:** service role holds SELECT and INSERT only; a trigger refuses
  any UPDATE, the owner's included. Rows go only by cascade (a deleted draft
  roster, which never has one; a deleted location).
- **No names, no pay:** profile ids only; names are read when compared (a
  tombstone keeps `full_name`).
- **No backfill:** rosters published before the studio's first snapshot have
  none, and the view says from when they exist.

**Reading it:** `GET /api/schedule/rosters/[id]/compare?from&to&against`
(manager at the roster's studio) returns, per shift and coach, published vs
current window, the change (unchanged, moved, added after publish, removed
after publish) and the arrival stamp, with totals. Blocks match on the slot,
coaches on profile id within it (a swap reads as removed + added). Hours are
wall-clock like payroll's, except that `'24:00'` counts as midnight here.
"No arrival recorded" (`no_show_candidate`) is advisory: stamps exist for a
minority of shifts, and nothing alerts. The web view is "Published vs now" in
the change-log dialog (the Published chip), one section per published roster
the period sits on.
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js eslint.guardrails.config.mjs docs/roster-v2.md
git commit -m "SNAPSHOT.1 — OpenAPI for the roster comparison, the write rule armed on the new IO, roster doc

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine). Rebase on `origin/main` (14 BLOCKEDIT.1 and 33 QUALS.1 may have landed; both touch `ScheduleCalendar.jsx`) and re-run the focused suites before the full gate:

```bash
git fetch origin main && git rebase origin/main
npx vitest run tests/migration-634-roster-publish-snapshots.test.js src/lib/roster-compare.test.js src/lib/roster-snapshot.test.js src/lib/roster-compare-format.test.js 'src/app/api/schedule/rosters' src/components/schedule/RosterCompareSection.test.jsx src/components/schedule/RosterChangeLogDrawer.test.jsx src/components/ScheduleCalendar.visibility.test.jsx src/lib/openapi.test.js
TZ=America/New_York npx vitest run src/lib/roster-compare.test.js src/lib/roster-compare-format.test.js
```

Expected: all green.

- [ ] **The 12-command CI mirror (CLAUDE.md "Build, test & ship"):**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0 and vitest reports `0 failed`.
- `check:route-guards`: the compare route calls `getCurrentUser`.
- `check:location-scoping`: `roster_publish_snapshots` carries `location_id`, so it joins the tenant-table set automatically; no route queries it directly (only `src/lib/roster-snapshot.js`, which pins `location_id` on every read), and the compare route's `rosters` read has `assertLocationAccessOr404(` as evidence.
- `check:select-columns`: every literal column (the `shift_blocks` select with its two embeds, `locations(id, timezone)`, `profiles(id, full_name)`, the snapshot publishes list, `published_at`, and the compare route's `rosters` select) resolves against migrations 067/072/099/100/177/609/628/634.
- `check:mobile-parity`, `check:mobile-imports`, `check:mobile-lint`, `check:ota-paths`: untouched (no permission key, nothing under `mobile/` or `shared/`).
- `check:rls-restrictive`: the new table has no policies at all.

- [ ] **The build:**

```bash
npm run build
```

Expected: `✓ Compiled successfully`, and the route table lists `ƒ /api/schedule/rosters/[id]/compare`. This is the only check that catches a bad `@/lib/…` import (vitest runs on mocked imports), which matters here because `roster-compare.js` pulls `staff-calendar-feed`, `tz-time`, `staff-attendance` and `@shared/shift-kind` into a server route and `roster-compare-format.js` into a client component.

- [ ] **Independent review** (standing rule). Point the reviewer at: D2 (after the tag, best-effort, never failing the publish, and why not a transaction); D3 (one snapshot per `rosters` row; `format_version` instead of the brief's `version`); D4 (the grants: service_role SELECT/INSERT only, plus the trigger); D7 (slot matching; a swap is removed + added); D9 (advisory wording); the two route insertion points (after the `if (tagErr)` block, before the supersede sweep); the compare route's gate order; `loadRosterComparison`'s "a failed read is an error, a failed names read is not".

- [ ] **Browser checks** (memory `jsdom-cannot-see-layout`: a green suite cannot see layout). On the Vercel preview once mig 634 is applied, signed in as a manager, `/schedule`. **Do NOT publish on the preview just to test**: the preview runs against prod, so a publish is a real publish and notifies real coaches (an exact re-publish re-notifies anyone with untold changes). Use the rosters already published:
  1. A published week: click the green Published chip → the dialog shows "Changes | Published vs now"; the Changes view is unchanged from today.
  2. Published vs now on a roster published before deploy: the section says "Published vs now starts with the next publish at this studio…" (no snapshot exists yet anywhere). No red box.
  3. At 390px wide (DevTools device toolbar): the switch, the section heading, the totals and a long coach row wrap without horizontal scroll; the dialog scrolls with ONE scrollbar (the Changes list's cap moved from `17rem` to `19.5rem` when the switch shows).
  4. Keyboard: Tab reaches both switch buttons and the "Show unchanged shifts" box; Space toggles them; `aria-pressed` flips (screen reader or the Accessibility pane).
  5. A month view whose visible month straddles two published rosters (if one exists): two sections.
  After the **first real publish** post-merge (by Richard, not staged): repeat 1-4 on that week and see real totals, run the "AFTER THE FIRST REAL PUBLISH" SQL from the migration header, and record what each showed in the PR.

---

### Migration apply steps (after review is approved, BEFORE merge)

The operator is the orchestrating session, under Richard's 25 Sep merge authority.

1. `list_projects` → confirm `iyvtbjjxdggiadzwwvdj` is **un1t-crm**, not the sentinel project. `list_migrations` → confirm there is no 634.
2. Run pre-checks **(a)–(e)** from the migration header with `execute_sql`. Stop if (a), (b) or (d) differ from "Expected"; keep (c) and (e).
3. Write the rollback record to the scratchpad (`mig634-rollback-2026-09-2x.txt`): the output of (c) and (e) and the ROLLBACK block from the header, noting "revert code first; snapshots cannot be rebuilt".
4. `apply_migration` with name `634_roster_publish_snapshots` and the file's contents verbatim.
5. Run post-checks **(f)–(k)**. Then `get_advisors` type `security`, then type `performance`. Expected: INFO `rls_enabled_no_policy` on `roster_publish_snapshots` (by design, as `widget_tokens` and `staff_calendar_feeds`); possibly INFO `unused_index` on `roster_publish_snapshots_location_published_idx`; no `function_search_path_mutable` for `roster_publish_snapshots_refuse_update`.
6. Only now: rebase, wait for **Test & lint** and **Next build** to go green on the final rebase, and merge. **No OTA** (nothing under `mobile/` or `shared/`), so this merge does not wait on or block any EAS run.
7. After the next real publish at either studio: run the "AFTER THE FIRST REAL PUBLISH" query; check Vercel logs for `roster-snapshot` (expect none).

### PR

**Title:** `SNAPSHOT.1 — every publish keeps an immutable record of what it published; managers compare published vs now vs arrived (mig 634)`

**Body must say, in this order:**
1. **Migration 634 is applied BEFORE merge** (steps above). If the order ever slips, publishing is unaffected (the snapshot write logs and carries on); only the compare view errors until it exists.
2. **No OTA.** Web only; nothing under `mobile/` or `shared/`.
3. What is recorded, when: per publish (POST or an approval), after the blocks are tagged: every block in the period (slot, template name and kind, times, min/max) and every live coach (profile id, effective window). One immutable `jsonb` row per `rosters` row; service role SELECT/INSERT only plus an UPDATE-refusing trigger. No names, no pay.
4. **Never blocks a publish** (D2, the "never create a louder failure" invariant): no transaction exists to join; best-effort after the tag, one retry, `logError('roster-snapshot', …)`, nothing added to the publish response. Not written for drafts, dry runs, or a failed tag.
5. The comparison: `GET /api/schedule/rosters/[id]/compare` (manager at the studio; 404 outsider; 409 draft; 500 never an empty comparison). Slot matching; a swap reads removed + added; wall-clock hours like payroll; DST-exact "ended"; `?against=` compares with another publish of the period.
6. **Advisory only:** "No arrival recorded" is a prompt to check, never called a no-show, and alerts nothing (arrival stamps cover a minority of shifts; late/no-show alerts stay held per 00-INDEX).
7. **No backfill:** the view says from when snapshots exist at the studio.
8. The web view: "Published vs now" in the change-log dialog; unchanged hidden by default; up to four rosters per period.
9. Browser-check results (the five checks above; state that none involved publishing on the preview) and, once it has happened, the first real publish's snapshot row size and block count.
10. Follow-ups found (payroll `24:00` = 0h; see Review notes).
11. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit another row: `merge=union` duplicates an edited row.

```
| #<PR> | SNAPSHOT.1 — every publish keeps an immutable record of what it published; managers compare published vs now vs arrived | 2026-09-2x. Wave 3 PR 32. **Mig 634 applied before merge; no OTA.** `roster_publish_snapshots`: one jsonb row per `rosters` row (UNIQUE roster_id → rosters ON DELETE CASCADE; location → locations CASCADE; `format_version` 1; `block_count` CHECKed against the array; `published_by` without FK on purpose), RLS on with no policies, browser grants revoked, **service_role SELECT/INSERT only + a BEFORE UPDATE trigger refusing the owner too** (PGlite replay). Written by POST /api/schedule/rosters and approve AFTER the block tag, before the supersede sweep: best-effort (`writePublishSnapshot` never throws, one retry, 23505 on the retry = landed, `logError('roster-snapshot')`), never on a draft, dry run or failed tag; no publish transaction exists to join, and a lost record must not cost coaches their notice. Pure `src/lib/roster-compare.js`: slot `(template_id, block_date)` matching (a swap = removed + added), override-else-block windows, wall-clock hours as payroll (`24:00` = midnight here; payroll counts it 0h: follow-up), DST-exact ended via `wallInstant`, arrivals = `arrived_at` + the attendance report's back-to-back carry-over; tests for spring/autumn, overnight, `24:00`, added/removed blocks and coaches, re-published twice. `GET /api/schedule/rosters/[id]/compare` (manager at the studio, 404 outsider, 409 draft, 500 never empty; `from`/`to` window; `against` = another publish at the studio; `publishes` list; missing_reason `before_snapshots`/`not_saved`, no backfill). Web: "Published vs now" in the change-log dialog (lazy, unchanged hidden, ≤4 rosters). "No arrival recorded" advisory only; nothing alerts. |
```

---

### Review notes / open questions

1. **`version int` became `format_version` + one row per `rosters` row (D3).** The brief imagined re-publishes versioning one record. In this codebase every publish and re-publish inserts its own `rosters` row (`route.js:390`; the old one is superseded), so the natural key is `roster_id` and "which publish of this week" is the `publishes` list plus `?against=`. If Richard wants a per-period ordinal ("publish 3 of this week"), it can be derived at read time from `publishes`; no schema change needed.
2. **After the tag, not inside a transaction (D2).** There is no transaction to join: the publish is ~6 sequential PostgREST writes with hand-written compensation. Moving it into one SQL function would make the snapshot atomic with the publish, at the cost of rewriting the scheduler's most-reviewed code path. The honest `not_saved` message plus `logError` is the chosen trade. A reviewer who disagrees should say so before merge; the snapshot code is isolated enough to move into such a function later.
3. **The read-after-tag gap.** The snapshot reads blocks a few milliseconds after the tag. An edit landing in that window is recorded as published. Accepted: the change log (mig 236) still records the edit, and the window is far below anything a manager can hit.
4. **"No arrival recorded" will be noisy.** Arrival stamps exist for ~19% of shifts (00-INDEX), so most ended shifts will carry the amber chip. The wording, the caveat line and the "Show unchanged shifts" default are all chosen for that. If Richard finds it too loud, hiding the arrival chip until ARRIVALSHOW.1 (#34) raises coverage is a one-line change in `RosterCompareSection.jsx` (the totals line can stay).
5. **Arrival definition (D10).** Uses `arrived_at` plus the back-to-back carry-over, exactly the attendance report's. A `staff_attendance_events` row matched to an assignment whose `arrived_at` is empty is not read; mig 610 backfilled `arrived_at` from those, and mig 622 treats a matched event as an arrival for delete safety. If Richard wants the 622 definition here, it is one more paged read keyed by assignment id.
6. **Kind and template name are frozen at publish** (D1). If a template changes kind after publish, the block's `kind` in the comparison is the CURRENT one where the shift still exists (`(c || p).kind`), the published one where it was removed. Hours are unaffected either way.
7. **Draft approvals are snapshotted at approval,** not when the manager hit publish: the draft never put anything live, and approval re-projects the budget on current data too (BUDGETAPPROVE.1).
8. **Retention:** snapshots are kept indefinitely (well under 10 MB a year for two studios). A retention policy would need a DELETE path that does not exist (service role has no DELETE by design).
9. **No phone view.** Web-only by the brief; no permission key, so parity is unaffected. The phone's Manage mode could read the same route later.
10. **BLOCKEDIT.1's briefing note** is not in the snapshot (not asked for). Adding it later is additive: new keys in the document need no `format_version` bump as long as readers tolerate their absence.
11. **Superseded rosters are comparable**, and a trimmed roster's snapshot keeps its original period; the compare route clips to the window asked, so neither misreads.
12. **Up to four rosters per period** in the dialog. A month view normally sits on one or two; the cap is a guard against a studio that re-published many overlapping ranges.

### Follow-ups found while planning (not in this PR)

- 🔴 **Payroll counts a shift ending `'24:00'` as 0 hours.** `timeToHours` (`src/lib/payroll.js:25-34`) refuses hour 24, so `shiftHours` returns 0 for e.g. 22:00-24:00, and every hours/cost reader built on it (week cost, contractor spend, reports) under-counts that shift. `shift_blocks` allows `'24:00:00'` (`CHECK (end_time > start_time)`), and WORKTIME.1 met it as an end time. `roster-compare.test.js` pins today's 0h so the fix will flag that line for deletion.
- The compare route's `SNAPSHOT_COLUMNS` select is a constant, so `check:select-columns` cannot read it (a floor, not a proof); the mig 634 replay pins the columns instead. If the checker learns to follow a module-level string constant, this becomes covered for free.

---

### Self-review (done while writing)

- **Spec coverage:** snapshot per block (date, template, kind, times, min/max) and per live assignment (coach, effective window): Task 2 `buildPublishSnapshot`. On publish and every re-publish: Task 6 (POST + approve; one row per `rosters` row, D3). Table design with justification: D1, Task 1. Service-role only: Task 1 grants + self-check + replay. Inside the transaction or after with failure logged, justified by the louder-failure invariant: D2, Task 4/6. `GET /api/schedule/rosters/[id]/compare`, manager-only, per block/coach windows, arrived-at, classification incl. no-show candidate, totals: Tasks 3, 5, 7. Web view in the change-log dialog: Tasks 9-10. Pure model with DST, overnight, removed/added, re-published twice: Task 3. No backfill, said in the UI with a date: D11, Task 5 `missing_reason`, Task 8 `missingSnapshotMessage`. Gate, PR, CHANGELOG, review notes: above.
- **Placeholders:** none; every code step carries its code. The only `x` in a path is the CHANGELOG date and PR number, filled at PR time.
- **Names:** `writePublishSnapshot`, `loadWindowBlocks`, `loadRosterComparison`, `buildPublishSnapshot`, `compareSnapshot`, `clipWindow`, `publishedRosterIdsIn`, `visibleCompareBlocks`, `SNAPSHOT_FORMAT_VERSION` are used with the same names and argument shapes in every task and test.
