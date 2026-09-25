## PR CLASSLINK.1 — the class schedule goes platform-neutral, and the timetable's coaches map to the team

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `class_occurrences` (the shared schedule spine) stops assuming Glofox: every row carries a `source` and the source's own id for it (`source_ref`), plus the source's ids for the class's instructors (`instructor_refs`); `glofox_event_id` becomes optional (required for Glofox rows, absent for any other). A new `class_instructor_links` table says which person on the team each instructor id is, per studio, and managers set it in a "Timetable coaches" section on the shift templates page (`/settings/shifts`). Nothing reconciles, nothing reaches members.

**Why:** 00-INDEX Wave 3 PR 36. CLASSLINK.2 (#37) links shift blocks to classes over the roster horizon and lists mismatches ("rostered: A, timetable: B"). That needs (1) a spine that can hold Hatch Street's classes when Hatch moves off Glofox to `un1t.online` (memory `hatch-street-booking-platform`), and (2) a way to turn a timetable's opaque instructor id into a staff profile. Today neither exists: `glofox_event_id` is `NOT NULL` and the only trainer mapping (STUDIO-KPI.4) maps an id to a display NAME, and has never resolved one (below). CLASSLINK.3 (#38, the operator toggle for the rostered coach's name on customer class screens, off by default) then builds on #37.

**Architecture:** One migration (636) changes `class_occurrences` additively (three columns, one trigger, four constraints, `glofox_event_id` nullable) and creates `class_instructor_links` (service role only). For Glofox rows the database derives `source_ref` and `instructor_refs` itself, so the Glofox sync keeps writing exactly what it writes today and stays correct whichever of migration and code lands first. One pure module (`src/lib/class-instructors.js`) normalises instructor ids and summarises the timetable per instructor; one IO module (`src/lib/class-instructors-server.js`) reads and writes; one route (`/api/schedule/class-instructors`, GET + PUT) and one client component serve the managers. The two spine readers that hand an occurrence onward by its Glofox id (`resolveCurrentOccurrence`, `resolveCurrentClassForTv`) skip rows without one; the climate planners and the sync's cancellation reconcile already do, and are pinned.

**Tech Stack:** Next.js 16 route handlers, Supabase Postgres (PGlite for the migration replay), Vitest (node + jsdom), React client components.

**Size / ships:** M. **Migration 636** (reserved in 00-INDEX) + web deploy. **No OTA**: nothing under `mobile/` or `shared/` changes. No permission key (`check:mobile-parity` untouched).

**DEPLOY ORDER:**
1. **Apply mig 636 BEFORE merge** (steps at the end; the CLAUDE.md rule). Alone it changes no behaviour: every existing row reads `source = 'glofox'`, `source_ref = glofox_event_id`, and the unchanged Glofox sync keeps working because the trigger fills the two derived columns (D3, pinned by the replay's "old writer" test).
2. **Then merge.** If the order ever slips, only the new mapping route fails (500: it selects `instructor_refs` and reads `class_instructor_links`); the sync, the AC automations, HR linking and the TV do not touch any new column.
3. **Apply away from a sync tick.** `/api/cron/sync-class-occurrences` runs `*/15` (`vercel.json:139-142`); the ALTERs hold an ACCESS EXCLUSIVE lock for well under a second, so avoid :00/:15/:30/:45.

**Batch 9 pairing:** rides beside 18 AVAIL.3. No shared files (this PR touches no schedule calendar, phone or availability file). `src/lib/openapi.js`, `src/lib/openapi.test.js`, `eslint.guardrails.config.mjs` and `docs/CHANGELOG.md` are the usual hotspots: rebase and keep both sides.

---

### What was found (verified against `origin/main` at `d1d5167c`, #1769, and read-only SQL on `iyvtbjjxdggiadzwwvdj`, 25 Sep ~16:00Z)

**The spine today.** `class_occurrences` (mig 284 `supabase/migrations/284_class_climate.sql:26-40`, + `cancelled_at` in mig 344): `glofox_event_id text NOT NULL`, `CONSTRAINT class_occurrences_unique UNIQUE (location_id, glofox_event_id)`, indexes `idx_class_occurrences_loc_start (location_id, starts_at)` and the partial `idx_class_occurrences_live … WHERE cancelled_at IS NULL`. RLS on; one policy, `class_occurrences_location_scoped_select` (authenticated SELECT at own locations). No triggers. Table-level grants are Supabase's defaults (ALL to anon, authenticated, service_role); writes are denied to the browser by RLS (no write policy).

**Live data (counts only):** 632 rows, all UN1T Stillorgan, 18 Jun → 27 Sep 2026 (the sync fetches 48 hours ahead), 1.5 MB. 0 null `glofox_event_id`. 184 rows in the last 28 days, 8 ahead. `raw->'trainers'` is an array of 24-hex STRINGS on every row (656 entries, 24 rows carry two trainers, max 2), **5 distinct trainer ids**. **`instructor` is NULL on 632 of 632 rows** (see Follow-ups). Hatch Street has no rows and no working Glofox credentials (`settings.glofox` has no `branch_id`/`api_key`; its `channel_connections` Glofox row is inactive). All studios' `locations.timezone` = `Europe/Dublin`. Stillorgan has 12 active members, Hatch 5.

**The one writer.** `syncOccurrencesForLocation` (`src/lib/class-occurrences.js:223-338`), called every 15 minutes by `src/app/api/cron/sync-class-occurrences/route.js`:
- maps each active, non-private Glofox event with `mapEventToOccurrence` (`:96-129`) to `{ location_id, glofox_event_id, name, program, starts_at, ends_at, capacity, instructor, raw, synced_at }` and upserts with `onConflict: 'location_id,glofox_event_id'` (`:255-258`);
- reconciles cancellations inside the fetched window: reads `glofox_event_id` for the window (`:272-279`), keeps ids not seen (`.filter((id) => id && …)`, `:280-282`), stamps `cancelled_at` with `.in('glofox_event_id', goneIds)` (`:283-289`). **A row with a null `glofox_event_id` can never be cancelled by it** (the `id &&` filter and the `.in`);
- backfills `instructor` by `raw->trainers->>0` (`:310-335`).
Rows are never deleted, only stamped, so a row's `id` is stable across syncs (the upsert keeps the row). CLASSLINK.2 can therefore reference `class_occurrences.id`.

**Every reader (`git grep class_occurrences origin/main`), and what each does with `glofox_event_id`:**

| Reader | Uses the Glofox id as a key? | A row with no Glofox id… |
|---|---|---|
| `resolveCurrentOccurrence` (`class-occurrences.js:368-386`) → HR session stamping (`bridge-samples.js:331,425`), `hr-detections.js:165`, `live-class.js:210`, `class-bookings.js:168`, `timer/active/route.js:76`, Apple Health ingest (`apple-health/ingest/route.js:90`) | **Yes**: returns `{ glofox_event_id, class_name, ends_at }`, stamped on `heart_rate_sessions.glofox_event_id` (mig 287) and compared across sessions | would be stamped as a class with no key. **Skipped by this PR (D7).** |
| `resolveCurrentClassForTv` (`:394-412`) → `live-board.js:98` (TV intro card) | **Yes** (returned as the card's `glofox_event_id`) | **Skipped by this PR (D7).** |
| `class-climate-runner.js:43-49` via `planClassClimate` (`class-climate.js:82-98`) | **Yes**: `automation_fire_log` (mig 284) is keyed `(automation_key, glofox_event_id, device_id, action_step)`, `glofox_event_id NOT NULL` | already skipped (`class-climate.js:86` `if (!occ?.glofox_event_id …) continue`). **Pinned.** |
| `bathroom-climate-runner.js:56-62` via `planBathroomClimate` (`bathroom-climate.js:54-70`) | **Yes** (same fire log) | already skipped (`bathroom-climate.js:58`). **Pinned.** |
| sync reconcile (above) | **Yes** | never cancelled. **Pinned.** |
| `shared/studio-kpis.js:287-296` → `computeFloor` (`shared/studio-kpi-math.js:192-196`) | joins bookings by it | counted as a class with no Glofox bookings (a null key never matches a booking). Harmless; `shared/` untouched (no OTA). |
| `automations/[key]/schedule/route.js:38-45` → `ClassClimateCard.jsx:225`, `BathroomClimateCard.jsx:225` (`key={c.glofox_event_id}`) | React list key only | a duplicate `null` key warning; listed as a follow-up for the PR that writes non-Glofox rows. |
| `auto-end-stale-hr-sessions/route.js:90`, `credit-attendance/route.js:129-132`, `bridge-samples.js:442-447`, `class-bookings.js:232-236` | look up BY ids taken from other tables | a null never matches. Safe. |
| `fleet-health/route.js:313`, `hyrox/publish-runner.js:26`, `hyrox/reminder-runner.js:23`, `(members)/hyrox/page.js:63`, `shelly/reconcile.js:223`, `shared/dashboard-data.js:684`, `class-categories.js:43` | no | unaffected (time and name only). |
| `locations/[id]/glofox-trainers/route.js:57-64` | reads `raw->trainers` | unaffected. |

Nothing in `mobile/` or `champ-app` reads `class_occurrences`. No reader uses `select('*')`.

**Customer class screens do NOT read the spine.** `src/lib/public-classes.js:13-30` (the `/start` picker, `/api/public/classes`) and `src/lib/today-feed-data.js` read Glofox live via `fetchUpcomingEvents`, and carry the Glofox event id (`event_id: e._id || e.id`, `public-classes.js:21`). So CLASSLINK.3 will need event id → spine row, which is exactly the kept `UNIQUE (location_id, glofox_event_id)` (D2).

**Trainers today.** STUDIO-KPI.4 maps a trainer id to a display NAME: operator overrides in `settings.glofox.trainer_names` (edited as "id = Name" lines in `GlofoxIntegrationTab.jsx:203-230`, owner/master only; `src/lib/glofox-trainer-names.js`), else `GET /2.0/trainers`, else `GET /2.0/members/{id}` per id (cap 10 per run) (`resolveTrainerNames`, `class-occurrences.js:149-209`). **No override is set anywhere** (neither `locations.settings.glofox` nor `channel_connections.config`) and the API resolves none, so all 632 `instructor` values are NULL. There is no trainer id → staff PROFILE mapping anywhere. `extractTrainerIds` (`:55-66`) is the id rule: 24-hex, lowercased, strings or objects' `_id`.

**The un1t.online design draft disagrees with row 36.** `~/code/un1t-crm/docs/superpowers/specs/2026-09-01-un1t-online-hatch-integration-design.md` (untracked in the primary checkout, NOT on `main`) §3.3 decided to write Hatch event ids INTO `glofox_event_id` and add a `source_platform` column. Row 36 (25 Sep) says `glofox_event_id` becomes optional. This plan follows row 36 and says why in D2; open question 1 asks Richard to confirm so the spec can be corrected.

**Access pattern to copy:** `src/app/api/schedule/grid/route.js:38-62` (query-param studio): `hasRoleAtAnyLocation(user, MANAGER_ROLES)` → 403; zod on the query → 400; `assertLocationAccess(user, location_id)` → 403; `hasRoleAtLocation(user, location_id, MANAGER_ROLES)` → 403. Its test harness (`grid/route.test.js:1-60`) mocks `@/lib/auth` keeping the REAL role helpers.

**Migration style to copy:** mig 634 (new service-role-only table, `supabase/migrations/634_roster_publish_snapshots.sql`) and mig 628 (additive ALTER with a self-check, `628_shift_template_kind.sql`); PGlite replay `tests/migration-634-roster-publish-snapshots.test.js`.

---

### Decisions (each pinned by a test)

**D1. `source` on every occurrence: `'glofox'` (default) or `'un1t_online'`, one vocabulary for both tables.** The values follow `channel_connections.platform` (`'glofox'` today; the un1t.online draft proposes `'un1t_online'` for the registry). A CHECK list, not free text: a new source is a new integration and a one-line migration. The migration's self-check asserts the two tables' CHECKs are identical. No `'manual'` source (nothing writes one; open question 4). *Pinned:* replay "refuses an unknown source", "the two source lists are the same list".

**D2. `source_ref` is the neutral key; `glofox_event_id` becomes optional; the Glofox key stays.** `source_ref text NOT NULL` (1–200 chars), `UNIQUE (location_id, source, source_ref)`: the key any future writer upserts on. `glofox_event_id` loses `NOT NULL`, and `CHECK ((source = 'glofox') = (glofox_event_id IS NOT NULL))`: a Glofox row always has one, no other row ever does. `class_occurrences_unique (location_id, glofox_event_id)` is KEPT: it is the Glofox sync's conflict target (`class-occurrences.js:258`) and the key CLASSLINK.3 will use to find the spine row for a live Glofox event (NULLs are distinct, so any number of non-Glofox rows fit beside it). **Why not the un1t.online draft's "put un1t ids in `glofox_event_id`":** four readers key downstream tables by that column (`automation_fire_log`, `heart_rate_sessions`, the TV card, HR detections), so a un1t id there would be filed as a Glofox id in tables that say Glofox; making the column honest costs two `if (!occ.glofox_event_id) continue` lines now (D7) and a re-keying PR before a second source writes rows (follow-up), not a 52-file rename. *Pinned:* replay "a Glofox row with no event id is refused", "a un1t.online row that carries a Glofox event id is refused", "one row per (studio, source, source_ref)", "accepts a un1t.online row … several of them beside the Glofox key".

**D3. The database derives the Glofox columns; the Glofox writer names none of them.** A `BEFORE INSERT OR UPDATE OF source, glofox_event_id, raw, source_ref, instructor_refs` trigger sets, for a Glofox row only, `source_ref := glofox_event_id` and `instructor_refs :=` the trainer ids in `raw.trainers` by `extractTrainerIds`'s rule (24-hex, strings or objects' `_id`, lowercased, first-seen order, no repeats). Why in SQL, not in `mapEventToOccurrence`: a `NOT NULL` column the running writer does not name would fail EVERY sync from the moment the migration lands until the deploy (the spine goes stale; the AC and HR linking read it), and naming the new columns in the writer would 400 every sync if the deploy ever came first. With the trigger, the unchanged writer is correct before, during and after, and no writer can desync the derived columns (an UPDATE that sets them is re-derived). Rows of other sources are left exactly as their writer set them. *Pinned:* replay "the UNCHANGED Glofox writer still works", "the PostgREST-shaped upsert … re-derives on a trainer change and keeps the row id", "a write cannot desync the derived columns", "backfills every existing row" (the `extractTrainerIds` fixtures); `class-occurrences-source.test.js` "the Glofox writer names none of the new columns".

**D4. `instructor_refs text[]` on the occurrence, not a join table.** Tiny (≤ 2 per class today), always read with its occurrence, ordered (the first is Glofox's lead trainer, which the name backfill already treats specially, `class-occurrences.js:301-309`). CLASSLINK.2 joins it to `class_instructor_links` on `(location_id, source, ref)`. No index: 1.5 MB table, per-studio reads bounded by `(location_id, starts_at)`.

**D5. The mapping is its own table, per studio: `class_instructor_links (location_id, source, external_instructor_id) → profile_id`.** Per studio because Glofox trainer ids belong to a branch, and a coach at both studios is two ids anyway. `UNIQUE (location_id, source, external_instructor_id)`: one id is exactly one person; one person may have several ids (a duplicate trainer account). Glofox ids are stored lowercase 24-hex (CHECK). `profile_id → profiles ON DELETE CASCADE` (a staff profile is never deleted, CLAUDE.md, so it never fires; the mig 622 tombstone needs nothing), `location_id → locations ON DELETE CASCADE`, `updated_by` a plain uuid with no FK (the mig 634 D5 reasoning). Service role only: RLS on, no policies, browser privileges revoked, `service_role` SELECT/INSERT/UPDATE/DELETE only. **Kept apart from `settings.glofox.trainer_names`**, which maps an id to a display NAME for the scorecard, is owner-only, and may name someone who is not staff; nothing here changes names, `instructor` or the scorecard (open question 2). *Pinned:* replay `class_instructor_links` describe.

**D6. Who may link, and to whom.** `MANAGER_ROLES` AT the studio (master, owner, manager, head_coach): the same people who edit shift templates on the same page (`src/app/api/schedule/templates/route.js:65-78`). The person must be an ACTIVE member of that studio (a `profile_locations` row there, `profiles.active`, not a tombstone): the route answers 400 otherwise and writes nothing. A link to someone later deactivated or moved is KEPT and shown flagged "(no longer at this studio)" rather than silently deleted: CLASSLINK.2 will treat it as unlinked, and the manager can re-point it. *Pinned:* `class-instructors-server.test.js` "refuses someone who is not a member / inactive / a tombstone", `class-instructors.test.js` "at_studio".

**D7. Readers that hand an occurrence onward by its Glofox id skip rows without one.** `resolveCurrentOccurrence` and `resolveCurrentClassForTv` get one line each; the two climate planners and the sync reconcile already behave and get pins. **No behaviour changes today** (0 such rows, and D2's CHECK means a Glofox row always has an id). Re-keying these readers onto a neutral key is a follow-up that must land before any writer adds non-Glofox rows (until then a Hatch class on `un1t.online` would not drive the AC, HR linking or the TV card). *Pinned:* `class-occurrences-source.test.js`, `class-climate-runner.test.js`, `bathroom-climate.test.js`.

**D8. The manager's view: "Timetable coaches" on `/settings/shifts`, below the templates.** Glofox names do not resolve (0 of 632), so each instructor id is identified by what a manager recognises: its class count and its three most common weekly slots ("HYROX · Mon 06:30", studio timezone, DST-exact via `Intl`), plus the resolved name when there ever is one (`instructor` on single-trainer classes), and the raw id in small type. Window: the last 28 days plus whatever the timetable already holds ahead (48 hours today); a linked id with no recent classes still shows so it can be unlinked. One `<select>` per id: "Not linked", the studio's active team by name, and a disabled "(no longer at this studio)" entry for a stale link. A studio with no timetable (Hatch) says so. Not in the Glofox settings tab: that tab is owner/master only and about credentials, while the people who roster (managers, head coaches) live on the templates page. *Pinned:* `ClassInstructorLinks.test.jsx`.

**D9. Names only.** The route sends ids, names, class counts and slot labels. No `capacity`, no booked count (the "never surface capacity" rule; this is staff-facing, but nothing needs it), no `contracted_hours_per_week`, no pay. *Pinned:* `class-instructors.test.js` "the coach options carry only id and name" and "an instructor row carries no capacity".

**D10. Scope fence.** No sync widening (default 9: CLASSLINK.2 measures the call cost first), no reconcile, no shift-block link, no customer display, no change to `resolveTrainerNames` or the scorecard, no backfill of links (names do not resolve, so there is nothing to match on), no auto-suggest.

---

### Files

| Path | Change | Responsibility |
|---|---|---|
| `supabase/migrations/636_class_schedule_platform_neutral.sql` | Create | `class_occurrences` source columns, trigger, constraints; `class_instructor_links`; self-check |
| `tests/migration-636-class-schedule-platform-neutral.test.js` | Create | PGlite replay of the real file |
| `src/lib/class-instructors.js` | Create | PURE, client-safe: `CLASS_SOURCES`, `INSTRUCTOR_WINDOW_DAYS`, `normalizeInstructorRef`, `instructorKey`, `sourceLabel`, `shortRef`, `weeklySlot`, `summariseInstructors` |
| `src/lib/class-instructors.test.js` | Create | |
| `src/lib/class-instructors-server.js` | Create | IO: `ClassInstructorPutSchema`, `loadInstructorMapping`, `saveInstructorLink` |
| `src/lib/class-instructors-server.test.js` | Create | IO against a recording fake client |
| `src/app/api/schedule/class-instructors/route.js` | Create | GET + PUT, manager at the studio |
| `src/app/api/schedule/class-instructors/route.test.js` | Create | Gate, validation, pass-through |
| `src/lib/class-occurrences.js` | Modify (header comment lines 1-7; the two `for (const occ of data || [])` loops at 380 and 406) | D7 |
| `src/lib/class-occurrences-source.test.js` | Create | D3 writer pin, D7 resolver pins |
| `src/lib/class-climate-runner.test.js` | Modify (append one `it` in each of two existing `describe`s) | D7 pins |
| `src/lib/bathroom-climate.test.js` | Modify (append one `describe`) | D7 pin |
| `src/components/schedule/ClassInstructorLinks.jsx` | Create | The "Timetable coaches" section |
| `src/components/schedule/ClassInstructorLinks.test.jsx` | Create | jsdom |
| `src/app/settings/shifts/page.js` | Modify (whole file shown) | Render the section |
| `src/lib/openapi.js` | Modify (import block; after the `/api/locations/{id}/glofox-trainers` registration, which closes at line 3772) | GET + PUT |
| `src/lib/openapi.test.js` | Modify (append one `it` before the final `})`) | |
| `eslint.guardrails.config.mjs` | Modify (`no-unchecked-supabase-write` `files`, after `'src/app/api/schedule/assignments/*/replace/**',` at line 319) | Arm the new IO + route |
| `docs/roster-v2.md` | Modify (append after "Publish snapshots", line 239 onward) | Section "Class schedule sources and timetable coaches" |
| `docs/CHANGELOG.md` | Modify (after `gh pr create`) | One row |

---

### Task 1: Migration 636 and its PGlite replay

**Files:**
- Create: `supabase/migrations/636_class_schedule_platform_neutral.sql`
- Create: `tests/migration-636-class-schedule-platform-neutral.test.js`

- [ ] **Step 1: Write the failing replay test** at `tests/migration-636-class-schedule-platform-neutral.test.js`:

```js
// CLASSLINK.1 — behavioural test for migration 636, against the REAL file.
//
// Same reason as the 628/632/634 replays: there is no local Supabase stack,
// so without this the DDL would get its first execution on prod. Boots
// PGlite, recreates the three API roles and Supabase's DEFAULT privileges,
// builds class_occurrences exactly as migs 284 + 344 left it (the live shape
// on 25 Sep 2026) with rows in it, applies the real 636 file, and proves the
// header's claims: existing rows are backfilled, the UNCHANGED Glofox writer
// keeps working (the deploy-order guarantee), the derived columns cannot be
// desynced, the source rules hold, and class_instructor_links is service-role
// only. (PGlite's db.exec runs SQL text; it is not child_process.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_636 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/636_class_schedule_platform_neutral.sql'),
  'utf8',
)

const LOC = '20000000-0000-0000-0000-000000000001'
const LOC2 = '20000000-0000-0000-0000-000000000002'
const P1 = '40000000-0000-0000-0000-000000000001'
const P2 = '40000000-0000-0000-0000-000000000002'
const ID1 = '61a38e7d0cf1970aae0fb3a9'
const ID2 = 'deadbeefdeadbeefdeadbeef'
const ID3 = 'cafebabecafebabecafebabe'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  -- What Supabase does for every table and function created in public. The
  -- migration must undo it itself for the new table and function.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY);
  -- class_occurrences exactly as migs 284 + 344 left it.
  CREATE TABLE public.class_occurrences (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id      uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    glofox_event_id  text NOT NULL,
    name             text,
    program          text,
    starts_at        timestamptz,
    ends_at          timestamptz,
    capacity         integer,
    instructor       text,
    raw              jsonb,
    synced_at        timestamptz NOT NULL DEFAULT now(),
    created_at       timestamptz NOT NULL DEFAULT now(),
    cancelled_at     timestamptz,
    CONSTRAINT class_occurrences_unique UNIQUE (location_id, glofox_event_id)
  );
  CREATE INDEX idx_class_occurrences_loc_start ON public.class_occurrences (location_id, starts_at);
  ALTER TABLE public.class_occurrences ENABLE ROW LEVEL SECURITY;
  INSERT INTO public.locations (id) VALUES ('${LOC}'), ('${LOC2}');
  INSERT INTO public.profiles (id) VALUES ('${P1}'), ('${P2}');
  -- The extractTrainerIds fixtures (src/lib/class-climate.test.js:122-141),
  -- as rows that exist before the migration.
  INSERT INTO public.class_occurrences (location_id, glofox_event_id, name, starts_at, raw) VALUES
    ('${LOC}', 'evt-a', 'Strength 45', '2026-09-21T05:30:00Z', '{"trainers":["${ID1.toUpperCase()}","Coach Mia"]}'),
    ('${LOC}', 'evt-b', 'HYROX', '2026-09-22T17:00:00Z', '{"trainers":[{"_id":"${ID2}"},"${ID1}","${ID2.toUpperCase()}"]}'),
    ('${LOC}', 'evt-c', 'Open gym', '2026-09-23T07:00:00Z', NULL),
    ('${LOC}', 'evt-d', 'Mobility', '2026-09-24T07:00:00Z', '{"trainers":"not-an-array"}');
`

let db
beforeAll(async () => {
  db = new PGlite()
  await db.exec(BASE_SCHEMA)
  await db.exec(MIG_636)
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

async function row(glofoxEventId) {
  const { rows } = await db.query(
    `SELECT id, source, source_ref, instructor_refs FROM public.class_occurrences WHERE glofox_event_id = $1`,
    [glofoxEventId],
  )
  return rows[0]
}

describe('migration 636 — class_occurrences goes platform-neutral', () => {
  it('backfills every existing row as a Glofox row with the derived columns', async () => {
    expect(await row('evt-a')).toMatchObject({ source: 'glofox', source_ref: 'evt-a', instructor_refs: [ID1] })
    // string + object entries, lowercased, first-seen order, no repeats
    expect(await row('evt-b')).toMatchObject({ source: 'glofox', source_ref: 'evt-b', instructor_refs: [ID2, ID1] })
    expect(await row('evt-c')).toMatchObject({ source_ref: 'evt-c', instructor_refs: [] })
    expect(await row('evt-d')).toMatchObject({ source_ref: 'evt-d', instructor_refs: [] })
  })

  it('has exactly the documented new column shapes, and glofox_event_id is optional', async () => {
    const { rows } = await db.query(`SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'class_occurrences'
        AND column_name IN ('glofox_event_id', 'instructor_refs', 'source', 'source_ref')
      ORDER BY column_name`)
    expect(rows).toEqual([
      { column_name: 'glofox_event_id', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'instructor_refs', data_type: 'ARRAY', is_nullable: 'NO', column_default: "'{}'::text[]" },
      { column_name: 'source', data_type: 'text', is_nullable: 'NO', column_default: "'glofox'::text" },
      { column_name: 'source_ref', data_type: 'text', is_nullable: 'NO', column_default: null },
    ])
  })

  it('the UNCHANGED Glofox writer still works: an INSERT naming none of the new columns is derived', async () => {
    await inTx(async () => {
      await asRole('service_role', async () => {
        await db.exec(`INSERT INTO public.class_occurrences (location_id, glofox_event_id, name, starts_at, raw, synced_at)
          VALUES ('${LOC}', 'evt-new', 'Strength 45', '2026-09-28T05:30:00Z', '{"trainers":["${ID3}"]}', now())`)
      })
      expect(await row('evt-new')).toMatchObject({ source: 'glofox', source_ref: 'evt-new', instructor_refs: [ID3] })
    })
  })

  it('the PostgREST-shaped upsert (onConflict location_id,glofox_event_id) re-derives on a trainer change and keeps the row id', async () => {
    await inTx(async () => {
      const before = await row('evt-a')
      await asRole('service_role', async () => {
        await db.exec(`INSERT INTO public.class_occurrences (location_id, glofox_event_id, name, starts_at, raw, synced_at, cancelled_at)
          VALUES ('${LOC}', 'evt-a', 'Strength 45', '2026-09-21T05:30:00Z', '{"trainers":["${ID3}","${ID1}"]}', now(), NULL)
          ON CONFLICT (location_id, glofox_event_id) DO UPDATE SET
            location_id = EXCLUDED.location_id, glofox_event_id = EXCLUDED.glofox_event_id, name = EXCLUDED.name,
            starts_at = EXCLUDED.starts_at, raw = EXCLUDED.raw, synced_at = EXCLUDED.synced_at,
            cancelled_at = EXCLUDED.cancelled_at`)
      })
      const after = await row('evt-a')
      expect(after.id).toBe(before.id)
      expect(after).toMatchObject({ source_ref: 'evt-a', instructor_refs: [ID3, ID1] })
    })
  })

  it('a write cannot desync the derived columns of a Glofox row', async () => {
    await inTx(async () => {
      await db.exec(`UPDATE public.class_occurrences SET source_ref = 'something-else', instructor_refs = '{}' WHERE glofox_event_id = 'evt-a'`)
      expect(await row('evt-a')).toMatchObject({ source_ref: 'evt-a', instructor_refs: [ID1] })
    })
  })

  it('an update touching none of the watched columns leaves the derived columns alone (the instructor backfill)', async () => {
    await inTx(async () => {
      await db.exec(`UPDATE public.class_occurrences SET instructor = 'Jess' WHERE glofox_event_id = 'evt-a'`)
      expect(await row('evt-a')).toMatchObject({ source_ref: 'evt-a', instructor_refs: [ID1] })
    })
  })

  it('accepts a un1t.online row exactly as its writer set it, and several of them beside the Glofox key', async () => {
    await inTx(async () => {
      await asRole('service_role', async () => {
        await db.exec(`INSERT INTO public.class_occurrences (location_id, source, source_ref, instructor_refs, name, starts_at, raw)
          VALUES ('${LOC}', 'un1t_online', 'u-1', '{coach-7}', 'Engine', '2026-09-28T07:00:00Z', '{"trainers":["${ID1}"]}'),
                 ('${LOC}', 'un1t_online', 'u-2', '{}', 'Engine', '2026-09-29T07:00:00Z', NULL)`)
      })
      const { rows } = await db.query(`SELECT source_ref, glofox_event_id, instructor_refs FROM public.class_occurrences
        WHERE source = 'un1t_online' ORDER BY source_ref`)
      // raw.trainers is NOT read for another source: the writer owns its refs.
      expect(rows).toEqual([
        { source_ref: 'u-1', glofox_event_id: null, instructor_refs: ['coach-7'] },
        { source_ref: 'u-2', glofox_event_id: null, instructor_refs: [] },
      ])
    })
  })

  it('one row per (studio, source, source_ref); the same ref at another studio is fine', async () => {
    await inTx(async () => {
      await db.exec(`INSERT INTO public.class_occurrences (location_id, source, source_ref) VALUES ('${LOC}', 'un1t_online', 'u-1')`)
      await db.exec(`INSERT INTO public.class_occurrences (location_id, source, source_ref) VALUES ('${LOC2}', 'un1t_online', 'u-1')`)
      await expect(db.exec(`INSERT INTO public.class_occurrences (location_id, source, source_ref) VALUES ('${LOC}', 'un1t_online', 'u-1')`))
        .rejects.toThrow(/class_occurrences_source_ref_key/)
    })
  })

  it('a Glofox row with no event id is refused', async () => {
    await expect(db.exec(`INSERT INTO public.class_occurrences (location_id, name) VALUES ('${LOC}', 'No id')`))
      .rejects.toThrow(/source_ref/)
  })

  it('a un1t.online row that carries a Glofox event id is refused', async () => {
    await expect(db.exec(`INSERT INTO public.class_occurrences (location_id, source, source_ref, glofox_event_id)
      VALUES ('${LOC}', 'un1t_online', 'u-9', 'evt-z')`)).rejects.toThrow(/class_occurrences_source_ids_check/)
  })

  it('refuses an unknown source and an empty source_ref', async () => {
    await expect(db.exec(`INSERT INTO public.class_occurrences (location_id, source, source_ref) VALUES ('${LOC}', 'mindbody', 'm-1')`))
      .rejects.toThrow(/class_occurrences_source_check/)
    await expect(db.exec(`INSERT INTO public.class_occurrences (location_id, source, source_ref) VALUES ('${LOC}', 'un1t_online', '')`))
      .rejects.toThrow(/class_occurrences_source_ref_check/)
  })

  it('the trigger function is not callable by the browser roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await db.query(
        `SELECT has_function_privilege($1, 'public.class_occurrences_derive_refs()', 'EXECUTE') AS ok`, [role])
      expect(rows[0].ok, `${role} can execute the trigger function`).toBe(false)
    }
  })
})

describe('migration 636 — class_instructor_links', () => {
  const link = (over = {}) => {
    const v = { location: LOC, source: 'glofox', ref: ID1, profile: P1, ...over }
    return `INSERT INTO public.class_instructor_links (location_id, source, external_instructor_id, profile_id)
      VALUES ('${v.location}', '${v.source}', '${v.ref}', '${v.profile}')`
  }

  it('has exactly the documented shape', async () => {
    const { rows } = await db.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'class_instructor_links' ORDER BY column_name`)
    expect(rows).toEqual([
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'external_instructor_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'location_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'profile_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'source', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'updated_by', data_type: 'uuid', is_nullable: 'YES' },
    ])
  })

  it('has RLS on and NO policies', async () => {
    const rls = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.class_instructor_links'::regclass`)
    expect(rls.rows).toEqual([{ relrowsecurity: true }])
    const pol = await db.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'public.class_instructor_links'::regclass`)
    expect(pol.rows).toEqual([{ n: 0 }])
  })

  it('takes every privilege away from anon and authenticated, despite the default grants', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const { rows } = await db.query(`SELECT has_table_privilege($1, 'public.class_instructor_links', $2) AS ok`, [role, priv])
        expect(rows[0].ok, `${role} still holds ${priv}`).toBe(false)
      }
    }
  })

  it('leaves the service role SELECT, INSERT, UPDATE and DELETE, and no TRUNCATE', async () => {
    for (const [priv, want] of [['SELECT', true], ['INSERT', true], ['UPDATE', true], ['DELETE', true], ['TRUNCATE', false]]) {
      const { rows } = await db.query(`SELECT has_table_privilege('service_role', 'public.class_instructor_links', $1) AS ok`, [priv])
      expect(rows[0].ok, `service_role ${priv}`).toBe(want)
    }
  })

  it('the service role links, re-points and unlinks', async () => {
    await inTx(async () => {
      await asRole('service_role', async () => {
        await db.exec(link())
        await db.exec(`UPDATE public.class_instructor_links SET profile_id = '${P2}' WHERE external_instructor_id = '${ID1}'`)
        const { rows } = await db.query(`SELECT profile_id FROM public.class_instructor_links`)
        expect(rows).toEqual([{ profile_id: P2 }])
        await db.exec(`DELETE FROM public.class_instructor_links WHERE external_instructor_id = '${ID1}'`)
      })
    })
  })

  it('the browser role is refused outright, not shown an empty table', async () => {
    await asRole('authenticated', async () => {
      await expect(db.query('SELECT * FROM public.class_instructor_links')).rejects.toThrow(/permission denied/)
    })
  })

  it('one person per instructor id per studio; one person may hold several ids', async () => {
    await inTx(async () => {
      await db.exec(link())
      await db.exec(link({ ref: ID2 }))
      await db.exec(link({ location: LOC2 }))
      await expect(db.exec(link({ profile: P2 }))).rejects.toThrow(/class_instructor_links_ref_key/)
    })
  })

  it('a Glofox id must be lowercase 24-hex; another source takes any 1..200 characters', async () => {
    await expect(db.exec(link({ ref: ID1.toUpperCase() }))).rejects.toThrow(/class_instructor_links_ref_check/)
    await expect(db.exec(link({ ref: ID1.slice(1) }))).rejects.toThrow(/class_instructor_links_ref_check/)
    await expect(db.exec(link({ source: 'mindbody' }))).rejects.toThrow(/class_instructor_links_source_check/)
    await inTx(async () => {
      await db.exec(link({ source: 'un1t_online', ref: 'Coach-7' }))
    })
    await expect(db.exec(link({ source: 'un1t_online', ref: '' }))).rejects.toThrow(/class_instructor_links_ref_check/)
  })

  it('goes with its studio and with its person', async () => {
    await inTx(async () => {
      await db.exec(link())
      await db.exec(link({ location: LOC2 }))
      await db.exec(`DELETE FROM public.class_occurrences WHERE location_id = '${LOC2}'`)
      await db.exec(`DELETE FROM public.locations WHERE id = '${LOC2}'`)
      let r = await db.query(`SELECT count(*)::int AS n FROM public.class_instructor_links`)
      expect(r.rows).toEqual([{ n: 1 }])
      await db.exec(`DELETE FROM public.profiles WHERE id = '${P1}'`)
      r = await db.query(`SELECT count(*)::int AS n FROM public.class_instructor_links`)
      expect(r.rows).toEqual([{ n: 0 }])
    })
  })

  it('the two source lists are the same list', async () => {
    const { rows } = await db.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('class_occurrences_source_check', 'class_instructor_links_source_check') ORDER BY conname`)
    expect(rows).toHaveLength(2)
    expect(rows[0].def).toBe(rows[1].def)
    expect(rows[0].def).toMatch(/glofox/)
    expect(rows[0].def).toMatch(/un1t_online/)
  })
})

describe('migration 636 — replay', () => {
  it('re-running the file is a no-op', async () => {
    const before = await db.query(`SELECT id, source, source_ref, instructor_refs FROM public.class_occurrences ORDER BY glofox_event_id`)
    await db.exec(MIG_636)
    const after = await db.query(`SELECT id, source, source_ref, instructor_refs FROM public.class_occurrences ORDER BY glofox_event_id`)
    expect(after.rows).toEqual(before.rows)
    const trig = await db.query(`SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgrelid = 'public.class_occurrences'::regclass AND NOT tgisinternal`)
    expect(trig.rows).toEqual([{ n: 1 }])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/migration-636-class-schedule-platform-neutral.test.js`
Expected: FAIL, `ENOENT: no such file or directory … 636_class_schedule_platform_neutral.sql`.

- [ ] **Step 3: Write the migration** at `supabase/migrations/636_class_schedule_platform_neutral.sql`:

```sql
-- 636 — CLASSLINK.1: the class schedule goes platform-neutral, and the
-- timetable's instructors map to staff.
--
-- NOT APPLIED YET. Apply BEFORE the CLASSLINK.1 code deploys: the new mapping
-- route (GET/PUT /api/schedule/class-instructors) selects instructor_refs and
-- reads class_instructor_links. Applied alone this file changes NO behaviour:
-- every existing row reads source 'glofox' with source_ref = glofox_event_id,
-- and the Glofox sync (src/lib/class-occurrences.js, unchanged) keeps writing
-- exactly what it writes today, because the trigger below fills the derived
-- columns. Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-636-class-schedule-platform-neutral.test.js), which runs
-- this file verbatim. APPLY AWAY FROM A SYNC TICK: the sync cron runs every
-- 15 minutes (:00/:15/:30/:45) and the ALTERs hold an ACCESS EXCLUSIVE lock
-- until COMMIT (well under a second).
--
-- WHAT
--   public.class_occurrences (the shared schedule spine, migs 284 + 344):
--     source           text NOT NULL DEFAULT 'glofox'
--                      CHECK (source IN ('glofox', 'un1t_online'))
--     source_ref       text NOT NULL, 1..200 characters: the source's own id
--                      for this occurrence. UNIQUE (location_id, source,
--                      source_ref) is the key any future writer upserts on.
--     instructor_refs  text[] NOT NULL DEFAULT '{}': the source's ids for the
--                      class's instructors, first-seen order, no repeats.
--     glofox_event_id  NOT NULL dropped. CHECK ((source = 'glofox') =
--                      (glofox_event_id IS NOT NULL)): a Glofox row always has
--                      one, a row of any other source never does.
--     class_occurrences_unique (location_id, glofox_event_id) is KEPT: it is
--       the Glofox sync's conflict target, and the key that finds the spine
--       row for a live Glofox event (CLASSLINK.3). NULLs are distinct, so any
--       number of non-Glofox rows sit beside it.
--     class_occurrences_derive_refs, BEFORE INSERT OR UPDATE OF source,
--       glofox_event_id, raw, source_ref, instructor_refs: for a GLOFOX row
--       only, source_ref := glofox_event_id and instructor_refs := the 24-hex
--       ids in raw.trainers (string entries, or objects' _id), lowercased,
--       first-seen order, no repeats. That is extractTrainerIds's rule
--       (src/lib/class-occurrences.js:55-66); the replay runs its fixtures.
--       Rows of any other source are left exactly as their writer set them.
--   public.class_instructor_links (new): which staff profile an instructor id
--     is, per studio. UNIQUE (location_id, source, external_instructor_id):
--     one id is one person; one person may hold several ids. A Glofox id is
--     stored lowercase 24-hex (CHECK). Service role only.
--
-- WHY THE DATABASE DERIVES THE GLOFOX COLUMNS
--   A NOT NULL column the running sync does not name would fail EVERY sync
--   from the moment this file lands until the code deploys, and the spine
--   would go stale under the AC automations and HR linking that read it.
--   Naming the new columns in the sync instead would 400 every sync if the
--   code ever deployed first. With the trigger the unchanged writer is correct
--   before, during and after, and no write can desync the derived columns (an
--   UPDATE that sets them is re-derived).
--
-- WHY glofox_event_id STAYS (optional) INSTEAD OF HOLDING OTHER SOURCES' IDS
--   Four readers key other tables by it (automation_fire_log,
--   heart_rate_sessions, HR detections, the TV card). An un1t.online id in it
--   would be filed as a Glofox id in tables that say Glofox. Those readers
--   skip rows without a Glofox id (CLASSLINK.1 code; no such row exists yet)
--   and are re-keyed before any writer adds one.
--
-- WHY class_instructor_links IS PER STUDIO, SERVICE ROLE ONLY
--   Glofox trainer ids belong to a branch. The only door is
--   /api/schedule/class-instructors (manager AT the studio; the person must
--   be an active member there). profile_id → profiles ON DELETE CASCADE never
--   fires (staff profiles are tombstoned, never deleted, mig 622). updated_by
--   is a plain uuid (no FK, the mig 634 reasoning). Separate from
--   settings.glofox.trainer_names, which maps an id to a display NAME.
--
-- ACCESS
--   class_occurrences: grants and RLS unchanged; the existing authenticated
--   SELECT policy (own locations) now also shows source, source_ref and
--   instructor_refs: opaque ids, no PII.
--   class_instructor_links: RLS on with NO policies, browser privileges
--   revoked, service_role SELECT/INSERT/UPDATE/DELETE only. Expected advisor
--   note afterwards: INFO rls_enabled_no_policy on it, exactly as
--   staff_calendar_feeds (632) and roster_publish_snapshots (634). By design.
--
-- LOCKS: ACCESS EXCLUSIVE on class_occurrences until COMMIT. The ADD COLUMNs
--   with constant defaults are catalog-only; the backfill UPDATE rewrites
--   ~640 rows (1.5 MB); SET NOT NULL and the CHECKs scan once; the new UNIQUE
--   builds one small index. The FKs of the new table take a brief SHARE ROW
--   EXCLUSIVE on locations and profiles.
--
-- REPLAYING THIS FILE IS A NO-OP (IF NOT EXISTS; CREATE OR REPLACE FUNCTION;
-- DROP ... IF EXISTS then ADD/CREATE; the backfill only touches rows whose
-- source_ref is NULL). One explicit transaction, so a failed self-check leaves
-- NOTHING applied.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; run IMMEDIATELY before applying, stop if any
-- answer differs from "Expected")
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The names are free:
--       SELECT column_name FROM information_schema.columns
--        WHERE table_schema='public' AND table_name='class_occurrences'
--          AND column_name IN ('source','source_ref','instructor_refs');
--       SELECT to_regclass('public.class_instructor_links') AS t,
--              to_regprocedure('public.class_occurrences_derive_refs()') AS f;
--     Expected: 0 rows; t = NULL, f = NULL.
-- (b) The spine is the shape this file assumes:
--       SELECT is_nullable FROM information_schema.columns
--        WHERE table_schema='public' AND table_name='class_occurrences' AND column_name='glofox_event_id';
--       SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--        WHERE conrelid='public.class_occurrences'::regclass ORDER BY 1;
--       SELECT count(*) FROM pg_trigger
--        WHERE tgrelid='public.class_occurrences'::regclass AND NOT tgisinternal;
--     Expected: NO; class_occurrences_location_id_fkey, class_occurrences_pkey,
--     class_occurrences_unique UNIQUE (location_id, glofox_event_id); 0.
-- (c) What exists (KEEP THE OUTPUT for the rollback record):
--       SELECT location_id, count(*) AS n, count(*) FILTER (WHERE glofox_event_id IS NULL) AS no_id,
--              min(starts_at), max(starts_at)
--         FROM public.class_occurrences GROUP BY 1;
--       SELECT count(DISTINCT lower(t)) FROM public.class_occurrences o,
--              jsonb_array_elements_text(CASE WHEN jsonb_typeof(o.raw->'trainers')='array'
--                                             THEN o.raw->'trainers' ELSE '[]'::jsonb END) t
--        WHERE t ~* '^[0-9a-f]{24}$';
--     Expected (25 Sep): one row (Stillorgan), ~630-700 rows, no_id 0; 5.
-- (d) The FK targets are what the file assumes:
--       SELECT table_name, data_type FROM information_schema.columns
--        WHERE table_schema='public' AND column_name='id' AND table_name IN ('locations','profiles')
--        ORDER BY 1;
--     Expected: locations uuid, profiles uuid.
-- (e) list_migrations shows no 636. The clock is not within a minute of
--     :00/:15/:30/:45 (the sync cron).
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (f) SELECT column_name, data_type, is_nullable, column_default
--       FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='class_occurrences'
--        AND column_name IN ('glofox_event_id','instructor_refs','source','source_ref') ORDER BY 1;
--     Expected: glofox_event_id text YES NULL; instructor_refs ARRAY NO
--     '{}'::text[]; source text NO 'glofox'::text; source_ref text NO NULL.
-- (g) SELECT source, count(*) AS n,
--            count(*) FILTER (WHERE source_ref = glofox_event_id) AS ref_ok,
--            count(*) FILTER (WHERE cardinality(instructor_refs) = 0) AS no_refs,
--            count(*) FILTER (WHERE instructor_refs[1] IS DISTINCT FROM lower(raw->'trainers'->>0)) AS lead_differs
--       FROM public.class_occurrences GROUP BY 1;
--     Expected: one row: glofox | n from (c) | n | 0 | 0 (every live row's
--     first trainer is a 24-hex string, so the lead ref IS raw.trainers[0]).
-- (h) SELECT count(DISTINCT r) FROM public.class_occurrences, unnest(instructor_refs) r;
--     Expected: the number from (c) (5 on 25 Sep).
-- (i) SELECT conname FROM pg_constraint
--      WHERE conrelid IN ('public.class_occurrences'::regclass, 'public.class_instructor_links'::regclass)
--      ORDER BY 1;
--     Expected 13: class_instructor_links_location_id_fkey, _pkey,
--     _profile_id_fkey, _ref_check, _ref_key, _source_check;
--     class_occurrences_location_id_fkey, _pkey, _source_check,
--     _source_ids_check, _source_ref_check, _source_ref_key, _unique.
-- (j) SELECT tgname, tgenabled FROM pg_trigger
--      WHERE tgrelid='public.class_occurrences'::regclass AND NOT tgisinternal;
--     Expected: class_occurrences_derive_refs | O.
-- (k) SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--       FROM information_schema.table_privileges
--      WHERE table_schema='public' AND table_name='class_instructor_links' GROUP BY 1 ORDER BY 1;
--     Expected: postgres (owner) everything; service_role exactly
--     DELETE,INSERT,SELECT,UPDATE; NO row for anon or authenticated.
-- (l) get_advisors (security, then performance). Expected: INFO
--     rls_enabled_no_policy on class_instructor_links (by design); possibly
--     INFO unused_index on class_instructor_links_profile_idx and on the
--     class_occurrences_source_ref_key index; nothing else new.
--     function_search_path_mutable must NOT appear for
--     class_occurrences_derive_refs (it pins search_path = '').
-- (m) AFTER THE NEXT SYNC TICK (:00/:15/:30/:45):
--       SELECT name, last_ok_at FROM public.cron_heartbeats WHERE name = 'sync-class-occurrences';
--       SELECT count(*) AS synced, count(*) FILTER (WHERE source_ref = glofox_event_id) AS ok
--         FROM public.class_occurrences WHERE synced_at > '<the apply time>';
--     Expected: last_ok_at after the apply; synced = ok and > 0.
--
-- ROLLBACK (forward-only repo; this is a NEW migration, never an edit here):
--   Revert the CLASSLINK.1 code FIRST and let it deploy (the mapping route
--   reads instructor_refs and class_instructor_links; nothing else does).
--   Record the links first: SELECT * FROM public.class_instructor_links;
--   (profile ids and instructor ids only). Then:
--     BEGIN;
--       DROP TABLE IF EXISTS public.class_instructor_links;
--       DROP TRIGGER IF EXISTS class_occurrences_derive_refs ON public.class_occurrences;
--       DROP FUNCTION IF EXISTS public.class_occurrences_derive_refs();
--       ALTER TABLE public.class_occurrences DROP CONSTRAINT IF EXISTS class_occurrences_source_ref_key;
--       ALTER TABLE public.class_occurrences DROP CONSTRAINT IF EXISTS class_occurrences_source_ref_check;
--       ALTER TABLE public.class_occurrences DROP CONSTRAINT IF EXISTS class_occurrences_source_ids_check;
--       ALTER TABLE public.class_occurrences DROP CONSTRAINT IF EXISTS class_occurrences_source_check;
--       -- Only valid while every row is a Glofox row (true until a later PR
--       -- writes another source; delete those rows first if it has):
--       ALTER TABLE public.class_occurrences ALTER COLUMN glofox_event_id SET NOT NULL;
--       ALTER TABLE public.class_occurrences DROP COLUMN IF EXISTS instructor_refs;
--       ALTER TABLE public.class_occurrences DROP COLUMN IF EXISTS source_ref;
--       ALTER TABLE public.class_occurrences DROP COLUMN IF EXISTS source;
--     COMMIT;
--   The links are lost (recorded above). Usually unnecessary: every new
--   class_occurrences column is derived, and the new table is inert without
--   the code.

BEGIN;

-- ── 1. class_occurrences: the source, its own id, the instructors ────────
ALTER TABLE public.class_occurrences
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'glofox';
ALTER TABLE public.class_occurrences
  ADD COLUMN IF NOT EXISTS source_ref text;
ALTER TABLE public.class_occurrences
  ADD COLUMN IF NOT EXISTS instructor_refs text[] NOT NULL DEFAULT '{}'::text[];

-- ── 2. The derivation for Glofox rows ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.class_occurrences_derive_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.source = 'glofox' THEN
    NEW.source_ref := NEW.glofox_event_id;
    NEW.instructor_refs := coalesce((
      SELECT array_agg(t.ref ORDER BY t.first_pos)
        FROM (
          SELECT lower(x.ref) AS ref, min(x.pos) AS first_pos
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(NEW.raw -> 'trainers') = 'array'
                        THEN NEW.raw -> 'trainers'
                        ELSE '[]'::jsonb END
                 ) WITH ORDINALITY AS e(val, pos)
            CROSS JOIN LATERAL (
              SELECT CASE jsonb_typeof(e.val)
                       WHEN 'string' THEN e.val #>> '{}'
                       WHEN 'object' THEN e.val ->> '_id'
                     END AS ref,
                     e.pos AS pos
            ) AS x
           WHERE x.ref ~* '^[0-9a-f]{24}$'
           GROUP BY lower(x.ref)
        ) AS t
    ), '{}'::text[]);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.class_occurrences_derive_refs() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS class_occurrences_derive_refs ON public.class_occurrences;
CREATE TRIGGER class_occurrences_derive_refs
  BEFORE INSERT OR UPDATE OF source, glofox_event_id, raw, source_ref, instructor_refs
  ON public.class_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.class_occurrences_derive_refs();

-- ── 3. Backfill every existing row THROUGH the trigger ────────────────────
UPDATE public.class_occurrences SET source_ref = glofox_event_id WHERE source_ref IS NULL;

ALTER TABLE public.class_occurrences ALTER COLUMN source_ref SET NOT NULL;
ALTER TABLE public.class_occurrences ALTER COLUMN glofox_event_id DROP NOT NULL;

-- ── 4. The source rules ───────────────────────────────────────────────────
ALTER TABLE public.class_occurrences DROP CONSTRAINT IF EXISTS class_occurrences_source_check;
ALTER TABLE public.class_occurrences
  ADD CONSTRAINT class_occurrences_source_check
  CHECK (source IN ('glofox', 'un1t_online'));

ALTER TABLE public.class_occurrences DROP CONSTRAINT IF EXISTS class_occurrences_source_ids_check;
ALTER TABLE public.class_occurrences
  ADD CONSTRAINT class_occurrences_source_ids_check
  CHECK ((source = 'glofox') = (glofox_event_id IS NOT NULL));

ALTER TABLE public.class_occurrences DROP CONSTRAINT IF EXISTS class_occurrences_source_ref_check;
ALTER TABLE public.class_occurrences
  ADD CONSTRAINT class_occurrences_source_ref_check
  CHECK (length(source_ref) BETWEEN 1 AND 200);

ALTER TABLE public.class_occurrences DROP CONSTRAINT IF EXISTS class_occurrences_source_ref_key;
ALTER TABLE public.class_occurrences
  ADD CONSTRAINT class_occurrences_source_ref_key
  UNIQUE (location_id, source, source_ref);

-- ── 5. class_instructor_links ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.class_instructor_links (
  id                      uuid        NOT NULL DEFAULT gen_random_uuid(),
  location_id             uuid        NOT NULL,
  source                  text        NOT NULL,
  external_instructor_id  text        NOT NULL,
  profile_id              uuid        NOT NULL,
  updated_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT class_instructor_links_pkey PRIMARY KEY (id),
  CONSTRAINT class_instructor_links_ref_key UNIQUE (location_id, source, external_instructor_id),
  CONSTRAINT class_instructor_links_location_id_fkey
    FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE CASCADE,
  CONSTRAINT class_instructor_links_profile_id_fkey
    FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT class_instructor_links_source_check CHECK (source IN ('glofox', 'un1t_online')),
  CONSTRAINT class_instructor_links_ref_check CHECK (
    length(external_instructor_id) BETWEEN 1 AND 200
    AND (source <> 'glofox' OR external_instructor_id ~ '^[0-9a-f]{24}$')
  )
);

-- "Which ids is this person?" (CLASSLINK.2) and the profiles FK. The UNIQUE
-- index's leading location_id covers the locations FK.
CREATE INDEX IF NOT EXISTS class_instructor_links_profile_idx
  ON public.class_instructor_links (profile_id);

ALTER TABLE public.class_instructor_links ENABLE ROW LEVEL SECURITY;

-- Deliberately NO policies (see ACCESS in the header).
REVOKE ALL ON public.class_instructor_links FROM anon, authenticated;
REVOKE ALL ON public.class_instructor_links FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_instructor_links TO service_role;

-- ── 6. Comments ──────────────────────────────────────────────────────────
COMMENT ON TABLE public.class_occurrences IS
  'The shared class schedule spine (CLASS-CLIMATE.1 mig 284; platform-neutral since CLASSLINK.1 mig 636). One row per scheduled class instance per studio, from the booking system named by source (glofox today; un1t_online reserved). source_ref is that system''s id for the occurrence (UNIQUE per studio and source); glofox_event_id is set for Glofox rows only. instructor_refs are the system''s instructor ids (mapped to staff through class_instructor_links). raw keeps the full event. Writes are service-role only. Readers that key other tables by glofox_event_id skip rows without one.';
COMMENT ON COLUMN public.class_occurrences.glofox_event_id IS
  'Glofox event _id for a Glofox row (source = ''glofox''); NULL for every other source (CHECK class_occurrences_source_ids_check, mig 636). Still UNIQUE per studio: the Glofox sync upserts on (location_id, glofox_event_id).';
COMMENT ON COLUMN public.class_occurrences.source_ref IS
  'CLASSLINK.1 (mig 636): the source''s own id for this occurrence. Derived from glofox_event_id by trigger class_occurrences_derive_refs for Glofox rows; set by the writer for any other source.';
COMMENT ON COLUMN public.class_occurrences.instructor_refs IS
  'CLASSLINK.1 (mig 636): the source''s ids for the class''s instructors, first-seen order, no repeats. For Glofox rows derived by trigger from raw.trainers (24-hex, lowercased; extractTrainerIds''s rule). Mapped to staff through class_instructor_links.';
COMMENT ON TABLE public.class_instructor_links IS
  'CLASSLINK.1 (mig 636): which staff profile a class timetable''s instructor id is, per studio and source. One id is one person; one person may hold several ids. Service role only; written by PUT /api/schedule/class-instructors (a manager at the studio; the person an active member there). Not the display-name map (settings.glofox.trainer_names).';

-- ── 7. Self-check (the mig 153b habit: verify the catalog, not this text) ──
-- ADD COLUMN / CREATE TABLE IF NOT EXISTS silently KEEP a same-named object of
-- another shape; a RAISE here aborts the transaction, so nothing half-applies.
DO $$
DECLARE
  v_cols text;
  v_n    int;
  v_a    text;
  v_b    text;
  v_bad  text;
BEGIN
  SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' ORDER BY column_name)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'class_occurrences'
     AND column_name IN ('glofox_event_id', 'instructor_refs', 'source', 'source_ref');
  IF v_cols IS DISTINCT FROM
     'glofox_event_id:text:YES:,instructor_refs:ARRAY:NO:''{}''::text[],source:text:NO:''glofox''::text,source_ref:text:NO:' THEN
    RAISE EXCEPTION 'mig 636: class_occurrences source columns have the wrong shape (%)', v_cols;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_constraint
   WHERE conrelid = 'public.class_occurrences'::regclass
     AND convalidated
     AND conname IN ('class_occurrences_source_check', 'class_occurrences_source_ids_check',
                     'class_occurrences_source_ref_check', 'class_occurrences_source_ref_key',
                     'class_occurrences_unique');
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'mig 636: expected 5 validated source constraints on class_occurrences, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_trigger
   WHERE tgrelid = 'public.class_occurrences'::regclass
     AND tgname = 'class_occurrences_derive_refs'
     AND NOT tgisinternal AND tgenabled = 'O';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'mig 636: the derive trigger is missing or disabled';
  END IF;

  SELECT count(*) INTO v_n
    FROM public.class_occurrences
   WHERE source = 'glofox' AND source_ref IS DISTINCT FROM glofox_event_id;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'mig 636: % Glofox rows have a source_ref that is not their glofox_event_id', v_n;
  END IF;

  SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'class_instructor_links';
  IF v_cols IS DISTINCT FROM
     'created_at:timestamp with time zone:NO,external_instructor_id:text:NO,id:uuid:NO,location_id:uuid:NO,profile_id:uuid:NO,source:text:NO,updated_at:timestamp with time zone:NO,updated_by:uuid:YES' THEN
    RAISE EXCEPTION 'mig 636: class_instructor_links has the wrong shape (%); a table of that name existed before this file', v_cols;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_constraint
   WHERE conrelid = 'public.class_instructor_links'::regclass
     AND conname IN ('class_instructor_links_pkey', 'class_instructor_links_ref_key',
                     'class_instructor_links_location_id_fkey', 'class_instructor_links_profile_id_fkey',
                     'class_instructor_links_source_check', 'class_instructor_links_ref_check');
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'mig 636: expected 6 constraints on class_instructor_links, found %', v_n;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_a FROM pg_constraint WHERE conname = 'class_occurrences_source_check';
  SELECT pg_get_constraintdef(oid) INTO v_b FROM pg_constraint WHERE conname = 'class_instructor_links_source_check';
  IF v_a IS DISTINCT FROM v_b THEN
    RAISE EXCEPTION 'mig 636: the two source lists differ (% vs %)', v_a, v_b;
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.class_instructor_links'::regclass) THEN
    RAISE EXCEPTION 'mig 636: RLS is not enabled on class_instructor_links';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.class_instructor_links'::regclass) THEN
    RAISE EXCEPTION 'mig 636: class_instructor_links must carry NO policies (service role only)';
  END IF;

  SELECT string_agg(r || ':' || p, ',' ORDER BY r, p) INTO v_bad
    FROM unnest(ARRAY['anon', 'authenticated']) AS r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
   WHERE has_table_privilege(r, 'public.class_instructor_links', p);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 636: browser roles still hold % on class_instructor_links', v_bad;
  END IF;
  IF NOT (has_table_privilege('service_role', 'public.class_instructor_links', 'SELECT')
      AND has_table_privilege('service_role', 'public.class_instructor_links', 'INSERT')
      AND has_table_privilege('service_role', 'public.class_instructor_links', 'UPDATE')
      AND has_table_privilege('service_role', 'public.class_instructor_links', 'DELETE')) THEN
    RAISE EXCEPTION 'mig 636: service_role lacks SELECT, INSERT, UPDATE or DELETE on class_instructor_links';
  END IF;
  IF has_table_privilege('service_role', 'public.class_instructor_links', 'TRUNCATE') THEN
    RAISE EXCEPTION 'mig 636: service_role still holds TRUNCATE on class_instructor_links';
  END IF;
END $$;

COMMIT;
```

- [ ] **Step 4: Run the replay to see it pass**

Run: `npx vitest run tests/migration-636-class-schedule-platform-neutral.test.js`
Expected: PASS, 23 tests. If "has exactly the documented new column shapes" fails only on the `column_default` text, the self-check's literal differs the same way and the file would not have applied: change BOTH the test literal and the self-check literal to what `information_schema` prints, never one of them.

- [ ] **Step 5: Prove the migration-replaying checks still parse the tree**

Run: `npm run check:select-columns && npm run check:rls-restrictive && npm run check:location-scoping`
Expected: all three exit 0. (`check:select-columns` now knows `source`, `source_ref`, `instructor_refs` and the new table; nothing selects them yet. `class_instructor_links` carries `location_id`, so it joins `check:location-scoping`'s tenant set; no route reads it directly.)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/636_class_schedule_platform_neutral.sql tests/migration-636-class-schedule-platform-neutral.test.js
git commit -m "CLASSLINK.1 — mig 636: class_occurrences gains source/source_ref/instructor_refs (derived for Glofox rows by trigger), glofox_event_id optional; class_instructor_links (service role only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: The pure model

**Files:**
- Create: `src/lib/class-instructors.js`
- Create: `src/lib/class-instructors.test.js`

- [ ] **Step 1: Write the failing test** at `src/lib/class-instructors.test.js`:

```js
// CLASSLINK.1 — the pure half of "who is this timetable instructor?".
// Run under TZ=Europe/Dublin (default) AND TZ=America/New_York: nothing here
// may depend on the machine's zone.

import { describe, it, expect } from 'vitest'
import {
  CLASS_SOURCES,
  INSTRUCTOR_WINDOW_DAYS,
  normalizeInstructorRef,
  instructorKey,
  sourceLabel,
  shortRef,
  weeklySlot,
  summariseInstructors,
} from './class-instructors.js'

const ID1 = '61a38e7d0cf1970aae0fb3a9'
const ID2 = 'deadbeefdeadbeefdeadbeef'
const ID3 = 'cafebabecafebabecafebabe'
const TZ = 'Europe/Dublin'

describe('the vocabulary', () => {
  it('is the same two sources as the migration 636 CHECKs, and a 28-day window', () => {
    expect(CLASS_SOURCES).toEqual(['glofox', 'un1t_online'])
    expect(Object.isFrozen(CLASS_SOURCES)).toBe(true)
    expect(INSTRUCTOR_WINDOW_DAYS).toBe(28)
  })

  it('labels sources for people', () => {
    expect(sourceLabel('glofox')).toBe('Glofox')
    expect(sourceLabel('un1t_online')).toBe('un1t.online')
  })

  it('shortens a long id to its last six characters and leaves a short one alone', () => {
    expect(shortRef(ID1)).toBe('…0fb3a9')
    expect(shortRef('c-7')).toBe('c-7')
  })

  it('keys an instructor by source and id', () => {
    expect(instructorKey('glofox', ID1)).toBe(`glofox|${ID1}`)
  })
})

describe('normalizeInstructorRef', () => {
  it('lowercases a Glofox id and accepts only 24 hex characters', () => {
    expect(normalizeInstructorRef('glofox', ID1.toUpperCase())).toBe(ID1)
    expect(normalizeInstructorRef('glofox', `  ${ID1}  `)).toBe(ID1)
    expect(normalizeInstructorRef('glofox', ID1.slice(1))).toBeNull()
    expect(normalizeInstructorRef('glofox', `${ID1}0`)).toBeNull()
    expect(normalizeInstructorRef('glofox', 'Coach Mia')).toBeNull()
  })

  it('keeps another source\'s id as written (trimmed), 1..200 characters', () => {
    expect(normalizeInstructorRef('un1t_online', ' Coach-7 ')).toBe('Coach-7')
    expect(normalizeInstructorRef('un1t_online', 'x'.repeat(200))).toBe('x'.repeat(200))
    expect(normalizeInstructorRef('un1t_online', 'x'.repeat(201))).toBeNull()
    expect(normalizeInstructorRef('un1t_online', '   ')).toBeNull()
  })

  it('refuses an unknown source and anything that is not a string', () => {
    expect(normalizeInstructorRef('mindbody', ID1)).toBeNull()
    expect(normalizeInstructorRef('glofox', null)).toBeNull()
    expect(normalizeInstructorRef('glofox', 42)).toBeNull()
  })
})

describe('weeklySlot', () => {
  it('reads the studio wall clock in summer time and in winter time', () => {
    // Mon 28 Sep 2026 06:30 IST = 05:30Z; Mon 2 Nov 2026 06:30 GMT = 06:30Z
    expect(weeklySlot('2026-09-28T05:30:00.000Z', TZ)).toEqual({ weekday: 'Mon', time: '06:30', order: 1 })
    expect(weeklySlot('2026-11-02T06:30:00.000Z', TZ)).toEqual({ weekday: 'Mon', time: '06:30', order: 1 })
  })

  it('gives midnight as 00:00 and Sunday the last place', () => {
    expect(weeklySlot('2026-11-01T00:00:00.000Z', TZ)).toEqual({ weekday: 'Sun', time: '00:00', order: 7 })
  })

  it('answers null for no instant', () => {
    expect(weeklySlot(null, TZ)).toBeNull()
    expect(weeklySlot('not a date', TZ)).toBeNull()
  })
})

// A Monday 06:30 strength class and a Wednesday 18:00 HYROX, most weeks.
const occ = (over = {}) => ({
  id: over.id || 'o',
  source: 'glofox',
  name: 'Strength 45',
  starts_at: '2026-09-21T05:30:00.000Z', // Mon 06:30 Dublin
  instructor: null,
  instructor_refs: [ID1],
  ...over,
})

describe('summariseInstructors', () => {
  const members = ['p1', 'p2', 'p3']
  const profiles = [
    { id: 'p1', full_name: 'Alex Example', active: true, deleted_at: null },
    { id: 'p2', full_name: 'Bea Sample', active: true, deleted_at: null },
    { id: 'p3', full_name: 'Cal Former', active: false, deleted_at: null },
    { id: 'p4', full_name: 'Dee Elsewhere', active: true, deleted_at: null },
    { id: 'p5', full_name: 'Eve Deleted', active: false, deleted_at: '2026-09-01T00:00:00Z' },
  ]

  it('counts each instructor\'s classes, a two-trainer class for both, a repeated id once', () => {
    const { instructors } = summariseInstructors({
      occurrences: [
        occ({ id: 'a' }),
        occ({ id: 'b', starts_at: '2026-09-14T05:30:00.000Z' }),
        occ({ id: 'c', name: 'HYROX', starts_at: '2026-09-23T17:00:00.000Z', instructor_refs: [ID2, ID1, ID2] }),
      ],
      tz: TZ,
    })
    expect(instructors.map((i) => [i.external_id, i.classes])).toEqual([[ID1, 3], [ID2, 1]])
  })

  it('lists the three most common weekly slots, busiest first', () => {
    const { instructors } = summariseInstructors({
      occurrences: [
        occ({ id: '1' }), occ({ id: '2', starts_at: '2026-09-14T05:30:00.000Z' }), occ({ id: '3', starts_at: '2026-09-07T05:30:00.000Z' }),
        occ({ id: '4', name: 'HYROX', starts_at: '2026-09-23T17:00:00.000Z' }), occ({ id: '5', name: 'HYROX', starts_at: '2026-09-16T17:00:00.000Z' }),
        occ({ id: '6', name: 'Mobility', starts_at: '2026-09-25T09:00:00.000Z' }),
        occ({ id: '7', name: 'Open gym', starts_at: '2026-09-26T08:00:00.000Z' }),
      ],
      tz: TZ,
    })
    expect(instructors[0].slots).toEqual([
      { name: 'Strength 45', weekday: 'Mon', time: '06:30', count: 3 },
      { name: 'HYROX', weekday: 'Wed', time: '18:00', count: 2 },
      { name: 'Mobility', weekday: 'Fri', time: '10:00', count: 1 },
    ])
  })

  it('takes a label only from single-trainer classes, the most common one', () => {
    const { instructors } = summariseInstructors({
      occurrences: [
        occ({ id: '1', instructor: 'Jess' }),
        occ({ id: '2', instructor: 'Jess' }),
        occ({ id: '3', instructor: 'J. Murphy' }),
        occ({ id: '4', instructor: 'Jess, Dan', instructor_refs: [ID1, ID2] }),
      ],
      tz: TZ,
    })
    const byId = Object.fromEntries(instructors.map((i) => [i.external_id, i]))
    expect(byId[ID1].label).toBe('Jess')
    expect(byId[ID2].label).toBeNull()
  })

  it('attaches links, flags a link to someone no longer at the studio, and keeps a linked id with no recent classes', () => {
    const { instructors } = summariseInstructors({
      occurrences: [occ({ id: '1' }), occ({ id: '2', instructor_refs: [ID2] })],
      links: [
        { source: 'glofox', external_instructor_id: ID1, profile_id: 'p1' },
        { source: 'glofox', external_instructor_id: ID2, profile_id: 'p3' },
        { source: 'glofox', external_instructor_id: ID3, profile_id: 'p4' },
      ],
      profiles,
      memberIds: members,
      tz: TZ,
    })
    const byId = Object.fromEntries(instructors.map((i) => [i.external_id, i]))
    expect(byId[ID1].link).toEqual({ profile_id: 'p1', full_name: 'Alex Example', at_studio: true })
    expect(byId[ID2].link).toEqual({ profile_id: 'p3', full_name: 'Cal Former', at_studio: false }) // deactivated
    expect(byId[ID3]).toMatchObject({ classes: 0, slots: [], link: { profile_id: 'p4', full_name: 'Dee Elsewhere', at_studio: false } }) // not a member here
  })

  it('a link to a tombstone is not at the studio', () => {
    const { instructors } = summariseInstructors({
      links: [{ source: 'glofox', external_instructor_id: ID1, profile_id: 'p5' }],
      profiles, memberIds: [...members, 'p5'], tz: TZ,
    })
    expect(instructors[0].link).toEqual({ profile_id: 'p5', full_name: 'Eve Deleted', at_studio: false })
  })

  it('ignores an unknown source, a malformed id, and a row with no refs', () => {
    const { instructors } = summariseInstructors({
      occurrences: [
        occ({ id: '1', source: 'mindbody' }),
        occ({ id: '2', instructor_refs: ['Coach Mia'] }),
        occ({ id: '3', instructor_refs: null }),
      ],
      links: [{ source: 'glofox', external_instructor_id: 'nope', profile_id: 'p1' }],
      tz: TZ,
    })
    expect(instructors).toEqual([])
  })

  it('keeps sources apart: the same id string under two sources is two instructors', () => {
    const { instructors } = summariseInstructors({
      occurrences: [occ({ id: '1' }), occ({ id: '2', source: 'un1t_online', instructor_refs: [ID1] })],
      tz: TZ,
    })
    expect(instructors.map((i) => instructorKey(i.source, i.external_id))).toEqual([`glofox|${ID1}`, `un1t_online|${ID1}`])
  })

  it('offers the studio\'s active members only, by name, and carries only id and name', () => {
    const { coaches } = summariseInstructors({ profiles, memberIds: members, tz: TZ })
    expect(coaches).toEqual([
      { id: 'p1', full_name: 'Alex Example' },
      { id: 'p2', full_name: 'Bea Sample' },
    ])
  })

  it('an instructor row carries no capacity, booked count or contract', () => {
    const { instructors } = summariseInstructors({ occurrences: [occ({ capacity: 20, booked: 12 })], tz: TZ })
    expect(Object.keys(instructors[0]).sort()).toEqual(['classes', 'external_id', 'label', 'link', 'slots', 'source'])
    expect(Object.keys(instructors[0].slots[0]).sort()).toEqual(['count', 'name', 'time', 'weekday'])
  })

  it('orders instructors busiest first, then by source and id', () => {
    const { instructors } = summariseInstructors({
      occurrences: [occ({ id: '1', instructor_refs: [ID3] }), occ({ id: '2', instructor_refs: [ID2] }), occ({ id: '3', instructor_refs: [ID2] })],
      tz: TZ,
    })
    expect(instructors.map((i) => i.external_id)).toEqual([ID2, ID3])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/class-instructors.test.js`
Expected: FAIL, `Failed to resolve import "./class-instructors.js"`.

- [ ] **Step 3: Write the module** at `src/lib/class-instructors.js`:

```js
// CLASSLINK.1 — the class timetable's instructors, and which person on the
// team each one is (mig 636: class_occurrences.source / instructor_refs,
// class_instructor_links).
//
// PURE and client-safe: no IO, no next/*, no zod. The route's IO lives in
// src/lib/class-instructors-server.js; the "Timetable coaches" component
// imports the label helpers from here.
//
// Names only: nothing here reads or returns capacity, booked counts,
// contracted hours or pay.

/** The booking systems a class can come from. MUST match migration 636's two CHECKs. */
export const CLASS_SOURCES = Object.freeze(['glofox', 'un1t_online'])

/** How far back the manager's view counts classes (the timetable ahead is always included). */
export const INSTRUCTOR_WINDOW_DAYS = 28

const MAX_REF_LENGTH = 200
const GLOFOX_REF_RE = /^[0-9a-f]{24}$/
const SLOT_LIMIT = 3
const SOURCE_LABELS = Object.freeze({ glofox: 'Glofox', un1t_online: 'un1t.online' })
const WEEKDAY_ORDER = Object.freeze({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })

export function isClassSource(source) {
  return CLASS_SOURCES.includes(source)
}

/** 'Glofox' / 'un1t.online' for people; an unknown source reads as itself. */
export function sourceLabel(source) {
  return SOURCE_LABELS[source] || String(source || '')
}

/** The last six characters of a long id, for a label ("Glofox coach …0fb3a9"). */
export function shortRef(ref) {
  const s = String(ref || '')
  return s.length > 8 ? `…${s.slice(-6)}` : s
}

/** One instructor, across tables: source + id. */
export function instructorKey(source, ref) {
  return `${source}|${ref}`
}

/**
 * The stored form of an instructor id, or null when it is not one.
 * Glofox: 24 hex characters, lowercased (extractTrainerIds's rule, and the
 * class_instructor_links_ref_check CHECK). Any other source: trimmed,
 * 1..200 characters, case kept.
 */
export function normalizeInstructorRef(source, raw) {
  if (!isClassSource(source) || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_REF_LENGTH) return null
  if (source === 'glofox') {
    const lower = trimmed.toLowerCase()
    return GLOFOX_REF_RE.test(lower) ? lower : null
  }
  return trimmed
}

const slotFormatters = new Map()
function slotFormatter(tz) {
  if (!slotFormatters.has(tz)) {
    slotFormatters.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }))
  }
  return slotFormatters.get(tz)
}

/**
 * The weekly slot a class instant falls in, on the studio's wall clock
 * (DST-exact through Intl): { weekday: 'Mon'..'Sun', time: 'HH:MM', order: 1..7 }.
 * Null for no instant.
 */
export function weeklySlot(startsAtIso, tz) {
  const ms = Date.parse(startsAtIso ?? '')
  if (!Number.isFinite(ms)) return null
  const parts = {}
  for (const { type, value } of slotFormatter(tz).formatToParts(new Date(ms))) parts[type] = value
  // 'en-GB' has emitted hour '24' at midnight on some engines (the guard
  // tz-time.js and dublin-time.js carry for the same reason).
  const hour = parts.hour === '24' ? '00' : parts.hour
  return { weekday: parts.weekday, time: `${hour}:${parts.minute}`, order: WEEKDAY_ORDER[parts.weekday] ?? 8 }
}

function topLabel(counts) {
  let best = null
  let bestCount = 0
  for (const [label, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && label < best)) {
      best = label
      bestCount = count
    }
  }
  return best
}

function bySlot(a, b) {
  return b.count - a.count || a.order - b.order || a.time.localeCompare(b.time) || a.name.localeCompare(b.name)
}

function isActivePerson(p) {
  return !!p && p.active === true && !p.deleted_at
}

/**
 * The manager's view of one studio's timetable instructors.
 *
 * @param {object} args
 * @param {Array<{ source, name, starts_at, instructor, instructor_refs }>} [args.occurrences]
 *   the studio's non-cancelled occurrences in the window
 * @param {Array<{ source, external_instructor_id, profile_id }>} [args.links]  the studio's links
 * @param {Array<{ id, full_name, active, deleted_at }>} [args.profiles]  members + linked people
 * @param {string[]} [args.memberIds]  profile ids with a profile_locations row at the studio
 * @param {string} [args.tz]  the studio's IANA zone
 * @returns {{ instructors: Array<{ source, external_id, classes, label, slots, link }>,
 *             coaches: Array<{ id, full_name }> }}
 */
export function summariseInstructors({ occurrences = [], links = [], profiles = [], memberIds = [], tz = 'Europe/Dublin' } = {}) {
  const members = new Set(memberIds)
  const people = new Map(profiles.map((p) => [p.id, p]))
  const byKey = new Map()
  const entry = (source, ref) => {
    const key = instructorKey(source, ref)
    if (!byKey.has(key)) {
      byKey.set(key, { source, external_id: ref, classes: 0, labels: new Map(), slots: new Map(), link: null })
    }
    return byKey.get(key)
  }

  for (const o of occurrences) {
    if (!isClassSource(o?.source)) continue
    const refs = [...new Set(
      (Array.isArray(o.instructor_refs) ? o.instructor_refs : [])
        .map((r) => normalizeInstructorRef(o.source, r))
        .filter(Boolean),
    )]
    const slot = weeklySlot(o.starts_at, tz)
    const name = (typeof o.name === 'string' && o.name.trim()) || 'Class'
    for (const ref of refs) {
      const e = entry(o.source, ref)
      e.classes++
      if (refs.length === 1 && typeof o.instructor === 'string' && o.instructor.trim()) {
        const label = o.instructor.trim()
        e.labels.set(label, (e.labels.get(label) || 0) + 1)
      }
      if (slot) {
        const sk = `${name}|${slot.weekday}|${slot.time}`
        const cur = e.slots.get(sk) || { name, weekday: slot.weekday, time: slot.time, order: slot.order, count: 0 }
        cur.count++
        e.slots.set(sk, cur)
      }
    }
  }

  for (const l of links) {
    const ref = normalizeInstructorRef(l?.source, l?.external_instructor_id)
    if (!ref) continue
    const p = people.get(l.profile_id)
    entry(l.source, ref).link = {
      profile_id: l.profile_id,
      full_name: p?.full_name || null,
      at_studio: isActivePerson(p) && members.has(l.profile_id),
    }
  }

  const instructors = [...byKey.values()]
    .map((e) => ({
      source: e.source,
      external_id: e.external_id,
      classes: e.classes,
      label: topLabel(e.labels),
      slots: [...e.slots.values()].sort(bySlot).slice(0, SLOT_LIMIT)
        .map(({ name, weekday, time, count }) => ({ name, weekday, time, count })),
      link: e.link,
    }))
    .sort((a, b) => b.classes - a.classes || a.source.localeCompare(b.source) || a.external_id.localeCompare(b.external_id))

  const coaches = profiles
    .filter((p) => members.has(p.id) && isActivePerson(p))
    .map((p) => ({ id: p.id, full_name: p.full_name || 'Unnamed' }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id))

  return { instructors, coaches }
}
```

- [ ] **Step 4: Run the tests to see them pass, in two zones**

Run: `npx vitest run src/lib/class-instructors.test.js && TZ=America/New_York npx vitest run src/lib/class-instructors.test.js`
Expected: PASS both times, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/class-instructors.js src/lib/class-instructors.test.js
git commit -m "CLASSLINK.1 — pure model: instructor id rules, weekly slots, per-instructor timetable summary, names only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The IO

**Files:**
- Create: `src/lib/class-instructors-server.js`
- Create: `src/lib/class-instructors-server.test.js`

- [ ] **Step 1: Write the failing test** at `src/lib/class-instructors-server.test.js`:

```js
// CLASSLINK.1 — the reads and the one write behind /api/schedule/class-instructors,
// against a recording fake client that honours the filters the code relies on.

import { describe, it, expect } from 'vitest'
import { loadInstructorMapping, saveInstructorLink, ClassInstructorPutSchema } from './class-instructors-server.js'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'
const ID1 = '61a38e7d0cf1970aae0fb3a9'
const ID2 = 'deadbeefdeadbeefdeadbeef'
const NOW = Date.parse('2026-09-25T16:00:00.000Z')

// fail: { '<table>' | '<table>:<op>': true } makes that call answer an error.
function fakeDb(tables = {}, { fail = {} } = {}) {
  const store = JSON.parse(JSON.stringify(tables))
  const calls = []
  function from(table) {
    const call = { table, op: 'select', columns: null, returning: null, filters: [], order: null, range: null, limit: null, single: false, payload: null, onConflict: null }
    calls.push(call)
    const match = (r) => call.filters.every(([k, c, v]) => {
      if (k === 'eq') return r[c] === v
      if (k === 'gte') return r[c] >= v
      if (k === 'is') return v === null ? r[c] == null : r[c] === v
      if (k === 'in') return v.includes(r[c])
      return false
    })
    const answer = () => {
      if (fail[`${table}:${call.op}`] || fail[table]) return { data: null, error: { message: `${table} ${call.op} failed` } }
      const rows = store[table] || (store[table] = [])
      if (call.op === 'delete') {
        const gone = rows.filter(match)
        store[table] = rows.filter((r) => !match(r))
        return { data: gone.map((r) => ({ id: r.id })), error: null }
      }
      if (call.op === 'upsert') {
        const keys = call.onConflict.split(',')
        const i = rows.findIndex((r) => keys.every((k) => r[k] === call.payload[k]))
        const saved = i === -1 ? { id: `link-${rows.length + 1}`, ...call.payload } : Object.assign(rows[i], call.payload)
        if (i === -1) rows.push(saved)
        return { data: fail.upsertReturnsNothing ? [] : [saved], error: null }
      }
      let out = rows.filter(match)
      if (call.range) out = out.slice(call.range[0], call.range[1] + 1)
      if (call.limit != null) out = out.slice(0, call.limit)
      if (call.single) return { data: out[0] ?? null, error: null }
      return { data: out, error: null }
    }
    const chain = {
      select(cols) { if (call.op === 'select') call.columns = cols; else call.returning = cols; return chain },
      eq(c, v) { call.filters.push(['eq', c, v]); return chain },
      gte(c, v) { call.filters.push(['gte', c, v]); return chain },
      is(c, v) { call.filters.push(['is', c, v]); return chain },
      in(c, v) { call.filters.push(['in', c, v]); return chain },
      order(c) { call.order = c; return chain },
      range(a, b) { call.range = [a, b]; return chain },
      limit(n) { call.limit = n; return chain },
      maybeSingle() { call.single = true; return chain },
      delete() { call.op = 'delete'; return chain },
      upsert(payload, opts) { call.op = 'upsert'; call.payload = payload; call.onConflict = opts?.onConflict; return chain },
      then(resolve, reject) { return Promise.resolve(answer()).then(resolve, reject) },
    }
    return chain
  }
  return { from, calls, store }
}

const TABLES = () => ({
  locations: [{ id: LOC, timezone: 'Europe/Dublin' }],
  class_occurrences: [
    { id: 'o1', location_id: LOC, source: 'glofox', name: 'Strength 45', starts_at: '2026-09-21T05:30:00.000Z', cancelled_at: null, instructor: null, instructor_refs: [ID1] },
    { id: 'o2', location_id: LOC, source: 'glofox', name: 'Strength 45', starts_at: '2026-08-01T05:30:00.000Z', cancelled_at: null, instructor: null, instructor_refs: [ID2] }, // before the window
    { id: 'o3', location_id: LOC, source: 'glofox', name: 'HYROX', starts_at: '2026-09-23T17:00:00.000Z', cancelled_at: '2026-09-22T10:00:00.000Z', instructor: null, instructor_refs: [ID2] }, // cancelled
    { id: 'o4', location_id: OTHER, source: 'glofox', name: 'Engine', starts_at: '2026-09-22T05:30:00.000Z', cancelled_at: null, instructor: null, instructor_refs: [ID2] }, // another studio
  ],
  class_instructor_links: [
    { id: 'l1', location_id: LOC, source: 'glofox', external_instructor_id: ID1, profile_id: P1, updated_at: '2026-09-20T00:00:00Z' },
    { id: 'l2', location_id: OTHER, source: 'glofox', external_instructor_id: ID2, profile_id: P2, updated_at: '2026-09-20T00:00:00Z' },
  ],
  profile_locations: [
    { id: 'pl1', location_id: LOC, profile_id: P1 },
    { id: 'pl2', location_id: OTHER, profile_id: P2 },
  ],
  profiles: [
    { id: P1, full_name: 'Alex Example', active: true, deleted_at: null },
    { id: P2, full_name: 'Bea Sample', active: true, deleted_at: null },
  ],
})

describe('loadInstructorMapping', () => {
  it('reads this studio\'s last 28 days of live classes, its links and its team, and summarises them', async () => {
    const db = fakeDb(TABLES())
    const { data, error } = await loadInstructorMapping(db, { locationId: LOC, nowMs: NOW })
    expect(error).toBeNull()
    expect(data.window_days).toBe(28)
    expect(data.instructors).toEqual([{
      source: 'glofox', external_id: ID1, classes: 1, label: null,
      slots: [{ name: 'Strength 45', weekday: 'Mon', time: '06:30', count: 1 }],
      link: { profile_id: P1, full_name: 'Alex Example', at_studio: true },
    }])
    expect(data.coaches).toEqual([{ id: P1, full_name: 'Alex Example' }])
  })

  it('pins the occurrence read: this studio, the window start, not cancelled, paged on a stable order', async () => {
    const db = fakeDb(TABLES())
    await loadInstructorMapping(db, { locationId: LOC, nowMs: NOW })
    const occ = db.calls.find((c) => c.table === 'class_occurrences')
    expect(occ.columns).toBe('id, source, name, starts_at, instructor, instructor_refs')
    expect(occ.filters).toEqual([
      ['eq', 'location_id', LOC],
      ['gte', 'starts_at', '2026-08-28T16:00:00.000Z'],
      ['is', 'cancelled_at', null],
    ])
    expect(occ.order).toBe('id')
    expect(occ.range).toEqual([0, 999])
  })

  it('reads profiles only by id, for members and linked people together, and never a pay column', async () => {
    const db = fakeDb(TABLES())
    await loadInstructorMapping(db, { locationId: LOC, nowMs: NOW })
    const prof = db.calls.filter((c) => c.table === 'profiles')
    expect(prof).toHaveLength(1)
    expect(prof[0].columns).toBe('id, full_name, active, deleted_at')
    expect(prof[0].filters).toEqual([['in', 'id', [P1]]])
  })

  it('does not read profiles when the studio has no team and no links', async () => {
    const t = TABLES()
    t.profile_locations = []
    t.class_instructor_links = []
    const db = fakeDb(t)
    const { data } = await loadInstructorMapping(db, { locationId: LOC, nowMs: NOW })
    expect(data.coaches).toEqual([])
    expect(db.calls.some((c) => c.table === 'profiles')).toBe(false)
  })

  it('falls back to Europe/Dublin when the studio has no timezone row', async () => {
    const t = TABLES()
    t.locations = []
    const { data } = await loadInstructorMapping(fakeDb(t), { locationId: LOC, nowMs: NOW })
    expect(data.instructors[0].slots[0].time).toBe('06:30')
  })

  it.each(['locations', 'class_occurrences', 'class_instructor_links', 'profile_locations', 'profiles'])(
    'a failed %s read is an error, never an empty mapping',
    async (table) => {
      const { data, error } = await loadInstructorMapping(fakeDb(TABLES(), { fail: { [table]: true } }), { locationId: LOC, nowMs: NOW })
      expect(data).toBeNull()
      expect(error.message).toMatch(/failed/)
    },
  )
})

describe('saveInstructorLink', () => {
  const base = { locationId: LOC, source: 'glofox', externalId: ID2, actorId: P1, nowMs: NOW }

  it('links an instructor id to an active member of the studio, upserting on the natural key', async () => {
    const db = fakeDb(TABLES())
    const out = await saveInstructorLink(db, { ...base, profileId: P1 })
    expect(out.ok).toBe(true)
    expect(out.data.link).toMatchObject({ location_id: LOC, source: 'glofox', external_instructor_id: ID2, profile_id: P1 })
    const up = db.calls.find((c) => c.op === 'upsert')
    expect(up.onConflict).toBe('location_id,source,external_instructor_id')
    expect(up.payload).toEqual({
      location_id: LOC, source: 'glofox', external_instructor_id: ID2, profile_id: P1,
      updated_by: P1, updated_at: '2026-09-25T16:00:00.000Z',
    })
    expect(up.returning).toBe('id, source, external_instructor_id, profile_id, updated_at')
  })

  it('re-points an existing link in place', async () => {
    const t = TABLES()
    t.profile_locations.push({ id: 'pl3', location_id: LOC, profile_id: P2 })
    const db = fakeDb(t)
    const out = await saveInstructorLink(db, { ...base, externalId: ID1, profileId: P2 })
    expect(out.ok).toBe(true)
    expect(db.store.class_instructor_links.filter((l) => l.location_id === LOC)).toHaveLength(1)
    expect(db.store.class_instructor_links.find((l) => l.external_instructor_id === ID1).profile_id).toBe(P2)
  })

  it('unlinks with profileId null, scoped to this studio, and reports what it removed', async () => {
    const db = fakeDb(TABLES())
    const out = await saveInstructorLink(db, { ...base, externalId: ID1, profileId: null })
    expect(out).toEqual({ ok: true, data: { link: null, removed: 1 } })
    const del = db.calls.find((c) => c.op === 'delete')
    expect(del.filters).toEqual([['eq', 'location_id', LOC], ['eq', 'source', 'glofox'], ['eq', 'external_instructor_id', ID1]])
    expect(db.store.class_instructor_links.map((l) => l.id)).toEqual(['l2'])
  })

  it('unlinking something not linked is fine (removed 0)', async () => {
    const out = await saveInstructorLink(fakeDb(TABLES()), { ...base, profileId: null })
    expect(out).toEqual({ ok: true, data: { link: null, removed: 0 } })
  })

  it('refuses someone who is not a member of this studio, and writes nothing', async () => {
    const db = fakeDb(TABLES())
    const out = await saveInstructorLink(db, { ...base, profileId: P2 }) // P2 is at OTHER only
    expect(out).toMatchObject({ ok: false, status: 400 })
    expect(out.error).toMatch(/active member of this studio/)
    expect(db.calls.some((c) => c.op === 'upsert')).toBe(false)
  })

  it.each([
    ['inactive', { active: false, deleted_at: null }],
    ['a tombstone', { active: false, deleted_at: '2026-09-01T00:00:00Z' }],
  ])('refuses a member who is %s, and writes nothing', async (_label, patch) => {
    const t = TABLES()
    Object.assign(t.profiles[0], patch)
    const db = fakeDb(t)
    const out = await saveInstructorLink(db, { ...base, profileId: P1 })
    expect(out).toMatchObject({ ok: false, status: 400 })
    expect(db.calls.some((c) => c.op === 'upsert')).toBe(false)
  })

  it('pins the membership and person reads', async () => {
    const db = fakeDb(TABLES())
    await saveInstructorLink(db, { ...base, profileId: P1 })
    const mem = db.calls.find((c) => c.table === 'profile_locations')
    expect(mem.filters).toEqual([['eq', 'location_id', LOC], ['eq', 'profile_id', P1]])
    const person = db.calls.find((c) => c.table === 'profiles')
    expect(person.columns).toBe('id, active, deleted_at')
    expect(person.filters).toEqual([['eq', 'id', P1]])
  })

  it.each([
    ['the membership read', { profile_locations: true }],
    ['the person read', { profiles: true }],
    ['the upsert', { 'class_instructor_links:upsert': true }],
    ['the delete', { 'class_instructor_links:delete': true }],
  ])('%s failing is a 500 with the reason', async (_label, fail) => {
    const profileId = fail['class_instructor_links:delete'] ? null : P1
    const out = await saveInstructorLink(fakeDb(TABLES(), { fail }), { ...base, profileId })
    expect(out).toMatchObject({ ok: false, status: 500 })
    expect(out.error).toMatch(/failed/)
  })

  it('an upsert that returns no row is a 500, not a success', async () => {
    const out = await saveInstructorLink(fakeDb(TABLES(), { fail: { upsertReturnsNothing: true } }), { ...base, profileId: P1 })
    expect(out).toMatchObject({ ok: false, status: 500 })
  })
})

describe('ClassInstructorPutSchema', () => {
  it('takes a studio, a source, an id and a person or null', () => {
    expect(ClassInstructorPutSchema.safeParse({ location_id: LOC, source: 'glofox', external_id: ID1, profile_id: P1 }).success).toBe(true)
    expect(ClassInstructorPutSchema.safeParse({ location_id: LOC, source: 'glofox', external_id: ID1, profile_id: null }).success).toBe(true)
  })

  it('refuses an unknown source, a missing person key, an empty or over-long id', () => {
    expect(ClassInstructorPutSchema.safeParse({ location_id: LOC, source: 'mindbody', external_id: ID1, profile_id: P1 }).success).toBe(false)
    expect(ClassInstructorPutSchema.safeParse({ location_id: LOC, source: 'glofox', external_id: ID1 }).success).toBe(false)
    expect(ClassInstructorPutSchema.safeParse({ location_id: LOC, source: 'glofox', external_id: '', profile_id: P1 }).success).toBe(false)
    expect(ClassInstructorPutSchema.safeParse({ location_id: LOC, source: 'glofox', external_id: 'x'.repeat(201), profile_id: P1 }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/class-instructors-server.test.js`
Expected: FAIL, `Failed to resolve import "./class-instructors-server.js"`.

- [ ] **Step 3: Write the module** at `src/lib/class-instructors-server.js`:

```js
// CLASSLINK.1 — the reads and the one write behind /api/schedule/class-instructors.
// Service-role client in, plain results out; the route owns the gate.
//
// Every read that fails is an ERROR, never an empty mapping: a manager told
// "nothing to link" when the read failed would stop looking (the
// discarded-error class). Names only: profiles are read as id, full_name,
// active, deleted_at; no contract or pay column is ever named.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { selectAll } from '@/lib/select-all'
import { resolveTz } from '@/lib/tz-time'
import { CLASS_SOURCES, INSTRUCTOR_WINDOW_DAYS, summariseInstructors } from '@/lib/class-instructors'

const LINK_COLUMNS = 'id, source, external_instructor_id, profile_id, updated_at'
const DAY_MS = 86_400_000

/** PUT /api/schedule/class-instructors. profile_id null unlinks. */
export const ClassInstructorPutSchema = z.object({
  location_id: uuidLike,
  source: z.enum(CLASS_SOURCES),
  external_id: z.string().min(1).max(200),
  profile_id: uuidLike.nullable(),
})

/**
 * One studio's timetable instructors (last INSTRUCTOR_WINDOW_DAYS days plus
 * whatever the timetable holds ahead, cancelled classes excluded), their links,
 * and the studio's active team as link options.
 *
 * @returns {Promise<{ data: { window_days, instructors, coaches } | null, error: { message } | null }>}
 */
export async function loadInstructorMapping(db, { locationId, nowMs = Date.now() }) {
  try {
    const { data: location, error: locError } = await db
      .from('locations')
      .select('id, timezone')
      .eq('id', locationId)
      .maybeSingle()
    if (locError) return { data: null, error: { message: locError.message } }

    const sinceIso = new Date(nowMs - INSTRUCTOR_WINDOW_DAYS * DAY_MS).toISOString()
    // selectAll throws on a page error; the catch below turns that into an error result.
    const occurrences = await selectAll((from, to) => db
      .from('class_occurrences')
      .select('id, source, name, starts_at, instructor, instructor_refs')
      .eq('location_id', locationId)
      .gte('starts_at', sinceIso)
      .is('cancelled_at', null)
      .order('id', { ascending: true })
      .range(from, to))
    const links = await selectAll((from, to) => db
      .from('class_instructor_links')
      .select(LINK_COLUMNS)
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(from, to))
    const memberRows = await selectAll((from, to) => db
      .from('profile_locations')
      .select('profile_id')
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(from, to))

    const memberIds = [...new Set(memberRows.map((r) => r.profile_id))]
    const ids = [...new Set([...memberIds, ...links.map((l) => l.profile_id)])]
    let profiles = []
    if (ids.length > 0) {
      const { data, error } = await db.from('profiles').select('id, full_name, active, deleted_at').in('id', ids)
      if (error) return { data: null, error: { message: error.message } }
      profiles = data || []
    }

    const { instructors, coaches } = summariseInstructors({
      occurrences, links, profiles, memberIds, tz: resolveTz(location?.timezone),
    })
    return { data: { window_days: INSTRUCTOR_WINDOW_DAYS, instructors, coaches }, error: null }
  } catch (err) {
    return { data: null, error: { message: err?.message || String(err) } }
  }
}

/**
 * Link one instructor id at a studio to one ACTIVE member of that studio, or
 * unlink it (profileId null). externalId must already be normalised
 * (normalizeInstructorRef); the route does that.
 *
 * @returns {Promise<{ ok: true, data: { link, removed } } | { ok: false, status: 400|500, error: string }>}
 */
export async function saveInstructorLink(db, { locationId, source, externalId, profileId, actorId = null, nowMs = Date.now() }) {
  if (profileId == null) {
    const { data, error } = await db
      .from('class_instructor_links')
      .delete()
      .eq('location_id', locationId)
      .eq('source', source)
      .eq('external_instructor_id', externalId)
      .select('id')
    if (error) return { ok: false, status: 500, error: error.message }
    return { ok: true, data: { link: null, removed: (data || []).length } }
  }

  const { data: membership, error: memError } = await db
    .from('profile_locations')
    .select('profile_id')
    .eq('location_id', locationId)
    .eq('profile_id', profileId)
    .limit(1)
  if (memError) return { ok: false, status: 500, error: memError.message }
  const { data: person, error: personError } = await db
    .from('profiles')
    .select('id, active, deleted_at')
    .eq('id', profileId)
    .maybeSingle()
  if (personError) return { ok: false, status: 500, error: personError.message }
  if (!membership?.length || !person || person.active !== true || person.deleted_at) {
    return { ok: false, status: 400, error: 'Pick someone who is an active member of this studio' }
  }

  const { data, error } = await db
    .from('class_instructor_links')
    .upsert({
      location_id: locationId,
      source,
      external_instructor_id: externalId,
      profile_id: profileId,
      updated_by: actorId,
      updated_at: new Date(nowMs).toISOString(),
    }, { onConflict: 'location_id,source,external_instructor_id' })
    .select(LINK_COLUMNS)
  if (error) return { ok: false, status: 500, error: error.message }
  const link = data?.[0]
  if (!link) return { ok: false, status: 500, error: 'The link was not saved' }
  return { ok: true, data: { link, removed: 0 } }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run src/lib/class-instructors-server.test.js`
Expected: PASS, 25 tests. (The upsert fake returns the stored row, which carries `location_id`; the real call returns `LINK_COLUMNS` only. The test asserts `toMatchObject`, so either shape passes; the component reads only `profile_id`.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/class-instructors-server.js src/lib/class-instructors-server.test.js
git commit -m "CLASSLINK.1 — IO: load a studio's timetable instructors + links + team; link or unlink one (active members only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `GET` and `PUT /api/schedule/class-instructors`

**Files:**
- Create: `src/app/api/schedule/class-instructors/route.js`
- Create: `src/app/api/schedule/class-instructors/route.test.js`

- [ ] **Step 1: Write the failing test** at `src/app/api/schedule/class-instructors/route.test.js`:

```js
// CLASSLINK.1 — GET/PUT /api/schedule/class-instructors. The reads and the
// write are pinned in src/lib/class-instructors-server.test.js; locked here:
// the gate, the query/body contract, id normalisation, and pass-through.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    // SCHEDROLES.1 — REAL: the role AT location_id is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/class-instructors-server', async (importOriginal) => ({
  ...(await importOriginal()),
  loadInstructorMapping: vi.fn(),
  saveInstructorLink: vi.fn(),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { loadInstructorMapping, saveInstructorLink } = await import('@/lib/class-instructors-server')
const { logError } = await import('@/lib/log')
const { GET, PUT } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const P1 = '11111111-1111-4111-8111-111111111111'
const ID1 = '61a38e7d0cf1970aae0fb3a9'

const MAPPING = {
  window_days: 28,
  instructors: [{ source: 'glofox', external_id: ID1, classes: 3, label: null, slots: [], link: null }],
  coaches: [{ id: P1, full_name: 'Alex Example' }],
}

const getReq = (params = {}) => {
  const url = new URL('http://test/api/schedule/class-instructors')
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const putReq = (body) => ({ url: 'http://test/api/schedule/class-instructors', json: async () => body })
const as = (rolesByLocation, profileRole = 'staff') => ({
  id: 'u1', role: Object.values(rolesByLocation)[0] || profileRole, profileRole, rolesByLocation,
  locations: Object.keys(rolesByLocation).map((id) => ({ id })),
})
const body = (over = {}) => ({ location_id: LOC, source: 'glofox', external_id: ID1, profile_id: P1, ...over })
const forbidden = () => NextResponse.json({ success: false, error: 'Forbidden — location not in your assignments' }, { status: 403 })

beforeEach(() => {
  getCurrentUser.mockReset()
  assertLocationAccess.mockReset().mockReturnValue(null)
  loadInstructorMapping.mockReset().mockResolvedValue({ data: MAPPING, error: null })
  saveInstructorLink.mockReset().mockResolvedValue({ ok: true, data: { link: { id: 'l1', source: 'glofox', external_instructor_id: ID1, profile_id: P1 }, removed: 0 } })
  logError.mockClear()
})

describe('GET /api/schedule/class-instructors', () => {
  it('403 with no session, and reads nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(403)
    expect(loadInstructorMapping).not.toHaveBeenCalled()
  })

  it('403 for a coach at the studio, even though they manage another', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'staff', [OTHER]: 'manager' }))
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(403)
    expect(loadInstructorMapping).not.toHaveBeenCalled()
  })

  it('403 for a manager of another studio, via assertLocationAccess', async () => {
    getCurrentUser.mockResolvedValue(as({ [OTHER]: 'manager' }))
    assertLocationAccess.mockReturnValue(forbidden())
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(403)
    expect(assertLocationAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), LOC)
    expect(loadInstructorMapping).not.toHaveBeenCalled()
  })

  it('400 on a missing or malformed location_id', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    for (const params of [{}, { location_id: 'nope' }]) {
      expect((await GET(getReq(params))).status, JSON.stringify(params)).toBe(400)
    }
    expect(loadInstructorMapping).not.toHaveBeenCalled()
  })

  it.each(['manager', 'owner', 'head_coach'])('200 for a %s at the studio, passing the read through untouched', async (role) => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: role }))
    const res = await GET(getReq({ location_id: LOC }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: MAPPING })
    expect(loadInstructorMapping).toHaveBeenCalledWith({ tag: 'db' }, { locationId: LOC })
  })

  it('200 for a master (no per-location row)', async () => {
    getCurrentUser.mockResolvedValue({ ...as({}), profileRole: 'master', role: 'master', locations: [{ id: LOC }] })
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(200)
  })

  it('500 when the read fails, logged, never an empty mapping', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    loadInstructorMapping.mockResolvedValue({ data: null, error: { message: 'profiles read failed' } })
    const res = await GET(getReq({ location_id: LOC }))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json).not.toHaveProperty('data')
    expect(logError).toHaveBeenCalledWith('api/schedule/class-instructors', 'mapping read failed', expect.objectContaining({ location_id: LOC }))
  })
})

describe('PUT /api/schedule/class-instructors', () => {
  it('403 with no session or no manager role anywhere, and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(putReq(body()))).status).toBe(403)
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'staff' }))
    expect((await PUT(putReq(body()))).status).toBe(403)
    expect(saveInstructorLink).not.toHaveBeenCalled()
  })

  it('403 for a coach at the studio who manages another', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'staff', [OTHER]: 'manager' }))
    expect((await PUT(putReq(body()))).status).toBe(403)
    expect(saveInstructorLink).not.toHaveBeenCalled()
  })

  it('403 for a studio outside the caller\'s assignments', async () => {
    getCurrentUser.mockResolvedValue(as({ [OTHER]: 'manager' }))
    assertLocationAccess.mockReturnValue(forbidden())
    expect((await PUT(putReq(body()))).status).toBe(403)
    expect(saveInstructorLink).not.toHaveBeenCalled()
  })

  it('400 on a bad body (unknown source, missing profile_id key, malformed ids)', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    for (const b of [
      body({ source: 'mindbody' }),
      { location_id: LOC, source: 'glofox', external_id: ID1 },
      body({ location_id: 'nope' }),
      body({ profile_id: 'nope' }),
    ]) {
      expect((await PUT(putReq(b))).status, JSON.stringify(b)).toBe(400)
    }
    expect(saveInstructorLink).not.toHaveBeenCalled()
  })

  it('400 on an id that is not a Glofox trainer id, saying so', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    for (const external_id of ['Coach Mia', ID1.slice(1)]) {
      const res = await PUT(putReq(body({ external_id })))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('That is not a valid Glofox instructor id')
    }
    expect(saveInstructorLink).not.toHaveBeenCalled()
  })

  it('normalises the id, and passes the studio, source, person and actor through', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'head_coach' }))
    const res = await PUT(putReq(body({ external_id: ` ${ID1.toUpperCase()} ` })))
    expect(res.status).toBe(200)
    expect(saveInstructorLink).toHaveBeenCalledWith({ tag: 'db' }, {
      locationId: LOC, source: 'glofox', externalId: ID1, profileId: P1, actorId: 'u1',
    })
    expect((await res.json()).data.link.profile_id).toBe(P1)
  })

  it('profile_id null unlinks', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    saveInstructorLink.mockResolvedValue({ ok: true, data: { link: null, removed: 1 } })
    const res = await PUT(putReq(body({ profile_id: null })))
    expect(res.status).toBe(200)
    expect(saveInstructorLink).toHaveBeenCalledWith({ tag: 'db' }, expect.objectContaining({ profileId: null }))
    expect(await res.json()).toEqual({ success: true, data: { link: null, removed: 1 } })
  })

  it('relays a 400 from the write (not an active member) without logging it as a failure', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    saveInstructorLink.mockResolvedValue({ ok: false, status: 400, error: 'Pick someone who is an active member of this studio' })
    const res = await PUT(putReq(body()))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Pick someone who is an active member of this studio')
    expect(logError).not.toHaveBeenCalled()
  })

  it('500 when the write fails, logged', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    saveInstructorLink.mockResolvedValue({ ok: false, status: 500, error: 'class_instructor_links upsert failed' })
    const res = await PUT(putReq(body()))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Could not save that link')
    expect(logError).toHaveBeenCalledWith('api/schedule/class-instructors', 'link write failed', expect.objectContaining({ location_id: LOC, err: 'class_instructor_links upsert failed' }))
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run 'src/app/api/schedule/class-instructors/route.test.js'`
Expected: FAIL, `Failed to resolve import "./route.js"`.

- [ ] **Step 3: Write the route** at `src/app/api/schedule/class-instructors/route.js`:

```js
// CLASSLINK.1 — the class timetable's instructors at one studio, and which
// person on the team each one is.
//
// GET /api/schedule/class-instructors?location_id=<uuid>
//   Every instructor id the studio's class timetable (class_occurrences,
//   migs 284/636) named in the last 28 days or holds ahead, plus any already
//   linked: its class count, its three most common weekly slots (class name,
//   weekday, time in the studio's timezone), the name the booking system gave
//   it when there is one, and its link. Plus the studio's active team as link
//   options (id and name only).
// PUT /api/schedule/class-instructors
//   { location_id, source, external_id, profile_id | null } links one
//   instructor id to one ACTIVE member of that studio, or unlinks it.
//
// Gate (both): MANAGER_ROLES somewhere (403), a valid query/body (400),
// assertLocationAccess on the caller-supplied studio (403: a param route, as
// the templates route and GET /api/schedule/grid), then MANAGER_ROLES AT that
// studio (SCHEDROLES.1: never user.role).
//
// Names only. No capacity, no booked count, no contracted hours, no pay.
// Nothing here reaches members.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { normalizeInstructorRef, sourceLabel } from '@/lib/class-instructors'
import { ClassInstructorPutSchema, loadInstructorMapping, saveInstructorLink } from '@/lib/class-instructors-server'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({ location_id: uuidLike })
const UNAUTHORIZED = { success: false, error: 'Unauthorized' }
const NOT_MANAGER_THERE = { success: false, error: 'Forbidden — needs a manager role at that location' }

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json(UNAUTHORIZED, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({ location_id: url.searchParams.get('location_id') })
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  const { location_id } = parsed.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, location_id, MANAGER_ROLES)) {
    return NextResponse.json(NOT_MANAGER_THERE, { status: 403 })
  }

  const db = createServerClient()
  const { data, error } = await loadInstructorMapping(db, { locationId: location_id })
  if (error) {
    logError('api/schedule/class-instructors', 'mapping read failed', { location_id, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not load the timetable coaches' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json(UNAUTHORIZED, { status: 403 })
  }

  const validation = await validateBody(request, ClassInstructorPutSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, body.location_id, MANAGER_ROLES)) {
    return NextResponse.json(NOT_MANAGER_THERE, { status: 403 })
  }

  const externalId = normalizeInstructorRef(body.source, body.external_id)
  if (!externalId) {
    return NextResponse.json(
      { success: false, error: `That is not a valid ${sourceLabel(body.source)} instructor id` },
      { status: 400 },
    )
  }

  const db = createServerClient()
  const out = await saveInstructorLink(db, {
    locationId: body.location_id,
    source: body.source,
    externalId,
    profileId: body.profile_id,
    actorId: user.id,
  })
  if (!out.ok) {
    if (out.status >= 500) {
      logError('api/schedule/class-instructors', 'link write failed', { location_id: body.location_id, err: out.error })
      return NextResponse.json({ success: false, error: 'Could not save that link' }, { status: 500 })
    }
    return NextResponse.json({ success: false, error: out.error }, { status: out.status })
  }
  return NextResponse.json({ success: true, data: out.data })
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run 'src/app/api/schedule/class-instructors/route.test.js'`
Expected: PASS, 18 tests.

- [ ] **Step 5: The route checks**

Run: `npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns`
Expected: all exit 0 (`getCurrentUser` is the guard; the route queries no table directly, the IO pins `location_id` on every read and write; every literal column resolves against migs 004/051/284/344/622/636).

- [ ] **Step 6: Commit**

```bash
git add 'src/app/api/schedule/class-instructors/route.js' 'src/app/api/schedule/class-instructors/route.test.js'
git commit -m "CLASSLINK.1 — GET/PUT /api/schedule/class-instructors: managers at the studio see its timetable instructors and link each to an active team member

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

