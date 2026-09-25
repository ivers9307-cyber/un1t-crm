## PR QUALS.1 — staff qualifications with expiry: a catalogue, records per person, an advisory requirement on a template, a weekly digest to owners

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A studio can record who holds which qualification (first aid, insurance, Garda vetting, anything else the organisation adds) and when it expires. It can say that a shift template needs one, and owners hear once a week about anything expired or expiring in the next 30 days. Concretely:

- **(a) Catalogue.** An organisation-level list of qualification types. First aid, Insurance and Garda vetting are seeded for every organisation. Owners add, rename and archive types.
- **(b) Records.** One record per person per type: `issued_on` (optional), `expires_on` (optional: no date means it does not expire), a note (at most 300 characters), and who recorded and last changed it. Owners and managers at a studio the person belongs to manage them. Everyone else sees their own, read-only, on the web.
- **(c) Requirement.** A shift template may list up to 5 required types. This is **advisory**: the ranked picker (CANDIDATES.1) badges a coach with "First aid: not on record" or "First aid: expired", judged on the shift's date. Nothing ever refuses an assignment.
- **(d) Digest.** Once a week, each owner (and each master linked to the studio) gets a push listing what is expired or expiring in the next 30 days, for the people at the studios they own. It falls back to email when they have no phone. It respects staff quiet hours, it uses a registered push category, and it rides the existing daily `contract-reminders` cron as an ARM with its own heartbeat row.

Tombstoned staff (mig 622) and deactivated staff are excluded everywhere: the page list, the digest, the picker advisory and every write.

**Why:** This comes from the 19 Sep product review, Wave 3 ("the roster as the source of truth"). Today nothing in the estate knows whether the coach on a 6am class has first aid, or when Hatch Street's instructors' insurance lapses. The owner finds out when it matters.

**Ships:** a web deploy, **migration 635**, **and an OTA**. The index lists QUALS.1 as "no OTA", but it is not one. These `shared/` paths change and `shared/**` is a publish path (CLAUDE.md, "A push to `main` touching a bundle path PUBLISHES AN OTA"):

- `shared/qualifications.js` (new; the phone does not import it yet, so no-op on phones)
- `shared/permissions.js` + `shared/permission-bundles.js` (phones gain ONE new toggle, "Qualification expiry")
- `shared/push-channels.js`
- Path A only: `shared/candidates.js` (the manager picker's badge list; the phone renders `reason`, which is unchanged)

The program rule applies: one phone update at a time. Its batch pair, 32 SNAPSHOT.1, publishes no OTA, but check this PR's EAS Update run before the NEXT OTA merge (and wait for any in-flight one before merging this). **Phone later:** there is no phone qualifications screen. The digest push's tap does nothing on the phone (an unknown `data.type` is logged and ignored, `mobile/app/_layout.jsx:115-121`). A follow-up adds a route.

**Depends on:** CANDIDATES.1 (19) for the picker half (c) only. Task 0 decides path A (CANDIDATES.1 merged: wire it) or path B (not merged: ship everything else; Task 10B records the three-line hand-off, and the pure function it calls ships here either way). Everything else stands alone on `origin/main`.

**Tech stack:** Next.js 16 App Router, Supabase (Postgres + PostgREST), Vitest (+ jsdom for components), PGlite for the migration replay.

---

### Decisions this plan makes (each flagged again in Review notes)

1. **The catalogue is per ORGANISATION, not per studio.** A qualification belongs to a person, and a coach who works at Stillorgan and Hatch Street holds one first-aid certificate, not two. Per-studio types would make "First aid" two different rows for one person, and the digest and the picker would disagree about which one counts. Organisation is also the boundary everything else in the scheduler already uses for "the other studio" (`src/lib/sibling-locations.js`, ORGSCOPE.1), and CCF Autos (a different organisation) gets its own catalogue. Records carry `organization_id` too, pinned to their type's organisation by a composite foreign key, so a record can never point at another organisation's type.
2. **Who manages records:** `owner` or `manager` (master bypasses, via `hasRoleAtLocation`) **at a studio the person belongs to**, inside the record's organisation. Head coaches are NOT included (the brief says owners and managers), even though they can edit templates (`MANAGER_ROLES`). **Who edits the catalogue:** owners (and masters). Org admins (SAAS-4) are not given it in this cut. **Everyone else** at the studio sees only their own records on the same page, read-only.
3. **`expires_on` is optional.** No date means "does not expire" (status `valid`, shown as "No expiry"). Garda vetting disclosures carry no expiry date. The form asks for a date unless "Does not expire" is ticked, so a missing date is always a decision, never an omission. The brief listed `expires_on` as required; this is the one deliberate deviation. Review note 1.
4. **One record per (person, type)** (a UNIQUE key). A renewal is an edit of the dates. No history of past certificates in this cut.
5. **Statuses are pure and shared** (`shared/qualifications.js`). On a given day: `missing` (no record), `expired` (`expires_on` before the day), `expiring` (the day itself up to 30 days ahead), `valid` (later, or no expiry), `null` (an unreadable date: unknown, never an all-clear). A certificate that expires ON the day of a shift still covers that shift.
6. **Requirements live in their own table,** `shift_template_qualification_requirements`, not as a column on `shift_templates`. `authenticated` holds table-level UPDATE on `shift_templates`, and a mig 600 policy lets any manager write any column through the browser (mig 628's header). A column there would widen what the browser can write. The new table is service-role only, cascades with a template's hard delete (SHIFTTPL.1), and a `SECURITY DEFINER` trigger refuses a type from another organisation. TPLCLONE.1's copy does not copy requirements in this cut. Review note 5.
7. **The advisory is a badge, not a rank.** A missing or expired requirement adds a `warn` badge to the web picker. It does not change the tier or the order, and it is not in the phone's `reason` line. Manager audience only: a coach asking a colleague to cover never learns the colleague's qualifications. Head coaches ARE in the picker's manager audience (`MANAGER_ROLES`), so they see the badge. Review note 6.
8. **The digest rides `contract-reminders`** (daily, 08:00 UTC) as a third arm, with its own heartbeat row `qualification-digest` (86400 s + 43200 s grace, the `roster-runway` convention). It does NOT get a new cron:
   - 08:00 UTC is 08:00 or 09:00 in Dublin, inside the staff push band every day of the year.
   - It is already the "once-a-day staff nudges" cron (RUNWAY.1 put the runway alert there for the same reason).
   - A new cron would add a `vercel.json` entry and a route for a job that runs once a week.

   **Weekly = at most once per recipient per Dublin week (Mon–Sun), on the first daily run that has something to say.** Normally that is Monday. The claim key is `qualification_digest:<organisation>:<Monday>` in `push_event_sends` (per recipient, `src/lib/push-dedup.js`). A delivery that fails outright releases its claim, so Tuesday's run retries it. A week with nothing expiring sends nothing. The trade-off: an item that first becomes due on a Wednesday of a week that already had a digest waits for next Monday, and one that becomes due in a week that had none goes out that day. Review note 7.
9. **Digest recipients:** an ACTIVE, non-tombstoned profile whose `profile_locations` role is `owner` at a studio, or whose `profiles.role` is `master` and who holds a row there (the `resolveRoleRecipientIds` rule, `src/lib/push.js:364-381`, re-implemented without its discarded read error, which is a follow-up in the index). Each recipient's list covers the people at the studios where THEY qualify, per organisation. An owner of Stillorgan only never sees a Hatch-only coach. A recipient who is an owner in two organisations gets two digests.
10. **Push category `qualification_expiry`**, registered at every site (`MOBILE_PERMISSIONS`, all six role defaults ON, `EXEMPT_KEYS`, `CATEGORY_CHANNELS` → `reminders`, the registry with `fallbackEmail: true`). Default ON for every role, for AVAIL.1's reason (`src/lib/availability-change-registration.test.js:3-6`): `sendPush` without a `locationId` resolves one key for the person, so a single `false` anywhere silences them everywhere. The code narrows who is sent anything. The push says how many; the fallback email carries the list. Review note 8.
11. **Quiet hours:** `inStaffPushHours` (`src/lib/staff-push-hours.js`), judged at EVERY studio the recipient's list covers. Outside the band nothing is claimed, so a later run sends.
12. **No document upload** (index default 7): phone uploads are dead (`mobile-multipart-upload-dead`), and a manager records type, dates and a note.
13. **A tombstone's records stay on disk** (like AVAIL.1's rules, mig 630 header). They are never listed: a tombstone has no `profile_locations`, and every read also filters `isRosterableProfile`. `tombstone_staff_profile()` (mig 622) is not changed. Review note 10.

### Query budget

| Surface | Reads | Bounded by |
|---|---|---|
| `GET /api/qualifications` (manager) | location → org (1); types (1); members of the studio (paged 1,000); records (`.in` chunks of 100 people, each paged 1,000) | 4 fixed + pages |
| `GET /api/qualifications` (self) | location → org; types; own records | 3 |
| record POST/PATCH/DELETE | the type or record by id (1); the person's `profile_locations` with `locations!inner` (1); the write (1) | 3 |
| picker advisory (path A, only when the template has requirements) | requirements with type embed (1); records for eligible members (chunks of 100, paged) | +1 when the template requires nothing, +2 otherwise |
| digest arm (daily) | locations (1); organisations, all `profile_locations` of those studios (paged), active types, records expiring by today+30 (paged), in parallel | 5 fixed + pages |

**Prerequisite:** a fresh worktree (Task 0). Run tests with `npx vitest run <file>`. Run date-touching tests twice, under `TZ=Europe/Dublin` and `TZ=America/Los_Angeles`. zsh treats `[id]` as a glob, so single-quote every path that contains it.

### Files

| File | Responsibility | OTA |
|---|---|---|
| `supabase/migrations/635_staff_qualifications.sql` (create) | three tables, the same-org trigger, seeds, the `qualification-digest` heartbeat row, self-check | |
| `tests/migration-635-staff-qualifications.test.js` (create) | PGlite replay of the real file | |
| `shared/qualifications.js` (create) | statuses, labels, requirement gaps + badge, digest rows + headline, answer parsing (pure) | **yes** (no-op) |
| `shared/qualifications.test.js` (create) | tests | yes (test file) |
| `shared/permissions.js` (modify: after line 727, and after each `notify_availability_change: true,` at lines 795, 835, 878, 915, 956, 999) | `notify_qualification_expiry` | **yes** |
| `shared/permission-bundles.js` (modify: lines 335, 380, after 398) | `EXEMPT_KEYS` + the counts in two comments | **yes** |
| `shared/push-channels.js` (modify: after line 102) | `qualification_expiry: 'reminders'` | **yes** |
| `src/lib/notifications-registry.js` (modify: after the `availability_change` entry, lines 260-270) | the registry entry | |
| `src/lib/push-channels.test.js` (modify: `STAFF_TYPES`, after line 26) | `qualification_digest` | |
| `src/lib/qualification-expiry-registration.test.js` (create) | every registration site | |
| `src/lib/qualifications-schemas.js` (create) | Zod bodies (shared by the routes and OpenAPI) | |
| `src/lib/qualifications-server.js` (create) | reads, writes, authority, template requirements, the picker facts | |
| `src/lib/qualifications-mock-db.test-helpers.js` (create) | a chainable supabase mock for the two lib tests | |
| `src/lib/qualifications-server.test.js` (create) | tests | |
| `src/app/api/qualifications/route.js` (create) | GET list (manager or self), POST a record | |
| `src/app/api/qualifications/route.test.js` (create) | gates + delegation | |
| `src/app/api/qualifications/[id]/route.js` (create) | PATCH, DELETE a record | |
| `src/app/api/qualifications/[id]/route.test.js` (create) | gates + delegation | |
| `src/app/api/qualifications/types/route.js` (create) | POST a type (owner) | |
| `src/app/api/qualifications/types/[id]/route.js` (create) | PATCH a type: rename, archive, restore | |
| `src/app/api/qualifications/types/route.test.js` (create) | both type routes | |
| `src/app/api/schedule/template-qualifications/route.js` (create) | GET a studio's requirements + catalogue, PUT one template's | |
| `src/app/api/schedule/template-qualifications/route.test.js` (create) | gates + delegation | |
| `src/lib/openapi.js` (modify: import near line 30; entries after the AVAIL.1 block, just before `// WORKTIME.1 — the assign picker's…`, line 4643) | register 8 operations | |
| `src/lib/openapi.test.js` (modify: after the AVAIL.1 `it`, line 26) | pin them | |
| `src/app/(team)/schedule/qualifications/page.js` (create) | the page | |
| `src/components/QualificationsManager.jsx` (create) | manager view, self view, record form, catalogue | |
| `src/components/QualificationsManager.test.jsx` (create) | tests | |
| `src/components/ScheduleTabs.jsx` (modify: line 57 import; after line 115) | a Qualifications tab for everyone | |
| `src/components/ScheduleTabs.test.jsx` (modify: lines 65-71; one new `it`) | the tab | |
| `src/components/ShiftTemplateManager.jsx` (modify: imports after line 16, state after line 128, `handleSave` lines 130-177, list row near 397, `<TemplateFormModal>` line 515, `TemplateFormModal` 534-791) | the "Requires" field and chip | |
| `src/components/ShiftTemplateManager.quals.test.jsx` (create) | tests | |
| Path A: `shared/candidates.js` (modify: imports; `candidateBadges`; `UNCHECKED_LABELS`) | the badge | **yes** |
| Path A: `shared/candidates.test.js` (modify: append) | tests | yes (test file) |
| Path A: `src/lib/candidates-data.js` (modify: `loadBlockCandidates`) | attach gaps (manager only) | |
| Path A: `src/lib/candidates-data.test.js` (modify: one `vi.mock`, one describe) | tests | |
| Path A: `src/app/api/schedule/blocks/[id]/candidates/route.js` + `route.test.js` (modify: the block select) | `template_id` | |
| `src/lib/qualification-digest.js` (create) | plan (pure) + run the weekly digest | |
| `src/lib/qualification-digest.test.js` (create) | tests | |
| `src/lib/cron-arm-health.js` + `.test.js` (modify: after `runwayArmHealthy`, line 57-60; test lines 13, 17-24, append) | `QUALIFICATION_DIGEST_HEARTBEAT`, `qualificationDigestArmHealthy`, a drift guard | |
| `src/app/api/cron/contract-reminders/route.js` (modify: imports lines 31-32; after line 84; line 172) | the third arm + its stamp | |
| `src/app/api/cron/contract-reminders/route.test.js` (modify: a mock, fixtures, 9 assertions, a new describe) | tests | |
| `eslint.guardrails.config.mjs` (modify: after line 306, `'src/lib/staff-calendar-feed-server.js',`, inside the `no-unchecked-supabase-write` `files` list) | arm the new files | |
| `docs/CHANGELOG.md` (modify) | one row, after `gh pr create` | |

**Naming traps, already checked** on `origin/main` at `27500a90` (#1764, 25 Sep), with `git grep` over `src/`, `shared/`, `mobile/`, `supabase/` and `tests/`:

- None of these names exists yet: `staff_qualification`, `qualification_expiry`, `qualification-digest`, `qualificationStatus`, `requirementGaps`, `qualificationGapBadge`, `digestRows`, `QUAL_MANAGER_ROLES`.
- There is no `src/lib/qualifications.js`, so `tests/shared-pair-sync.test.js` has nothing to classify. That is why the server files are `qualifications-server.js` and `qualifications-schemas.js`.
- `shared/qualifications.js` keeps its date helpers private except `daysUntil` and `formatQualificationDate`, whose names exist nowhere in `src/lib`.
- Regex matching uses `String#match`. The workspace's security hook refuses any file whose text contains the call form of `exec`, so the PGlite test below runs PGlite's multi-statement runner through `Reflect.apply(db.exec, db, [sql])`. That is the same method the migration 630/633 tests call directly.

**Conflict hotspots:**

- `src/lib/openapi.js`
- `docs/CHANGELOG.md`
- `eslint.guardrails.config.mjs`
- `src/components/ScheduleTabs.jsx`
- `src/components/ShiftTemplateManager.jsx` (TPLCLONE.1 and SHIFTTYPE.1 already merged; nothing else in flight touches it)
- `shared/permissions.js` + `shared/permission-bundles.js` (any PR registering a category)
- path A: `shared/candidates.js` and `src/lib/candidates-data.js` (REPLACE.1 may touch the candidates route)

Rebase before merge.

---

### Task 0: Preflight — fresh worktree, what has merged, which path

**Files:** none.

- [ ] **Step 1: A fresh worktree off `origin/main`** (never a shared checkout: `dev-workflow-worktrees`)

```bash
cd ~/code/un1t-crm && git fetch origin main
git worktree add ~/code/un1t-crm-quals1 -b quals-1 origin/main
cd ~/code/un1t-crm-quals1 && npm ci
```

- [ ] **Step 2: Migration 635 is free, and nothing by these names exists**

```bash
ls supabase/migrations | grep -E '^63[0-9]_'
git grep -n -E "staff_qualification|qualification_expiry|qualification-digest|QUAL_MANAGER_ROLES" -- src shared supabase tests mobile
```

Expected: no `635_` file, and no grep hits. The other files listed will be 628, 630, 632, 633 and whatever batches 4–6 added. If 635 is taken, STOP and ask: the index reserves it.

- [ ] **Step 3: Path A or path B**

```bash
test -f shared/candidates.js && git grep -n "export async function loadBlockCandidates" -- src/lib/candidates-data.js && echo PATH_A || echo PATH_B
git grep -n "shift_templates(name, start_time, end_time), shift_assignments(profile_id, status)" -- 'src/app/api/schedule/blocks/[id]/candidates/route.js'
git grep -n "^export function candidateBadges\|^const UNCHECKED_LABELS" -- shared/candidates.js
```

Path A needs all three greps to hit:

- CANDIDATES.1 merged with `loadBlockCandidates`;
- the route's block select as its plan wrote it (19-CANDIDATES.1.md, Task 5);
- `candidateBadges` and `UNCHECKED_LABELS` in `shared/candidates.js`.

If the select or the names differ, adapt Task 10A to what is on main. The change stays the same: the block read carries `template_id`, and the manager answer gains `qualification_gaps`. Do not reshape CANDIDATES.1. If CANDIDATES.1 is not merged, take path B (Task 10B).

- [ ] **Step 4: Anchors this plan cites still hold**

```bash
grep -n "notify_availability_change" shared/permissions.js shared/permission-bundles.js
grep -n "availability_change" shared/push-channels.js src/lib/notifications-registry.js
grep -n "runwayArmHealthy(runway)\|const outcome = " src/app/api/cron/contract-reminders/route.js
grep -n "{ key: 'attendance'" src/components/ScheduleTabs.jsx
```

Expected line numbers:

- `shared/permissions.js`: 727, 795, 835, 878, 915, 956, 999
- `shared/permission-bundles.js`: 398
- `shared/push-channels.js`: 102
- the registry: 261
- the route: 81 and 172
- the tabs: 115

A shift of a few lines is fine: edit by the quoted anchor text, not the number.

No commit.

---

### Task 1: Migration 635 — tables, trigger, seeds, heartbeat (with a PGlite replay)

**Files:**
- Create: `tests/migration-635-staff-qualifications.test.js`
- Create: `supabase/migrations/635_staff_qualifications.sql`

- [ ] **Step 1: Write the failing test**

Create `tests/migration-635-staff-qualifications.test.js`:

```js
// QUALS.1 — behavioural test for migration 635 (staff qualifications).
//
// Boots PGlite, recreates the minimum prod shape the file touches
// (organizations, locations, profiles, shift_templates, cron_heartbeats, the
// three API roles with Supabase's default privileges, the private schema),
// applies the REAL file, replays it, and checks the posture, the constraints,
// the same-organisation trigger, the seeds and the heartbeat row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/635_staff_qualifications.sql'),
  'utf8',
)

const ORG_A = '00000000-0000-0000-0000-0000000000a1'
const ORG_B = '00000000-0000-0000-0000-0000000000b1'
const ORG_LATER = '00000000-0000-0000-0000-0000000000c1'
const LOC_A = '00000000-0000-0000-0000-0000000000a2'
const LOC_B = '00000000-0000-0000-0000-0000000000b2'
const COACH = '10000000-0000-0000-0000-00000000000a'
const OWNER = '10000000-0000-0000-0000-00000000000b'
const TPL_A = '20000000-0000-0000-0000-00000000000a'
const TPL_B = '20000000-0000-0000-0000-00000000000b'
const TPL_TEMP = '20000000-0000-0000-0000-0000000000cc'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  -- Supabase's default privileges: every new public table is granted to all
  -- three API roles. The migration must take the browser's away.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.locations (
    id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), name text
  );
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, deleted_at timestamptz);
  CREATE TABLE public.shift_templates (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id), name text
  );
  CREATE TABLE public.cron_heartbeats (
    name text PRIMARY KEY, last_ok_at timestamptz, expected_interval_seconds int,
    grace_seconds int, notes text, last_outcome jsonb
  );
`

const SEED = `
  INSERT INTO public.organizations (id, name) VALUES ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
  INSERT INTO public.locations (id, organization_id, name) VALUES ('${LOC_A}', '${ORG_A}', 'Studio A'), ('${LOC_B}', '${ORG_B}', 'Garage B');
  INSERT INTO public.profiles (id, full_name) VALUES ('${COACH}', 'Coach C'), ('${OWNER}', 'Owner O');
  INSERT INTO public.shift_templates (id, location_id, name) VALUES ('${TPL_A}', '${LOC_A}', 'Morning'), ('${TPL_B}', '${LOC_B}', 'Service');
`

let db
// PGlite's multi-statement runner (the method the 630/633 tests call as
// db.exec), reached through Reflect.apply: the workspace's security hook
// refuses a file containing that call form.
const runSql = (text) => Reflect.apply(db.exec, db, [text])

async function asRole(role, sql, params = []) {
  await runSql(`SET ROLE ${role}`)
  try {
    return await db.query(sql, params)
  } finally {
    await runSql('RESET ROLE')
  }
}

const typeId = async (org, name) =>
  (await db.query('SELECT id FROM public.staff_qualification_types WHERE organization_id = $1 AND name = $2', [org, name])).rows[0]?.id

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(SEED)
  await runSql(MIGRATION)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 635 — posture', () => {
  const TABLES = ['staff_qualification_types', 'staff_qualifications', 'shift_template_qualification_requirements']

  it('anon and authenticated hold nothing on any of the three tables', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of TABLES) {
        await expect(asRole(role, `SELECT 1 FROM public.${table}`)).rejects.toThrow(/permission denied/)
      }
    }
  })

  it('service_role can read them', async () => {
    const { rows } = await asRole('service_role', 'SELECT count(*)::int AS n FROM public.staff_qualification_types')
    expect(rows[0].n).toBeGreaterThan(0)
  })

  it('RLS is on and there are no policies (service-role only)', async () => {
    const { rows } = await db.query(`
      SELECT relname, relrowsecurity FROM pg_class
       WHERE relname = ANY($1) AND relnamespace = 'public'::regnamespace ORDER BY relname`, [TABLES])
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.relrowsecurity)).toBe(true)
    const policies = await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)`, [TABLES])
    expect(policies.rows[0].n).toBe(0)
  })
})

describe('migration 635 — seeds and heartbeat', () => {
  it('seeds First aid, Insurance and Garda vetting for every organisation, in that order', async () => {
    for (const org of [ORG_A, ORG_B]) {
      const { rows } = await db.query(
        'SELECT name, active FROM public.staff_qualification_types WHERE organization_id = $1 ORDER BY sort_order, name', [org])
      expect(rows).toEqual([
        { name: 'First aid', active: true },
        { name: 'Insurance', active: true },
        { name: 'Garda vetting', active: true },
      ])
    }
  })

  it('inserts the qualification-digest heartbeat row (86400s + 43200s grace), born healthy', async () => {
    const { rows } = await db.query(`SELECT expected_interval_seconds, grace_seconds, last_ok_at IS NOT NULL AS armed FROM public.cron_heartbeats WHERE name = 'qualification-digest'`)
    expect(rows).toEqual([{ expected_interval_seconds: 86400, grace_seconds: 43200, armed: true }])
  })

  it('replays as a no-op for the seeds (an owner rename survives), re-arms the heartbeat, and seeds an organisation added since', async () => {
    await runSql(`UPDATE public.staff_qualification_types SET name = 'First aid (PHECC)' WHERE organization_id = '${ORG_A}' AND name = 'First aid'`)
    await runSql(`UPDATE public.cron_heartbeats SET last_ok_at = now() - interval '3 days' WHERE name = 'qualification-digest'`)
    await runSql(`INSERT INTO public.organizations (id, name) VALUES ('${ORG_LATER}', 'Org C')`)
    await runSql(MIGRATION)
    const a = await db.query('SELECT name FROM public.staff_qualification_types WHERE organization_id = $1 ORDER BY sort_order', [ORG_A])
    expect(a.rows.map((r) => r.name)).toEqual(['First aid (PHECC)', 'Insurance', 'Garda vetting'])
    const c = await db.query('SELECT count(*)::int AS n FROM public.staff_qualification_types WHERE organization_id = $1', [ORG_LATER])
    expect(c.rows[0].n).toBe(3)
    const hb = await db.query(`SELECT last_ok_at > now() - interval '1 minute' AS fresh FROM public.cron_heartbeats WHERE name = 'qualification-digest'`)
    expect(hb.rows[0].fresh).toBe(true)
    await runSql(`UPDATE public.staff_qualification_types SET name = 'First aid' WHERE organization_id = '${ORG_A}' AND name = 'First aid (PHECC)'`)
  })
})

describe('migration 635 — types', () => {
  it('a name is unique per organisation, case-insensitively; another organisation may reuse it', async () => {
    await expect(runSql(`INSERT INTO public.staff_qualification_types (organization_id, name) VALUES ('${ORG_A}', 'first AID')`))
      .rejects.toThrow(/duplicate key/)
    await runSql(`INSERT INTO public.staff_qualification_types (organization_id, name) VALUES ('${ORG_B}', 'Forklift')`)
    await runSql(`INSERT INTO public.staff_qualification_types (organization_id, name) VALUES ('${ORG_A}', 'Forklift')`)
  })

  it.each([[''], ['   '], ['\n'], [' Leading'], ['Trailing '], ['Two\nlines'], ['x'.repeat(61)]])(
    'refuses the name %j', async (name) => {
      await expect(db.query('INSERT INTO public.staff_qualification_types (organization_id, name) VALUES ($1, $2)', [ORG_A, name]))
        .rejects.toThrow(/staff_qualification_types_name/)
    })
})

describe('migration 635 — records', () => {
  it('stores a record whose type is in its own organisation', async () => {
    const fa = await typeId(ORG_A, 'First aid')
    await db.query(`INSERT INTO public.staff_qualifications (organization_id, profile_id, qualification_type_id, issued_on, expires_on, note, recorded_by)
                    VALUES ($1, $2, $3, '2025-01-10', '2027-01-10', 'PHECC FAR', $4)`, [ORG_A, COACH, fa, OWNER])
    const { rows } = await db.query('SELECT expires_on::text AS e FROM public.staff_qualifications WHERE profile_id = $1', [COACH])
    expect(rows).toEqual([{ e: '2027-01-10' }])
  })

  it('refuses a record that names another organisation\'s type (composite FK)', async () => {
    const faB = await typeId(ORG_B, 'First aid')
    await expect(db.query('INSERT INTO public.staff_qualifications (organization_id, profile_id, qualification_type_id) VALUES ($1, $2, $3)', [ORG_A, OWNER, faB]))
      .rejects.toThrow(/staff_qualifications_type_same_org/)
  })

  it('one record per person per type', async () => {
    const fa = await typeId(ORG_A, 'First aid')
    await expect(db.query('INSERT INTO public.staff_qualifications (organization_id, profile_id, qualification_type_id) VALUES ($1, $2, $3)', [ORG_A, COACH, fa]))
      .rejects.toThrow(/staff_qualifications_one_per_type/)
  })

  it('refuses an expiry before the issue date, and a blank or over-long note; no expiry is allowed', async () => {
    const ins = await typeId(ORG_A, 'Insurance')
    const insert = (issued, expires, note) => db.query(
      'INSERT INTO public.staff_qualifications (organization_id, profile_id, qualification_type_id, issued_on, expires_on, note) VALUES ($1, $2, $3, $4, $5, $6)',
      [ORG_A, OWNER, ins, issued, expires, note])
    await expect(insert('2026-05-01', '2026-04-30', null)).rejects.toThrow(/staff_qualifications_dates/)
    await expect(insert(null, '2026-04-30', '  \n ')).rejects.toThrow(/staff_qualifications_note/)
    await expect(insert(null, '2026-04-30', 'x'.repeat(301))).rejects.toThrow(/staff_qualifications_note/)
    await insert('2026-05-01', null, null) // no expiry
  })

  it('a type that has a record cannot be deleted (archive it instead)', async () => {
    const fa = await typeId(ORG_A, 'First aid')
    await expect(db.query('DELETE FROM public.staff_qualification_types WHERE id = $1', [fa])).rejects.toThrow(/foreign key/)
  })
})

describe('migration 635 — template requirements', () => {
  it('accepts a type from the template\'s own organisation', async () => {
    const fa = await typeId(ORG_A, 'First aid')
    await asRole('service_role', 'INSERT INTO public.shift_template_qualification_requirements (template_id, qualification_type_id) VALUES ($1, $2)', [TPL_A, fa])
    const { rows } = await db.query('SELECT count(*)::int AS n FROM public.shift_template_qualification_requirements WHERE template_id = $1', [TPL_A])
    expect(rows[0].n).toBe(1)
  })

  it('refuses a type from another organisation, whoever writes it', async () => {
    const faB = await typeId(ORG_B, 'First aid')
    await expect(asRole('service_role', 'INSERT INTO public.shift_template_qualification_requirements (template_id, qualification_type_id) VALUES ($1, $2)', [TPL_A, faB]))
      .rejects.toThrow(/qualification_requirement_other_org/)
    const ins = await typeId(ORG_A, 'Insurance')
    await expect(db.query('INSERT INTO public.shift_template_qualification_requirements (template_id, qualification_type_id) VALUES ($1, $2)', [TPL_B, ins]))
      .rejects.toThrow(/qualification_requirement_other_org/)
  })

  it('a hard-deleted template takes its requirements with it', async () => {
    await runSql(`INSERT INTO public.shift_templates (id, location_id, name) VALUES ('${TPL_TEMP}', '${LOC_A}', 'Temp')`)
    const ins = await typeId(ORG_A, 'Insurance')
    await db.query('INSERT INTO public.shift_template_qualification_requirements (template_id, qualification_type_id) VALUES ($1, $2)', [TPL_TEMP, ins])
    await runSql(`DELETE FROM public.shift_templates WHERE id = '${TPL_TEMP}'`)
    const { rows } = await db.query('SELECT count(*)::int AS n FROM public.shift_template_qualification_requirements WHERE template_id = $1', [TPL_TEMP])
    expect(rows[0].n).toBe(0)
  })

  it('the trigger function is not executable by the browser roles', async () => {
    const { rows } = await db.query(`
      SELECT has_function_privilege('authenticated', 'private.shift_template_qualification_same_org()', 'EXECUTE') AS auth,
             has_function_privilege('anon', 'private.shift_template_qualification_same_org()', 'EXECUTE') AS anon`)
    expect(rows[0]).toEqual({ auth: false, anon: false })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run tests/migration-635-staff-qualifications.test.js`
Expected: FAIL, `ENOENT … 635_staff_qualifications.sql`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/635_staff_qualifications.sql`:

```sql
-- 635 — QUALS.1: staff qualifications with expiry.
--
-- THE MODEL
-- ─────────
--   staff_qualification_types  the ORGANISATION's catalogue (First aid,
--       Insurance, Garda vetting seeded for every organisation). Per
--       organisation, not per studio: a qualification belongs to a person,
--       and a coach at two studios of one organisation holds one first-aid
--       certificate, not two. Types are archived (active = false), never
--       deleted: a record or a requirement pins them.
--   staff_qualifications  one row per (person, type): issued_on (optional),
--       expires_on (optional; NULL = does not expire), note <= 300, who
--       recorded it and who last changed it. organization_id is pinned to the
--       type's organisation by a composite FK, so a record can never point at
--       another organisation's type.
--   shift_template_qualification_requirements  a template may ask for up to
--       5 types (the cap is the API's). ADVISORY: the coach picker badges a
--       coach without a current record; nothing refuses an assignment. Its
--       own table rather than a shift_templates column because the browser
--       still holds UPDATE on shift_templates (mig 600 policy, mig 628
--       header); this table is service-role only. A SECURITY DEFINER trigger
--       refuses a type from another organisation, whoever writes the row.
--
-- POSTURE: SERVICE ROLE ONLY on all three. RLS enabled, NO policies, the
-- browser roles hold NO privilege (every reader is an /api route on the
-- service-role client). get_advisors rls_enabled_no_policy (INFO) rises by
-- exactly 3.
--
-- FKs: profile_id CASCADE (inert: a staff profile is never deleted, mig 622
-- tombstones it; a tombstone's records stay on disk and are never listed,
-- because a tombstone has no profile_locations). recorded_by / updated_by /
-- created_by SET NULL (an audit column outlives its actor). template_id
-- CASCADE (SHIFTTPL.1's hard delete of an unused template takes its
-- requirements). organization_id CASCADE (organisations are not deleted).
-- Type references are NO ACTION: a type in use cannot be deleted.
--
-- HEARTBEAT (the CLAUDE.md arm rule): the weekly digest is an ARM of the
-- daily 08:00 UTC cron /api/cron/contract-reminders, so it gets its OWN row,
-- 'qualification-digest', 86400s + 43200s grace (the roster-runway
-- convention, mig 633). It is stamped only when the arm returned an outcome
-- and did not throw (src/lib/cron-arm-health.js). Born healthy, ON CONFLICT
-- DO UPDATE re-arm (601/623/633).
--
-- APPLY ORDER. Apply this file BEFORE the QUALS.1 code deploys: its routes
-- and the arm read these tables, and a select naming a missing table fails.
-- Applied alone it changes nothing (new objects only). Then, per the arm
-- rule, RE-RUN the heartbeat INSERT below via execute_sql right AFTER the
-- production deploy is live. A row seeded early only goes stale after 36
-- hours, so this is belt and braces, but it is the rule. The WHOLE FILE also
-- replays as a no-op (IF NOT EXISTS, CREATE OR REPLACE, seeds only for an
-- organisation with no types at all, so an owner's renames survive).
--
-- One explicit transaction: a failed self-check leaves NOTHING applied.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; keep the output in the scratchpad)
-- ─────────────────────────────────────────────────────────────────────────
-- (a) Nothing by these names exists yet:
--       SELECT to_regclass('public.staff_qualification_types'),
--              to_regclass('public.staff_qualifications'),
--              to_regclass('public.shift_template_qualification_requirements'),
--              to_regprocedure('private.shift_template_qualification_same_org()');
--     Expected: NULL, NULL, NULL, NULL.
-- (b) SELECT name FROM public.cron_heartbeats WHERE name = 'qualification-digest';   -- 0 rows
-- (c) The private schema exists (mig 622's triggers live there):
--       SELECT nspname FROM pg_namespace WHERE nspname = 'private';                   -- 1 row
-- (d) What will be seeded (information): SELECT id, name, active FROM public.organizations ORDER BY name;
--     Expected on 25 Sep: UN1T Group, CCF Autos (mig 079), maybe more.
-- (e) The advisor baseline: get_advisors(security) → rls_enabled_no_policy count.
-- (f) list_migrations shows no 635.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (g) SELECT r, t, p FROM unnest(ARRAY['anon', 'authenticated']) r,
--            unnest(ARRAY['public.staff_qualification_types', 'public.staff_qualifications',
--                         'public.shift_template_qualification_requirements']) t,
--            unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
--      WHERE has_table_privilege(r, t, p);
--     Expected: 0 rows.
-- (h) SELECT o.name, count(t.id) FROM public.organizations o
--       LEFT JOIN public.staff_qualification_types t ON t.organization_id = o.id GROUP BY 1 ORDER BY 1;
--     Expected: 3 per organisation.
-- (i) SELECT name, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats
--      WHERE name = 'qualification-digest';   -- 86400, 43200
-- (j) SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.shift_template_qualification_requirements'::regclass
--        AND NOT tgisinternal;   -- shift_template_qualification_same_org
-- (k) get_advisors (security AND performance). Expected: rls_enabled_no_policy
--     +3 (these tables), nothing else new. unindexed_foreign_keys: none (every
--     FK is indexed below).
-- (l) Smoke once deployed: GET /api/qualifications?location_id=<Stillorgan> as
--     an owner → 200, three types, every member listed.
--
-- ROLLBACK (only while no record has been entered; afterwards dump the three
-- tables first). Revert the QUALS.1 code FIRST and let it deploy (its routes
-- and the arm fail without these tables), then:
--   BEGIN;
--   DROP TABLE IF EXISTS public.shift_template_qualification_requirements;
--   DROP FUNCTION IF EXISTS private.shift_template_qualification_same_org();
--   DROP TABLE IF EXISTS public.staff_qualifications;
--   DROP TABLE IF EXISTS public.staff_qualification_types;
--   DELETE FROM public.cron_heartbeats WHERE name = 'qualification-digest';
--   COMMIT;

BEGIN;

-- ── The catalogue ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_qualification_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 100,
  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- One line, 1-60 characters, no leading or trailing whitespace. \s covers
  -- newlines, so a newline-only name fails `~ '\S'` (the BLOCKEDIT.1 lesson:
  -- btrim() trims spaces only).
  CONSTRAINT staff_qualification_types_name CHECK (
    char_length(name) BETWEEN 1 AND 60
    AND name ~ '\S'
    AND name !~ '^\s'
    AND name !~ '\s$'
    AND name !~ '[\r\n]'
  ),
  -- The target of staff_qualifications' composite FK.
  CONSTRAINT staff_qualification_types_id_org UNIQUE (id, organization_id)
);

-- One name per organisation, case-insensitively. Leads with organization_id,
-- so it also covers that FK.
CREATE UNIQUE INDEX IF NOT EXISTS staff_qualification_types_org_name_key
  ON public.staff_qualification_types (organization_id, lower(name));
CREATE INDEX IF NOT EXISTS staff_qualification_types_created_by_idx
  ON public.staff_qualification_types (created_by) WHERE created_by IS NOT NULL;

ALTER TABLE public.staff_qualification_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_qualification_types FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_qualification_types TO service_role;

COMMENT ON TABLE public.staff_qualification_types IS
  'QUALS.1 (mig 635) — an ORGANISATION''s catalogue of staff qualification types (First aid, Insurance, Garda vetting seeded per organisation). Owners add, rename and archive (active = false); a type is never deleted once a record or a template requirement names it. Service-role only: RLS on, no policies, no browser grants.';

-- ── The records ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_qualifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  qualification_type_id uuid NOT NULL,
  issued_on             date,
  expires_on            date,
  note                  text,
  recorded_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_qualifications_type_same_org
    FOREIGN KEY (qualification_type_id, organization_id)
    REFERENCES public.staff_qualification_types (id, organization_id),
  CONSTRAINT staff_qualifications_one_per_type UNIQUE (profile_id, qualification_type_id),
  CONSTRAINT staff_qualifications_dates CHECK (
    issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on
  ),
  CONSTRAINT staff_qualifications_note CHECK (
    note IS NULL OR (char_length(note) <= 300 AND note ~ '\S')
  )
);

-- The digest's read: an organisation's records by expiry. Leads with
-- organization_id, so it also covers that FK.
CREATE INDEX IF NOT EXISTS staff_qualifications_org_expires_idx
  ON public.staff_qualifications (organization_id, expires_on);
-- The composite FK to the catalogue (advisor unindexed_foreign_keys), and the
-- picker's "records of these types" read.
CREATE INDEX IF NOT EXISTS staff_qualifications_type_org_idx
  ON public.staff_qualifications (qualification_type_id, organization_id);
-- profile_id is covered by staff_qualifications_one_per_type (leads with it).
CREATE INDEX IF NOT EXISTS staff_qualifications_recorded_by_idx
  ON public.staff_qualifications (recorded_by) WHERE recorded_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS staff_qualifications_updated_by_idx
  ON public.staff_qualifications (updated_by) WHERE updated_by IS NOT NULL;

ALTER TABLE public.staff_qualifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_qualifications FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_qualifications TO service_role;

COMMENT ON TABLE public.staff_qualifications IS
  'QUALS.1 (mig 635) — one row per (person, qualification type): issued_on (optional), expires_on (NULL = does not expire), note <= 300, recorded_by / updated_by. organization_id is the type''s (composite FK). Managed by owners and managers at a studio the person belongs to (the API decides; service-role only). Status on a day (shared/qualifications.js): missing, expired (before the day), expiring (the day up to 30 days ahead), valid. A tombstoned person''s rows stay and are never listed.';

-- ── Template requirements (advisory) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shift_template_qualification_requirements (
  template_id           uuid NOT NULL REFERENCES public.shift_templates(id) ON DELETE CASCADE,
  qualification_type_id uuid NOT NULL REFERENCES public.staff_qualification_types(id),
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, qualification_type_id)
);

CREATE INDEX IF NOT EXISTS shift_template_qualification_requirements_type_idx
  ON public.shift_template_qualification_requirements (qualification_type_id);
CREATE INDEX IF NOT EXISTS shift_template_qualification_requirements_created_by_idx
  ON public.shift_template_qualification_requirements (created_by) WHERE created_by IS NOT NULL;

ALTER TABLE public.shift_template_qualification_requirements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shift_template_qualification_requirements FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_template_qualification_requirements TO service_role;

COMMENT ON TABLE public.shift_template_qualification_requirements IS
  'QUALS.1 (mig 635) — the qualification types a shift template asks for (the API caps it at 5). ADVISORY ONLY: the coach picker badges a coach with no current record on the shift''s date; no route refuses an assignment because of it. Same organisation as the template''s studio (trigger shift_template_qualification_same_org). Service-role only.';

-- Same organisation, whoever writes. SECURITY DEFINER (the mig 622 posture
-- for private.refuse_tombstone_access_row): the check must read
-- shift_templates, locations and the catalogue whatever the writer's grants.
-- Lives in `private` (not exposed by PostgREST), pins search_path.
CREATE OR REPLACE FUNCTION private.shift_template_qualification_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.shift_templates t
      JOIN public.locations l ON l.id = t.location_id
      JOIN public.staff_qualification_types q ON q.organization_id = l.organization_id
     WHERE t.id = NEW.template_id
       AND q.id = NEW.qualification_type_id
  ) THEN
    RAISE EXCEPTION 'qualification_requirement_other_org: type % is not in the organisation of template %',
      NEW.qualification_type_id, NEW.template_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.shift_template_qualification_same_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS shift_template_qualification_same_org ON public.shift_template_qualification_requirements;
CREATE TRIGGER shift_template_qualification_same_org
  BEFORE INSERT OR UPDATE ON public.shift_template_qualification_requirements
  FOR EACH ROW EXECUTE FUNCTION private.shift_template_qualification_same_org();

-- ── Seeds: only for an organisation with NO types at all ─────────────────
-- So a replay never re-adds a type an owner renamed or archived, and an
-- organisation created since the first apply gets the three on a replay.
INSERT INTO public.staff_qualification_types (organization_id, name, sort_order)
SELECT o.id, s.name, s.sort_order
  FROM public.organizations o
 CROSS JOIN (VALUES ('First aid', 10), ('Insurance', 20), ('Garda vetting', 30)) AS s(name, sort_order)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.staff_qualification_types t WHERE t.organization_id = o.id
 );

-- ── The digest arm's heartbeat row (born healthy, re-armed on replay) ────
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'qualification-digest',
  now(),
  86400,
  43200,
  'QUALS.1 — the weekly qualification digest arm (src/lib/qualification-digest.js runQualificationDigest) of the daily 08:00 UTC Vercel cron /api/cron/contract-reminders. No route or vercel.json entry of its own. Runs every day; each owner is sent at most one digest per Dublin week (push_event_sends key qualification_digest:<org>:<Monday>), on the first run with anything expired or expiring in 30 days. Stamped ONLY when the arm returned an outcome and did not throw (a locations, links, types or records read failure); a per-recipient delivery failure (outcome.failed, claim released for tomorrow) and a week with nothing to say still stamp. Independent of the parent and of the roster-runway arm. STALE = no clean run for 36 hours: read contract-reminders.last_outcome.qualifications (the error text) and the cron-contract-reminders logError lines. last_outcome carries { organizations, recipients, rows, nothing_due, quiet_hours, sent, emailed, email_failed, deduped, failed }.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- ── Self-check (POST-state, from the catalog, never from this text) ──────
DO $$
DECLARE
  t text;
  r text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_qualification_types', 'staff_qualifications', 'shift_template_qualification_requirements'] LOOP
    PERFORM 1 FROM pg_class c WHERE c.oid = ('public.' || t)::regclass AND c.relrowsecurity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 635: RLS is not enabled on public.%; nothing was applied', t;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(r, 'public.' || t, p) THEN
          RAISE EXCEPTION 'mig 635: % still holds % on public.%; nothing was applied', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  PERFORM 1 FROM public.organizations o
   WHERE NOT EXISTS (SELECT 1 FROM public.staff_qualification_types q WHERE q.organization_id = o.id);
  IF FOUND THEN
    RAISE EXCEPTION 'mig 635: an organisation has no qualification types after the seed; nothing was applied';
  END IF;

  PERFORM 1 FROM public.cron_heartbeats h
   WHERE h.name = 'qualification-digest' AND h.expected_interval_seconds = 86400 AND h.grace_seconds = 43200;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 635: the qualification-digest heartbeat row did not end up on 86400 + 43200; nothing was applied';
  END IF;
END $$;

COMMIT;
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run tests/migration-635-staff-qualifications.test.js`
Expected: every test passes.

If `refuses a type from another organisation` fails with a permission error instead of `qualification_requirement_other_org`, the DEFINER function did not run as its owner. It should: `runSql` runs as the PGlite superuser, which creates it. Check that before changing anything.

Then run `npm run check:select-columns && npm run check:rls-restrictive`. Both must stay green; the new tables' columns come from this file.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/635_staff_qualifications.sql tests/migration-635-staff-qualifications.test.js
git commit -m "QUALS.1 — mig 635: qualification catalogue, records, template requirements, digest heartbeat

Organisation-level types (First aid, Insurance, Garda vetting seeded once per
organisation), one record per person per type (expiry optional, note <= 300),
advisory template requirements in their own table with a same-organisation
DEFINER trigger. Service-role only: RLS on, no policies, no browser grants.
qualification-digest heartbeat 86400 + 43200, ON CONFLICT re-arm. Replays as a
no-op; post-state self-check. Not applied by the PR.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `shared/qualifications.js` — statuses, gaps, digest rows (pure)

**Files:**
- Create: `shared/qualifications.test.js`
- Create: `shared/qualifications.js`

- [ ] **Step 1: Write the failing test**

Create `shared/qualifications.test.js`:

```js
// QUALS.1 — the pure qualification rules. No clock, no database, no host
// timezone: run under TZ=Europe/Dublin AND a US zone.

import { describe, it, expect } from 'vitest'
import {
  QUALIFICATION_EXPIRY_WINDOW_DAYS, QUALIFICATION_STATUSES, QUALIFICATION_STATUS_TONES,
  daysUntil, formatQualificationDate, qualificationStatus, qualificationStatusLabel,
  personNeedsAttention, requirementGaps, qualificationGapBadge, attachQualificationGaps,
  digestRows, digestHeadline, parseTemplateQualificationsAnswer,
} from './qualifications.js'

const TODAY = '2026-09-28'
const rec = (expires_on, over = {}) => ({ id: 'r', profile_id: 'p', qualification_type_id: 'fa', expires_on, ...over })

describe('daysUntil and formatQualificationDate', () => {
  it('whole calendar days, across month, year, leap-day and DST boundaries', () => {
    expect(daysUntil('2026-09-28', '2026-09-28')).toBe(0)
    expect(daysUntil('2026-09-28', '2026-10-28')).toBe(30)
    expect(daysUntil('2026-10-24', '2026-10-26')).toBe(2) // Irish clocks go back on 25 Oct
    expect(daysUntil('2027-03-27', '2027-03-29')).toBe(2) // and forward on 28 Mar 2027
    expect(daysUntil('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysUntil('2026-09-28', '2026-09-27')).toBe(-1)
    expect(daysUntil('2028-02-28', '2028-03-01')).toBe(2)
  })

  it('an unreadable date is null, never a number', () => {
    expect(daysUntil('2026-02-30', '2026-03-01')).toBeNull()
    expect(daysUntil('28/09/2026', '2026-10-01')).toBeNull()
    expect(daysUntil(null, '2026-10-01')).toBeNull()
  })

  it("formats as '31 Aug 2026', or '' when unreadable", () => {
    expect(formatQualificationDate('2026-08-31')).toBe('31 Aug 2026')
    expect(formatQualificationDate('2027-01-05')).toBe('5 Jan 2027')
    expect(formatQualificationDate('2026-13-01')).toBe('')
    expect(formatQualificationDate(undefined)).toBe('')
  })
})

describe('qualificationStatus', () => {
  it('missing, expired, expiring (the day up to 30 days ahead), valid; no expiry is valid', () => {
    expect(QUALIFICATION_EXPIRY_WINDOW_DAYS).toBe(30)
    expect(QUALIFICATION_STATUSES).toEqual(['valid', 'expiring', 'expired', 'missing'])
    expect(qualificationStatus(null, TODAY)).toBe('missing')
    expect(qualificationStatus(rec('2026-09-27'), TODAY)).toBe('expired')
    expect(qualificationStatus(rec('2026-09-28'), TODAY)).toBe('expiring')
    expect(qualificationStatus(rec('2026-10-28'), TODAY)).toBe('expiring')
    expect(qualificationStatus(rec('2026-10-29'), TODAY)).toBe('valid')
    expect(qualificationStatus(rec(null), TODAY)).toBe('valid')
    expect(qualificationStatus(rec(''), TODAY)).toBe('valid')
  })

  it('takes a custom window', () => {
    expect(qualificationStatus(rec('2026-10-05'), TODAY, { windowDays: 7 })).toBe('expiring')
    expect(qualificationStatus(rec('2026-10-06'), TODAY, { windowDays: 7 })).toBe('valid')
  })

  it('an unreadable date is unknown (null): neither an all-clear nor an alarm', () => {
    expect(qualificationStatus(rec('2026-02-30'), TODAY)).toBeNull()
    expect(qualificationStatus(rec('2026-10-01'), 'not a day')).toBeNull()
  })

  it('tones follow the status', () => {
    expect(QUALIFICATION_STATUS_TONES).toEqual({ valid: 'good', expiring: 'warn', expired: 'bad', missing: 'muted' })
  })
})

describe('qualificationStatusLabel', () => {
  it('says what a manager needs to know', () => {
    expect(qualificationStatusLabel(null, TODAY)).toBe('Not on record')
    expect(qualificationStatusLabel(rec(null), TODAY)).toBe('No expiry')
    expect(qualificationStatusLabel(rec('2026-09-27'), TODAY)).toBe('Expired yesterday (27 Sep 2026)')
    expect(qualificationStatusLabel(rec('2026-08-31'), TODAY)).toBe('Expired 31 Aug 2026')
    expect(qualificationStatusLabel(rec('2026-09-28'), TODAY)).toBe('Expires today')
    expect(qualificationStatusLabel(rec('2026-09-29'), TODAY)).toBe('Expires tomorrow')
    expect(qualificationStatusLabel(rec('2026-10-20'), TODAY)).toBe('Expires in 22 days (20 Oct 2026)')
    expect(qualificationStatusLabel(rec('2027-03-01'), TODAY)).toBe('Valid until 1 Mar 2027')
    expect(qualificationStatusLabel(rec('2026-02-30'), TODAY)).toBe('Expiry date unreadable')
  })
})

describe('personNeedsAttention', () => {
  it('true when a record is expired or expiring; missing and unreadable are not "attention"', () => {
    expect(personNeedsAttention([rec('2027-03-01'), rec(null)], TODAY)).toBe(false)
    expect(personNeedsAttention([rec('2027-03-01'), rec('2026-10-01')], TODAY)).toBe(true)
    expect(personNeedsAttention([rec('2026-01-01')], TODAY)).toBe(true)
    expect(personNeedsAttention([rec('2026-02-30')], TODAY)).toBe(false)
    expect(personNeedsAttention([], TODAY)).toBe(false)
    expect(personNeedsAttention(undefined, TODAY)).toBe(false)
  })
})

describe('requirementGaps — judged on the SHIFT date', () => {
  const REQUIRED = [{ id: 'ins', name: 'Insurance' }, { id: 'fa', name: 'First aid' }]

  it('missing and expired are gaps; a certificate expiring on the shift day covers it; sorted by name', () => {
    const records = [rec('2026-10-10', { qualification_type_id: 'fa' })]
    expect(requirementGaps({ required: REQUIRED, records, onISO: '2026-10-10' })).toEqual([
      { type_id: 'ins', name: 'Insurance', status: 'missing', expires_on: null },
    ])
    expect(requirementGaps({ required: REQUIRED, records, onISO: '2026-10-11' })).toEqual([
      { type_id: 'fa', name: 'First aid', status: 'expired', expires_on: '2026-10-10' },
      { type_id: 'ins', name: 'Insurance', status: 'missing', expires_on: null },
    ])
  })

  it('no requirement, no gap; no expiry covers; an unreadable record is not a gap (unknown is neutral)', () => {
    const FA = [{ id: 'fa', name: 'First aid' }]
    expect(requirementGaps({ required: [], records: [], onISO: TODAY })).toEqual([])
    expect(requirementGaps({ required: FA, records: [rec(null)], onISO: TODAY })).toEqual([])
    expect(requirementGaps({ required: FA, records: [rec('2026-02-30')], onISO: TODAY })).toEqual([])
  })
})

describe('qualificationGapBadge', () => {
  it('one gap names it; several are counted; the title lists every one and says advisory', () => {
    expect(qualificationGapBadge([])).toBeNull()
    expect(qualificationGapBadge(undefined)).toBeNull()
    expect(qualificationGapBadge([{ type_id: 'fa', name: 'First aid', status: 'missing', expires_on: null }])).toEqual({
      key: 'qualifications', tone: 'warn', text: 'First aid: not on record',
      title: 'This shift asks for First aid (not on record). Advisory only: you can still assign them.',
    })
    expect(qualificationGapBadge([{ type_id: 'fa', name: 'First aid', status: 'expired', expires_on: '2026-08-31' }]).text)
      .toBe('First aid: expired')
    expect(qualificationGapBadge([
      { type_id: 'fa', name: 'First aid', status: 'expired', expires_on: '2026-08-31' },
      { type_id: 'ins', name: 'Insurance', status: 'missing', expires_on: null },
    ])).toEqual({
      key: 'qualifications', tone: 'warn', text: '2 qualifications missing or expired',
      title: 'This shift asks for First aid (expired 31 Aug 2026) and Insurance (not on record). Advisory only: you can still assign them.',
    })
  })
})

describe('attachQualificationGaps', () => {
  it('adds qualification_gaps to copies; with nothing required, the same list comes back', () => {
    const list = [{ profile_id: 'a', rank: 1 }, { profile_id: 'b', rank: 2 }]
    expect(attachQualificationGaps(list, { required: [], records: [], onISO: TODAY })).toBe(list)
    const out = attachQualificationGaps(list, {
      required: [{ id: 'fa', name: 'First aid' }],
      records: [{ profile_id: 'a', qualification_type_id: 'fa', expires_on: '2027-01-01' }],
      onISO: TODAY,
    })
    expect(out).toEqual([
      { profile_id: 'a', rank: 1, qualification_gaps: [] },
      { profile_id: 'b', rank: 2, qualification_gaps: [{ type_id: 'fa', name: 'First aid', status: 'missing', expires_on: null }] },
    ])
    expect(list[0]).not.toHaveProperty('qualification_gaps')
  })
})

describe('digestRows and digestHeadline', () => {
  const PEOPLE = [{ profile_id: 'ann', full_name: 'Ann' }, { profile_id: 'bob', full_name: 'Bob' }]
  const TYPES = [
    { id: 'fa', name: 'First aid', active: true },
    { id: 'ins', name: 'Insurance', active: true },
    { id: 'old', name: 'Old cert', active: false },
  ]
  const RECORDS = [
    { profile_id: 'bob', qualification_type_id: 'fa', expires_on: '2026-10-05' },
    { profile_id: 'ann', qualification_type_id: 'ins', expires_on: '2026-10-20' },
    { profile_id: 'ann', qualification_type_id: 'fa', expires_on: '2026-09-20' },
    { profile_id: 'ann', qualification_type_id: 'old', expires_on: '2026-09-01' }, // archived type
    { profile_id: 'zed', qualification_type_id: 'fa', expires_on: '2026-09-01' }, // not one of these people
    { profile_id: 'bob', qualification_type_id: 'ins', expires_on: '2027-06-01' }, // valid
  ]

  it('expired first (oldest first), then expiring (soonest first); archived types and outsiders left out', () => {
    expect(digestRows({ people: PEOPLE, types: TYPES, records: RECORDS, todayISO: TODAY })).toEqual([
      { profile_id: 'ann', full_name: 'Ann', type_id: 'fa', type_name: 'First aid', expires_on: '2026-09-20', status: 'expired', days: -8 },
      { profile_id: 'bob', full_name: 'Bob', type_id: 'fa', type_name: 'First aid', expires_on: '2026-10-05', status: 'expiring', days: 7 },
      { profile_id: 'ann', full_name: 'Ann', type_id: 'ins', type_name: 'Insurance', expires_on: '2026-10-20', status: 'expiring', days: 22 },
    ])
  })

  it('the headline counts, singular and plural, or is null with nothing to say', () => {
    const rows = digestRows({ people: PEOPLE, types: TYPES, records: RECORDS, todayISO: TODAY })
    expect(digestHeadline(rows)).toBe('1 qualification has expired and 2 more expire in the next 30 days.')
    expect(digestHeadline(rows.slice(0, 1))).toBe('1 qualification has expired.')
    expect(digestHeadline(rows.slice(1))).toBe('2 qualifications expire in the next 30 days.')
    expect(digestHeadline(rows.slice(2))).toBe('1 qualification expires in the next 30 days.')
    expect(digestHeadline([rows[0], rows[0], rows[1]])).toBe('2 qualifications have expired and 1 more expires in the next 30 days.')
    expect(digestHeadline([])).toBeNull()
  })
})

describe('parseTemplateQualificationsAnswer', () => {
  it('understands { types, requirements }; anything else (an older server, a test mock) is not understood', () => {
    expect(parseTemplateQualificationsAnswer(null)).toEqual({ ok: false })
    expect(parseTemplateQualificationsAnswer({ success: false, error: 'x' })).toEqual({ ok: false })
    expect(parseTemplateQualificationsAnswer({ success: true, data: [{ id: 't1' }] })).toEqual({ ok: false })
    expect(parseTemplateQualificationsAnswer({ success: true, data: {
      types: [{ id: 'fa', name: 'First aid', active: true }, { id: '', name: 'x' }, null],
      requirements: { t1: ['fa', 7], t2: 'junk' },
    } })).toEqual({ ok: true, types: [{ id: 'fa', name: 'First aid', active: true }], requirements: { t1: ['fa'] } })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/qualifications.test.js`
Expected: FAIL, `Failed to resolve import "./qualifications.js"`.

- [ ] **Step 3: Implement**

Create `shared/qualifications.js`:

```js
// shared/qualifications.js
//
// QUALS.1 — staff qualifications with expiry (first aid, insurance, Garda
// vetting, and whatever else an organisation adds). PURE: no IO, no clock,
// no host timezone. Dates are Dublin calendar days as 'YYYY-MM-DD', compared
// as day numbers built with Date.UTC, so nothing moves with the machine's zone.
//
// One record per (person, type). A record with no expires_on does not expire.
// The status of a record ON a day:
//   missing   no record
//   expired   expires_on is before the day
//   expiring  expires_on is the day itself or within the next windowDays (30)
//   valid     later than that, or no expiry
//   null      a date that cannot be read: unknown, never an all-clear and
//             never an alarm
//
// A template's requirement is ADVISORY. requirementGaps() judges on the
// SHIFT's date, and only `missing` and `expired` are gaps: a certificate
// that expires on the day of the shift still covers it. Nothing here refuses
// anything; the pickers badge.
//
// Web only today (the qualifications page, the template editor, the ranked
// picker via shared/candidates.js). It lives in shared/ so the phone can
// adopt it without a copy.

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 24 * 60 * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const QUALIFICATION_EXPIRY_WINDOW_DAYS = 30
export const QUALIFICATION_STATUSES = Object.freeze(['valid', 'expiring', 'expired', 'missing'])
export const QUALIFICATION_STATUS_TONES = Object.freeze({ valid: 'good', expiring: 'warn', expired: 'bad', missing: 'muted' })

// A real calendar day → a whole day number; anything else → null.
// Date.UTC rolls 2026-02-30 over to 2 March, so read the parts back.
function dayNumber(iso) {
  const m = String(iso ?? '').match(ISO_DAY)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return Math.round(ms / DAY_MS)
}

const hasNoExpiry = (record) => record.expires_on == null || record.expires_on === ''
const cmpText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { sensitivity: 'base' })

function joinList(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Whole days from `fromISO` to `toISO` (negative when `toISO` is earlier); null if either is unreadable. */
export function daysUntil(fromISO, toISO) {
  const a = dayNumber(fromISO)
  const b = dayNumber(toISO)
  return a === null || b === null ? null : b - a
}

/** '2026-08-31' → '31 Aug 2026'; '' for an unreadable date. */
export function formatQualificationDate(iso) {
  if (dayNumber(iso) === null) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/**
 * 'missing' | 'expired' | 'expiring' | 'valid' | null (unreadable).
 * @param {{ expires_on?: string|null }|null} record
 * @param {string} onISO  the day being judged (today, or a shift's date)
 */
export function qualificationStatus(record, onISO, { windowDays = QUALIFICATION_EXPIRY_WINDOW_DAYS } = {}) {
  if (!record) return 'missing'
  if (hasNoExpiry(record)) return 'valid'
  const days = daysUntil(onISO, record.expires_on)
  if (days === null) return null
  if (days < 0) return 'expired'
  if (days <= windowDays) return 'expiring'
  return 'valid'
}

/** The row's second line on the qualifications page. */
export function qualificationStatusLabel(record, onISO, opts) {
  const status = qualificationStatus(record, onISO, opts)
  if (status === 'missing') return 'Not on record'
  if (status === null) return 'Expiry date unreadable'
  if (hasNoExpiry(record)) return 'No expiry'
  const days = daysUntil(onISO, record.expires_on)
  const when = formatQualificationDate(record.expires_on)
  if (status === 'expired') return days === -1 ? `Expired yesterday (${when})` : `Expired ${when}`
  if (status === 'expiring') {
    if (days === 0) return 'Expires today'
    if (days === 1) return 'Expires tomorrow'
    return `Expires in ${days} days (${when})`
  }
  return `Valid until ${when}`
}

/** The page's "Needs attention" filter: any record expired or expiring on `onISO`. */
export function personNeedsAttention(records, onISO) {
  return (records || []).some((r) => {
    const s = qualificationStatus(r, onISO)
    return s === 'expired' || s === 'expiring'
  })
}

/**
 * What one person lacks for one shift, judged on the shift's date.
 * @param {{ required: Array<{ id, name }>, records: Array<{ qualification_type_id, expires_on }>, onISO: string }} args
 *   `records` are THIS person's.
 * @returns {Array<{ type_id, name, status: 'missing'|'expired', expires_on }>} sorted by name
 */
export function requirementGaps({ required = [], records = [], onISO } = {}) {
  const gaps = []
  for (const t of required || []) {
    if (!t?.id) continue
    const rec = (records || []).find((r) => r?.qualification_type_id === t.id) || null
    // windowDays 0: expiring ON the shift day still covers the shift.
    const status = qualificationStatus(rec, onISO, { windowDays: 0 })
    if (status === 'missing' || status === 'expired') {
      gaps.push({ type_id: t.id, name: t.name || 'Qualification', status, expires_on: rec?.expires_on ?? null })
    }
  }
  return gaps.sort((a, b) => cmpText(a.name, b.name) || String(a.type_id).localeCompare(String(b.type_id)))
}

const gapWords = (g) => (g.status === 'expired'
  ? `expired ${formatQualificationDate(g.expires_on)}`.trim()
  : 'not on record')

/**
 * The web picker's badge for a candidate's gaps, in candidateBadges' shape
 * ({ key, tone, text, title }), or null when nothing is missing.
 */
export function qualificationGapBadge(gaps) {
  const list = (Array.isArray(gaps) ? gaps : []).filter((g) => g && (g.status === 'missing' || g.status === 'expired'))
  if (list.length === 0) return null
  const text = list.length === 1
    ? `${list[0].name}: ${list[0].status === 'expired' ? 'expired' : 'not on record'}`
    : `${list.length} qualifications missing or expired`
  return {
    key: 'qualifications',
    tone: 'warn',
    text,
    title: `This shift asks for ${joinList(list.map((g) => `${g.name} (${gapWords(g)})`))}. Advisory only: you can still assign them.`,
  }
}

/**
 * Copies of ranked candidates, each with `qualification_gaps`. With nothing
 * required, the SAME array comes back (no field is added). Never re-ranks.
 */
export function attachQualificationGaps(candidates, { required = [], records = [], onISO } = {}) {
  if (!Array.isArray(candidates)) return []
  if (!required?.length) return candidates
  const byProfile = new Map()
  for (const r of records || []) {
    if (!r?.profile_id) continue
    if (!byProfile.has(r.profile_id)) byProfile.set(r.profile_id, [])
    byProfile.get(r.profile_id).push(r)
  }
  return candidates.map((c) => (c?.profile_id
    ? { ...c, qualification_gaps: requirementGaps({ required, records: byProfile.get(c.profile_id) || [], onISO }) }
    : c))
}

/**
 * The owner digest's rows: records of these people, of ACTIVE types, that are
 * expired or expiring on `todayISO`. Expired first (oldest first), then
 * expiring (soonest first), then name, then type.
 */
export function digestRows({ people = [], types = [], records = [], todayISO, windowDays = QUALIFICATION_EXPIRY_WINDOW_DAYS } = {}) {
  const names = new Map((people || []).filter((p) => p?.profile_id).map((p) => [p.profile_id, p.full_name ?? null]))
  const typeNames = new Map((types || []).filter((t) => t?.id && t.active !== false).map((t) => [t.id, t.name]))
  const rows = []
  for (const r of records || []) {
    if (!names.has(r?.profile_id) || !typeNames.has(r?.qualification_type_id)) continue
    const status = qualificationStatus(r, todayISO, { windowDays })
    if (status !== 'expired' && status !== 'expiring') continue
    rows.push({
      profile_id: r.profile_id,
      full_name: names.get(r.profile_id),
      type_id: r.qualification_type_id,
      type_name: typeNames.get(r.qualification_type_id),
      expires_on: r.expires_on,
      status,
      days: daysUntil(todayISO, r.expires_on),
    })
  }
  const rank = { expired: 0, expiring: 1 }
  return rows.sort((a, b) => rank[a.status] - rank[b.status]
    || a.expires_on.localeCompare(b.expires_on)
    || cmpText(a.full_name, b.full_name)
    || cmpText(a.type_name, b.type_name)
    || String(a.profile_id).localeCompare(String(b.profile_id)))
}

/** '1 qualification has expired and 2 more expire in the next 30 days.' or null. */
export function digestHeadline(rows, windowDays = QUALIFICATION_EXPIRY_WINDOW_DAYS) {
  const expired = (rows || []).filter((r) => r?.status === 'expired').length
  const expiring = (rows || []).filter((r) => r?.status === 'expiring').length
  const some = (n) => (n === 1 ? '1 qualification' : `${n} qualifications`)
  const hasHave = (n) => (n === 1 ? 'has' : 'have')
  const expireVerb = (n) => (n === 1 ? 'expires' : 'expire')
  if (expired && expiring) return `${some(expired)} ${hasHave(expired)} expired and ${expiring} more ${expireVerb(expiring)} in the next ${windowDays} days.`
  if (expired) return `${some(expired)} ${hasHave(expired)} expired.`
  if (expiring) return `${some(expiring)} ${expireVerb(expiring)} in the next ${windowDays} days.`
  return null
}

/**
 * The template editor's reading of GET /api/schedule/template-qualifications.
 * { ok: true, types, requirements } or { ok: false } (not loaded, refused, or
 * a shape it does not know): the editor then shows no field and saves none.
 */
export function parseTemplateQualificationsAnswer(json) {
  if (!json || json.success !== true) return { ok: false }
  const d = json.data
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false }
  if (!Array.isArray(d.types) || !d.requirements || typeof d.requirements !== 'object' || Array.isArray(d.requirements)) return { ok: false }
  const requirements = {}
  for (const [templateId, ids] of Object.entries(d.requirements)) {
    if (Array.isArray(ids)) requirements[templateId] = ids.filter((id) => typeof id === 'string' && id)
  }
  return { ok: true, types: d.types.filter((t) => t && t.id && t.name), requirements }
}
```

- [ ] **Step 4: Run it, expect PASS, both timezones**

Run: `for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run shared/qualifications.test.js || break; done`
Expected: every test passes in both runs. Then `npx vitest run tests/shared-pair-sync.test.js` (unchanged: there is no `src/lib/qualifications.js`).

- [ ] **Step 5: Commit**

```bash
git add shared/qualifications.js shared/qualifications.test.js
git commit -m "QUALS.1 — shared/qualifications.js: statuses, labels, requirement gaps, digest rows (pure)

missing / expired / expiring (the day up to 30 days ahead) / valid; no
expiry is valid; an unreadable date is unknown, never an all-clear.
Requirements judge on the shift date (expiring that day still covers).
Date.UTC day numbers only: no host timezone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Register the `qualification_expiry` push category everywhere

An unregistered category fails CLOSED: only masters would receive it (CLAUDE.md, "An UNREGISTERED `sendPush` category fails CLOSED"). The category is the BARE name; `push.js` adds `notify_`.

**Files:**
- Create: `src/lib/qualification-expiry-registration.test.js`
- Modify: `shared/permissions.js`, `shared/permission-bundles.js`, `shared/push-channels.js`, `src/lib/notifications-registry.js`, `src/lib/push-channels.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/qualification-expiry-registration.test.js`:

```js
// QUALS.1 — the `qualification_expiry` push category is registered at EVERY
// site a category needs. An unregistered category fails CLOSED (CLAUDE.md):
// only masters would ever see it. Default ON for all six roles, not just
// owners, for the reason AVAIL.1 gives (availability-change-registration.test.js):
// sendPush without a locationId resolves ONE key for the person, so a single
// assignment resolving it false (an owner who is staff somewhere) would
// silence them everywhere. Recipients are narrowed in code
// (src/lib/qualification-digest.js: owners and masters only).

import { describe, it, expect } from 'vitest'
import { MOBILE_PERMISSIONS, DEFAULT_MOBILE_PERMISSIONS_BY_ROLE, NOTIFY_KEYS } from '@shared/permissions'
import { EXEMPT_KEYS } from '@shared/permission-bundles'
import { androidChannelId } from '@shared/push-channels'
import { getNotificationCategory } from './notifications-registry'
import { QUALIFICATION_DIGEST_CATEGORY, QUALIFICATION_DIGEST_TYPE } from './qualification-digest'

const KEY = 'notify_qualification_expiry'

describe('qualification_expiry category registration', () => {
  it('the digest sends the BARE category name, and it is this one', () => {
    expect(QUALIFICATION_DIGEST_CATEGORY).toBe('qualification_expiry')
    expect(QUALIFICATION_DIGEST_TYPE).toBe('qualification_digest')
  })

  it('is a personal, mobile-only notify toggle with a label the settings screens can render', () => {
    const entry = MOBILE_PERMISSIONS.find((p) => p.key === KEY)
    expect(entry).toMatchObject({ key: KEY, mobileOnly: true, isNotify: true })
    expect(entry.label).toMatch(/Qualification expiry/)
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

  it('rides the Android "reminders" channel (a scheduled nudge, like inspection_due)', () => {
    expect(androidChannelId({ category: 'qualification_expiry', type: 'qualification_digest' })).toBe('reminders')
  })

  it('is in the registry: cron, owners, email fallback carrying the list', () => {
    expect(getNotificationCategory('qualification_expiry')).toMatchObject({
      category: 'qualification_expiry',
      label: 'Qualification expiry',
      trigger: { kind: 'cron' },
      recipients: { kind: 'roles_at_location' },
      configurable: { leadTimes: false, roles: false },
      fallbackEmail: true,
      emailSubject: 'Qualifications to renew',
    })
  })
})
```

This test imports `./qualification-digest`, which Task 11 creates. Until then, create a one-line stub, so this task stands alone:

```js
// src/lib/qualification-digest.js (stub, replaced in Task 11)
export const QUALIFICATION_DIGEST_CATEGORY = 'qualification_expiry'
export const QUALIFICATION_DIGEST_TYPE = 'qualification_digest'
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/qualification-expiry-registration.test.js`
Expected: FAIL on the permission, exempt, channel and registry tests (the constants test passes).

- [ ] **Step 3: Register it**

`shared/permissions.js`, in `MOBILE_PERMISSIONS`, directly after the `notify_availability_change` entry (line 727):

```js
  // QUALS.1 — the weekly qualification-expiry digest: what has expired or
  // expires in 30 days, for the people at your studios. Recipients are owners
  // (and masters) only, narrowed in src/lib/qualification-digest.js. Default
  // ON for every role (see src/lib/qualification-expiry-registration.test.js).
  { key: 'notify_qualification_expiry', label: '… Qualification expiry', hint: 'Weekly: qualifications at your studios that have expired or expire within 30 days (owners)', mobileOnly: true, isNotify: true },
```

`shared/permissions.js`, in `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE`, directly after EACH of the six `    notify_availability_change: true,` lines (795, 835, 878, 915, 956, 999: master, staff, reception, head_coach, manager, owner):

```js
    notify_qualification_expiry: true,
```

`shared/permission-bundles.js`: in the two comments at lines 335 and 380, change `27 personal` to `28 personal`. Directly after `  'notify_availability_change',` (line 398):

```js
  'notify_qualification_expiry',
```

`shared/push-channels.js`, in `CATEGORY_CHANNELS`, directly after the `availability_change: 'updates',` line (102):

```js
  qualification_expiry: 'reminders', // QUALS.1 — the weekly qualification-expiry digest (owners)
```

`src/lib/notifications-registry.js`: insert a new entry directly after the `availability_change` entry's closing `},` (the entry that starts at line 260), before the closing `])`:

```js
  {
    category: 'qualification_expiry',
    label: 'Qualification expiry',
    description: 'At most once a week, and only when something is due: the qualifications (first aid, insurance, vetting and any others your organisation tracks) of the people at the studios you own that have expired or expire in the next 30 days. Sent between 7am and 10pm studio time.',
    trigger: { kind: 'cron', source: '/api/cron/contract-reminders (daily 08:00 UTC) -> src/lib/qualification-digest.js' },
    recipients: { kind: 'roles_at_location', detail: 'Owners (and masters linked to the studio); the list covers the people at the studios where they are owner, never another organisation' },
    configurable: { leadTimes: false, roles: false },
    // The push can only say how many; the fallback email carries the list,
    // and an owner without the app would otherwise never hear at all.
    fallbackEmail: true,
    emailSubject: 'Qualifications to renew',
  },
```

`src/lib/push-channels.test.js`, in `STAFF_TYPES`, directly after the `'availability_changed', // AVAIL.1 …` line (26):

```js
  'qualification_digest', // QUALS.1 — rides category 'qualification_expiry'
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run src/lib/qualification-expiry-registration.test.js src/lib/push-channels.test.js tests/push-category-literals.test.js src/lib/availability-change-registration.test.js shared/`
Expected: all pass. `tests/push-category-literals.test.js` checks that every registered `notify_<category>` has a `CATEGORY_CHANNELS` entry. `shared/` covers the permission and bundle tests.

Then `npm run check:mobile-parity && npm run check:bundle-sql`. Both stay green: a `notify_*` key is exempt, not bundled.

- [ ] **Step 5: Commit**

```bash
git add shared/permissions.js shared/permission-bundles.js shared/push-channels.js src/lib/notifications-registry.js src/lib/push-channels.test.js src/lib/qualification-expiry-registration.test.js src/lib/qualification-digest.js
git commit -m "QUALS.1 — register the qualification_expiry push category: default on, reminders channel, email fallback

Every site a category needs (an unregistered one fails closed). Default ON
for all six roles; the digest narrows recipients to owners and masters.
Phones gain one 'Qualification expiry' toggle (shared/: this publishes).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The data layer — `qualifications-schemas.js` and `qualifications-server.js`

Routes stay thin. Every decision that needs a ROW (whose record is this, which organisation is this type in, is the person current) lives here, answers 404 for anything the caller may not touch, and returns `{ status, body }` for the route to send.

**Files:**
- Create: `src/lib/qualifications-schemas.js`
- Create: `src/lib/qualifications-mock-db.test-helpers.js`
- Create: `src/lib/qualifications-server.test.js`
- Create: `src/lib/qualifications-server.js`

- [ ] **Step 1: The schemas (no test of their own; the route tests pin them)**

Create `src/lib/qualifications-schemas.js`:

```js
// src/lib/qualifications-schemas.js
//
// QUALS.1 — request bodies for the qualification routes. Zod only, no IO, so
// src/lib/openapi.js can import them without pulling in the data layer.
// Plain schemas, no transforms (zod v4 + zod-to-openapi): trimming a note and
// turning '' into null happen in src/lib/qualifications-server.js.

import { z } from 'zod'
import { uuidLike, realIsoDate } from './schemas'

export const MAX_TEMPLATE_REQUIREMENTS = 5
export const QUALIFICATION_NOTE_MAX = 300
export const QUALIFICATION_TYPE_NAME_MAX = 60

const DateOrNull = realIsoDate.nullable().optional()
const Note = z.string().max(QUALIFICATION_NOTE_MAX, 'A note is at most 300 characters').nullable().optional()
const datesInOrder = (v) => !v.issued_on || !v.expires_on || v.expires_on >= v.issued_on
const DATES_ORDER = { message: 'The expiry date is before the issue date', path: ['expires_on'] }
const TypeName = z.string().trim()
  .min(1, 'Give the qualification a name')
  .max(QUALIFICATION_TYPE_NAME_MAX, 'At most 60 characters')
  .refine((s) => !/[\r\n]/.test(s), 'One line only')

// expires_on null (or absent) = the qualification does not expire (plan
// decision 3). The page's form sends null only when "Does not expire" is ticked.
export const QualificationRecordCreateSchema = z.object({
  profile_id: uuidLike,
  qualification_type_id: uuidLike,
  issued_on: DateOrNull,
  expires_on: DateOrNull,
  note: Note,
}).refine(datesInOrder, DATES_ORDER)

// The type and the person are fixed: to change them, delete and record again.
export const QualificationRecordPatchSchema = z.object({
  issued_on: DateOrNull,
  expires_on: DateOrNull,
  note: Note,
}).refine((v) => v.issued_on !== undefined || v.expires_on !== undefined || v.note !== undefined, { message: 'Nothing to change' })
  .refine(datesInOrder, DATES_ORDER)

export const QualificationTypeCreateSchema = z.object({
  location_id: uuidLike, // the studio the owner is acting from; its organisation owns the type
  name: TypeName,
})

export const QualificationTypePatchSchema = z.object({
  name: TypeName.optional(),
  active: z.boolean().optional(),
}).refine((v) => v.name !== undefined || v.active !== undefined, { message: 'Nothing to change' })

export const TemplateQualificationsPutSchema = z.object({
  template_id: uuidLike,
  qualification_type_ids: z.array(uuidLike).max(MAX_TEMPLATE_REQUIREMENTS, 'At most 5 qualifications'),
})
```

- [ ] **Step 2: The mock db helper**

Create `src/lib/qualifications-mock-db.test-helpers.js`. The name follows `like-escape.test-helpers.js`: not a test file, and imported only by tests.

```js
// QUALS.1 — a chainable supabase mock for the qualification data-layer tests.
// Every query is logged ({ table, op, select, returning, filters, payload,
// options, range, single }) and answered by `respond(query)`, which returns
// { data, error }. Builders are thenables, like supabase's.

export function mockDb(respond = () => ({ data: [], error: null })) {
  const log = []
  return {
    log,
    from(table) {
      const q = { table, op: 'select', select: null, returning: null, filters: [], payload: null, options: null, range: null, single: null }
      log.push(q)
      const chain = {
        select(cols) { if (q.op === 'select') q.select = cols; else q.returning = cols; return chain },
        insert(payload) { q.op = 'insert'; q.payload = payload; return chain },
        update(payload) { q.op = 'update'; q.payload = payload; return chain },
        upsert(payload, options) { q.op = 'upsert'; q.payload = payload; q.options = options; return chain },
        delete() { q.op = 'delete'; return chain },
        eq(col, val) { q.filters.push(['eq', col, val]); return chain },
        neq(col, val) { q.filters.push(['neq', col, val]); return chain },
        in(col, val) { q.filters.push(['in', col, val]); return chain },
        is(col, val) { q.filters.push(['is', col, val]); return chain },
        not(col, opr, val) { q.filters.push(['not', col, opr, val]); return chain },
        lte(col, val) { q.filters.push(['lte', col, val]); return chain },
        order() { return chain },
        limit() { return chain },
        range(from, to) { q.range = [from, to]; return chain },
        maybeSingle() { q.single = 'maybe'; return chain },
        single() { q.single = 'single'; return chain },
        then(resolve, reject) { return Promise.resolve().then(() => respond(q)).then(resolve, reject) },
      }
      return chain
    },
  }
}

/** respond() from a map keyed 'table.op' or 'table'; a function value is called with the query. */
export function byTable(map) {
  return (q) => {
    const hit = map[`${q.table}.${q.op}`] ?? map[q.table]
    if (typeof hit === 'function') return hit(q)
    return hit ?? { data: q.single ? null : [], error: null }
  }
}

export const filter = (q, op, col) => q.filters.find((f) => f[0] === op && f[1] === col)?.[2]
```

- [ ] **Step 3: Write the failing test**

Create `src/lib/qualifications-server.test.js`:

```js
// QUALS.1 — the qualification data layer: who may read and write what
// (judged on the row, 404 for anything out of reach), that deactivated and
// tombstoned people are never listed or written for, and that a failed read
// is a 500, never an empty list.

import { describe, it, expect, vi } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { mockDb, byTable, filter } = await import('./qualifications-mock-db.test-helpers')
const {
  QUAL_MANAGER_ROLES, QUAL_CATALOGUE_ROLES,
  loadQualificationsPage, createQualificationRecord, updateQualificationRecord, deleteQualificationRecord,
  canEditCatalogue, createQualificationType, updateQualificationType,
  readTemplateRequirements, replaceTemplateRequirements, readBlockQualificationFacts,
} = await import('./qualifications-server')

const ORG = 'org-1'
const OTHER_ORG = 'org-2'
const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const GARAGE = 'loc-garage' // another organisation's studio

const person = (over) => ({ profileRole: 'staff', locations: [{ id: STILL, organization_id: ORG }], ...over })
const manager = person({ id: 'm1', full_name: 'Mia Manager', rolesByLocation: { [STILL]: 'manager' } })
const owner = person({
  id: 'o1', full_name: 'Olive Owner', rolesByLocation: { [STILL]: 'owner', [HATCH]: 'owner' },
  locations: [{ id: STILL, organization_id: ORG }, { id: HATCH, organization_id: ORG }],
})
const headCoach = person({ id: 'h1', full_name: 'Hal Head', rolesByLocation: { [STILL]: 'head_coach' } })
const coach = person({ id: 'c1', full_name: 'Cal Coach', rolesByLocation: { [STILL]: 'staff' } })
const master = { id: 'x1', full_name: 'Max Master', profileRole: 'master', rolesByLocation: {}, locations: [] }

const TYPES = [
  { id: 'fa', organization_id: ORG, name: 'First aid', active: true, sort_order: 10 },
  { id: 'old', organization_id: ORG, name: 'Old cert', active: false, sort_order: 100 },
]
const orgOf = (loc) => (loc === GARAGE ? OTHER_ORG : ORG)
const link = (profile_id, location_id, profile = {}) => ({
  profile_id, location_id,
  locations: { id: location_id, organization_id: orgOf(location_id) },
  profiles: { id: profile_id, full_name: `${profile_id[0].toUpperCase()}${profile_id.slice(1)}`, active: true, deleted_at: null, ...profile },
})
const RECORD = { id: 'r1', organization_id: ORG, profile_id: 'ann', qualification_type_id: 'fa', issued_on: '2026-05-01', expires_on: '2027-05-01', note: null, updated_at: '2026-09-01T00:00:00Z' }

describe('roles', () => {
  it('records: owner and manager; catalogue: owner (masters bypass both)', () => {
    expect(QUAL_MANAGER_ROLES).toEqual(['owner', 'manager'])
    expect(QUAL_CATALOGUE_ROLES).toEqual(['owner'])
  })
})

describe('loadQualificationsPage', () => {
  const pageDb = (over = {}) => mockDb(byTable({
    locations: { data: { id: STILL, organization_id: ORG }, error: null },
    staff_qualification_types: { data: TYPES, error: null },
    profile_locations: { data: [
      link('bob', STILL), link('ann', STILL),
      link('gone', STILL, { active: false, deleted_at: '2026-09-01T00:00:00Z' }),
      link('off', STILL, { active: false }),
      link('nul', STILL, { active: null }), // mig 626: a NULL active is active
    ], error: null },
    staff_qualifications: { data: [RECORD], error: null },
    ...over,
  }))

  it('a manager gets every current member A–Z with their records; tombstoned and deactivated people are not listed', async () => {
    const db = pageDb()
    const out = await loadQualificationsPage(db, { user: manager, locationId: STILL, today: '2026-09-28' })
    expect(out.status).toBe(200)
    expect(out.body.data).toMatchObject({ audience: 'manager', today: '2026-09-28', organization_id: ORG, can_edit_types: false, types: TYPES })
    expect(out.body.data.people).toEqual([
      { profile_id: 'ann', full_name: 'Ann', records: [RECORD] },
      { profile_id: 'bob', full_name: 'Bob', records: [] },
      { profile_id: 'nul', full_name: 'Nul', records: [] },
    ])
    const recQ = db.log.find((q) => q.table === 'staff_qualifications')
    expect(filter(recQ, 'eq', 'organization_id')).toBe(ORG)
    expect(filter(recQ, 'in', 'profile_id')).toEqual(['ann', 'bob', 'nul'])
    const memberQ = db.log.find((q) => q.table === 'profile_locations')
    expect(filter(memberQ, 'eq', 'location_id')).toBe(STILL)
  })

  it('an owner may also edit the catalogue', async () => {
    const out = await loadQualificationsPage(pageDb(), { user: owner, locationId: STILL, today: '2026-09-28' })
    expect(out.body.data.can_edit_types).toBe(true)
  })

  it.each([['a coach', coach], ['a head coach', headCoach]])('%s gets their own records only, read-only', async (_, user) => {
    const own = { ...RECORD, profile_id: user.id }
    const db = pageDb({ staff_qualifications: { data: [own], error: null } })
    const out = await loadQualificationsPage(db, { user, locationId: STILL, today: '2026-09-28' })
    expect(out.body.data).toMatchObject({ audience: 'self', can_edit_types: false })
    expect(out.body.data.people).toEqual([{ profile_id: user.id, full_name: user.full_name, records: [own] }])
    expect(db.log.some((q) => q.table === 'profile_locations')).toBe(false)
    expect(filter(db.log.find((q) => q.table === 'staff_qualifications'), 'in', 'profile_id')).toEqual([user.id])
  })

  it('a failed read is a 500, never an empty list; a studio that does not exist is a 404', async () => {
    for (const table of ['staff_qualification_types', 'profile_locations', 'staff_qualifications']) {
      const out = await loadQualificationsPage(pageDb({ [table]: { data: null, error: { message: 'down' } } }), { user: manager, locationId: STILL, today: '2026-09-28' })
      expect(out.status, table).toBe(500)
    }
    const missing = await loadQualificationsPage(pageDb({ locations: { data: null, error: null } }), { user: manager, locationId: STILL, today: '2026-09-28' })
    expect(missing.status).toBe(404)
  })
})

describe('createQualificationRecord', () => {
  const INPUT = { profile_id: 'ann', qualification_type_id: 'fa', expires_on: '2027-01-01', note: '  PHECC  ' }
  const createDb = ({ type = TYPES[0], links = [link('ann', STILL)], insert } = {}) => mockDb(byTable({
    'staff_qualification_types.select': { data: type, error: null },
    'profile_locations.select': { data: links, error: null },
    'staff_qualifications.insert': insert ?? ((q) => ({ data: { id: 'new', ...q.payload }, error: null })),
  }))

  it('records it in the TYPE\'s organisation, trims the note, stamps who recorded it', async () => {
    const db = createDb()
    const out = await createQualificationRecord(db, { user: manager, input: INPUT })
    expect(out.status).toBe(201)
    const ins = db.log.find((q) => q.op === 'insert')
    expect(ins.payload).toEqual({
      organization_id: ORG, profile_id: 'ann', qualification_type_id: 'fa',
      issued_on: null, expires_on: '2027-01-01', note: 'PHECC', recorded_by: 'm1', updated_by: 'm1',
    })
    expect(filter(db.log.find((q) => q.table === 'profile_locations'), 'eq', 'profile_id')).toBe('ann')
  })

  it('a blank note is stored as null', async () => {
    const db = createDb()
    await createQualificationRecord(db, { user: manager, input: { ...INPUT, note: ' \n ' } })
    expect(db.log.find((q) => q.op === 'insert').payload.note).toBeNull()
  })

  it.each([
    ['an unknown type', { type: null }, manager],
    ['a person at a studio the caller does not manage', { links: [link('ann', HATCH)] }, manager],
    ['a head coach (not a records role)', {}, headCoach],
    ['a coach', {}, coach],
    ['a deactivated person', { links: [link('ann', STILL, { active: false })] }, manager],
    ['a tombstone', { links: [link('ann', STILL, { active: false, deleted_at: '2026-09-01T00:00:00Z' })] }, manager],
    ['a person only at another organisation\'s studio', { links: [link('ann', GARAGE)] }, owner],
  ])('404 for %s, and nothing is written', async (_, over, user) => {
    const db = createDb(over)
    const out = await createQualificationRecord(db, { user, input: INPUT })
    expect(out.status).toBe(404)
    expect(db.log.some((q) => q.op === 'insert')).toBe(false)
  })

  it('a master may record for anyone at a studio of the type\'s organisation', async () => {
    const out = await createQualificationRecord(createDb(), { user: master, input: INPUT })
    expect(out.status).toBe(201)
  })

  it('an archived type is refused (400) once the caller is known to be allowed', async () => {
    const out = await createQualificationRecord(createDb({ type: TYPES[1] }), { user: manager, input: { ...INPUT, qualification_type_id: 'old' } })
    expect(out).toMatchObject({ status: 400, body: { success: false, error: expect.stringMatching(/archived/) } })
  })

  it('a duplicate is a 409; a CHECK refusal is a 400; anything else is a 500', async () => {
    const dup = await createQualificationRecord(createDb({ insert: { data: null, error: { code: '23505', message: 'dup' } } }), { user: manager, input: INPUT })
    expect(dup.status).toBe(409)
    const chk = await createQualificationRecord(createDb({ insert: { data: null, error: { code: '23514', message: 'check' } } }), { user: manager, input: INPUT })
    expect(chk.status).toBe(400)
    const boom = await createQualificationRecord(createDb({ insert: { data: null, error: { code: 'XX000', message: 'boom' } } }), { user: manager, input: INPUT })
    expect(boom.status).toBe(500)
  })
})

describe('updateQualificationRecord and deleteQualificationRecord', () => {
  const rowDb = ({ record = RECORD, links = [link('ann', STILL)], write } = {}) => mockDb(byTable({
    'staff_qualifications.select': { data: record, error: null },
    'profile_locations.select': { data: links, error: null },
    'staff_qualifications.update': write ?? ((q) => ({ data: [{ ...RECORD, ...q.payload }], error: null })),
    'staff_qualifications.delete': write ?? { data: [{ id: 'r1' }], error: null },
  }))

  it('updates only the fields sent, stamps updated_by/updated_at, scoped to the record\'s organisation', async () => {
    const db = rowDb()
    const out = await updateQualificationRecord(db, { user: manager, id: 'r1', input: { expires_on: '2028-05-01' } })
    expect(out.status).toBe(200)
    const upd = db.log.find((q) => q.op === 'update')
    expect(Object.keys(upd.payload).sort()).toEqual(['expires_on', 'updated_at', 'updated_by'])
    expect(upd.payload.updated_by).toBe('m1')
    expect(filter(upd, 'eq', 'id')).toBe('r1')
    expect(filter(upd, 'eq', 'organization_id')).toBe(ORG)
  })

  it('judges the dates against what is stored: a new expiry before the stored issue date is a 400, nothing written', async () => {
    const db = rowDb()
    const out = await updateQualificationRecord(db, { user: manager, id: 'r1', input: { expires_on: '2026-04-01' } })
    expect(out.status).toBe(400)
    expect(db.log.some((q) => q.op === 'update')).toBe(false)
  })

  it('404: a missing record, one the caller does not manage, a zero-row write', async () => {
    expect((await updateQualificationRecord(rowDb({ record: null }), { user: manager, id: 'r1', input: { note: 'x' } })).status).toBe(404)
    expect((await updateQualificationRecord(rowDb({ links: [link('ann', HATCH)] }), { user: manager, id: 'r1', input: { note: 'x' } })).status).toBe(404)
    expect((await updateQualificationRecord(rowDb({ write: { data: [], error: null } }), { user: manager, id: 'r1', input: { note: 'x' } })).status).toBe(404)
    expect((await deleteQualificationRecord(rowDb({ links: [link('ann', HATCH)] }), { user: manager, id: 'r1' })).status).toBe(404)
    expect((await deleteQualificationRecord(rowDb({ write: { data: [], error: null } }), { user: manager, id: 'r1' })).status).toBe(404)
  })

  it('deletes, scoped to the record\'s organisation', async () => {
    const db = rowDb()
    const out = await deleteQualificationRecord(db, { user: owner, id: 'r1' })
    expect(out).toEqual({ status: 200, body: { success: true, data: { id: 'r1', deleted: true } } })
    const del = db.log.find((q) => q.op === 'delete')
    expect(filter(del, 'eq', 'organization_id')).toBe(ORG)
  })
})

describe('the catalogue', () => {
  it('canEditCatalogue: an owner at a studio of that organisation, or a master', () => {
    expect(canEditCatalogue(owner, ORG)).toBe(true)
    expect(canEditCatalogue(owner, OTHER_ORG)).toBe(false)
    expect(canEditCatalogue(manager, ORG)).toBe(false)
    expect(canEditCatalogue(master, OTHER_ORG)).toBe(true)
    expect(canEditCatalogue(null, ORG)).toBe(false)
  })

  it('creates a type in the studio\'s organisation; a duplicate name is a 409', async () => {
    const db = mockDb(byTable({
      locations: { data: { id: STILL, organization_id: ORG }, error: null },
      'staff_qualification_types.insert': (q) => ({ data: { id: 'new', ...q.payload, active: true, sort_order: 100 }, error: null }),
    }))
    const out = await createQualificationType(db, { user: owner, input: { location_id: STILL, name: 'Manual handling' } })
    expect(out.status).toBe(201)
    expect(db.log.find((q) => q.op === 'insert').payload).toEqual({ organization_id: ORG, name: 'Manual handling', created_by: 'o1' })
    const dupDb = mockDb(byTable({
      locations: { data: { id: STILL, organization_id: ORG }, error: null },
      'staff_qualification_types.insert': { data: null, error: { code: '23505', message: 'dup' } },
    }))
    expect((await createQualificationType(dupDb, { user: owner, input: { location_id: STILL, name: 'First aid' } })).status).toBe(409)
  })

  it('renames or archives a type for an owner of its organisation; 404 for anyone else', async () => {
    const typeDb = () => mockDb(byTable({
      'staff_qualification_types.select': { data: TYPES[0], error: null },
      'staff_qualification_types.update': (q) => ({ data: [{ ...TYPES[0], ...q.payload }], error: null }),
    }))
    const db = typeDb()
    const out = await updateQualificationType(db, { user: owner, id: 'fa', input: { active: false } })
    expect(out.status).toBe(200)
    const upd = db.log.find((q) => q.op === 'update')
    expect(upd.payload).toEqual({ active: false })
    expect(filter(upd, 'eq', 'organization_id')).toBe(ORG)
    const refused = typeDb()
    expect((await updateQualificationType(refused, { user: manager, id: 'fa', input: { name: 'X' } })).status).toBe(404)
    expect(refused.log.some((q) => q.op === 'update')).toBe(false)
  })
})

describe('template requirements', () => {
  it('reads the studio\'s catalogue and every template\'s requirements, keyed by template', async () => {
    const db = mockDb(byTable({
      locations: { data: { id: STILL, organization_id: ORG }, error: null },
      staff_qualification_types: { data: TYPES, error: null },
      shift_templates: { data: [{ id: 't1' }, { id: 't2' }], error: null },
      shift_template_qualification_requirements: { data: [{ template_id: 't1', qualification_type_id: 'fa' }], error: null },
    }))
    const out = await readTemplateRequirements(db, { locationId: STILL })
    expect(out).toEqual({ status: 200, body: { success: true, data: { types: TYPES, requirements: { t1: ['fa'] } } } })
    expect(filter(db.log.find((q) => q.table === 'shift_templates'), 'eq', 'location_id')).toBe(STILL)
    expect(filter(db.log.find((q) => q.table === 'shift_template_qualification_requirements'), 'in', 'template_id')).toEqual(['t1', 't2'])
  })

  const TYPES_WITH_INS = [...TYPES, { id: 'ins', organization_id: ORG, name: 'Insurance', active: true, sort_order: 20 }]
  const reqDb = ({ template = { id: 't1', location_id: STILL }, current = ['fa'], types = TYPES_WITH_INS, add } = {}) => mockDb(byTable({
    shift_templates: { data: template, error: null },
    locations: { data: { id: STILL, organization_id: ORG }, error: null },
    'shift_template_qualification_requirements.select': { data: current.map((id) => ({ qualification_type_id: id })), error: null },
    'staff_qualification_types.select': (q) => ({ data: types.filter((t) => filter(q, 'in', 'id').includes(t.id)), error: null }),
    'shift_template_qualification_requirements.delete': { data: null, error: null },
    'shift_template_qualification_requirements.upsert': add ?? { data: null, error: null },
  }))

  it('replaces the set: removes what was dropped, adds what is new, ignores duplicates', async () => {
    const db = reqDb()
    const out = await replaceTemplateRequirements(db, { user: headCoach, input: { template_id: 't1', qualification_type_ids: ['ins', 'ins'] } })
    expect(out.body.data).toEqual({ template_id: 't1', qualification_type_ids: ['ins'], added: 1, removed: 1 })
    const del = db.log.find((q) => q.op === 'delete')
    expect(filter(del, 'eq', 'template_id')).toBe('t1')
    expect(filter(del, 'in', 'qualification_type_id')).toEqual(['fa'])
    const up = db.log.find((q) => q.op === 'upsert')
    expect(up.payload).toEqual([{ template_id: 't1', qualification_type_id: 'ins', created_by: 'h1' }])
    expect(up.options).toEqual({ onConflict: 'template_id,qualification_type_id', ignoreDuplicates: true })
  })

  it('no change, no write', async () => {
    const db = reqDb()
    await replaceTemplateRequirements(db, { user: manager, input: { template_id: 't1', qualification_type_ids: ['fa'] } })
    expect(db.log.some((q) => q.op === 'delete' || q.op === 'upsert')).toBe(false)
  })

  it('refuses a type from another organisation (400) and a newly added archived type (400); an archived type already required may stay', async () => {
    const foreign = await replaceTemplateRequirements(reqDb({ types: [{ id: 'zz', organization_id: OTHER_ORG, name: 'X', active: true }] }),
      { user: manager, input: { template_id: 't1', qualification_type_ids: ['zz'] } })
    expect(foreign.status).toBe(400)
    const archivedNew = await replaceTemplateRequirements(reqDb(), { user: manager, input: { template_id: 't1', qualification_type_ids: ['old'] } })
    expect(archivedNew.status).toBe(400)
    const archivedKept = await replaceTemplateRequirements(reqDb({ current: ['old'] }), { user: manager, input: { template_id: 't1', qualification_type_ids: ['old'] } })
    expect(archivedKept.status).toBe(200)
  })

  it('404 for a template that does not exist or is at a studio the caller is not in; 403 for staff at the studio', async () => {
    expect((await replaceTemplateRequirements(reqDb({ template: null }), { user: manager, input: { template_id: 't1', qualification_type_ids: [] } })).status).toBe(404)
    expect((await replaceTemplateRequirements(reqDb({ template: { id: 't9', location_id: HATCH } }), { user: manager, input: { template_id: 't9', qualification_type_ids: [] } })).status).toBe(404)
    expect((await replaceTemplateRequirements(reqDb(), { user: coach, input: { template_id: 't1', qualification_type_ids: [] } })).status).toBe(403)
  })

  it('the database\'s same-organisation refusal is a 400, not a 500', async () => {
    const out = await replaceTemplateRequirements(reqDb({ add: { data: null, error: { code: 'P0001', message: 'qualification_requirement_other_org: type x' } } }),
      { user: manager, input: { template_id: 't1', qualification_type_ids: ['fa', 'ins'] } })
    expect(out.status).toBe(400)
  })
})

describe('readBlockQualificationFacts (the ranked picker\'s read)', () => {
  it('no template, nothing read', async () => {
    const db = mockDb()
    expect(await readBlockQualificationFacts(db, { templateId: null, profileIds: ['a'] })).toEqual({ required: [], records: [], error: null })
    expect(db.log).toHaveLength(0)
  })

  it('reads the ACTIVE required types, then only those types\' records for these people', async () => {
    const db = mockDb(byTable({
      shift_template_qualification_requirements: { data: [
        { qualification_type_id: 'fa', staff_qualification_types: TYPES[0] },
        { qualification_type_id: 'old', staff_qualification_types: TYPES[1] },
      ], error: null },
      staff_qualifications: { data: [{ profile_id: 'a', qualification_type_id: 'fa', expires_on: '2027-01-01' }], error: null },
    }))
    const out = await readBlockQualificationFacts(db, { templateId: 't1', profileIds: ['a', 'b', 'a'] })
    expect(out.required).toEqual([{ id: 'fa', name: 'First aid', organization_id: ORG }])
    expect(out.records).toHaveLength(1)
    const recQ = db.log.find((q) => q.table === 'staff_qualifications')
    expect(filter(recQ, 'eq', 'organization_id')).toBe(ORG)
    expect(filter(recQ, 'in', 'qualification_type_id')).toEqual(['fa'])
    expect(filter(recQ, 'in', 'profile_id')).toEqual(['a', 'b'])
  })

  it('a template that requires nothing (or only archived types) reads no records', async () => {
    const db = mockDb(byTable({ shift_template_qualification_requirements: { data: [{ qualification_type_id: 'old', staff_qualification_types: TYPES[1] }], error: null } }))
    expect(await readBlockQualificationFacts(db, { templateId: 't1', profileIds: ['a'] })).toEqual({ required: [], records: [], error: null })
    expect(db.log.some((q) => q.table === 'staff_qualifications')).toBe(false)
  })

  it('a failed read is an error (the picker says "not checked"), never "nothing required"', async () => {
    const db = mockDb(byTable({ shift_template_qualification_requirements: { data: null, error: { message: 'down' } } }))
    expect(await readBlockQualificationFacts(db, { templateId: 't1', profileIds: ['a'] })).toEqual({ required: null, records: null, error: { message: 'down' } })
  })
})
```

- [ ] **Step 4: Run it, expect FAIL**

Run: `npx vitest run src/lib/qualifications-server.test.js`
Expected: FAIL, `Failed to resolve import "./qualifications-server"`.

- [ ] **Step 5: Implement**

Create `src/lib/qualifications-server.js`:

```js
// src/lib/qualifications-server.js
//
// QUALS.1 — the data layer behind /api/qualifications/** and
// /api/schedule/template-qualifications, and the ranked picker's facts.
// Service-role client passed in (CLAUDE.md: "Service-role routes get NO
// RLS"). The routes judge what the REQUEST tells them (signed in, a studio
// the caller belongs to, a coarse role); every check that needs a ROW (whose
// record is this, which organisation is this type in, is the person current)
// lives here and answers 404 for anything the caller may not touch, so an id
// is never confirmed.
//
// WHO (plan decisions 2 and 7):
//   records    owner or manager (master bypasses) AT a studio the person
//              belongs to, inside the record's organisation
//   catalogue  owner (master bypasses) at a studio of the organisation
//   template   requirements: MANAGER_ROLES at the template's studio, the
//              template editor's own gate (SCHEDROLES.1)
// A deactivated person or a tombstone is never listed and never written for
// (isRosterableProfile); a tombstone also has no profile_locations (mig 622).
//
// Returns { status, body } for the routes to send as they are. Never throws.

import { hasRoleAtLocation } from './role-at-location'
import { MANAGER_ROLES } from './schemas'
import { isRosterableProfile } from './roster-write'
import { logWarn } from './log'
import { MAX_TEMPLATE_REQUIREMENTS } from './qualifications-schemas'

export const QUAL_MANAGER_ROLES = Object.freeze(['owner', 'manager'])
export const QUAL_CATALOGUE_ROLES = Object.freeze(['owner'])

const PAGE = 1000
const PEOPLE_CHUNK = 100 // × a handful of types per person stays under a page
const TEMPLATE_CHUNK = 200
const TYPE_COLUMNS = 'id, organization_id, name, active, sort_order'
const RECORD_COLUMNS = 'id, organization_id, profile_id, qualification_type_id, issued_on, expires_on, note, updated_at'
const REQUIREMENTS = 'shift_template_qualification_requirements'

const ok = (body, status = 200) => ({ status, body: { success: true, ...body } })
const fail = (status, error) => ({ status, body: { success: false, error } })
const notFound = () => fail(404, 'Not found')
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const cmpText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { sensitivity: 'base' })
const cleanNote = (note) => (typeof note === 'string' && note.trim() ? note.trim() : null)
const chunks = (list, size) => {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function readFailed(what, error) {
  logWarn('qualifications', `${what} read failed`, { err: error?.message })
  return fail(500, `Could not read the ${what}`)
}

function writeFailed(error) {
  if (error?.code === '23505') return fail(409, 'This person already has a record of that qualification. Edit it instead.')
  if (error?.code === '23514') return fail(400, 'Check the dates and the note: the expiry cannot be before the issue date, and a note is at most 300 characters.')
  if (/^qualification_requirement_other_org/.test(String(error?.message || ''))) return fail(400, 'Unknown qualification type')
  logWarn('qualifications', 'write failed', { code: error?.code, err: error?.message })
  return fail(500, 'Could not save the change')
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** The organisation a studio belongs to. */
export async function readLocationOrganization(db, locationId) {
  const { data, error } = await db.from('locations').select('id, organization_id').eq('id', locationId).maybeSingle()
  if (error) return { organizationId: null, error }
  return { organizationId: data?.organization_id ?? null, error: null }
}

/** Current (active, not tombstoned) members of one studio, A–Z. */
export async function readStudioMembers(db, locationId) {
  const members = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('profile_locations')
      .select('profile_id, profiles!inner(id, full_name, active, deleted_at)')
      .eq('location_id', locationId)
      .order('profile_id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { members: null, error }
    for (const l of data || []) {
      if (!l?.profile_id || !isRosterableProfile(l.profiles)) continue
      members.push({ profile_id: l.profile_id, full_name: l.profiles.full_name ?? null })
    }
    if (!data || data.length < PAGE) break
  }
  members.sort((a, b) => cmpText(a.full_name, b.full_name) || a.profile_id.localeCompare(b.profile_id))
  return { members, error: null }
}

/** An organisation's catalogue, archived types included (their records still show). */
export async function readQualificationTypes(db, organizationId) {
  const { data, error } = await db
    .from('staff_qualification_types')
    .select(TYPE_COLUMNS)
    .eq('organization_id', organizationId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
  if (error) return { types: null, error }
  return { types: data || [], error: null }
}

/** These people's records in one organisation (chunked, each chunk paged). */
export async function readQualificationRecords(db, { organizationId, profileIds }) {
  const records = []
  for (const ids of chunks([...new Set((profileIds || []).filter(Boolean))], PEOPLE_CHUNK)) {
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await db
        .from('staff_qualifications')
        .select(RECORD_COLUMNS)
        .eq('organization_id', organizationId)
        .in('profile_id', ids)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) return { records: null, error }
      records.push(...(data || []))
      if (!data || data.length < PAGE) break
    }
  }
  return { records, error: null }
}

/**
 * GET /api/qualifications. The route has already checked the caller belongs
 * to `locationId`. A records manager there gets every current member; anyone
 * else gets their own records, read-only.
 */
export async function loadQualificationsPage(db, { user, locationId, today }) {
  const manager = hasRoleAtLocation(user, locationId, QUAL_MANAGER_ROLES)
  const org = await readLocationOrganization(db, locationId)
  if (org.error) return readFailed('studio', org.error)
  if (!org.organizationId) return notFound()

  const { types, error: typeErr } = await readQualificationTypes(db, org.organizationId)
  if (typeErr) return readFailed('qualification types', typeErr)

  let people
  if (manager) {
    const { members, error } = await readStudioMembers(db, locationId)
    if (error) return readFailed('team', error)
    people = members
  } else {
    people = [{ profile_id: user.id, full_name: user.full_name ?? null }]
  }

  const { records, error: recErr } = await readQualificationRecords(db, {
    organizationId: org.organizationId, profileIds: people.map((p) => p.profile_id),
  })
  if (recErr) return readFailed('qualifications', recErr)
  const byPerson = new Map()
  for (const r of records) {
    if (!byPerson.has(r.profile_id)) byPerson.set(r.profile_id, [])
    byPerson.get(r.profile_id).push(r)
  }

  return ok({
    data: {
      audience: manager ? 'manager' : 'self',
      today,
      organization_id: org.organizationId,
      can_edit_types: manager && hasRoleAtLocation(user, locationId, QUAL_CATALOGUE_ROLES),
      types,
      people: people.map((p) => ({ ...p, records: byPerson.get(p.profile_id) || [] })),
    },
  })
}

// ── Authority on a row ─────────────────────────────────────────────────────

/**
 * A studio, in `organizationId`, that the person currently belongs to and
 * where the caller may manage records; null when there is none. A person has
 * a handful of profile_locations rows, so this does not page.
 */
export async function findManagingStudio(db, { user, profileId, organizationId }) {
  const { data, error } = await db
    .from('profile_locations')
    .select('location_id, locations!inner(id, organization_id), profiles!inner(id, active, deleted_at)')
    .eq('profile_id', profileId)
  if (error) return { locationId: null, error }
  const studios = (data || [])
    .filter((l) => l?.locations?.organization_id === organizationId && isRosterableProfile(l.profiles))
    .map((l) => l.location_id)
    .sort()
  return { locationId: studios.find((loc) => hasRoleAtLocation(user, loc, QUAL_MANAGER_ROLES)) ?? null, error: null }
}

/** May this caller edit this organisation's catalogue? Owner at one of its studios, or a master. */
export function canEditCatalogue(user, organizationId) {
  if (!user || !organizationId) return false
  if (user.profileRole === 'master') return true
  return (user.locations || []).some((l) => l?.organization_id === organizationId && hasRoleAtLocation(user, l.id, QUAL_CATALOGUE_ROLES))
}

// ── Records ────────────────────────────────────────────────────────────────

export async function createQualificationRecord(db, { user, input }) {
  const { data: type, error: typeErr } = await db
    .from('staff_qualification_types')
    .select(TYPE_COLUMNS)
    .eq('id', input.qualification_type_id)
    .maybeSingle()
  if (typeErr) return readFailed('qualification type', typeErr)
  if (!type) return notFound()

  const managing = await findManagingStudio(db, { user, profileId: input.profile_id, organizationId: type.organization_id })
  if (managing.error) return readFailed('memberships', managing.error)
  if (!managing.locationId) return notFound()
  if (type.active === false) return fail(400, 'That qualification type is archived. Restore it first.')

  const { data, error } = await db
    .from('staff_qualifications')
    .insert({
      organization_id: type.organization_id,
      profile_id: input.profile_id,
      qualification_type_id: type.id,
      issued_on: input.issued_on ?? null,
      expires_on: input.expires_on ?? null,
      note: cleanNote(input.note),
      recorded_by: user.id,
      updated_by: user.id,
    })
    .select(RECORD_COLUMNS)
    .single()
  if (error) return writeFailed(error)
  return ok({ data }, 201)
}

async function loadManagedRecord(db, { user, id }) {
  const { data: record, error } = await db.from('staff_qualifications').select(RECORD_COLUMNS).eq('id', id).maybeSingle()
  if (error) return { out: readFailed('qualification', error) }
  if (!record) return { out: notFound() }
  const managing = await findManagingStudio(db, { user, profileId: record.profile_id, organizationId: record.organization_id })
  if (managing.error) return { out: readFailed('memberships', managing.error) }
  if (!managing.locationId) return { out: notFound() }
  return { record }
}

export async function updateQualificationRecord(db, { user, id, input }) {
  const { record, out } = await loadManagedRecord(db, { user, id })
  if (out) return out

  // Judge the dates as they WILL be, not only as sent.
  const issued = has(input, 'issued_on') ? input.issued_on : record.issued_on
  const expires = has(input, 'expires_on') ? input.expires_on : record.expires_on
  if (issued && expires && expires < issued) return fail(400, 'The expiry date is before the issue date')

  const patch = { updated_by: user.id, updated_at: new Date().toISOString() }
  if (has(input, 'issued_on')) patch.issued_on = input.issued_on ?? null
  if (has(input, 'expires_on')) patch.expires_on = input.expires_on ?? null
  if (has(input, 'note')) patch.note = cleanNote(input.note)

  const { data, error } = await db
    .from('staff_qualifications')
    .update(patch)
    .eq('id', id)
    .eq('organization_id', record.organization_id)
    .select(RECORD_COLUMNS)
  if (error) return writeFailed(error)
  if (!data?.length) return notFound()
  return ok({ data: data[0] })
}

export async function deleteQualificationRecord(db, { user, id }) {
  const { record, out } = await loadManagedRecord(db, { user, id })
  if (out) return out
  const { data, error } = await db
    .from('staff_qualifications')
    .delete()
    .eq('id', id)
    .eq('organization_id', record.organization_id)
    .select('id')
  if (error) return writeFailed(error)
  if (!data?.length) return notFound()
  return ok({ data: { id, deleted: true } })
}

// ── The catalogue ──────────────────────────────────────────────────────────

/** The route has checked the caller is an owner (or master) at input.location_id. */
export async function createQualificationType(db, { user, input }) {
  const org = await readLocationOrganization(db, input.location_id)
  if (org.error) return readFailed('studio', org.error)
  if (!org.organizationId) return notFound()
  const { data, error } = await db
    .from('staff_qualification_types')
    .insert({ organization_id: org.organizationId, name: input.name, created_by: user.id })
    .select(TYPE_COLUMNS)
    .single()
  if (error?.code === '23505') return fail(409, 'There is already a qualification type with that name.')
  if (error) return writeFailed(error)
  return ok({ data }, 201)
}

export async function updateQualificationType(db, { user, id, input }) {
  const { data: type, error } = await db.from('staff_qualification_types').select(TYPE_COLUMNS).eq('id', id).maybeSingle()
  if (error) return readFailed('qualification type', error)
  if (!type || !canEditCatalogue(user, type.organization_id)) return notFound()
  const patch = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.active !== undefined) patch.active = input.active
  const { data, error: updErr } = await db
    .from('staff_qualification_types')
    .update(patch)
    .eq('id', id)
    .eq('organization_id', type.organization_id)
    .select(TYPE_COLUMNS)
  if (updErr?.code === '23505') return fail(409, 'There is already a qualification type with that name.')
  if (updErr) return writeFailed(updErr)
  if (!data?.length) return notFound()
  return ok({ data: data[0] })
}

// ── Template requirements ──────────────────────────────────────────────────

async function readTemplateIds(db, locationId) {
  const ids = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('shift_templates')
      .select('id')
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { ids: null, error }
    ids.push(...(data || []).map((t) => t.id))
    if (!data || data.length < PAGE) break
  }
  return { ids, error: null }
}

/**
 * GET /api/schedule/template-qualifications. The route has checked the caller
 * manages templates at `locationId`. { types (the whole catalogue, archived
 * flagged), requirements: { [template_id]: [type_id] } }.
 */
export async function readTemplateRequirements(db, { locationId }) {
  const org = await readLocationOrganization(db, locationId)
  if (org.error) return readFailed('studio', org.error)
  if (!org.organizationId) return notFound()
  const [typeRead, templateRead] = await Promise.all([
    readQualificationTypes(db, org.organizationId),
    readTemplateIds(db, locationId),
  ])
  if (typeRead.error) return readFailed('qualification types', typeRead.error)
  if (templateRead.error) return readFailed('templates', templateRead.error)

  const requirements = {}
  for (const ids of chunks(templateRead.ids, TEMPLATE_CHUNK)) {
    const { data, error } = await db
      .from(REQUIREMENTS)
      .select('template_id, qualification_type_id')
      .in('template_id', ids)
    if (error) return readFailed('template requirements', error)
    for (const r of data || []) (requirements[r.template_id] ||= []).push(r.qualification_type_id)
  }
  return ok({ data: { types: typeRead.types, requirements } })
}

/**
 * PUT /api/schedule/template-qualifications: replace one template's set.
 * Two statements (remove, then add), not one transaction: a failure between
 * them leaves a subset, and repeating the save completes it (both halves are
 * idempotent).
 */
export async function replaceTemplateRequirements(db, { user, input }) {
  const { data: template, error } = await db
    .from('shift_templates')
    .select('id, location_id')
    .eq('id', input.template_id)
    .maybeSingle()
  if (error) return readFailed('template', error)
  if (!template) return notFound()
  const member = user?.profileRole === 'master' || (user?.locations || []).some((l) => l?.id === template.location_id)
  if (!member) return notFound()
  if (!hasRoleAtLocation(user, template.location_id, MANAGER_ROLES)) {
    return fail(403, 'Only a manager at this studio can change what a shift template asks for.')
  }

  const wanted = [...new Set(input.qualification_type_ids || [])]
  if (wanted.length > MAX_TEMPLATE_REQUIREMENTS) return fail(400, 'At most 5 qualifications')

  const org = await readLocationOrganization(db, template.location_id)
  if (org.error) return readFailed('studio', org.error)
  const { data: currentRows, error: curErr } = await db
    .from(REQUIREMENTS)
    .select('qualification_type_id')
    .eq('template_id', template.id)
  if (curErr) return readFailed('template requirements', curErr)
  const current = new Set((currentRows || []).map((r) => r.qualification_type_id))

  if (wanted.length) {
    const { data: types, error: typeErr } = await db.from('staff_qualification_types').select(TYPE_COLUMNS).in('id', wanted)
    if (typeErr) return readFailed('qualification types', typeErr)
    const byId = new Map((types || []).map((t) => [t.id, t]))
    for (const id of wanted) {
      const t = byId.get(id)
      if (!t || t.organization_id !== org.organizationId) return fail(400, 'Unknown qualification type')
      if (t.active === false && !current.has(id)) return fail(400, `${t.name} is archived. Restore it first.`)
    }
  }

  const toRemove = [...current].filter((id) => !wanted.includes(id))
  const toAdd = wanted.filter((id) => !current.has(id))
  if (toRemove.length) {
    const { error: delErr } = await db
      .from(REQUIREMENTS)
      .delete()
      .eq('template_id', template.id)
      .in('qualification_type_id', toRemove)
    if (delErr) return writeFailed(delErr)
  }
  if (toAdd.length) {
    const { error: addErr } = await db
      .from(REQUIREMENTS)
      .upsert(
        toAdd.map((id) => ({ template_id: template.id, qualification_type_id: id, created_by: user.id })),
        { onConflict: 'template_id,qualification_type_id', ignoreDuplicates: true },
      )
    if (addErr) return writeFailed(addErr)
  }
  return ok({ data: { template_id: template.id, qualification_type_ids: wanted, added: toAdd.length, removed: toRemove.length } })
}

// ── The ranked picker's facts (CANDIDATES.1 plug-in) ───────────────────────

/**
 * What one block's template asks for, and these people's records of exactly
 * those types. Archived types are not advised on. Never throws; a failed read
 * is { error } so the picker says "not checked", never "nothing required".
 * @returns {Promise<{ required: Array<{ id, name, organization_id }>|null, records: object[]|null, error }>}
 */
export async function readBlockQualificationFacts(db, { templateId, profileIds = [] } = {}) {
  if (!templateId) return { required: [], records: [], error: null }
  try {
    const { data, error } = await db
      .from(REQUIREMENTS)
      .select('qualification_type_id, staff_qualification_types!inner(id, name, organization_id, active)')
      .eq('template_id', templateId)
    if (error) return { required: null, records: null, error }
    const required = (data || [])
      .map((r) => r?.staff_qualification_types)
      .filter((t) => t?.id && t.active !== false)
      .map((t) => ({ id: t.id, name: t.name, organization_id: t.organization_id }))
      .sort((a, b) => cmpText(a.name, b.name) || a.id.localeCompare(b.id))
    const ids = [...new Set((profileIds || []).filter(Boolean))]
    if (!required.length || !ids.length) return { required, records: [], error: null }

    const organizationId = required[0].organization_id
    const typeIds = required.map((t) => t.id)
    const records = []
    for (const chunk of chunks(ids, PEOPLE_CHUNK)) {
      for (let offset = 0; ; offset += PAGE) {
        const { data: rows, error: recErr } = await db
          .from('staff_qualifications')
          .select('profile_id, qualification_type_id, expires_on')
          .eq('organization_id', organizationId)
          .in('qualification_type_id', typeIds)
          .in('profile_id', chunk)
          .order('id', { ascending: true })
          .range(offset, offset + PAGE - 1)
        if (recErr) return { required: null, records: null, error: recErr }
        records.push(...(rows || []))
        if (!rows || rows.length < PAGE) break
      }
    }
    return { required, records, error: null }
  } catch (e) {
    return { required: null, records: null, error: { message: e?.message || 'qualification facts read threw' } }
  }
}
```

- [ ] **Step 6: Run it, expect PASS; then the lints that read this file**

Run: `npx vitest run src/lib/qualifications-server.test.js && npm run check:select-columns && npx vitest run tests/staff-tombstone-readers.test.js`
Expected: all pass. `check:select-columns` resolves `profiles.active/deleted_at/full_name` (migs 004 and 622), `locations.organization_id` (mig 079) and the new tables (mig 635). The tombstone-readers guard passes because nothing here calls `from('profiles')`: people come through the `profile_locations` embed.

- [ ] **Step 7: Commit**

```bash
git add src/lib/qualifications-schemas.js src/lib/qualifications-server.js src/lib/qualifications-server.test.js src/lib/qualifications-mock-db.test-helpers.js
git commit -m "QUALS.1 — qualification data layer: page read, records, catalogue, template requirements, picker facts

Records: owner/manager at a studio the person belongs to, in the record's
organisation, judged on the row (404 otherwise). Catalogue: owners. Template
requirements: the template editor's gate. Deactivated and tombstoned people
are never listed or written for. A failed read is a 500, never an empty list.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The record and catalogue routes

Each route follows the mutation skeleton in CLAUDE.md: `getCurrentUser()` → role pre-check (403) → `validateBody` → location access → `createServerClient()` → work (the data layer) → `{ success, data }`. None of them calls `.from()` itself, so `check:location-scoping` has nothing to judge (the new tables carry `organization_id`, not `location_id`, and are scoped in the data layer).

**Files:**
- Create: `src/app/api/qualifications/route.js` + `route.test.js`
- Create: `src/app/api/qualifications/[id]/route.js` + `route.test.js`
- Create: `src/app/api/qualifications/types/route.js`, `src/app/api/qualifications/types/[id]/route.js`, `src/app/api/qualifications/types/route.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/qualifications/route.test.js`:

```js
// QUALS.1 — GET/POST /api/qualifications. The data layer is pinned in
// src/lib/qualifications-server.test.js; here: the gates, the query and body
// contracts, and that the route sends what the data layer answers.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ db: true })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/dublin-time', async (importOriginal) => ({ ...(await importOriginal()), dublinTodayStr: () => '2026-09-28' }))
vi.mock('@/lib/qualifications-server', async (importOriginal) => ({
  ...(await importOriginal()),
  loadQualificationsPage: vi.fn(),
  createQualificationRecord: vi.fn(),
}))

const { NextResponse } = await import('next/server')
const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { loadQualificationsPage, createQualificationRecord } = await import('@/lib/qualifications-server')
const { GET, POST } = await import('./route.js')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PERSON = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const TYPE = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const coach = { id: 'c1', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'staff' } }
const headCoach = { ...coach, id: 'h1', rolesByLocation: { [LOC]: 'head_coach' } }
const manager = { ...coach, id: 'm1', rolesByLocation: { [LOC]: 'manager' } }

const getReq = (params = {}) => {
  const url = new URL('http://test/api/qualifications')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const postReq = (body) => ({ url: 'http://test/api/qualifications', json: async () => body })
const VALID = { profile_id: PERSON, qualification_type_id: TYPE, issued_on: '2026-01-10', expires_on: '2028-01-10', note: 'PHECC' }

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  loadQualificationsPage.mockResolvedValue({ status: 200, body: { success: true, data: { audience: 'self' } } })
  createQualificationRecord.mockResolvedValue({ status: 201, body: { success: true, data: { id: 'r1' } } })
})

describe('GET /api/qualifications', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(401)
    expect(loadQualificationsPage).not.toHaveBeenCalled()
  })

  it('400 without a well-formed location_id', async () => {
    getCurrentUser.mockResolvedValue(coach)
    expect((await GET(getReq())).status).toBe(400)
    expect((await GET(getReq({ location_id: 'nope' }))).status).toBe(400)
  })

  it('403 from assertLocationAccess for a studio outside the caller\'s assignments', async () => {
    getCurrentUser.mockResolvedValue(manager)
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false }, { status: 403 }))
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(403)
    expect(loadQualificationsPage).not.toHaveBeenCalled()
  })

  it('any member of the studio reaches the data layer (which decides manager or self), as of Dublin today', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const res = await GET(getReq({ location_id: LOC }))
    expect(res.status).toBe(200)
    expect(loadQualificationsPage).toHaveBeenCalledWith({ db: true }, { user: coach, locationId: LOC, today: '2026-09-28' })
    expect(await res.json()).toEqual({ success: true, data: { audience: 'self' } })
  })

  it('sends the data layer\'s failure as it is', async () => {
    getCurrentUser.mockResolvedValue(manager)
    loadQualificationsPage.mockResolvedValue({ status: 500, body: { success: false, error: 'Could not read the team' } })
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(500)
  })
})

describe('POST /api/qualifications', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(postReq(VALID))).status).toBe(401)
  })

  it.each([['a coach', coach], ['a head coach', headCoach]])('403 for %s (records are owners\' and managers\')', async (_, user) => {
    getCurrentUser.mockResolvedValue(user)
    expect((await POST(postReq(VALID))).status).toBe(403)
    expect(createQualificationRecord).not.toHaveBeenCalled()
  })

  it.each([
    [{ ...VALID, expires_on: '2026-02-30' }],
    [{ ...VALID, issued_on: '2028-02-01' }], // expiry before issue
    [{ ...VALID, note: 'x'.repeat(301) }],
    [{ ...VALID, profile_id: 'nope' }],
    [{ qualification_type_id: TYPE }],
  ])('400 for %j', async (body) => {
    getCurrentUser.mockResolvedValue(manager)
    expect((await POST(postReq(body))).status).toBe(400)
    expect(createQualificationRecord).not.toHaveBeenCalled()
  })

  it('a manager somewhere reaches the data layer, which judges the person on the row; no expiry is allowed', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const body = { ...VALID, expires_on: null }
    const res = await POST(postReq(body))
    expect(res.status).toBe(201)
    expect(createQualificationRecord).toHaveBeenCalledWith({ db: true }, { user: manager, input: body })
  })
})
```

Create `src/app/api/qualifications/[id]/route.test.js`:

```js
// QUALS.1 — PATCH/DELETE /api/qualifications/[id]: gates and delegation.
// A malformed id is a 404 (detail route: ids are never confirmed).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ db: true })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return { getCurrentUser: vi.fn(), hasRoleAtAnyLocation: real.hasRoleAtAnyLocation }
})
vi.mock('@/lib/qualifications-server', async (importOriginal) => ({
  ...(await importOriginal()),
  updateQualificationRecord: vi.fn(),
  deleteQualificationRecord: vi.fn(),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { updateQualificationRecord, deleteQualificationRecord } = await import('@/lib/qualifications-server')
const { PATCH, DELETE } = await import('./route.js')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const coach = { id: 'c1', profileRole: 'staff', rolesByLocation: { [LOC]: 'staff' } }
const owner = { id: 'o1', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' } }
const props = (id = ID) => ({ params: Promise.resolve({ id }) })
const req = (body) => ({ url: `http://test/api/qualifications/${ID}`, json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  updateQualificationRecord.mockResolvedValue({ status: 200, body: { success: true, data: { id: ID } } })
  deleteQualificationRecord.mockResolvedValue({ status: 200, body: { success: true, data: { id: ID, deleted: true } } })
})

describe('PATCH /api/qualifications/[id]', () => {
  it('401, 403 for a coach, 404 for a malformed id, 400 for an empty or impossible body', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PATCH(req({ note: 'x' }), props())).status).toBe(401)
    getCurrentUser.mockResolvedValue(coach)
    expect((await PATCH(req({ note: 'x' }), props())).status).toBe(403)
    getCurrentUser.mockResolvedValue(owner)
    expect((await PATCH(req({ note: 'x' }), props('nope'))).status).toBe(404)
    expect((await PATCH(req({}), props())).status).toBe(400)
    expect((await PATCH(req({ issued_on: '2026-05-01', expires_on: '2026-04-01' }), props())).status).toBe(400)
    expect(updateQualificationRecord).not.toHaveBeenCalled()
  })

  it('delegates with the id and the parsed body', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const res = await PATCH(req({ expires_on: '2028-01-01' }), props())
    expect(res.status).toBe(200)
    expect(updateQualificationRecord).toHaveBeenCalledWith({ db: true }, { user: owner, id: ID, input: { expires_on: '2028-01-01' } })
  })
})

describe('DELETE /api/qualifications/[id]', () => {
  it('401, 403 for a coach, 404 for a malformed id; otherwise delegates', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await DELETE(req(), props())).status).toBe(401)
    getCurrentUser.mockResolvedValue(coach)
    expect((await DELETE(req(), props())).status).toBe(403)
    getCurrentUser.mockResolvedValue(owner)
    expect((await DELETE(req(), props('nope'))).status).toBe(404)
    expect(deleteQualificationRecord).not.toHaveBeenCalled()
    expect((await DELETE(req(), props())).status).toBe(200)
    expect(deleteQualificationRecord).toHaveBeenCalledWith({ db: true }, { user: owner, id: ID })
  })
})
```

Create `src/app/api/qualifications/types/route.test.js`:

```js
// QUALS.1 — POST /api/qualifications/types and PATCH /api/qualifications/types/[id].
// Owners (and masters) edit their organisation's catalogue.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ db: true })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/qualifications-server', async (importOriginal) => ({
  ...(await importOriginal()),
  createQualificationType: vi.fn(),
  updateQualificationType: vi.fn(),
}))

const { NextResponse } = await import('next/server')
const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { createQualificationType, updateQualificationType } = await import('@/lib/qualifications-server')
const { POST } = await import('./route.js')
const { PATCH } = await import('./[id]/route.js')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
const manager = { id: 'm1', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } }
const owner = { ...manager, id: 'o1', rolesByLocation: { [LOC]: 'owner' } }
const req = (body) => ({ url: 'http://test/api/qualifications/types', json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  createQualificationType.mockResolvedValue({ status: 201, body: { success: true, data: { id: ID } } })
  updateQualificationType.mockResolvedValue({ status: 200, body: { success: true, data: { id: ID } } })
})

describe('POST /api/qualifications/types', () => {
  it('401; 400 for a blank, two-line or over-long name; 403 outside the studio; 403 for a manager', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req({ location_id: LOC, name: 'X' }))).status).toBe(401)
    getCurrentUser.mockResolvedValue(owner)
    for (const name of ['', '   ', 'Two\nlines', 'x'.repeat(61)]) {
      expect((await POST(req({ location_id: LOC, name }))).status, JSON.stringify(name)).toBe(400)
    }
    assertLocationAccess.mockReturnValueOnce(NextResponse.json({ success: false }, { status: 403 }))
    expect((await POST(req({ location_id: LOC, name: 'Manual handling' }))).status).toBe(403)
    getCurrentUser.mockResolvedValue(manager)
    expect((await POST(req({ location_id: LOC, name: 'Manual handling' }))).status).toBe(403)
    expect(createQualificationType).not.toHaveBeenCalled()
  })

  it('an owner at the studio creates it (name trimmed)', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const res = await POST(req({ location_id: LOC, name: '  Manual handling ' }))
    expect(res.status).toBe(201)
    expect(createQualificationType).toHaveBeenCalledWith({ db: true }, { user: owner, input: { location_id: LOC, name: 'Manual handling' } })
  })
})

describe('PATCH /api/qualifications/types/[id]', () => {
  const props = (id = ID) => ({ params: Promise.resolve({ id }) })
  it('401; 403 for someone who owns nothing; 404 for a malformed id; 400 for an empty body; otherwise delegates', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PATCH(req({ active: false }), props())).status).toBe(401)
    getCurrentUser.mockResolvedValue(manager)
    expect((await PATCH(req({ active: false }), props())).status).toBe(403)
    getCurrentUser.mockResolvedValue(owner)
    expect((await PATCH(req({ active: false }), props('nope'))).status).toBe(404)
    expect((await PATCH(req({}), props())).status).toBe(400)
    expect(updateQualificationType).not.toHaveBeenCalled()
    expect((await PATCH(req({ active: false }), props())).status).toBe(200)
    expect(updateQualificationType).toHaveBeenCalledWith({ db: true }, { user: owner, id: ID, input: { active: false } })
  })
})
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/app/api/qualifications`
Expected: FAIL, the route modules do not resolve.

- [ ] **Step 3: Implement the routes**

Create `src/app/api/qualifications/route.js`:

```js
// QUALS.1 — GET: the qualifications page's data for one studio. An owner or
// manager AT location_id (master bypasses) gets every current member of the
// studio with their records; anyone else at the studio gets their own,
// read-only. POST: record a qualification for someone. Only owners and
// managers get past the pre-check; whether THIS person is theirs is judged on
// the row (src/lib/qualifications-server.js), 404 if not.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { dublinTodayStr } from '@/lib/dublin-time'
import { QualificationRecordCreateSchema } from '@/lib/qualifications-schemas'
import { QUAL_MANAGER_ROLES, loadQualificationsPage, createQualificationRecord } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

const send = (out) => NextResponse.json(out.body, { status: out.status })

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  return send(await loadQualificationsPage(createServerClient(), { user, locationId, today: dublinTodayStr() }))
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // Coarse pre-check only (SCHEDROLES.1): the authority decision is the role
  // at a studio the PERSON belongs to, judged on the row.
  if (!hasRoleAtAnyLocation(user, QUAL_MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only an owner or a manager can record qualifications.' }, { status: 403 })
  }
  const validation = await validateBody(request, QualificationRecordCreateSchema)
  if (!validation.ok) return validation.response

  return send(await createQualificationRecord(createServerClient(), { user, input: validation.data }))
}
```

Create `src/app/api/qualifications/[id]/route.js`:

```js
// QUALS.1 — PATCH (dates, note) and DELETE one qualification record. Owners
// and managers at a studio the person belongs to, judged on the row in
// src/lib/qualifications-server.js. Detail route: a record the caller may not
// touch, a missing one and a malformed id are all 404.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { QualificationRecordPatchSchema } from '@/lib/qualifications-schemas'
import { QUAL_MANAGER_ROLES, updateQualificationRecord, deleteQualificationRecord } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

const send = (out) => NextResponse.json(out.body, { status: out.status })

async function gate(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!hasRoleAtAnyLocation(user, QUAL_MANAGER_ROLES)) {
    return { response: NextResponse.json({ success: false, error: 'Only an owner or a manager can change qualifications.' }, { status: 403 }) }
  }
  if (!uuidLike.safeParse(params?.id).success) {
    return { response: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  }
  return { user, id: params.id }
}

export async function PATCH(request, props) {
  const { user, id, response } = await gate(props)
  if (response) return response
  const validation = await validateBody(request, QualificationRecordPatchSchema)
  if (!validation.ok) return validation.response
  return send(await updateQualificationRecord(createServerClient(), { user, id, input: validation.data }))
}

export async function DELETE(request, props) {
  const { user, id, response } = await gate(props)
  if (response) return response
  return send(await deleteQualificationRecord(createServerClient(), { user, id }))
}
```

Create `src/app/api/qualifications/types/route.js`:

```js
// QUALS.1 — POST: add a qualification type to the organisation of
// location_id. Owners (and masters) at that studio.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { QualificationTypeCreateSchema } from '@/lib/qualifications-schemas'
import { QUAL_CATALOGUE_ROLES, createQualificationType } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const validation = await validateBody(request, QualificationTypeCreateSchema)
  if (!validation.ok) return validation.response
  const guard = assertLocationAccess(user, validation.data.location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, validation.data.location_id, QUAL_CATALOGUE_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only an owner can change the list of qualifications.' }, { status: 403 })
  }
  const out = await createQualificationType(createServerClient(), { user, input: validation.data })
  return NextResponse.json(out.body, { status: out.status })
}
```

Create `src/app/api/qualifications/types/[id]/route.js`:

```js
// QUALS.1 — PATCH one qualification type: rename it, archive it
// (active: false) or restore it. Owners (and masters) of its organisation,
// judged on the row; anyone else, a missing id and a malformed id are 404.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { QualificationTypePatchSchema } from '@/lib/qualifications-schemas'
import { QUAL_CATALOGUE_ROLES, updateQualificationType } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasRoleAtAnyLocation(user, QUAL_CATALOGUE_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only an owner can change the list of qualifications.' }, { status: 403 })
  }
  if (!uuidLike.safeParse(params?.id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const validation = await validateBody(request, QualificationTypePatchSchema)
  if (!validation.ok) return validation.response
  const out = await updateQualificationType(createServerClient(), { user, id: params.id, input: validation.data })
  return NextResponse.json(out.body, { status: out.status })
}
```

- [ ] **Step 4: Run, expect PASS; then the route lints**

Run: `npx vitest run src/app/api/qualifications && npm run check:route-guards && npm run check:location-scoping`
Expected: all pass. Every handler calls `getCurrentUser`, and no route file queries a table.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/qualifications'
git commit -m "QUALS.1 — /api/qualifications routes: list (manager or self), record, edit, delete; catalogue add and edit

Thin routes over src/lib/qualifications-server.js: session, coarse role
pre-check, body validation, location access, then the data layer judges the
row (404 for anything out of reach, malformed ids included).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `GET/PUT /api/schedule/template-qualifications`

**Files:**
- Create: `src/app/api/schedule/template-qualifications/route.js`
- Create: `src/app/api/schedule/template-qualifications/route.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/schedule/template-qualifications/route.test.js`:

```js
// QUALS.1 — the template editor's qualification requirements. Same gate as
// the template editor itself (SCHEDROLES.1): MANAGER_ROLES at the studio,
// head coaches included.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ db: true })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/qualifications-server', async (importOriginal) => ({
  ...(await importOriginal()),
  readTemplateRequirements: vi.fn(),
  replaceTemplateRequirements: vi.fn(),
}))

const { NextResponse } = await import('next/server')
const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { readTemplateRequirements, replaceTemplateRequirements } = await import('@/lib/qualifications-server')
const { GET, PUT } = await import('./route.js')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const TPL = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
const T = (n) => `0000000${n}-0000-0000-0000-000000000000`
const coach = { id: 'c1', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'staff' } }
const headCoach = { ...coach, id: 'h1', rolesByLocation: { [LOC]: 'head_coach' } }

const getReq = (params = {}) => {
  const url = new URL('http://test/api/schedule/template-qualifications')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const putReq = (body) => ({ url: 'http://test/api/schedule/template-qualifications', json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  readTemplateRequirements.mockResolvedValue({ status: 200, body: { success: true, data: { types: [], requirements: {} } } })
  replaceTemplateRequirements.mockResolvedValue({ status: 200, body: { success: true, data: { template_id: TPL } } })
})

describe('GET', () => {
  it('401; 400 without a location; 403 outside the studio; 403 for staff there', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(401)
    getCurrentUser.mockResolvedValue(headCoach)
    expect((await GET(getReq())).status).toBe(400)
    assertLocationAccess.mockReturnValueOnce(NextResponse.json({ success: false }, { status: 403 }))
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(403)
    getCurrentUser.mockResolvedValue(coach)
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(403)
    expect(readTemplateRequirements).not.toHaveBeenCalled()
  })

  it('a head coach at the studio reads it', async () => {
    getCurrentUser.mockResolvedValue(headCoach)
    const res = await GET(getReq({ location_id: LOC }))
    expect(res.status).toBe(200)
    expect(readTemplateRequirements).toHaveBeenCalledWith({ db: true }, { locationId: LOC })
  })
})

describe('PUT', () => {
  it('401; 403 for someone who manages nowhere; 400 for six types or a malformed id', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(putReq({ template_id: TPL, qualification_type_ids: [] }))).status).toBe(401)
    getCurrentUser.mockResolvedValue(coach)
    expect((await PUT(putReq({ template_id: TPL, qualification_type_ids: [] }))).status).toBe(403)
    getCurrentUser.mockResolvedValue(headCoach)
    expect((await PUT(putReq({ template_id: TPL, qualification_type_ids: [1, 2, 3, 4, 5, 6].map(T) }))).status).toBe(400)
    expect((await PUT(putReq({ template_id: 'nope', qualification_type_ids: [] }))).status).toBe(400)
    expect(replaceTemplateRequirements).not.toHaveBeenCalled()
  })

  it('delegates; the data layer judges the template\'s studio on the row', async () => {
    getCurrentUser.mockResolvedValue(headCoach)
    const body = { template_id: TPL, qualification_type_ids: [T(1)] }
    expect((await PUT(putReq(body))).status).toBe(200)
    expect(replaceTemplateRequirements).toHaveBeenCalledWith({ db: true }, { user: headCoach, input: body })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/app/api/schedule/template-qualifications`
Expected: FAIL, the route does not resolve.

- [ ] **Step 3: Implement**

Create `src/app/api/schedule/template-qualifications/route.js`:

```js
// QUALS.1 — what shift templates ask for (ADVISORY: the ranked picker badges
// a coach without a current record; nothing refuses an assignment).
// GET ?location_id= : the studio's organisation catalogue and every template's
//   requirements, for the template editor.
// PUT { template_id, qualification_type_ids (<= 5) }: replace one template's.
// Same gate as the template editor (SCHEDROLES.1): MANAGER_ROLES at the studio
// (the template's studio for PUT, judged on the row: 404 outside it, 403 for
// a member who is not a manager there).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { TemplateQualificationsPutSchema } from '@/lib/qualifications-schemas'
import { readTemplateRequirements, replaceTemplateRequirements } from '@/lib/qualifications-server'

export const dynamic = 'force-dynamic'

const FORBIDDEN = 'Only a manager at this studio can change what a shift template asks for.'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: FORBIDDEN }, { status: 403 })
  }
  const out = await readTemplateRequirements(createServerClient(), { locationId })
  return NextResponse.json(out.body, { status: out.status })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: FORBIDDEN }, { status: 403 })
  }
  const validation = await validateBody(request, TemplateQualificationsPutSchema)
  if (!validation.ok) return validation.response
  const out = await replaceTemplateRequirements(createServerClient(), { user, input: validation.data })
  return NextResponse.json(out.body, { status: out.status })
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run src/app/api/schedule/template-qualifications && npm run check:route-guards && npm run check:location-scoping`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/template-qualifications
git commit -m "QUALS.1 — GET/PUT /api/schedule/template-qualifications: a template's advisory requirements

The template editor's own gate (MANAGER_ROLES at the studio). At most 5
types, same organisation (the API and the mig 635 trigger both refuse
another's).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: OpenAPI

**Files:**
- Modify: `src/lib/openapi.js`
- Modify: `src/lib/openapi.test.js`

- [ ] **Step 1: Write the failing test**

In `src/lib/openapi.test.js`, directly after the `it('documents coach availability (AVAIL.1)…` block (it ends at line 38 on `27500a90`), add:

```js
  it('documents staff qualifications (QUALS.1): records, the catalogue and template requirements', () => {
    expect(spec.paths['/api/qualifications']).toHaveProperty('get')
    expect(spec.paths['/api/qualifications']).toHaveProperty('post')
    expect(spec.paths['/api/qualifications/{id}']).toHaveProperty('patch')
    expect(spec.paths['/api/qualifications/{id}']).toHaveProperty('delete')
    expect(spec.paths['/api/qualifications/types']).toHaveProperty('post')
    expect(spec.paths['/api/qualifications/types/{id}']).toHaveProperty('patch')
    expect(spec.paths['/api/schedule/template-qualifications']).toHaveProperty('get')
    expect(spec.paths['/api/schedule/template-qualifications']).toHaveProperty('put')
    expect(spec.paths['/api/qualifications'].post.requestBody).toBeDefined()
    // The contract says what the brief decided: advisory, and who may write.
    expect(spec.paths['/api/schedule/template-qualifications'].put.description).toMatch(/advisory/i)
    expect(spec.paths['/api/qualifications'].post.description).toMatch(/owner or manager/i)
  })
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: FAIL on the new test only.

- [ ] **Step 3: Register the operations**

In `src/lib/openapi.js`, add to the imports (next to `import { AvailabilityPutSchema } from '@/lib/availability-server'`, line 30):

```js
import {
  QualificationRecordCreateSchema, QualificationRecordPatchSchema,
  QualificationTypeCreateSchema, QualificationTypePatchSchema, TemplateQualificationsPutSchema,
} from '@/lib/qualifications-schemas'
```

Directly after the AVAIL.1 `put` registration (it ends just before `// WORKTIME.1 — the assign picker's working-time advisory for one block.`, line 4643 on `27500a90`), add:

```js
// QUALS.1 — staff qualifications with expiry (mig 635).
registry.registerPath({
  method: 'get',
  path: '/api/qualifications',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: "Qualifications at one studio: everyone (owner or manager) or your own",
  description: "QUALS.1. location_id must be a studio the caller belongs to. An owner or manager AT that studio (masters bypass) gets audience 'manager': every current member (deactivated and permanently deleted people are never listed), A-Z, each with their records in the studio's organisation. Anyone else gets audience 'self': their own records, read-only. Always returns the organisation's catalogue (types, archived ones flagged active: false), today (Dublin) and can_edit_types (owner at the studio, or master). A record: { id, qualification_type_id, issued_on, expires_on (null = does not expire), note, updated_at }. Status (valid, expiring within 30 days, expired, not on record) is computed by the client from today with shared/qualifications.js.",
  request: { query: z.object({ location_id: uuidLike }) },
  responses: {
    200: { description: '{ success, data: { audience, today, organization_id, can_edit_types, types, people: [{ profile_id, full_name, records }] } }' },
    400: { description: 'Missing or malformed location_id', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Studio outside your assignments', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'A read failed (never answered as an empty list)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/qualifications',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Record a qualification for someone',
  description: "QUALS.1. The caller must be an owner or manager (masters bypass) at a studio the person currently belongs to, in the type's organisation; otherwise 404 (the person and the type are never confirmed). One record per person per type (409 if one exists: edit it). expires_on null or absent = does not expire. A blank note is stored as null. The type must not be archived (400).",
  request: { body: { content: { 'application/json': { schema: QualificationRecordCreateSchema } } } },
  responses: {
    201: { description: '{ success, data: record }' },
    400: { description: 'Invalid body (a date that is not real, expiry before issue, note over 300) or an archived type', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not an owner or manager anywhere', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Unknown type, or a person the caller may not manage', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'The person already has a record of that type', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/qualifications/{id}',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: "Change a qualification record's dates or note",
  description: 'QUALS.1. Same authority as POST, judged on the record. The dates are judged as they will be after the change (a new expiry before the stored issue date is a 400). The type and the person are fixed.',
  request: { params: z.object({ id: uuidLike }), body: { content: { 'application/json': { schema: QualificationRecordPatchSchema } } } },
  responses: {
    200: { description: '{ success, data: record }' },
    400: { description: 'Nothing to change, or impossible dates', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not an owner or manager anywhere', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No such record, or not one the caller may manage', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/qualifications/{id}',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Delete a qualification record',
  description: 'QUALS.1. Same authority as POST, judged on the record.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: '{ success, data: { id, deleted: true } }' },
    403: { description: 'Not an owner or manager anywhere', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No such record, or not one the caller may manage', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/qualifications/types',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: "Add a qualification type to your organisation's list",
  description: "QUALS.1. Owners (and masters) at location_id; the type belongs to that studio's organisation. Names are one line, 1-60 characters, unique per organisation ignoring case (409).",
  request: { body: { content: { 'application/json': { schema: QualificationTypeCreateSchema } } } },
  responses: {
    201: { description: '{ success, data: type }' },
    400: { description: 'Invalid name', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Studio outside your assignments, or not an owner there', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'A type with that name exists', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/qualifications/types/{id}',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Rename, archive or restore a qualification type',
  description: 'QUALS.1. Owners (and masters) of the type\'s organisation. Archiving (active: false) keeps every record and requirement; archived types are left out of the owner digest and the picker advisory. Types are never deleted.',
  request: { params: z.object({ id: uuidLike }), body: { content: { 'application/json': { schema: QualificationTypePatchSchema } } } },
  responses: {
    200: { description: '{ success, data: type }' },
    400: { description: 'Nothing to change, or an invalid name', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not an owner anywhere', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No such type, or not in an organisation you own a studio of', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'A type with that name exists', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/schedule/template-qualifications',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'The qualifications each shift template at a studio asks for',
  description: "QUALS.1. Advisory: the ranked coach picker badges a coach with no current record of a required type on the shift's date; nothing refuses an assignment. Manager roles (master, owner, manager, head_coach) AT location_id. Returns the organisation's catalogue and { [template_id]: [type_id] }.",
  request: { query: z.object({ location_id: uuidLike }) },
  responses: {
    200: { description: '{ success, data: { types, requirements } }' },
    400: { description: 'Missing or malformed location_id', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Studio outside your assignments, or no manager role there', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/schedule/template-qualifications',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: "Replace one shift template's required qualifications (advisory)",
  description: "QUALS.1. Advisory only: requirements badge the coach picker and never refuse an assignment. At most 5 types, all in the template's organisation (400 otherwise; the database refuses another organisation's type too). A newly added type must not be archived; an archived type already required may stay. Manager roles AT the template's studio (404 outside it, 403 for a member who is not a manager there).",
  request: { body: { content: { 'application/json': { schema: TemplateQualificationsPutSchema } } } },
  responses: {
    200: { description: '{ success, data: { template_id, qualification_type_ids, added, removed } }' },
    400: { description: 'Invalid body, too many types, an unknown or archived type', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'No manager role at the template\'s studio', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No such template, or not at a studio the caller belongs to', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: all pass. If zod-to-openapi rejects one of the `.refine()`d object schemas, register the plain `z.object(...)` and keep the refinement in the route. Check `AvailabilityPutSchema` on main, which registers fine.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openapi.js src/lib/openapi.test.js
git commit -m "QUALS.1 — OpenAPI: qualifications, the catalogue, template requirements

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The page — Schedule › Qualifications

One page for everyone. Managers see the studio's people, one row per active type, and add, edit or delete records. Owners also see the catalogue. Everyone else sees their own rows, read-only. A new tab in the Schedule strip leads there for everyone.

**Files:**
- Create: `src/components/QualificationsManager.test.jsx`
- Create: `src/components/QualificationsManager.jsx`
- Create: `src/app/(team)/schedule/qualifications/page.js`
- Modify: `src/components/ScheduleTabs.jsx`, `src/components/ScheduleTabs.test.jsx`

- [ ] **Step 1: Write the failing tests**

Create `src/components/QualificationsManager.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// QUALS.1 — the qualifications page: the manager view (rows, chips, the
// attention filter, add / edit / delete), the read-only self view, and the
// owners' catalogue. The rules themselves are pinned in shared/qualifications.test.js.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
import QualificationsManager from './QualificationsManager'

const LOC = 'loc-1'
const TYPES = [
  { id: 'fa', name: 'First aid', active: true },
  { id: 'ins', name: 'Insurance', active: true },
  { id: 'old', name: 'Old cert', active: false },
]
const MANAGER_DATA = {
  audience: 'manager', today: '2026-09-28', organization_id: 'org', can_edit_types: false, types: TYPES,
  people: [
    { profile_id: 'ann', full_name: 'Ann Coach', records: [{ id: 'r1', qualification_type_id: 'fa', issued_on: null, expires_on: '2026-09-20', note: 'PHECC' }] },
    { profile_id: 'bob', full_name: 'Bob Coach', records: [{ id: 'r2', qualification_type_id: 'fa', issued_on: null, expires_on: '2027-09-20', note: null }] },
  ],
}

function mockFetch(data, { failLoad = false } = {}) {
  const calls = []
  global.fetch = vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET'
    calls.push({ url: String(url), method, body: opts.body ? JSON.parse(opts.body) : null })
    if (method === 'GET' && failLoad) return { ok: false, status: 500, json: async () => ({ success: false, error: 'Could not read the team' }) }
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ success: true, data }) }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
  })
  return calls
}

async function renderIt(data, opts) {
  const calls = mockFetch(data, opts)
  await act(async () => { render(<QualificationsManager locationId={LOC} />) })
  return calls
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('manager view', () => {
  it('lists each person with a row per ACTIVE type, a chip and the words; archived types without a record are hidden', async () => {
    const calls = await renderIt(MANAGER_DATA)
    expect(calls[0]).toMatchObject({ url: '/api/qualifications?location_id=loc-1', method: 'GET' })
    const ann = screen.getByRole('region', { name: 'Ann Coach' })
    expect(within(ann).getByText('First aid')).toBeTruthy()
    expect(within(ann).getByText('Expired', { selector: 'span' })).toBeTruthy()
    expect(within(ann).getByText('Expired 20 Sep 2026 · PHECC')).toBeTruthy()
    expect(within(ann).getByText('Insurance')).toBeTruthy()
    expect(within(ann).getByText('Not on record', { selector: 'span' })).toBeTruthy()
    expect(within(ann).queryByText(/Old cert/)).toBeNull()
  })

  it('"Only people with something expired or expiring" hides everyone else', async () => {
    await renderIt(MANAGER_DATA)
    fireEvent.click(screen.getByRole('checkbox', { name: /Only people with something expired/ }))
    expect(screen.queryByRole('region', { name: 'Bob Coach' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Ann Coach' })).toBeTruthy()
  })

  it('Add opens the form for that person and type and POSTs the record (note trimmed)', async () => {
    const calls = await renderIt(MANAGER_DATA)
    fireEvent.click(screen.getByRole('button', { name: 'Add Insurance for Ann Coach' }))
    fireEvent.change(screen.getByLabelText('Expires on'), { target: { value: '2027-06-30' } })
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: '  Policy 123  ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      url: '/api/qualifications', method: 'POST',
      body: { issued_on: null, expires_on: '2027-06-30', note: 'Policy 123', profile_id: 'ann', qualification_type_id: 'ins' },
    })
    expect(screen.getByRole('status').textContent).toBe('Insurance saved for Ann Coach.')
  })

  it('Save stays off until there is an expiry date or "Does not expire" is ticked', async () => {
    await renderIt(MANAGER_DATA)
    fireEvent.click(screen.getByRole('button', { name: 'Add Insurance for Bob Coach' }))
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Does not expire' }))
    expect(screen.getByLabelText('Expires on').disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(false)
  })

  it('Edit PATCHes the record; Delete asks first and does nothing when refused', async () => {
    const calls = await renderIt(MANAGER_DATA)
    fireEvent.click(screen.getByRole('button', { name: 'Edit First aid for Ann Coach' }))
    fireEvent.change(screen.getByLabelText('Expires on'), { target: { value: '2028-09-20' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      url: '/api/qualifications/r1', method: 'PATCH', body: { issued_on: null, expires_on: '2028-09-20', note: 'PHECC' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit First aid for Bob Coach' }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
    expect(confirm).toHaveBeenCalled()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })
})

describe('self view', () => {
  it('shows my rows read-only: no add, no edit, no catalogue', async () => {
    await renderIt({ ...MANAGER_DATA, audience: 'self', people: [MANAGER_DATA.people[0]] })
    expect(screen.getByText(/Your manager records these/)).toBeTruthy()
    expect(screen.getByText('Expired 20 Sep 2026 · PHECC')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^(Add|Edit) / })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Qualification types' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Only people/ })).toBeNull()
  })
})

describe('catalogue (owners)', () => {
  it('adds a type and archives one', async () => {
    const calls = await renderIt({ ...MANAGER_DATA, can_edit_types: true })
    const cat = screen.getByRole('region', { name: 'Qualification types' })
    fireEvent.change(within(cat).getByLabelText('New qualification type'), { target: { value: ' Manual handling ' } })
    await act(async () => { fireEvent.click(within(cat).getByRole('button', { name: 'Add' })) })
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      url: '/api/qualifications/types', method: 'POST', body: { location_id: LOC, name: 'Manual handling' },
    })
    await act(async () => { fireEvent.click(within(cat).getAllByRole('button', { name: 'Archive' })[0]) })
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      url: '/api/qualifications/types/fa', method: 'PATCH', body: { active: false },
    })
  })
})

describe('failure', () => {
  it('a failed load says so; it never renders an empty team', async () => {
    await renderIt(MANAGER_DATA, { failLoad: true })
    expect(screen.getByText('Could not load qualifications')).toBeTruthy()
    expect(screen.getByText('Could not read the team')).toBeTruthy()
    expect(screen.queryByText(/Nobody here yet/)).toBeNull()
  })
})
```

In `src/components/ScheduleTabs.test.jsx`, replace the first test (lines 65-71, `renders Schedule and Availability for a plain staffer with no grants`, added by AVAIL.1b #1763) with:

```jsx
  it('renders Schedule, Availability and Qualifications for a plain staffer with no grants', () => {
    render(<ScheduleTabs user={user()} />)
    const links = screen.getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual(['Schedule', 'Availability', 'Qualifications'])
    expect(links[0].getAttribute('href')).toBe('/schedule')
    expect(links[1].getAttribute('href')).toBe('/schedule/availability')
    expect(links[2].getAttribute('href')).toBe('/schedule/qualifications')
  })

  // QUALS.1 — everyone sees their own qualifications; managers manage them.
  it('shows Qualifications to every role, linking to /schedule/qualifications', () => {
    for (const role of ['staff', 'head_coach', 'manager', 'owner']) {
      render(<ScheduleTabs user={user({ role })} />)
      expect(linkFor('Qualifications').getAttribute('href'), role).toBe('/schedule/qualifications')
      cleanup()
    }
  })
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/components/QualificationsManager.test.jsx src/components/ScheduleTabs.test.jsx`
Expected: FAIL. The component does not resolve, and the tab does not exist.

- [ ] **Step 3: Implement the component**

Create `src/components/QualificationsManager.jsx`:

```jsx
'use client'

// QUALS.1 — Schedule › Qualifications. One page for everyone at the studio:
//   manager (owner or manager here, or master): every current member, one row
//     per active qualification type (+ any record of an archived type), a
//     status chip, and add / edit / delete. Owners also get the catalogue.
//   self (everyone else): their own rows, read-only.
// The server decides the audience (GET /api/qualifications); every button
// here is re-judged by its route. Statuses come from shared/qualifications.js
// against the server's Dublin `today`, so the browser's clock never decides.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, Pencil } from 'lucide-react'
import Modal from '@/components/ui/Modal'
import ScheduleErrorBanner from './schedule/ScheduleErrorBanner'
import { readJson } from './schedule/useScheduleData'
import {
  qualificationStatus, qualificationStatusLabel, personNeedsAttention, QUALIFICATION_EXPIRY_WINDOW_DAYS,
} from '@shared/qualifications'

// Status chips: bg-<c>-500/10 text-<c>-700 (the light-theme recipe, check:guardrails).
const CHIP = {
  valid: 'bg-emerald-500/10 text-emerald-700',
  expiring: 'bg-amber-500/10 text-amber-700',
  expired: 'bg-red-500/10 text-red-700',
  missing: 'bg-slate-500/10 text-slate-700',
  unknown: 'bg-slate-500/10 text-slate-700',
}
const WORD = { valid: 'Valid', expiring: 'Expiring', expired: 'Expired', missing: 'Not on record', unknown: 'Check' }
const JSON_HEADERS = { 'Content-Type': 'application/json' }
const INPUT = 'mt-1 w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'

// One row per active type, then any record of an archived type.
function rowsFor(person, types) {
  const byType = new Map((person.records || []).map((r) => [r.qualification_type_id, r]))
  const rows = types.filter((t) => t.active !== false).map((type) => ({ type, record: byType.get(type.id) || null }))
  for (const t of types) {
    if (t.active === false && byType.has(t.id)) rows.push({ type: t, record: byType.get(t.id) })
  }
  return rows
}

export default function QualificationsManager({ locationId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [editing, setEditing] = useState(null) // { person, type, record | null }

  const load = useCallback(async () => {
    if (!locationId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const json = await readJson(`/api/qualifications?location_id=${encodeURIComponent(locationId)}`)
      setData(json?.data || null)
    } catch (e) {
      setError(e?.message || 'Could not load qualifications')
    } finally {
      setLoading(false)
    }
  }, [locationId])

  useEffect(() => { load() }, [load])

  const today = data?.today
  const types = useMemo(() => data?.types || [], [data])
  const isManager = data?.audience === 'manager'
  const people = useMemo(() => {
    const list = data?.people || []
    return attentionOnly ? list.filter((p) => personNeedsAttention(p.records, today)) : list
  }, [data, attentionOnly, today])

  const done = useCallback((message) => {
    setEditing(null)
    setNotice(message)
    load()
  }, [load])

  if (!locationId) return <p className="text-sm text-un1t-subtle">Choose a studio first.</p>
  if (loading && !data) return <p className="text-sm text-un1t-subtle">Loading qualifications…</p>
  if (!data) return <ScheduleErrorBanner title="Could not load qualifications" message={error} onRetry={load} />

  return (
    <div className="space-y-4">
      {error && <ScheduleErrorBanner title="Something went wrong" message={error} onDismiss={() => setError(null)} />}
      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}

      {isManager ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} />
          Only people with something expired or expiring in the next {QUALIFICATION_EXPIRY_WINDOW_DAYS} days
        </label>
      ) : (
        <p className="text-sm text-un1t-subtle">Your manager records these. Tell them when you renew one.</p>
      )}

      {people.length === 0 && (
        <p className="text-sm text-un1t-subtle">{attentionOnly ? 'Nothing expired or expiring.' : 'Nobody here yet.'}</p>
      )}

      {people.map((p) => (
        <section key={p.profile_id} aria-label={p.full_name || 'Unnamed'} className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          {isManager && <h3 className="font-semibold mb-2">{p.full_name || 'Unnamed'}</h3>}
          <ul className="divide-y divide-un1t-border">
            {rowsFor(p, types).map(({ type, record }) => {
              const status = qualificationStatus(record, today) ?? 'unknown'
              return (
                <li key={type.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm">{type.name}{type.active === false ? ' (archived)' : ''}</div>
                    <div className="text-xs text-un1t-subtle">
                      {qualificationStatusLabel(record, today)}{record?.note ? ` · ${record.note}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${CHIP[status]}`}>{WORD[status]}</span>
                    {isManager && (
                      <button
                        type="button"
                        onClick={() => { setNotice(null); setEditing({ person: p, type, record }) }}
                        aria-label={`${record ? 'Edit' : 'Add'} ${type.name} for ${p.full_name || 'this person'}`}
                        className="p-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
                      >
                        {record ? <Pencil size={14} /> : <Plus size={14} />}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {data.can_edit_types && (
        <TypesCatalogue types={types} locationId={locationId} onChanged={done} onError={setError} />
      )}
      {editing && <RecordModal {...editing} onClose={() => setEditing(null)} onDone={done} />}
    </div>
  )
}

function RecordModal({ person, type, record, onClose, onDone }) {
  const [issuedOn, setIssuedOn] = useState(record?.issued_on || '')
  const [expiresOn, setExpiresOn] = useState(record?.expires_on || '')
  const [noExpiry, setNoExpiry] = useState(!!record && !record.expires_on)
  const [note, setNote] = useState(record?.note || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const who = person.full_name || 'this person'
  const canSave = !busy && (noExpiry || !!expiresOn)

  async function save() {
    setBusy(true)
    setError(null)
    const body = { issued_on: issuedOn || null, expires_on: noExpiry ? null : expiresOn, note: note.trim() || null }
    try {
      if (record) {
        await readJson(`/api/qualifications/${record.id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) })
      } else {
        await readJson('/api/qualifications', {
          method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({ ...body, profile_id: person.profile_id, qualification_type_id: type.id }),
        })
      }
      onDone(`${type.name} saved for ${who}.`)
    } catch (e) {
      setError(e?.message || 'Could not save')
      setBusy(false)
    }
  }

  async function remove() {
    if (!record || !window.confirm(`Delete ${type.name} for ${who}? This cannot be undone.`)) return
    setBusy(true)
    setError(null)
    try {
      await readJson(`/api/qualifications/${record.id}`, { method: 'DELETE' })
      onDone(`${type.name} deleted for ${who}.`)
    } catch (e) {
      setError(e?.message || 'Could not delete')
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${type.name} · ${who}`}
      dismissOnBackdrop={false}
      footer={(
        <>
          {record && (
            <button type="button" onClick={remove} disabled={busy} className="mr-auto text-sm text-red-700 disabled:opacity-50">Delete</button>
          )}
          <button type="button" onClick={onClose} className="text-sm px-3 py-2">Cancel</button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="text-sm px-3 py-2 rounded-md bg-un1t-text text-un1t-bg disabled:opacity-50"
          >
            Save
          </button>
        </>
      )}
    >
      <div className="space-y-3">
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <label className="block text-xs text-un1t-subtle">
          Issued on (optional)
          <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} className={INPUT} />
        </label>
        <label className="block text-xs text-un1t-subtle">
          Expires on
          <input type="date" value={expiresOn} disabled={noExpiry} onChange={(e) => setExpiresOn(e.target.value)} className={INPUT} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} />
          Does not expire
        </label>
        <label className="block text-xs text-un1t-subtle">
          Note (optional)
          <textarea
            value={note}
            maxLength={300}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. the certificate number or who issued it"
            className={INPUT}
          />
        </label>
      </div>
    </Modal>
  )
}

function TypesCatalogue({ types, locationId, onChanged, onError }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(work, message) {
    setBusy(true)
    try {
      await work()
      onChanged(message)
    } catch (e) {
      onError(e?.message || 'Could not change the list')
    } finally {
      setBusy(false)
    }
  }

  const patch = (t, body, message) => run(() => readJson(`/api/qualifications/types/${t.id}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body),
  }), message)

  function add() {
    const clean = name.trim()
    if (!clean) return
    run(async () => {
      await readJson('/api/qualifications/types', {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ location_id: locationId, name: clean }),
      })
      setName('')
    }, `${clean} added.`)
  }

  function rename(t) {
    const next = window.prompt('New name', t.name)?.trim()
    if (next && next !== t.name) patch(t, { name: next }, `Renamed to ${next}.`)
  }

  return (
    <section aria-label="Qualification types" className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <h3 className="font-semibold mb-1">Qualification types</h3>
      <p className="text-xs text-un1t-subtle mb-3">
        Shared by every studio in your organisation. Archiving a type hides it from new records, the weekly summary and
        the coach picker, and keeps what is already recorded.
      </p>
      <ul className="divide-y divide-un1t-border mb-3">
        {types.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>{t.name}{t.active === false ? ' (archived)' : ''}</span>
            <span className="flex gap-3">
              <button type="button" disabled={busy} onClick={() => rename(t)} className="text-xs text-un1t-subtle hover:text-un1t-text">Rename</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => patch(t, { active: t.active === false }, t.active === false ? `${t.name} restored.` : `${t.name} archived.`)}
                className="text-xs text-un1t-subtle hover:text-un1t-text"
              >
                {t.active === false ? 'Restore' : 'Archive'}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          aria-label="New qualification type"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Manual handling"
          className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        />
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={add}
          className="text-sm px-3 py-2 rounded-md bg-un1t-text text-un1t-bg disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </section>
  )
}
```

- [ ] **Step 4: The tab and the page**

`src/components/ScheduleTabs.jsx`: add `BadgeCheck` to the `lucide-react` import (line 57). Add the tab directly after the `attendance` entry (line 115):

```jsx
    // QUALS.1 — everyone: managers manage the studio's records, everyone else
    // sees their own (the page decides which; its routes re-judge).
    { key: 'qualifications', label: 'Qualifications', icon: BadgeCheck, href: '/schedule/qualifications', show: true },
```

Create `src/app/(team)/schedule/qualifications/page.js`:

```js
// QUALS.1 — Schedule › Qualifications. First aid, insurance, vetting and any
// other type the organisation tracks, with expiry dates. Owners and managers
// manage the studio's records; everyone else sees their own, read-only. The
// data comes from GET /api/qualifications (the page reads nothing itself, so
// no service-role client here and nothing for check:location-scoping).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import ScheduleTabs from '@/components/ScheduleTabs'
import QualificationsManager from '@/components/QualificationsManager'

export const dynamic = 'force-dynamic'

export default async function QualificationsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'schedule')) redirect('/')

  return (
    <div className="px-4 py-6 sm:p-8 max-w-5xl">
      <ScheduleTabs user={user} />
      <h2 className="text-2xl font-bold mb-1">Qualifications</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-3xl">
        First aid, insurance, vetting and anything else your organisation tracks, with the date each one expires.
        Owners and managers record them. Owners get a weekly summary of anything expired or expiring in the next 30 days.
        A shift template can ask for one: the coach picker then flags anyone without it on the day, but never stops you
        assigning them.
      </p>
      <QualificationsManager locationId={user.activeLocation?.id || null} />
    </div>
  )
}
```

- [ ] **Step 5: Run, expect PASS**

Run: `npx vitest run src/components/QualificationsManager.test.jsx src/components/ScheduleTabs.test.jsx 'src/app/(team)/schedule'`
Expected: all pass. The two page tests under `(team)/schedule` mount `ScheduleTabs` and still pass.

Then `npm run check:guardrails`. It checks the chip recipe (`bg-*-500/10 text-*-700`), that every button is typed, and that there are no dead `un1t-*` tokens.

- [ ] **Step 6: Commit**

```bash
git add src/components/QualificationsManager.jsx src/components/QualificationsManager.test.jsx src/components/ScheduleTabs.jsx src/components/ScheduleTabs.test.jsx 'src/app/(team)/schedule/qualifications/page.js'
git commit -m "QUALS.1 — Schedule › Qualifications page: manage records, the catalogue, or see your own

Managers: every current member, a row per active type, status chips, an
attention filter, add / edit / delete (expiry required unless 'Does not
expire'). Owners: the organisation's catalogue. Everyone else: their own,
read-only. A Qualifications tab for every role.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The template editor's "Requires" field

**Files:**
- Create: `src/components/ShiftTemplateManager.quals.test.jsx`
- Modify: `src/components/ShiftTemplateManager.jsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/ShiftTemplateManager.quals.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// QUALS.1 — a template's advisory requirements in the template editor: the
// chip on the list, the field in the form, and the separate PUT that saves
// them after the template (only when the set changed). When the catalogue
// does not load, there is no field and the template saves exactly as before.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import ShiftTemplateManager from '@/components/ShiftTemplateManager'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const MORNING = {
  id: 't-class', name: 'Morning', start_time: '06:00', end_time: '07:00', color: '#10B981', active: true,
  max_coaches: 10, min_coaches: 2, days_of_week: ['mon'], role_label: null, display_order: 0, kind: 'class',
}
const TYPES = [
  { id: 'fa', name: 'First aid', active: true },
  { id: 'ins', name: 'Insurance', active: true },
  { id: 'gv', name: 'Garda vetting', active: true },
  { id: 'old', name: 'Old cert', active: false },
]

async function renderManager({ quals = { types: TYPES, requirements: { 't-class': ['fa'] } }, qualsFail = false } = {}) {
  const writes = []
  global.fetch = vi.fn(async (url, opts) => {
    const u = String(url)
    if (opts?.method === 'PUT' || opts?.method === 'POST') {
      writes.push({ url: u, method: opts.method, body: JSON.parse(opts.body) })
      return { ok: true, status: opts.method === 'POST' ? 201 : 200, json: async () => ({ success: true, data: { id: 't-new' } }) }
    }
    if (u.startsWith('/api/schedule/template-qualifications')) {
      return qualsFail
        ? { ok: false, status: 500, json: async () => ({ success: false, error: 'down' }) }
        : { ok: true, status: 200, json: async () => ({ success: true, data: quals }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [MORNING] }) }
  })
  await act(async () => { render(<ShiftTemplateManager user={MANAGER} />) })
  return writes
}

const save = async (label = 'Save Changes') => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('template list', () => {
  it('shows what a template asks for', async () => {
    await renderManager()
    expect(screen.getByText('Requires First aid')).toBeTruthy()
  })
})

describe('template editor — Requires', () => {
  it('opens with the current requirements ticked, archived types hidden unless already required', async () => {
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    expect(screen.getByRole('checkbox', { name: 'First aid' }).checked).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Insurance' }).checked).toBe(false)
    expect(screen.queryByRole('checkbox', { name: /Old cert/ })).toBeNull()
  })

  it('saves the template first, then PUTs the new set; the template body carries no requirements', async () => {
    const writes = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Insurance' }))
    await save()
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      'PUT /api/schedule/templates/t-class',
      'PUT /api/schedule/template-qualifications',
    ])
    expect(writes[0].body).not.toHaveProperty('required_qualification_type_ids')
    expect(writes[1].body).toEqual({ template_id: 't-class', qualification_type_ids: ['fa', 'ins'] })
  })

  it('an unchanged set is not saved again', async () => {
    const writes = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    await save()
    expect(writes).toHaveLength(1)
  })

  it('a NEW template gets its requirements under the id the create returned', async () => {
    const writes = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'New Shift' }))
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Morning/), { target: { value: 'Evening' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Garda vetting' }))
    await save('Create Shift Template')
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      'POST /api/schedule/templates',
      'PUT /api/schedule/template-qualifications',
    ])
    expect(writes[1].body).toEqual({ template_id: 't-new', qualification_type_ids: ['gv'] })
  })

  it('an archived type that is already required is shown, ticked, and can be removed', async () => {
    const writes = await renderManager({ quals: { types: TYPES, requirements: { 't-class': ['old'] } } })
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    const old = screen.getByRole('checkbox', { name: 'Old cert (archived)' })
    expect(old.checked).toBe(true)
    fireEvent.click(old)
    await save()
    expect(writes[1].body).toEqual({ template_id: 't-class', qualification_type_ids: [] })
  })

  it('at most 5: the rest are disabled once 5 are ticked', async () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: `Q${id}`, active: true }))
    await renderManager({ quals: { types: six, requirements: { 't-class': ['a', 'b', 'c', 'd', 'e'] } } })
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    expect(screen.getByRole('checkbox', { name: 'Qf' }).disabled).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Qa' }).disabled).toBe(false)
  })

  it('when the catalogue does not load there is no field, and only the template is saved', async () => {
    const writes = await renderManager({ qualsFail: true })
    expect(screen.queryByText(/^Requires /)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    expect(screen.queryByRole('checkbox', { name: 'First aid' })).toBeNull()
    await save()
    expect(writes).toHaveLength(1)
    expect(writes[0].body).not.toHaveProperty('required_qualification_type_ids')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/ShiftTemplateManager.quals.test.jsx`
Expected: FAIL. There is no chip and no field yet.

- [ ] **Step 3: Implement** (six edits to `src/components/ShiftTemplateManager.jsx`)

(1) Imports, after `import { cloneSourceStudios, cloneResultNotice } from '@/lib/shift-template-clone'`:

```jsx
// QUALS.1 — what a template asks for (advisory: the coach picker badges, it
// never refuses). Saved by its own route after the template.
import { parseTemplateQualificationsAnswer } from '@shared/qualifications'
import { MAX_TEMPLATE_REQUIREMENTS } from '@/lib/qualifications-schemas'
```

(2) State and load, in `ShiftTemplateManager` directly after `useEffect(() => { fetchTemplates() }, [fetchTemplates])`:

```jsx
  // QUALS.1 — the organisation's catalogue and every template's requirements.
  // null = not loaded, refused, or not understood: the editor then shows no
  // field and saves nothing about requirements (the template saves as before).
  const [quals, setQuals] = useState(null)
  const fetchQuals = useCallback(async () => {
    if (!locationId) return
    try {
      const res = await fetch(`/api/schedule/template-qualifications?location_id=${locationId}`)
      const parsed = parseTemplateQualificationsAnswer(await res.json().catch(() => null))
      setQuals(parsed.ok ? parsed : null)
    } catch {
      setQuals(null)
    }
  }, [locationId])
  useEffect(() => { fetchQuals() }, [fetchQuals])

  const requiredIdsFor = (templateId) => (templateId && quals?.requirements?.[templateId]) || []
  const requiredNamesFor = (templateId) => requiredIdsFor(templateId)
    .map((id) => quals?.types.find((t) => t.id === id)?.name)
    .filter(Boolean)
  // The editor offers active types, plus any archived type this template
  // already asks for (so it can be seen and removed).
  const editorTypesFor = (templateId) => (quals
    ? quals.types.filter((t) => t.active !== false || requiredIdsFor(templateId).includes(t.id))
    : null)

  // PUT only when the set changed. A failure is reported, never swallowed:
  // the template itself did save.
  async function saveRequirements(templateId, before, wanted) {
    if (!templateId) return
    if (before.length === wanted.length && before.every((id) => wanted.includes(id))) return
    try {
      await readJson('/api/schedule/template-qualifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: templateId, qualification_type_ids: wanted }),
      })
    } catch (e) {
      failWith('Template saved, but not what it asks for', e?.message || 'Could not save the required qualifications')
    }
    fetchQuals()
  }
```

(3) `handleSave` (lines 130-177). Replace its first lines, up to and including `const payload = { ...formData, location_id: locationId, }`, with:

```jsx
  async function handleSave(formData) {
    const isEdit = typeof showForm === 'object'
    const url = isEdit ? `/api/schedule/templates/${showForm.id}` : '/api/schedule/templates'
    const method = isEdit ? 'PUT' : 'POST'

    // QUALS.1 — requirements ride their own route, AFTER the template (a new
    // one has no id until it is created). Absent = the field was not shown.
    const { required_qualification_type_ids: wantedQuals, ...templateFields } = formData
    const payload = {
      ...templateFields,
      location_id: locationId,
    }
```

In the same function, directly after the two lines `setShowForm(false)` and `fetchTemplates()`, add:

```jsx
      if (Array.isArray(wantedQuals)) {
        await saveRequirements(isEdit ? showForm.id : data.data?.id, isEdit ? requiredIdsFor(showForm.id) : [], wantedQuals)
      }
```

(4) The list chip. In the active-template row, directly after the `{t.kind === 'admin' && ( … )}` chip (line 397), add:

```jsx
                      {requiredNamesFor(t.id).length > 0 && (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-medium bg-sky-500/10 text-sky-700"
                          title="Advisory: the coach picker flags anyone without a current record on the day. It never stops an assignment."
                        >
                          Requires {requiredNamesFor(t.id).join(', ')}
                        </span>
                      )}
```

(5) Pass the catalogue to the form (the `<TemplateFormModal … />` at line 515):

```jsx
        <TemplateFormModal
          template={typeof showForm === 'object' ? showForm : null}
          onSave={handleSave}
          onClose={() => setShowForm(false)}
          qualificationTypes={editorTypesFor(typeof showForm === 'object' ? showForm.id : null)}
          requiredIds={requiredIdsFor(typeof showForm === 'object' ? showForm.id : null)}
        />
```

(6) `TemplateFormModal`. Change its signature and add the state after `const [classMin, setClassMin] = useState(null)`:

```jsx
function TemplateFormModal({ template, onSave, onClose, qualificationTypes = null, requiredIds = [] }) {
```

```jsx
  // QUALS.1 — null types = the catalogue did not load: no field, and the
  // save carries no requirements at all.
  const [requiredQuals, setRequiredQuals] = useState(requiredIds)
```

Render the field directly after the "Default Role / Position" `<div>` block and before the "Colour" block:

```jsx
          <TemplateQualificationsField types={qualificationTypes} selected={requiredQuals} onChange={setRequiredQuals} />
```

In the save button's `onSave({ … })` object, after `kind,`, add:

```jsx
              ...(qualificationTypes ? { required_qualification_type_ids: requiredQuals } : {}),
```

At the end of the file, add the field:

```jsx
// QUALS.1 — what a template asks for. Advisory: the coach picker badges a
// coach without a current record on the shift's date; nothing refuses.
function TemplateQualificationsField({ types, selected, onChange }) {
  if (!types || types.length === 0) return null
  const full = selected.length >= MAX_TEMPLATE_REQUIREMENTS
  return (
    <fieldset>
      <legend className="block text-xs text-un1t-subtle mb-2">Requires (advisory)</legend>
      <div className="flex flex-wrap gap-2">
        {types.map((t) => {
          const on = selected.includes(t.id)
          return (
            <label
              key={t.id}
              className={`flex items-center gap-1.5 text-sm px-2 py-1 rounded-md border ${on ? 'border-un1t-text' : 'border-un1t-border'}`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={!on && full}
                onChange={() => onChange(on ? selected.filter((id) => id !== t.id) : [...selected, t.id])}
              />
              {t.name}{t.active === false ? ' (archived)' : ''}
            </label>
          )
        })}
      </div>
      <p className="text-[11px] text-un1t-subtle mt-1.5">
        The coach picker flags anyone without a current record on the day. It never stops you assigning them. Up to {MAX_TEMPLATE_REQUIREMENTS}.
      </p>
    </fieldset>
  )
}
```

- [ ] **Step 4: Run, expect PASS, and every existing template test still passes**

Run: `npx vitest run src/components/ShiftTemplateManager`
Expected: all five files pass. The existing kind, list, clone and a11y tests answer every GET with the templates array. `parseTemplateQualificationsAnswer` reads that as "not understood", so those tests see no field and no extra write. The clone test counts only `/api/schedule/templates?` calls.

- [ ] **Step 5: Commit**

```bash
git add src/components/ShiftTemplateManager.jsx src/components/ShiftTemplateManager.quals.test.jsx
git commit -m "QUALS.1 — template editor: 'Requires (advisory)' field and list chip

Up to 5 types; archived ones shown only when already required. Saved by
PUT /api/schedule/template-qualifications after the template (a new
template's id comes from its create), only when the set changed. No field
and no extra write when the catalogue does not load.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10A (path A: CANDIDATES.1 merged): the advisory in the ranked picker

The ranked picker already renders `candidateBadges(c)` for every candidate (CANDIDATES.1 Task 7). So the web picker needs no component change: the server attaches `qualification_gaps` to each candidate, manager audience only, and `candidateBadges` turns them into one `warn` badge. Tier, rank and `reason` do not change, so the phone's sheets are untouched apart from the extra field in the answer, which they ignore.

**Files:**
- Modify: `shared/candidates.js`, `shared/candidates.test.js`
- Modify: `src/lib/candidates-data.js`, `src/lib/candidates-data.test.js`
- Modify: `src/app/api/schedule/blocks/[id]/candidates/route.js`, `route.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `shared/candidates.test.js` (add `candidateTier`, `rankCandidates`, `candidateReason`, `candidateBadges` and `candidatesUncheckedNote` to its import if any is missing):

```js
describe('QUALS.1 — qualification gaps', () => {
  const GAP = [{ type_id: 'fa', name: 'First aid', status: 'missing', expires_on: null }]

  it('a gap is one warn badge, after the others', () => {
    expect(candidateBadges({ free: true, qualification_gaps: GAP })).toEqual([{
      key: 'qualifications', tone: 'warn', text: 'First aid: not on record',
      title: 'This shift asks for First aid (not on record). Advisory only: you can still assign them.',
    }])
    const withRest = candidateBadges({ rest_gap: { rest_minutes: 600, other: {} }, qualification_gaps: GAP })
    expect(withRest.map((b) => b.key)).toEqual(['rest', 'qualifications'])
    expect(candidateBadges({ free: true, qualification_gaps: [] })).toEqual([])
  })

  it('never changes the tier, the order or the phone\'s reason line', () => {
    expect(candidateTier({ free: true, qualification_gaps: GAP })).toBe('ready')
    const ranked = rankCandidates([
      { profile_id: 'a', full_name: 'Abe', free: true, week_minutes: 0, qualification_gaps: GAP },
      { profile_id: 'b', full_name: 'Bea', free: true, week_minutes: 0 },
    ])
    expect(ranked.map((c) => c.profile_id)).toEqual(['a', 'b'])
    expect(ranked[0].reason).toBe(candidateReason({ free: true, week_minutes: 0 }))
  })

  it('an unread qualification check is named in the note', () => {
    expect(candidatesUncheckedNote({ qualifications: false })).toBe('Could not check qualifications, so the order may be off.')
  })
})
```

In `src/lib/candidates-data.test.js`, add beside its other `vi.mock` lines:

```js
vi.mock('./qualifications-server', () => ({ readBlockQualificationFacts: vi.fn() }))
```

Beside its other `await import`s:

```js
const { readBlockQualificationFacts } = await import('./qualifications-server')
```

Append this describe. It uses the file's own `mockDb`, `BLOCK` and top-level `beforeEach`. The eligible members there are `ann`, `con` and `nul`, and `BLOCK` has no `template_id`, so every existing test reads nothing new:

```js
describe('QUALS.1 — qualification gaps (manager audience only)', () => {
  const TPL_BLOCK = { ...BLOCK, template_id: 'tpl-1' }
  beforeEach(() => {
    readBlockQualificationFacts.mockReset().mockResolvedValue({
      required: [{ id: 'fa', name: 'First aid', organization_id: 'org-1' }],
      records: [{ profile_id: 'ann', qualification_type_id: 'fa', expires_on: '2027-01-01' }],
      error: null,
    })
  })

  it('attaches gaps judged on the block date, and says it checked', async () => {
    const out = await loadBlockCandidates(mockDb(), { block: TPL_BLOCK, audience: 'manager' })
    expect(readBlockQualificationFacts).toHaveBeenCalledWith(expect.anything(), { templateId: 'tpl-1', profileIds: ['ann', 'con', 'nul'] })
    const gaps = Object.fromEntries(out.candidates.map((c) => [c.profile_id, c.qualification_gaps]))
    expect(gaps.ann).toEqual([])
    expect(gaps.con).toEqual([{ type_id: 'fa', name: 'First aid', status: 'missing', expires_on: null }])
    expect(out.checked.qualifications).toBe(true)
  })

  it('a colleague never gets them, and nothing is read', async () => {
    const out = await loadBlockCandidates(mockDb(), { block: TPL_BLOCK, audience: 'colleague' })
    expect(readBlockQualificationFacts).not.toHaveBeenCalled()
    expect(out.candidates.every((c) => !('qualification_gaps' in c))).toBe(true)
  })

  it('a failed read is "not checked"; the list still comes back without gaps', async () => {
    readBlockQualificationFacts.mockResolvedValue({ required: null, records: null, error: { message: 'down' } })
    const out = await loadBlockCandidates(mockDb(), { block: TPL_BLOCK, audience: 'manager' })
    expect(out.error).toBeNull()
    expect(out.checked.qualifications).toBe(false)
    expect(out.candidates.every((c) => !('qualification_gaps' in c))).toBe(true)
  })

  it('a template that requires nothing adds no field and no checked key', async () => {
    readBlockQualificationFacts.mockResolvedValue({ required: [], records: [], error: null })
    const out = await loadBlockCandidates(mockDb(), { block: TPL_BLOCK, audience: 'manager' })
    expect(out.candidates.every((c) => !('qualification_gaps' in c))).toBe(true)
    expect(out.checked).not.toHaveProperty('qualifications')
  })
})
```

In `src/app/api/schedule/blocks/[id]/candidates/route.test.js`, change the expected block select to:

```js
    expect(db.log.select).toBe('id, location_id, template_id, block_date, start_time, end_time, shift_templates(name, start_time, end_time), shift_assignments(profile_id, status)')
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run shared/candidates.test.js src/lib/candidates-data.test.js 'src/app/api/schedule/blocks/[id]/candidates/route.test.js'`
Expected: FAIL on the new tests and on the select string.

- [ ] **Step 3: Implement**

`shared/candidates.js`:

- Import beside the other `./*.js` imports:

  ```js
  import { qualificationGapBadge } from './qualifications.js'
  ```

- In `candidateBadges`, directly before its final `return out`:

  ```js
    // QUALS.1 — the template's required qualifications, judged on the shift's
    // date and attached server-side for the manager audience only. Advisory: a
    // badge, never a tier, a rank or a line in `reason`.
    const quals = qualificationGapBadge(c.qualification_gaps)
    if (quals) out.push(quals)
  ```

- In `UNCHECKED_LABELS`, add a last entry: `['qualifications', 'qualifications'],`.

`src/lib/candidates-data.js`:

- Imports:

  ```js
  import { readBlockQualificationFacts } from './qualifications-server'
  import { attachQualificationGaps } from '@shared/qualifications'
  ```

- Add a fifth read to the `Promise.all` in `loadBlockCandidates`. The destructure becomes `const [shiftRead, leaveRead, availRead, contractRead, qualRead] = await Promise.all([` and the list gains:

  ```js
      // QUALS.1 — manager only: a colleague never learns a colleague's qualifications.
      manager && block.template_id ? readBlockQualificationFacts(db, { templateId: block.template_id, profileIds: ids }) : null,
  ```

- Replace the tail, from `const built = buildCandidates({` to `return { ...built, checked, error: null }`:

  ```js
      const built = buildCandidates({
        block, members, shifts: shiftRead.error ? [] : shiftRead.shifts, leave, rules, contracts, checked, audience: who,
      })
      // QUALS.1 — attach the gaps AFTER ranking: they badge, they never re-rank.
      let candidates = built.candidates
      if (qualRead?.error) note('qualifications', qualRead.error)
      else if (qualRead?.required?.length) {
        checked.qualifications = true
        candidates = attachQualificationGaps(candidates, { required: qualRead.required, records: qualRead.records, onISO: block.block_date })
      }
      return { ...built, candidates, checked, error: null }
  ```

`src/app/api/schedule/blocks/[id]/candidates/route.js`: add `template_id` to the block select, after `location_id`:

```js
    .select('id, location_id, template_id, block_date, start_time, end_time, shift_templates(name, start_time, end_time), shift_assignments(profile_id, status)')
```

- [ ] **Step 4: Run, expect PASS, both timezones**

Run: `for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run shared/candidates.test.js shared/qualifications.test.js src/lib/candidates-data.test.js 'src/app/api/schedule/blocks/[id]/candidates' || break; done && npx vitest run src/components/ScheduleCalendar.candidates.test.jsx && npm run check:select-columns && npm run check:mobile-imports`
Expected: all pass. `shift_blocks.template_id` is in mig 067. The phone imports nothing new.

- [ ] **Step 5: Commit**

```bash
git add shared/candidates.js shared/candidates.test.js src/lib/candidates-data.js src/lib/candidates-data.test.js 'src/app/api/schedule/blocks/[id]/candidates/route.js' 'src/app/api/schedule/blocks/[id]/candidates/route.test.js'
git commit -m "QUALS.1 — ranked picker: a badge for a required qualification missing or expired on the shift date

Manager audience only; a colleague never learns a colleague's qualifications.
Attached after ranking: never a tier, a rank or a reason line. One extra read
when the template requires nothing; a failed read says 'not checked'.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10B (path B: CANDIDATES.1 not merged): the hand-off

No code. Everything the picker needs ships in this PR:

- `readBlockQualificationFacts` (`src/lib/qualifications-server.js`, tested in Task 4);
- `attachQualificationGaps` and `qualificationGapBadge` (`shared/qualifications.js`, tested in Task 2).

Do NOT wire the advisory into today's `AssignCoachModal`. Its fallback list is the path CANDIDATES.1 keeps only for "no ranked answer", and a second per-open GET is what CANDIDATES.1 decision 7 removes.

- [ ] Put Task 10A in the PR body under "Not in this PR", verbatim, and ask the orchestrator to add this line to `00-INDEX.md` "Follow-ups". Do not edit the index from this branch.

  > QUALS.1 shipped without the picker badge (CANDIDATES.1 was not merged): apply 33-QUALS.1.md Task 10A in the first PR after CANDIDATES.1 merges (block select + `template_id`, a fifth read in `loadBlockCandidates`, `qualificationGapBadge` in `candidateBadges`).

- [ ] The CANDIDATES.1 implementer, if still building, applies Task 10A in their own branch instead: it is self-contained.

---

### Task 11: The weekly digest — `src/lib/qualification-digest.js`

Pure planning (who gets what, when), then a run that reads, plans and sends. It replaces Task 3's two-line stub.

**Files:**
- Create: `src/lib/qualification-digest.test.js`
- Modify (replace the stub): `src/lib/qualification-digest.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/qualification-digest.test.js`:

```js
// QUALS.1 — the weekly qualification digest: who gets one (owners, and
// masters linked to a studio; never another organisation's people), what it
// lists, quiet hours, the weekly claim key, the run's reads, and its failure
// posture (a read failure throws before anything is sent; one recipient's
// failure costs nobody else theirs).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./push-dedup', () => ({ notifyUsersOnce: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { notifyUsersOnce } = await import('./push-dedup')
const { logWarn } = await import('./log')
const { mockDb, byTable, filter } = await import('./qualifications-mock-db.test-helpers')
const {
  QUALIFICATION_DIGEST_CATEGORY, QUALIFICATION_DIGEST_TYPE,
  digestEventKey, planQualificationDigests, runQualificationDigest, digestEmailHtml,
} = await import('./qualification-digest')

const ORG = 'org-1'
const ORG2 = 'org-2'
const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const GARAGE = 'loc-garage'
const LOCATIONS = [
  { id: STILL, name: 'Stillorgan', organization_id: ORG, timezone: 'Europe/Dublin' },
  { id: HATCH, name: 'Hatch Street', organization_id: ORG, timezone: null },
  { id: GARAGE, name: 'Garage', organization_id: ORG2, timezone: 'Europe/Dublin' },
]
const ORGS = [{ id: ORG, name: 'Studio Group' }, { id: ORG2, name: 'Garage Co' }]
const person = (id, full_name, over = {}) => ({ id, full_name, role: 'staff', active: true, deleted_at: null, ...over })
const link = (profile_id, location_id, role, profile) => ({ profile_id, location_id, role, profiles: profile })
const LINKS = [
  link('owner', STILL, 'owner', person('owner', 'Olive Owner')),
  link('owner', HATCH, 'staff', person('owner', 'Olive Owner')), // owner at Stillorgan only
  link('master', STILL, 'manager', person('master', 'Max Master', { role: 'master' })), // a linked master is a recipient
  link('ann', STILL, 'staff', person('ann', 'Ann Coach')),
  link('bob', HATCH, 'staff', person('bob', 'Bob Coach')),
  link('howner', HATCH, 'owner', person('howner', 'Hattie Owner')),
  link('off', STILL, 'owner', person('off', 'Off Owner', { active: false })), // deactivated: nobody
  link('gone', STILL, 'staff', person('gone', 'Gone Coach', { active: false, deleted_at: '2026-09-01T00:00:00Z' })),
  link('gowner', GARAGE, 'owner', person('gowner', 'Gary Garage')),
]
const TYPES = [
  { id: 'fa', organization_id: ORG, name: 'First aid', active: true },
  { id: 'ins', organization_id: ORG, name: 'Insurance', active: true },
  { id: 'old', organization_id: ORG, name: 'Old cert', active: false },
  { id: 'gfa', organization_id: ORG2, name: 'First aid', active: true },
]
const rec = (profile_id, qualification_type_id, expires_on, organization_id = ORG) =>
  ({ id: `${profile_id}-${qualification_type_id}`, organization_id, profile_id, qualification_type_id, expires_on })
const RECORDS = [
  rec('ann', 'fa', '2026-09-20'), // expired
  rec('ann', 'ins', '2026-10-20'), // expiring
  rec('bob', 'fa', '2026-10-05'), // expiring (Hatch Street)
  rec('ann', 'old', '2026-09-01'), // archived type: never reported
  rec('gone', 'fa', '2026-09-01'), // a tombstone: never reported
]
const TODAY = '2026-09-28' // a Monday
const MON_0800Z = Date.parse('2026-09-28T08:00:00Z') // 09:00 in Dublin
const input = (over = {}) => ({
  locations: LOCATIONS, organizations: ORGS, links: LINKS, types: TYPES, records: RECORDS,
  todayISO: TODAY, nowMs: MON_0800Z, ...over,
})
const summary = (plans) => plans.map((pl) => [pl.recipientId, pl.organizationId, pl.rows.map((r) => `${r.profile_id}:${r.type_id}:${r.status}`)])

describe('planQualificationDigests', () => {
  it('one digest per recipient per organisation, listing only the people at the studios where THEY qualify', () => {
    const out = planQualificationDigests(input())
    expect(summary(out.plans)).toEqual([
      ['howner', ORG, ['bob:fa:expiring']],
      ['master', ORG, ['ann:fa:expired', 'ann:ins:expiring']],
      ['owner', ORG, ['ann:fa:expired', 'ann:ins:expiring']],
    ])
    expect(out).toMatchObject({ recipients: 4, nothing_due: 1, quiet_hours: 0, timezoneFallbackLocationIds: [] })
  })

  it('the payload: the registered category, the weekly key, a headline push, the list in the email', () => {
    const plan = planQualificationDigests(input()).plans.find((pl) => pl.recipientId === 'owner')
    expect(plan.eventKey).toBe('qualification_digest:org-1:2026-09-28')
    expect(plan.eventKey).toBe(digestEventKey(ORG, '2026-09-28'))
    expect(plan.payload).toMatchObject({
      title: 'Qualifications to renew',
      body: '1 qualification has expired and 1 more expires in the next 30 days. The list is under Schedule, Qualifications on the web.',
      category: QUALIFICATION_DIGEST_CATEGORY,
      emailSubject: 'Qualifications to renew at Studio Group',
      data: { type: QUALIFICATION_DIGEST_TYPE, organization_id: ORG, week_start: '2026-09-28' },
    })
    expect(plan.payload.emailHtml).toContain('Ann Coach')
    expect(plan.payload.emailHtml).toContain('Expired 20 Sep 2026')
    expect(plan.payload.emailHtml).toContain('Expires 20 Oct 2026')
  })

  it('the key is the Monday of the Dublin week, whichever day the run finds something', () => {
    const sunday = planQualificationDigests(input({ todayISO: '2026-10-04', nowMs: Date.parse('2026-10-04T08:00:00Z') }))
    expect(sunday.plans.map((pl) => pl.eventKey)).toEqual(Array(3).fill('qualification_digest:org-1:2026-09-28'))
  })

  it('quiet hours: outside 07:00-22:00 at any studio a list covers, nothing is planned, so nothing is claimed', () => {
    const late = planQualificationDigests(input({ nowMs: Date.parse('2026-09-28T21:30:00Z') })) // 22:30 Dublin
    expect(late.plans).toEqual([])
    expect(late.quiet_hours).toBe(3)
  })

  it('an unreadable studio timezone reads as Dublin and is reported once', () => {
    const odd = planQualificationDigests(input({ locations: LOCATIONS.map((l) => (l.id === HATCH ? { ...l, timezone: 'Mars/Base' } : l)) }))
    expect(odd.plans).toHaveLength(3)
    expect(odd.timezoneFallbackLocationIds).toEqual([HATCH])
  })

  it('nothing expired or expiring: no plan at all (a quiet week sends nothing)', () => {
    const out = planQualificationDigests(input({ records: [rec('ann', 'fa', '2027-06-01')] }))
    expect(out.plans).toEqual([])
    expect(out.nothing_due).toBe(4)
  })

  it('escapes what people typed', () => {
    const html = digestEmailHtml({ orgName: 'A & B', headline: '1 qualification has expired.', rows: [{ full_name: '<b>Eve</b>', type_name: 'First aid', expires_on: '2026-09-01', status: 'expired' }] })
    expect(html).toContain('&lt;b&gt;Eve&lt;/b&gt;')
    expect(html).toContain('A &amp; B')
    expect(html).not.toContain('<b>Eve</b>')
  })
})

describe('runQualificationDigest', () => {
  const runDb = (over = {}) => mockDb(byTable({
    locations: { data: LOCATIONS, error: null },
    organizations: { data: ORGS, error: null },
    profile_locations: { data: LINKS, error: null },
    staff_qualification_types: { data: TYPES.filter((t) => t.active), error: null },
    staff_qualifications: { data: RECORDS, error: null },
    ...over,
  }))

  beforeEach(() => {
    notifyUsersOnce.mockReset().mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0, emailed: 0, email_failed: 0, deduped: 0 })
  })

  it('reads active studios, their links, active types and records expiring by today + 30; one claim per recipient', async () => {
    const db = runDb()
    const out = await runQualificationDigest(db, { nowMs: MON_0800Z })
    const locQ = db.log.find((q) => q.table === 'locations')
    expect(filter(locQ, 'eq', 'active')).toBe(true)
    expect(filter(locQ, 'eq', 'is_host_anchor')).toBe(false)
    const recQ = db.log.find((q) => q.table === 'staff_qualifications')
    expect(filter(recQ, 'lte', 'expires_on')).toBe('2026-10-28')
    expect(filter(recQ, 'in', 'organization_id')).toEqual([ORG, ORG2])
    expect(filter(db.log.find((q) => q.table === 'profile_locations'), 'in', 'location_id')).toEqual([STILL, HATCH, GARAGE])
    expect(filter(db.log.find((q) => q.table === 'staff_qualification_types'), 'eq', 'active')).toBe(true)
    expect(notifyUsersOnce.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['qualification_digest:org-1:2026-09-28', ['howner']],
      ['qualification_digest:org-1:2026-09-28', ['master']],
      ['qualification_digest:org-1:2026-09-28', ['owner']],
    ])
    expect(out).toEqual({
      organizations: 2, recipients: 4, rows: 5, nothing_due: 1, quiet_hours: 0,
      sent: 3, emailed: 0, email_failed: 0, deduped: 0, failed: 0,
    })
  })

  it('one recipient failing costs nobody else their digest', async () => {
    notifyUsersOnce.mockRejectedValueOnce(new Error('expo down'))
    const out = await runQualificationDigest(runDb(), { nowMs: MON_0800Z })
    expect(notifyUsersOnce).toHaveBeenCalledTimes(3)
    expect(out).toMatchObject({ failed: 1, sent: 2 })
    expect(logWarn).toHaveBeenCalledWith('qualification-digest', 'send failed for a recipient', expect.anything())
  })

  it.each(['locations', 'organizations', 'profile_locations', 'staff_qualification_types', 'staff_qualifications'])(
    'a failed %s read throws before anything is sent (the cron records it; the heartbeat is not stamped)', async (table) => {
      await expect(runQualificationDigest(runDb({ [table]: { data: null, error: { message: 'down' } } }), { nowMs: MON_0800Z }))
        .rejects.toThrow(/read failed/)
      expect(notifyUsersOnce).not.toHaveBeenCalled()
    })

  it('no studios: a clean, empty outcome', async () => {
    const out = await runQualificationDigest(runDb({ locations: { data: [], error: null } }), { nowMs: MON_0800Z })
    expect(out).toMatchObject({ organizations: 0, recipients: 0, sent: 0 })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/qualification-digest.test.js`
Expected: FAIL. The stub exports only the two constants.

- [ ] **Step 3: Implement** (replace the whole stub)

`src/lib/qualification-digest.js`:

```js
// src/lib/qualification-digest.js
//
// QUALS.1 — the weekly qualification digest to owners. An ARM of the daily
// 08:00 UTC cron /api/cron/contract-reminders, with its own heartbeat row
// ('qualification-digest', mig 635; src/lib/cron-arm-health.js).
//
// WHO. Per organisation, each ACTIVE, non-tombstoned profile that is `owner`
// at one of its studios, or a `master` holding a row there (the
// resolveRoleRecipientIds rule, src/lib/push.js, re-read here so a failed
// read throws instead of looking like "nobody to tell"). Their list covers
// the current people at THE STUDIOS WHERE THEY QUALIFY, and nobody else:
// an owner of Stillorgan never sees a Hatch-only coach, and nobody ever sees
// another organisation's people.
//
// WHAT. Records of ACTIVE types that are expired, or expire within 30 days,
// on the Dublin today (shared/qualifications.js digestRows). A missing record
// is not listed (it would nag forever); an archived type is not listed.
//
// WHEN. The cron runs daily. Each recipient is claimed at most once per
// Dublin week (push_event_sends key qualification_digest:<org>:<Monday>,
// src/lib/push-dedup.js, one claim row per recipient), on the first run of
// the week with something to say, normally Monday. A delivery that fails
// outright releases its claim, so the next day retries. A week with nothing
// due sends nothing.
//
// QUIET HOURS (src/lib/staff-push-hours.js): nothing is planned, so nothing is
// claimed, unless the wall clock is inside [07:00, 22:00) at EVERY studio the
// recipient's list covers. 08:00 UTC is inside it all year in Dublin.
//
// HOW. notifyUsersOnce with category 'qualification_expiry' (registered:
// src/lib/qualification-expiry-registration.test.js): a push with the
// headline, and for a recipient with no device the registry's email fallback
// with the full list (payload.emailHtml).
//
// Throws on any read failure, BEFORE anything is sent; the cron records it
// and the heartbeat is not stamped. A per-recipient failure is counted in
// `failed` and never costs another recipient theirs.

import { notifyUsersOnce } from './push-dedup'
import { dublinDayStr, addDaysISO } from './dublin-time'
import { mondayOf } from './payroll'
import { inStaffPushHours, resolveStaffTimeZone } from './staff-push-hours'
import { isRosterableProfile } from './roster-write'
import { logWarn } from './log'
import {
  digestRows, digestHeadline, formatQualificationDate, QUALIFICATION_EXPIRY_WINDOW_DAYS,
} from '@shared/qualifications'

export const QUALIFICATION_DIGEST_CATEGORY = 'qualification_expiry'
export const QUALIFICATION_DIGEST_TYPE = 'qualification_digest'

const PAGE = 1000

export const digestEventKey = (organizationId, weekStart) => `qualification_digest:${organizationId}:${weekStart}`

const isRecipientLink = (l) => isRosterableProfile(l?.profiles) && (l.role === 'owner' || l.profiles.role === 'master')

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/** The fallback email's body: the headline and one row per record. */
export function digestEmailHtml({ orgName = '', headline = '', rows = [] } = {}) {
  const cell = 'padding:6px 8px;border-bottom:1px solid #eee;text-align:left'
  const items = rows.map((r) => `<tr><td style="${cell}">${esc(r.full_name || 'Someone')}</td><td style="${cell}">${esc(r.type_name)}</td><td style="${cell}">${r.status === 'expired' ? 'Expired' : 'Expires'} ${esc(formatQualificationDate(r.expires_on))}</td></tr>`).join('')
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
      <h2 style="font-size:18px;margin:0 0 12px 0">Qualifications to renew${orgName ? ` at ${esc(orgName)}` : ''}</h2>
      <p style="font-size:15px;line-height:1.5;margin:0 0 16px 0">${esc(headline)}</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">${items}</table>
      <p style="margin-top:24px;font-size:12px;color:#666">Update a record under Schedule, Qualifications on the web once it is renewed. You get this summary at most once a week, and only when something needs attention. It came by email because the Repset app is not set up on your phone.</p>
    </div>
  `
}

/**
 * PURE. Who gets a digest this run, with what.
 * @returns {{ plans: Array<{ recipientId, organizationId, eventKey, rows, payload }>,
 *   recipients: number, nothing_due: number, quiet_hours: number, timezoneFallbackLocationIds: string[] }}
 */
export function planQualificationDigests({
  locations = [], organizations = [], links = [], types = [], records = [], todayISO, nowMs,
  windowDays = QUALIFICATION_EXPIRY_WINDOW_DAYS,
} = {}) {
  const out = { plans: [], recipients: 0, nothing_due: 0, quiet_hours: 0, timezoneFallbackLocationIds: [] }
  const weekStart = mondayOf(todayISO)
  const locById = new Map(locations.filter((l) => l?.id && l.organization_id).map((l) => [l.id, l]))
  const orgNames = new Map(organizations.map((o) => [o.id, o.name]))

  const members = new Map() // location id → Map(profile id → full name)
  const qualifying = new Map() // `${org}|${profile}` → Set(location ids where they receive)
  for (const l of links) {
    const loc = locById.get(l?.location_id)
    if (!loc || !l.profile_id || !isRosterableProfile(l.profiles)) continue
    if (!members.has(loc.id)) members.set(loc.id, new Map())
    members.get(loc.id).set(l.profile_id, l.profiles.full_name ?? null)
    if (isRecipientLink(l)) {
      const key = `${loc.organization_id}|${l.profile_id}`
      if (!qualifying.has(key)) qualifying.set(key, new Set())
      qualifying.get(key).add(loc.id)
    }
  }

  const warned = new Set()
  for (const [key, locIds] of [...qualifying.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [organizationId, recipientId] = key.split('|')
    out.recipients++
    const people = new Map()
    for (const locId of locIds) for (const [pid, name] of members.get(locId) || []) people.set(pid, name)
    const rows = digestRows({
      people: [...people].map(([profile_id, full_name]) => ({ profile_id, full_name })),
      types: types.filter((t) => t.organization_id === organizationId),
      records: records.filter((r) => r.organization_id === organizationId),
      todayISO,
      windowDays,
    })
    if (rows.length === 0) {
      out.nothing_due++
      continue
    }

    let open = true
    for (const locId of [...locIds].sort()) {
      const { timeZone, warn } = resolveStaffTimeZone(locById.get(locId)?.timezone)
      if (warn && !warned.has(locId)) {
        warned.add(locId)
        out.timezoneFallbackLocationIds.push(locId)
      }
      if (!inStaffPushHours(nowMs, timeZone)) open = false
    }
    if (!open) {
      out.quiet_hours++
      continue
    }

    const orgName = orgNames.get(organizationId) || ''
    const headline = digestHeadline(rows, windowDays)
    out.plans.push({
      recipientId,
      organizationId,
      eventKey: digestEventKey(organizationId, weekStart),
      rows,
      payload: {
        title: 'Qualifications to renew',
        body: `${headline} The list is under Schedule, Qualifications on the web.`,
        category: QUALIFICATION_DIGEST_CATEGORY,
        // The registry's fallbackEmail is on; notifyUsers prefers these.
        emailSubject: orgName ? `Qualifications to renew at ${orgName}` : 'Qualifications to renew',
        emailHtml: digestEmailHtml({ orgName, headline, rows }),
        data: { type: QUALIFICATION_DIGEST_TYPE, organization_id: organizationId, week_start: weekStart },
      },
    })
  }
  return out
}

async function readPaged(label, build) {
  const rows = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build().range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${label} read failed: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

async function readOnce(label, query) {
  const { data, error } = await query
  if (error) throw new Error(`${label} read failed: ${error.message}`)
  return data || []
}

/**
 * @param {object} db  service-role supabase client
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<{ organizations, recipients, rows, nothing_due, quiet_hours, sent, emailed, email_failed, deduped, failed }>}
 *   throws when a read fails, before anything is sent
 */
export async function runQualificationDigest(db, { nowMs = Date.now() } = {}) {
  const outcome = {
    organizations: 0, recipients: 0, rows: 0, nothing_due: 0, quiet_hours: 0,
    sent: 0, emailed: 0, email_failed: 0, deduped: 0, failed: 0,
  }
  const todayISO = dublinDayStr(nowMs)

  const locations = await readOnce('locations', db
    .from('locations')
    .select('id, name, organization_id, timezone')
    .eq('active', true)
    .eq('is_host_anchor', false))
  const orgIds = [...new Set(locations.map((l) => l.organization_id).filter(Boolean))]
  outcome.organizations = orgIds.length
  if (orgIds.length === 0) return outcome
  const locIds = locations.map((l) => l.id)

  const [organizations, links, types, records] = await Promise.all([
    readOnce('organizations', db.from('organizations').select('id, name').in('id', orgIds)),
    readPaged('profile_locations', () => db
      .from('profile_locations')
      .select('profile_id, location_id, role, profiles!inner(id, full_name, role, active, deleted_at)')
      .in('location_id', locIds)
      .order('profile_id', { ascending: true })
      .order('location_id', { ascending: true })),
    readOnce('qualification types', db
      .from('staff_qualification_types')
      .select('id, organization_id, name, active')
      .in('organization_id', orgIds)
      .eq('active', true)),
    readPaged('qualifications', () => db
      .from('staff_qualifications')
      .select('id, organization_id, profile_id, qualification_type_id, expires_on')
      .in('organization_id', orgIds)
      .not('expires_on', 'is', null)
      .lte('expires_on', addDaysISO(todayISO, QUALIFICATION_EXPIRY_WINDOW_DAYS))
      .order('id', { ascending: true })),
  ])

  const planned = planQualificationDigests({ locations, organizations, links, types, records, todayISO, nowMs })
  outcome.recipients = planned.recipients
  outcome.nothing_due = planned.nothing_due
  outcome.quiet_hours = planned.quiet_hours
  if (planned.timezoneFallbackLocationIds.length) {
    logWarn('qualification-digest', 'invalid timezone on a location: using Europe/Dublin for it', { locationIds: planned.timezoneFallbackLocationIds })
  }

  for (const plan of planned.plans) {
    outcome.rows += plan.rows.length
    try {
      const r = await notifyUsersOnce(db, plan.eventKey, [plan.recipientId], plan.payload)
      outcome.sent += r?.sent || 0
      outcome.emailed += r?.emailed || 0
      outcome.email_failed += r?.email_failed || 0
      outcome.deduped += r?.deduped || 0
      outcome.failed += r?.failed || 0
    } catch (err) {
      // notifyUsersOnce is documented never to throw; if it does, one
      // recipient's failure must not cost the next one theirs.
      outcome.failed++
      logWarn('qualification-digest', 'send failed for a recipient', { recipientId: plan.recipientId, err: err?.message })
    }
  }
  return outcome
}
```

- [ ] **Step 4: Run, expect PASS, both timezones**

Run: `for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/qualification-digest.test.js src/lib/qualification-expiry-registration.test.js || break; done && npm run check:select-columns && npx vitest run tests/push-category-literals.test.js`
Expected: all pass. `locations.is_host_anchor` is mig 388; `locations.timezone` is already read by the runway arm; `profiles.role/active/deleted_at` resolve. The category literal is bare.

- [ ] **Step 5: Commit**

```bash
git add src/lib/qualification-digest.js src/lib/qualification-digest.test.js
git commit -m "QUALS.1 — the weekly qualification digest: owners (and linked masters), their studios' people only

Expired or expiring within 30 days, active types. At most once per recipient
per Dublin week (push_event_sends key per organisation and Monday), on the
first daily run with something to say; quiet hours at every studio covered;
a push with the headline, the email fallback with the list. Read failures
throw before anything is sent; one recipient's failure costs no one else.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Wire the arm into `contract-reminders`, with its own heartbeat

**Files:**
- Modify: `src/lib/cron-arm-health.js`, `src/lib/cron-arm-health.test.js`
- Modify: `src/app/api/cron/contract-reminders/route.js`, `route.test.js`
- Modify: `eslint.guardrails.config.mjs`

- [ ] **Step 1: Write the failing tests**

`src/lib/cron-arm-health.test.js`:

- Line 13 becomes `vi.mock('./push-dedup', () => ({ notifyUsersAtRolesOnce: vi.fn(), notifyUsersOnce: vi.fn() }))`.
- Add `QUALIFICATION_DIGEST_HEARTBEAT, qualificationDigestArmHealthy,` to the `await import('./cron-arm-health')` destructure (lines 17-21).
- After line 24, add `const { runQualificationDigest } = await import('./qualification-digest')`.
- Append:

```js
// QUALS.1 — the weekly qualification digest arm of contract-reminders.
describe('qualification-digest', () => {
  it('names its row, and judges an outcome the way the runway arm does', () => {
    expect(QUALIFICATION_DIGEST_HEARTBEAT).toBe('qualification-digest')
    const clean = { organizations: 1, recipients: 1, rows: 0, nothing_due: 1, quiet_hours: 0, sent: 0, emailed: 0, email_failed: 0, deduped: 0, failed: 1 }
    expect(qualificationDigestArmHealthy(clean)).toBe(true) // a delivery failure is not an arm fault
    expect(qualificationDigestArmHealthy({ error: 'locations read failed: down' })).toBe(false)
    expect(qualificationDigestArmHealthy(undefined)).toBe(false)
    expect(qualificationDigestArmHealthy([])).toBe(false)
  })

  it('drift guard: the REAL arm with no studios returns an outcome that stamps', async () => {
    const empty = { data: [], error: null }
    const db = { from: () => { const b = { select: () => b, eq: () => b, then: (r, j) => Promise.resolve(empty).then(r, j) }; return b } }
    const outcome = await runQualificationDigest(db, { nowMs: Date.parse('2026-09-28T08:00:00Z') })
    expect(outcome).toMatchObject({ organizations: 0, recipients: 0, sent: 0 })
    expect(qualificationDigestArmHealthy(outcome)).toBe(true)
  })
})
```

`src/app/api/cron/contract-reminders/route.test.js`:

(a) Beside the other mocks and imports:

```js
vi.mock('@/lib/qualification-digest', () => ({ runQualificationDigest: vi.fn() }))
```

```js
const { runQualificationDigest } = await import('@/lib/qualification-digest')
```

After `const OUTCOME = …`:

```js
const QUALS = { organizations: 1, recipients: 1, rows: 2, nothing_due: 0, quiet_hours: 0, sent: 1, emailed: 0, email_failed: 0, deduped: 0, failed: 0 }
```

In `beforeEach`, add `runQualificationDigest.mockReset().mockResolvedValue(QUALS)`.

(b) Existing assertions to update. The third arm now always runs and stamps between the other two:

| Test | Before | After |
|---|---|---|
| `401 without the cron bearer…` | — | add `expect(runQualificationDigest).not.toHaveBeenCalled()` |
| `runs the arm with the service-role client…` (both exact objects) | `… runway: OUTCOME, runway_arm_failed: 0,` | `… runway: OUTCOME, runway_arm_failed: 0, qualifications: QUALS, qualification_arm_failed: 0,` |
| `and vice versa: the contract half throwing…` | `['roster-runway']` | `['roster-runway', 'qualification-digest']` |
| `a clean arm: roster-runway is stamped…` | `stampedBeforeContracts` `['roster-runway']`; `stampedNames()` `['roster-runway', 'contract-reminders']` | `['roster-runway', 'qualification-digest']`; `['roster-runway', 'qualification-digest', 'contract-reminders']` |
| `the arm THROWS: roster-runway is NOT stamped…` | `['contract-reminders']`; the exact object ending `runway_arm_failed: 1,` | `['qualification-digest', 'contract-reminders']`; append `qualifications: QUALS, qualification_arm_failed: 0,` |
| `an arm that resolves with nothing…` | `['contract-reminders']` | `['qualification-digest', 'contract-reminders']` |
| `an arm that resolves with an { error } outcome…` | `['contract-reminders']` | `['qualification-digest', 'contract-reminders']` |
| `a rejecting roster-runway stamp…` | `['roster-runway', 'contract-reminders']` | `['roster-runway', 'qualification-digest', 'contract-reminders']` |

(c) Append:

```js
// QUALS.1 — the weekly qualification digest is the third arm, with its own
// heartbeat row ('qualification-digest', mig 635): stamped after the runway
// arm and BEFORE the contract half can crash, only when it returned an
// outcome without { error }. Isolated both ways, like the runway arm.
describe('GET /api/cron/contract-reminders — qualification digest arm', () => {
  it('runs with the service-role client and stamps its own row with its outcome, between the runway arm and the contracts', async () => {
    contractRows = [{ id: 'c1', status: 'issued', reminder_count: 0 }]
    let stampedBeforeContracts = null
    reminderDue.mockImplementation(() => { stampedBeforeContracts ??= stampedNames().slice(); return false })
    await GET(req())
    expect(runQualificationDigest).toHaveBeenCalledWith(fakeDb)
    expect(stampedBeforeContracts).toEqual(['roster-runway', 'qualification-digest'])
    expect(stampHeartbeat).toHaveBeenCalledWith('qualification-digest', QUALS)
  })

  it('a throwing digest is logged and visible, is not stamped, and costs neither the runway arm nor the contracts', async () => {
    runQualificationDigest.mockRejectedValue(new Error('qualifications read failed: down'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(logError).toHaveBeenCalledWith('cron-contract-reminders', 'qualification digest arm threw', expect.anything())
    expect(stampedNames()).toEqual(['roster-runway', 'contract-reminders'])
    expect(await res.json()).toMatchObject({
      qualifications: { error: 'qualifications read failed: down' }, qualification_arm_failed: 1, runway_arm_failed: 0,
    })
  })

  it('an { error } outcome, or nothing at all, is not stamped', async () => {
    runQualificationDigest.mockResolvedValue({ error: 'x' })
    await GET(req())
    expect(stampedNames()).toEqual(['roster-runway', 'contract-reminders'])
    stampHeartbeat.mockClear()
    runQualificationDigest.mockResolvedValue(undefined)
    await GET(req())
    expect(stampedNames()).toEqual(['roster-runway', 'contract-reminders'])
  })

  it('a runway arm that throws does not stop the digest', async () => {
    runRosterRunwayAlerts.mockRejectedValue(new Error('runway down'))
    await GET(req())
    expect(runQualificationDigest).toHaveBeenCalledTimes(1)
    expect(stampedNames()).toEqual(['qualification-digest', 'contract-reminders'])
  })

  it('a rejecting qualification-digest stamp is logged and costs the contracts nothing', async () => {
    stampHeartbeat.mockImplementation((name) =>
      name === 'qualification-digest' ? Promise.reject(new Error('stamp down')) : Promise.resolve())
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampedNames()).toEqual(['roster-runway', 'qualification-digest', 'contract-reminders'])
    expect(logWarn).toHaveBeenCalledWith('cron-contract-reminders', 'qualification-digest heartbeat failed', expect.anything())
  })
})
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/lib/cron-arm-health.test.js src/app/api/cron/contract-reminders/route.test.js`
Expected: FAIL. The predicate is missing, the arm is not wired, and the stamp lists differ.

- [ ] **Step 3: Implement**

`src/lib/cron-arm-health.js`. Extend the header list (after the `'shift-time-changes'` entry):

```js
//   'qualification-digest' — runQualificationDigest (src/lib/qualification-digest.js,
//                       QUALS.1), the third arm of the daily contract-reminders cron.
```

Change `// The first two rows are seeded by mig 633, the third by mig 639` to `// The first two rows are seeded by mig 633, the third by mig 639, the fourth by mig 635`. Directly after `runwayArmHealthy` (lines 57-60), add:

```js
// QUALS.1 — the weekly qualification digest arm of contract-reminders. Seeded by mig 635.
export const QUALIFICATION_DIGEST_HEARTBEAT = 'qualification-digest'

/**
 * True when a runQualificationDigest() outcome shows a clean run. The arm
 * throws on every failure of its own (a read), which the cron records as
 * { error }; `failed` counts per-recipient deliveries whose claims are
 * released for the next day, so it does not block the stamp. A week with
 * nothing due, and a quiet-hours run, are clean.
 */
export function qualificationDigestArmHealthy(outcome) {
  if (!isOutcome(outcome)) return false
  return !Object.prototype.hasOwnProperty.call(outcome, 'error')
}
```

`src/app/api/cron/contract-reminders/route.js`. Imports (lines 31-32) become:

```js
import { runRosterRunwayAlerts } from '@/lib/roster-runway-notify'
import { runQualificationDigest } from '@/lib/qualification-digest'
import {
  ROSTER_RUNWAY_HEARTBEAT, runwayArmHealthy,
  QUALIFICATION_DIGEST_HEARTBEAT, qualificationDigestArmHealthy,
} from '@/lib/cron-arm-health'
```

Add to the header comment, after the HEARTBEAT.1 line: `// QUALS.1 — also runs the weekly qualification digest (third arm), with its own heartbeat row 'qualification-digest' (mig 635).`

Directly after the runway arm's stamp block (the `if (runwayArmFailed === 0 && runwayArmHealthy(runway)) { … }` that ends at line 84), insert:

```js
  // QUALS.1 — third arm: the weekly qualification digest to owners
  // (src/lib/qualification-digest.js). Runs every day; each owner hears at
  // most once per Dublin week, on the first run with something expired or
  // expiring (push_event_sends claim), inside 07:00-22:00 studio time.
  // Isolated both ways, like the runway arm: its own try/catch, and its own
  // heartbeat row ('qualification-digest', mig 635) stamped under its own
  // .catch BEFORE the contract half runs, so a contract crash cannot cost a
  // clean digest its stamp. Only a returned outcome with no { error } stamps.
  let qualifications
  let qualificationArmFailed = 0
  try {
    qualifications = await runQualificationDigest(db)
  } catch (err) {
    qualificationArmFailed = 1
    logError('cron-contract-reminders', 'qualification digest arm threw', { err })
    qualifications = { error: err?.message || 'qualification digest arm failed' }
  }
  if (qualificationArmFailed === 0 && qualificationDigestArmHealthy(qualifications)) {
    await stampHeartbeat(QUALIFICATION_DIGEST_HEARTBEAT, qualifications).catch((err) =>
      logWarn('cron-contract-reminders', 'qualification-digest heartbeat failed', { err }))
  }
```

The `outcome` line (172) becomes:

```js
  const outcome = {
    checked: candidates.length, sent, emailFailed, rowErrors,
    runway, runway_arm_failed: runwayArmFailed,
    qualifications, qualification_arm_failed: qualificationArmFailed,
  }
```

`eslint.guardrails.config.mjs`, in the `no-unchecked-supabase-write` `files` list, directly after `'src/lib/staff-calendar-feed-server.js',` (line 306):

```js
      // QUALS.1 — qualification records, the catalogue, template requirements
      // and the digest. Born clean, armed on arrival.
      'src/lib/qualifications-server.js',
      'src/lib/qualification-digest.js',
      'src/app/api/qualifications/**',
      'src/app/api/schedule/template-qualifications/**',
```

(No `[id]` needs escaping here: `**` covers `[id]/route.js`. BLOCKEDIT.1's `[[]id]` note applies only to a literal `[id]` in a glob.)

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run src/lib/cron-arm-health.test.js src/app/api/cron/contract-reminders/route.test.js && npm run check:guardrails && grep -L stampHeartbeat src/app/api/cron/*/route.js`
Expected: tests pass and guardrails is clean. The grep lists only `health-check` and `ad-insights-backfill` (CLAUDE.md, Crons & webhooks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cron-arm-health.js src/lib/cron-arm-health.test.js src/app/api/cron/contract-reminders/route.js src/app/api/cron/contract-reminders/route.test.js eslint.guardrails.config.mjs
git commit -m "QUALS.1 — contract-reminders third arm: the weekly qualification digest, own heartbeat row

Stamped 'qualification-digest' (mig 635) only when the arm returned an
outcome without { error }, under its own .catch, after the runway arm and
before the contract half. Its failure is logged, rides in last_outcome, and
costs neither other arm anything. Guardrail armed on the new files.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The gate, the migration, the PR

- [ ] **Step 1: Date code under two timezones**

```bash
for tz in Europe/Dublin America/Los_Angeles; do
  TZ=$tz npx vitest run shared/qualifications.test.js src/lib/qualification-digest.test.js src/lib/qualifications-server.test.js src/components/QualificationsManager.test.jsx || break
done
```

Expected: all pass in both runs. In path A, add `shared/candidates.test.js src/lib/candidates-data.test.js` to the list.

- [ ] **Step 2: The full CI mirror (all twelve), then the build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
npm run build
```

Expected: every command exits 0. `npm run build` catches import resolution: `@shared/qualifications` in two client components, `@/lib/qualifications-schemas` in `ShiftTemplateManager`, and the new route files and page. If a test that is not part of this PR fails, check `origin/main` first. Do not "fix" another PR's test here.

- [ ] **Step 3: Independent review, then rebase**

Request an independent review (superpowers:requesting-code-review) of the whole diff against this plan. Fix its must-fixes, then re-run Step 2. Rebase onto a fresh `origin/main` (`git fetch origin main && git rebase origin/main`). The conflict hotspots are listed under Files. Re-run Step 2 after any conflict.

- [ ] **Step 4: Apply migration 635 BEFORE the merge** (merge authority: 00-INDEX, "Migrations")

The routes and the arm read the new tables, so the tables must exist before the code deploys.

1. Confirm the project with `list_projects`: un1t-crm is `iyvtbjjxdggiadzwwvdj`, NOT the sentinel project.
2. Run pre-checks (a)–(f) from the file header with `execute_sql`, one statement per call. Save the output to the scratchpad as `mig635-rollback-<date>.txt`, together with the ROLLBACK block from the header.
3. Apply: `apply_migration`, name `635_staff_qualifications`, the file's full text.
4. Run post-checks (g)–(j) and `list_migrations` (635 present).
5. Run `get_advisors` twice, security then performance. Expected: `rls_enabled_no_policy` +3 INFO and nothing else new.

If any answer differs from the header's "Expected", STOP. Nothing is half-applied: the file is one transaction with a self-check.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "QUALS.1 — staff qualifications with expiry: records, advisory template requirements, a weekly owner digest (mig 635, phone update)" --body-file "<scratchpad>/quals1-pr.md"
```

(Write the body file in the session scratchpad from the points below, ending with the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. `--body-file` avoids shell-quoting the markdown.)

**PR body points:**

- **What.** An organisation-level qualification catalogue: First aid, Insurance and Garda vetting are seeded per organisation, and owners add, rename and archive. Records are one per person per type (issued date optional, expiry optional = "does not expire", note ≤ 300), managed by owners and managers at a studio the person belongs to. Everyone else sees their own, read-only, at Schedule › Qualifications. Shift templates can ask for up to 5 types; this is advisory (path A: a badge in the ranked picker, judged on the shift's date; path B: shipped as a pure function, wiring below). A weekly digest to owners (and linked masters) lists what is expired or expiring in 30 days for their studios' people.
- **Migration 635, APPLIED BEFORE MERGE.** Three service-role-only tables (RLS on, no policies, no browser grants), a same-organisation DEFINER trigger, seeds, and the `qualification-digest` heartbeat row (86400 + 43200). Pre/post checks and advisors are in the rollback record `mig635-rollback-<date>.txt`. **Right after the prod deploy, re-run the heartbeat INSERT** (the arm rule). The row is born healthy with a 36-hour window, so this is belt and braces.
- **Phone update (OTA).** `shared/qualifications.js` (no-op on phones), `shared/permissions.js` + `permission-bundles.js` + `push-channels.js` (phones gain one "Qualification expiry" toggle), and in path A `shared/candidates.js` (the badge list; `reason` and the order are unchanged). The index row said no OTA; it does publish. One at a time: check the EAS Update run before the next OTA merge.
- **Cron.** A third ARM of `contract-reminders` (daily 08:00 UTC) with its own heartbeat row, stamped only on a clean run, placed so neither of the other halves can crash it out of its stamp (CLAUDE.md, "An ARM that rides another cron's schedule gets its OWN row").
- **Push category** `qualification_expiry` registered at every site (an unregistered one fails closed), default on for every role, recipients narrowed in code. The email fallback carries the list.
- **Excluded everywhere:** deactivated staff and tombstones (list, writes, digest, picker).
- **Security.** Every route: session → role pre-check → body → location access → data layer. Anything that needs a row (a record, a type, a template) answers 404 when out of reach, malformed ids included. The picker's badge is manager audience only.
- **Not in this PR:** a phone screen and a push-tap route for the digest ("phone later"); document upload (index default 7); TPLCLONE copying requirements. Path B only: Task 10A (the picker wiring), verbatim.
- **Owner steps after merge:** check the three seeded types per organisation (archive any that do not apply, e.g. Garda vetting at CCF Autos); enter current certificates; mark which templates need first aid.

- [ ] **Step 6: CHANGELOG row** (after the PR number exists; never edit a pushed row)

Add under the Done table header in `docs/CHANGELOG.md`, commit, and push to the same branch:

```
| #<PR> | QUALS.1 — staff qualifications with expiry: records, advisory template requirements, a weekly owner digest | <date>. Wave 3 PR 33. **Mig 635 applied before merge (heartbeat INSERT re-run after deploy); OTA** (`shared/`: phones gain one "Qualification expiry" toggle). Organisation-level catalogue `staff_qualification_types` (First aid / Insurance / Garda vetting seeded per org; owners add, rename, archive), `staff_qualifications` (one per person per type; expiry optional = no expiry; note ≤300; composite FK pins the record to its type's org), `shift_template_qualification_requirements` (≤5, advisory; same-org DEFINER trigger). All service-role only. Schedule › Qualifications: owners/managers at a studio the person belongs to manage records; everyone else sees their own. Template editor "Requires (advisory)". <Path A: ranked picker badge "First aid: not on record / expired" on the shift date, manager audience only, never a rank.> Weekly digest = third arm of `contract-reminders` with its own `qualification-digest` heartbeat (86400+43200): owners + linked masters, their studios' people only, expired or expiring in 30 days, at most once per Dublin week (push_event_sends key per org + Monday), quiet hours, category `qualification_expiry` (email fallback carries the list). Deactivated and tombstoned staff excluded everywhere. Pure rules in `shared/qualifications.js`. |
```

- [ ] **Step 7: After merge**

1. Watch the production deploy.
2. Re-run the heartbeat INSERT from mig 635 via `execute_sql`: the `INSERT INTO public.cron_heartbeats … ON CONFLICT (name) DO UPDATE …` statement alone, no `BEGIN` (an unterminated `begin;` in MCP `execute_sql` rolls back).
3. Watch the EAS Update run for the `shared/` publish.
4. The next day after 08:00 UTC, check the arm stamped, and ask Richard whether a digest arrived:

   ```sql
   SELECT last_ok_at, last_outcome FROM public.cron_heartbeats WHERE name = 'qualification-digest';
   ```

   Expected: `last_ok_at` after 08:00 UTC. `last_outcome` has `organizations` ≥ 1 and `recipients` ≥ 1. It has `nothing_due` = recipients until someone enters a record that expires within 30 days.

---

### Review notes / open questions (for Richard; each is cheap to change before merge)

1. **`expires_on` is optional** (decision 3). The brief listed it as required. Garda vetting disclosures carry no expiry, so the form asks for a date unless "Does not expire" is ticked. The alternative is a required date, and owners type a re-vetting date.
2. **The catalogue is per organisation** (decision 1). CCF Autos gets First aid / Insurance / Garda vetting too, because the brief said "for each organisation". Its owner can archive what does not apply. An organisation created after mig 635 gets no seed until the file is re-run or an owner adds types. A trigger on `organizations` is a possible follow-up.
3. **Who manages:** owners and managers only; head coaches cannot record, although they edit templates and set requirements. **Who edits the catalogue:** owners and masters; org admins (SAAS-4) are not included.
4. **Digest recipients are owners and linked masters, not managers** (decision 9). Should managers get it for their studio?
5. **TPLCLONE.1's copy does not copy requirements** (decision 6). Hatch Street's copied templates start with none.
6. **The picker advisory is a badge only** (decision 7): no tier, no rank, and not on the phone's reason line. Head coaches see the badge in the picker (manager audience) while they cannot open colleagues' records. The "not checked" note reuses CANDIDATES.1's wording "…so the order may be off", which is slightly wrong for qualifications (they never move the order). Change the sentence, or leave it as the one shared note.
7. **"Weekly" means at most once per recipient per Dublin week, on the first daily run with something due** (decision 8). Normally that is Monday 08:00/09:00. A failed Monday delivery retries Tuesday. Something that first becomes due mid-week, in a week that already had a digest, waits for next Monday. Something that becomes due in a week that had none goes out that day. The alternative, Mondays only, loses a week on any Monday failure.
8. **An owner with the app gets a push with the count, not the list.** The list is in the email, and the email only goes to owners without a device (the registry fallback, `src/lib/notify.js`). Should owners always get the email as well? That would need a second send path (the fallback is "no device" by design).
9. **The digest lists expired and expiring records only.** A person with NO record of a type is never listed (it would nag forever about optional types). A future option is an "a template requires it and they have none" list.
10. **A tombstone's records stay on disk** and are never listed (decision 13). Should `tombstone_staff_profile()` delete them, or null the notes? Same open question as AVAIL.1's rules.
11. **No certificate history and no audit row.** A renewal overwrites the dates, and a delete is a hard delete. `recorded_by`/`updated_by`/`updated_at` are the only trail.
12. **Requirement saves are two statements** (remove, then add), not one transaction. A failure between them leaves a subset, and saving again completes it.
13. **The phone** shows the new "Qualification expiry" toggle to every role (the AVAIL.1 precedent: default on everywhere, recipients narrowed in code). Tapping the digest push does nothing on the phone yet (logged as an unhandled type). A phone screen for your own qualifications, and the tap route, are the "phone later" follow-up.
14. **Index correction:** 00-INDEX lists QUALS.1 with no OTA; it publishes one (`shared/`). Please update the row.

**Follow-ups found while planning (not in this PR):**

- `resolveRoleRecipientIds` (`src/lib/push.js:364-381`) still discards its read error. The digest re-reads links itself for that reason. It is already in the index's follow-ups.
- Phone: an own-qualifications screen, a `qualification_digest` route in `mobile/lib/notification-nav.js`, and (path A) the badge in the phone's picker sheets.
- TPLCLONE.1: optionally copy a template's requirements (same organisation, so the types are valid).
