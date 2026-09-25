## PR SHIFTTYPE.1: shift templates are class or admin. An admin shift is never a staffing gap and stays out of the contractor budget

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `shift_templates` gets a `kind`, either `class` (the default) or `admin`. An admin shift has no minimum staffing, so it never shows as an "empty" or "short" gap on any surface. It stays out of the contractor budget gate and the contractor spend projection, and it still counts toward hours everywhere hours are counted. Cards draw it in a separate neutral tone.

**Why:** Richard decided this on 25 Sep. The decision is recorded in 00-INDEX under "Richard's decisions" and is binding:
- The roster scope is HYBRID. Only admin work that needs a time and a person is placed on the roster.
- Admin shifts carry no minimum staffing, so an unfilled admin block is never a gap.
- The publish check, the staffing chips and the runway alert look at class shifts only.
- Admin blocks stay out of the contractor budget gate but count toward working-time advisories.

Wave 1 left the card hook for this: `cardTone(block)` in `src/lib/roster-card-model.js:33` returns `'neutral'` for every block, with a comment saying Wave 2 returns `'admin'` there.

**Size / ships:** M. **Migration 628** + web deploy + **OTA**. `shared/**`, `mobile/lib/**` and `mobile/components/**` change, so merging publishes a phone update at 100%.

**DEPLOY ORDER (strict):**
1. **Apply mig 628 FIRST.** Use Supabase MCP `apply_migration` against **un1t-crm** (`iyvtbjjxdggiadzwwvdj`), then `get_advisors`. Full steps are in "Migration apply steps" at the end. The migration is safe on its own: it adds a column that defaults every row to `class`, which is exactly today's behaviour.
2. **Then merge.** The code names `shift_templates.kind` in a dozen PostgREST selects. If the code were live without the column, every one of those selects would return 400. That would break the calendar, the publish check, the runway chip, the spend panel and the Studio Overview. This is the ENROLFIX.1 class (CLAUDE.md, "A column named in a `.select()` is a CLAIM ABOUT THE SCHEMA"). A Vercel preview of this branch runs against prod, so the preview is also broken until 628 is applied. That is expected: apply before checking the preview.
3. A phone that has not taken the OTA yet never reads `kind` and treats every block as class, which is today's behaviour. So the phone update is harmless in either order.

---

### Decisions (made here, each justified)

**D1. The column lives on `shift_templates` only. It is NOT snapshotted onto `shift_blocks`; a block reads its kind through its template.**
- `shift_blocks.template_id` is `NOT NULL REFERENCES shift_templates ON DELETE RESTRICT` (`supabase/migrations/067_roster_v2_shift_blocks.sql:62`). Every block has exactly one template, so the `shift_templates(kind)` embed is to-one and never null.
- `min_coaches` and `max_coaches` are snapshotted so that a template edit does not reclassify PAST blocks (mig 177's comment). That reason does not apply to kind:
  - every staffing reader ignores past blocks (`futureBlockStaffing` returns null for `block_date < today`, `shared/roster-staffing.js:73`);
  - hours count both kinds, so kind cannot move an hours figure;
  - a published roster keeps its own contractor snapshot (`rosters.projected_contractor_eur`).
- A snapshot would also need every block WRITER to copy the kind: `generateBlocksForTemplate` (`src/lib/roster.js:384-395`), `roster-write.js:170-181` and `:533-541`, the exact copy (`roster-copy.js:255-260`), `POST /api/schedule/blocks`, and every future writer. A writer that forgot would repeat HORIZONMIN.1: mig 611 exists because the generator forgot `min_coaches`. A template-level column also needs no propagation step when a template's kind is flipped, and it creates no second place for the truth to drift.
- The fail direction is the safe one either way. A reader that does not embed the kind treats the block as **class** (D6). A missing embed therefore brings back pre-SHIFTTYPE behaviour (a false gap, or admin hours priced into the budget). It never hides a real class gap.
- Accepted consequence: flipping a template's kind also reclassifies its past blocks. Only the current month's contractor-spend panel can move because of that. It is rare and is flagged in Review notes.

**D2. `kind text NOT NULL DEFAULT 'class'`, with `CHECK (kind IN ('class','admin'))`, and no backfill.** Every existing template reads `class` (Stillorgan has 18, Hatch Street has none), which is today's behaviour byte for byte. Operators mark admin templates in the template editor after deploy. `ADD COLUMN` with a constant default is a catalog-only change on PG ≥ 11, so there is no table rewrite.

**D3. An admin template has `min_coaches = 0`, enforced in BOTH the API and a DB CHECK `kind <> 'admin' OR min_coaches = 0`.**
- The DB CHECK exists because the API is not the only door. The browser still holds UPDATE on `shift_templates`, through the mig 600 policy `shift_templates_upd` (any manager at the location) and the table-level grant. This is the same lesson as migs 618, 624 and 625.
- API policy: **refuse an explicit contradiction, and normalise an omitted value.**
  - `kind: 'admin'` with `min_coaches > 0` in the same body gets **400 `admin_has_no_minimum`**. A silent rewrite would hide a client bug and save something the operator did not type.
  - `kind: 'admin'` with no `min_coaches` writes `min_coaches: 0` in the same UPDATE. The DB CHECK needs both columns to change in one statement, and saying "admin" with no minimum is not a contradiction.
  - Switching admin → class with no minimum restores the create default of 1 (SHIFTMIN.1).
  - The web form always sends both fields anyway.
- The migration needs no "fix existing admin rows" step. The column is new, so no admin rows exist yet.

**D4. "No minimum staffing" means "no staffing question".** `futureBlockStaffing(block, today)` returns `null` for an admin block, which is the answer it already gives a past block. Every staffing surface already treats `null` as "nothing to flag", and almost all of them read through this one function (see the table below). The Studio Overview route is the only reader with its own inline minimum loop. That loop moves into a pure `underMinEntry` that skips admin.

**D5. Contractor money excludes admin; hours never filter on kind.** Admin is skipped at the three places that price contractor hours: `blockContractorCost` (the publish gate, `src/lib/roster-publish.js:261`), `summarizeMonth` (the spend panel), and `summarizeWeek`'s contractor total. The FTE implicit cost, week-cost, payroll `shiftHours`, the hours report, staff cost and coverage never read `kind`, so admin hours count there automatically. Tests pin this.

**D6. A kind that cannot be read is `class`.** `shiftKindOf()` returns `'admin'` only for the exact string `'admin'`.

**D7. A coach sees the kind.** Kind is not a capacity fact. The coach's slim block shape carries `shift_templates.kind`, so a coach's admin card gets the admin tone too. Capacity (`min/max_coaches`) is still stripped (`slimBlockForCoach`, `src/app/api/schedule/blocks/route.js:121`).

**D8. Studio Overview SUPPLY is unchanged.** `staff_scheduled` counts everyone rostered that day, admin included, because they are on site. Only the below-minimum rows skip admin. This is flagged in Review notes in case Richard wants event cover to count class shifts only.

### Every reader of `min_coaches`, staffing and contractor spend, and what this PR does to it

Verified with `grep -rn -E "min_coaches|futureBlockStaffing|staffingGaps|countStaffingGaps|blockFillState|summarizeMonth|summarizeWeek|blockContractorCost|fetchRosterRunways" src shared mobile` on `2f0b35ba`.

| Surface | Where the rule runs | Where the block rows come from | Change |
|---|---|---|---|
| The staffing rule | `shared/roster-staffing.js:71` `futureBlockStaffing` | n/a | **admin → `null`** |
| Gap list / counts | `shared/roster-staffing.js:85,104` | through `futureBlockStaffing` | none |
| Today staffing chip (web) | `src/lib/roster-staffing.js:58` `fetchStaffingGapsThisWeek` | select at `:71` | **select adds `shift_templates(kind)`** |
| Calendar week banner, day headers, cards, month cells | `src/components/ScheduleCalendar.jsx:556,1276,1335`; `src/lib/roster-card-model.js:134,196` | `GET /api/schedule/blocks` (`route.js:54`) | **embed adds `kind`**; the slim shape keeps it |
| Week summary panel (`unstaffedCount`, contractor week €) | `src/lib/roster-summary.js:206` via `RosterSummaryPanel.jsx:88` | calendar blocks | **admin skipped** in both |
| Publish preview staffing gaps | `src/lib/roster-publish.js:489` | `loadBudgetContext` select `:124-133` | **embed adds `kind`** |
| Publish contractor budget gate: `POST /api/schedule/rosters` (`route.js:227`), approve (`[id]/approve/route.js:126`), `/schedule/approvals` page (`page.js:72`), approvals provider (`providers/rosters.js:95`) | `src/lib/roster-publish.js:261` `blockContractorCost` | same select | **admin → €0** |
| Unbuilt-week runway (web chip, phone chip, daily push) | `shared/roster-runway.js:173` via `futureBlockStaffing` | `src/lib/roster-runway-data.js:50-56` (templates), `:73-80` (blocks) | **both selects add `kind`; a studio with only admin templates has nothing to roster** |
| Studio Overview day rows | `src/app/api/schedule/overview/route.js:229-245` (inline) | embed `:184` | **loop → `underMinEntry` (skips admin); embed adds `kind`** |
| Phone Manage fill chip | `mobile/lib/schedule-manage.js:34` `blockFillState` | `GET /api/schedule/blocks` via `mobile/lib/schedule-api.js:183` | **new state `'admin'`** |
| Contractor spend panel | `src/lib/roster-summary.js:308` `summarizeMonth` via `src/lib/roster-summary-server.js:53` | select `:69-80` | **embed adds `kind`; admin skipped** |
| FTE week-cost panel | `src/lib/roster-week-cost.js:56` | `:61-72` | none: hours (pinned by a test) |
| Hours / staff cost / coverage reports | `src/lib/report-generator.js:19-23,156,189,331` | `SHIFT_ROW_SELECT` | none: hours, and no minimum concept |
| Payroll | `src/lib/payroll.js` `shiftHours` | n/a | none |
| Template list "min 2, up to 10" | `src/components/ShiftTemplateManager.jsx:45` | `GET /api/schedule/templates` (`select('*')`) | **"Admin" label; min reads "no minimum"** |
| Writers that copy `min_coaches` onto blocks | `roster.js:388`, `roster-write.js:181,534`, `roster-copy.js:260` | the template's own `min_coaches` | none: an admin template carries 0 |
| Manual slot | `POST /api/schedule/blocks` (`route.js:191-217`) | template read `:199-203` | **admin forces 0 and refuses an explicit >0** |
| Template copy between studios (PR 12, if merged) | `src/lib/shift-template-clone.js` `TEMPLATE_CLONE_COLUMNS` | `select('*')` | **adds `kind`** (Task 13) |
| Coach feed `/api/schedule/shifts` | `src/lib/roster-read.js:96-107` | `shift_templates (*)` | none: `kind` rides along automatically; no staffing there |
| Dead code | `shared/dashboard-data.js:277` `fetchUnstaffedBlocksThisWeek`; `src/lib/roster.js:427` `isBlockUnstaffedFuture` | no non-test caller | untouched; flagged in Review notes |

### Files

| File | Responsibility | OTA bundle path? |
|---|---|---|
| `supabase/migrations/628_shift_template_kind.sql` (create) | the column, two CHECKs, self-check | no |
| `tests/migration-628-shift-template-kind.test.js` (create) | PGlite replay of 628 | no |
| `shared/shift-kind.js` (create) | `SHIFT_KINDS`, `DEFAULT_SHIFT_KIND`, `SHIFT_KIND_LABELS`, `shiftKindOf`, `isAdminShift` | **yes** |
| `shared/shift-kind.test.js` (create) | the predicate table | **yes** (a test-only over-trigger, accepted per CLAUDE.md) |
| `shared/roster-staffing.js` (modify: header line 28, `futureBlockStaffing` 62-77) | admin → no staffing question | **yes** |
| `shared/roster-runway.js` (modify: comments after line 21 and at 174) | says why admin is not counted (no code) | **yes** |
| `shared/roster-runway.test.js` (modify) | admin never on the runway | **yes** |
| `src/lib/roster-staffing.js` (modify: line 71) | Today chip select | no |
| `src/lib/roster-staffing.test.js` (modify) | admin never a gap | no |
| `src/lib/roster-runway-data.js` (modify: 17-19, 52, 61-65, 75) | selects + template filter | no |
| `src/lib/roster-runway-data.test.js` (modify) | reader test | no |
| `src/lib/roster-publish.js` (modify: 21, 127, 261) | publish gate + preview | no |
| `src/lib/roster-publish.test.js` (modify) | admin out of the gate | no |
| `src/lib/roster-summary.js` (modify: 16-25, 136, 160-173, 277, 288-290, 328) | spend panel + week summary | no |
| `src/lib/roster-summary.test.js` (modify) | admin out of contractor €, in hours | no |
| `src/lib/roster-summary-server.js` (modify: 75) | spend panel select | no |
| `src/lib/roster-summary-server.test.js` (create) | select + end-to-end exclusion | no |
| `src/lib/roster-week-cost.test.js` (modify) | pin: admin hours count | no |
| `src/lib/schedule-overview.js` (modify: add `underMinEntry`) | Studio Overview below-minimum row | no |
| `src/lib/schedule-overview.test.js` (modify) | `underMinEntry` table | no |
| `src/app/api/schedule/overview/route.js` (modify: 29-34, 184, 234-245) | uses `underMinEntry`; embed adds kind | no |
| `src/app/api/schedule/overview/route.test.js` (modify) | select carries kind | no |
| `src/lib/shift-template-kind.js` (create) | `resolveTemplateKindWrite`, `adminMinimumRefusal`, `ADMIN_MINIMUM_ERROR` | no |
| `src/lib/shift-template-kind.test.js` (create) | the write-rule table | no |
| `src/app/api/schedule/templates/route.js` (modify: 7, 27, 72, 85-89) | `kind` on create | no |
| `src/app/api/schedule/templates/route.test.js` (modify) | create tests | no |
| `src/app/api/schedule/templates/[id]/route.js` (modify: 14, 27, 58, 87, 100) | `kind` on edit | no |
| `src/app/api/schedule/templates/[id]/route.test.js` (modify) | edit tests | no |
| `src/app/api/schedule/blocks/route.js` (modify: 24, 54, 141, 201, 212, 217, 242) | embed kind, slim allow-list, manual-slot minimum | no |
| `src/app/api/schedule/blocks/route.test.js` (modify) | GET + POST tests | no |
| `src/lib/roster-card-model.js` (modify: 21, 23-36, 48, 79-80, 87-92, 101) | `cardTone` → `'admin'`, `kindLabel`, admin empty text | no |
| `src/lib/roster-card-model.test.js` (modify: 17-23 + new) | tone, card model, day header | no |
| `src/components/schedule/ShiftCard.jsx` (modify: 17-19, 40-42, after 122) | admin surface + "Admin" tag | no |
| `src/components/schedule/ShiftCard.test.jsx` (modify) | render test | no |
| `src/components/ShiftTemplateManager.jsx` (modify: after 31, 340, after 473, after 510, 570-586, 653) | Kind control, locked minimum, list label | no |
| `src/components/ShiftTemplateManager.kind.test.jsx` (create) | editor + list | no |
| `mobile/lib/schedule-manage.js` (modify: 6, 20-47) | `blockFillState` → `'admin'` | **yes** |
| `mobile/lib/schedule-manage.test.js` (modify) | admin fill state | **yes** |
| `mobile/components/schedule/BlockCard.jsx` (modify: 9-12) | admin chip colours | **yes** |
| `src/lib/shift-template-clone.js`, `src/lib/shift-template-clone.test.js` (modify, ONLY if PR 12 is on main) | the copy carries `kind` | no |
| `src/lib/openapi.js` (modify: the `POST /api/schedule/blocks` registration, 4350-4376) | description + 400 | no |
| `docs/roster-v2.md` (modify: append a section) | the rule, in one place | no |
| `docs/CHANGELOG.md` (modify, after `gh pr create`) | row `#<PR>` | no |

**Deliberately untouched:**
- `src/components/ScheduleCalendar.jsx`, a conflict hotspot for PRs 14, 16, 19, 20, 21 and 33. Every staffing decision it draws already goes through `futureBlockStaffing` or `roster-card-model.js`, and its blocks come from the blocks API, so nothing in it changes.
- `src/lib/roster-week-cost.js`, `src/lib/report-generator.js` and `src/lib/payroll.js`. They count hours, and admin hours must count.
- No `WEB_PERMISSIONS` key is added: kind is edited under the existing template role gate. So `check:mobile-parity` has nothing to reconcile.

**Prerequisite:** use a fresh worktree off `origin/main` (CLAUDE.md "Worktrees"; memory `dev-workflow-worktrees`):

```bash
git fetch origin main
git worktree add ../un1t-crm-shifttype -b shifttype-1 origin/main
cd ../un1t-crm-shifttype && npm ci
```

While building, run focused tests with `npx vitest run <files>`. Run the full suite and `npm run build` once, at the gate. This is an 8GB machine, so close the dev server and other worktrees' watchers first.

---

### Task 1: Migration 628 and its PGlite replay

**Files:**
- Create: `supabase/migrations/628_shift_template_kind.sql`
- Create: `tests/migration-628-shift-template-kind.test.js`

There is no local Supabase stack, so without a replay test the DDL would run for the first time on prod. This follows the 613/618/622/624/625 convention: boot PGlite, recreate the table as the migrations left it, run the real file, and assert what the header claims.

- [ ] **Step 1: Write the failing test**

```js
// SHIFTTYPE.1 — behavioural test for migration 628.
//
// Same reason as the 613/618/622/624/625 replays: there is no local Supabase
// stack, so without this the DDL would get its first execution on prod. Boots
// PGlite, recreates shift_templates with the columns and CHECKs migs
// 010/067/177 left it and the table-level grants prod has, applies the real
// 628 file, and proves the header's claims.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_628 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/628_shift_template_kind.sql'),
  'utf8',
)

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const TPL_CLASS = '40000000-0000-0000-0000-000000000001'
const TPL_ZERO = '40000000-0000-0000-0000-000000000002'

// shift_templates as migs 010 + 067 + 177 left it (only what 628 touches or
// must coexist with), with Supabase's default table-level grants.
const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.shift_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    name text NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL,
    active boolean DEFAULT true,
    days_of_week text[] NOT NULL DEFAULT '{}'::text[],
    max_coaches smallint NOT NULL DEFAULT 15,
    min_coaches smallint NOT NULL DEFAULT 1,
    UNIQUE (location_id, name),
    CONSTRAINT shift_templates_max_coaches_check CHECK (max_coaches BETWEEN 1 AND 50),
    CONSTRAINT shift_templates_min_coaches_check CHECK (min_coaches >= 0 AND min_coaches <= max_coaches)
  );
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_templates TO anon, authenticated;
  GRANT ALL ON public.shift_templates TO service_role;
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}');
  INSERT INTO public.shift_templates (id, location_id, name, start_time, end_time, min_coaches, max_coaches) VALUES
    ('${TPL_CLASS}', '${LOC}', 'Morning', '06:00', '07:00', 2, 10),
    ('${TPL_ZERO}',  '${LOC}', 'Consultation', '09:00', '10:00', 0, 3);
`

async function boot({ before = '' } = {}) {
  const pg = new PGlite()
  await pg.exec(BASE_SCHEMA)
  await pg.exec(SEED)
  if (before) await pg.exec(before)
  return pg
}

const insertTpl = (name, kind, min) => `INSERT INTO public.shift_templates
  (location_id, name, start_time, end_time, max_coaches, min_coaches${kind ? ', kind' : ''})
  VALUES ('${LOC}', '${name}', '12:00', '13:00', 5, ${min}${kind ? `, '${kind}'` : ''})`

const KIND_CONSTRAINTS = `SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.shift_templates'::regclass
    AND conname IN ('shift_templates_kind_check', 'shift_templates_admin_no_minimum')
  ORDER BY 1`

let db
beforeAll(async () => {
  db = await boot()
  await db.exec(MIG_628)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 628 — shift_templates.kind', () => {
  it("every existing template reads class: no backfill, today's behaviour exactly", async () => {
    const { rows } = await db.query('SELECT name, kind FROM public.shift_templates ORDER BY name')
    expect(rows).toEqual([{ name: 'Consultation', kind: 'class' }, { name: 'Morning', kind: 'class' }])
  })

  it('is NOT NULL text defaulting to class, so a writer that never heard of it creates a class template', async () => {
    const { rows } = await db.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'shift_templates' AND column_name = 'kind'`)
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'NO', column_default: "'class'::text" }])
    await db.exec('BEGIN')
    try {
      const r = await db.query(`${insertTpl('No kind', null, 1)} RETURNING kind`)
      expect(r.rows).toEqual([{ kind: 'class' }])
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('refuses a kind that is neither class nor admin', async () => {
    await expect(db.exec(insertTpl('Bad', 'desk', 0))).rejects.toThrow(/shift_templates_kind_check/)
  })

  it('refuses an admin template with a minimum, on INSERT and on UPDATE', async () => {
    await expect(db.exec(insertTpl('Admin with min', 'admin', 1))).rejects.toThrow(/shift_templates_admin_no_minimum/)
    await expect(db.exec(`UPDATE public.shift_templates SET kind = 'admin' WHERE id = '${TPL_CLASS}'`))
      .rejects.toThrow(/shift_templates_admin_no_minimum/)
  })

  it('accepts admin at minimum 0, and a switch that writes both columns in ONE statement (what the API sends)', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(insertTpl('Admin block', 'admin', 0))
      await db.exec(`UPDATE public.shift_templates SET kind = 'admin', min_coaches = 0 WHERE id = '${TPL_CLASS}'`)
      await expect(db.exec(`UPDATE public.shift_templates SET min_coaches = 1 WHERE id = '${TPL_CLASS}'`))
        .rejects.toThrow(/shift_templates_admin_no_minimum/)
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('a class template keeps any minimum, 0 included', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(insertTpl('Class zero', 'class', 0))
      await db.exec(insertTpl('Class three', 'class', 3))
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('changes no grant: the column rides the table-level grants every other column has', async () => {
    const { rows } = await db.query(`SELECT
      has_column_privilege('authenticated', 'public.shift_templates', 'kind', 'SELECT') AS auth_select,
      has_column_privilege('authenticated', 'public.shift_templates', 'kind', 'UPDATE') AS auth_update,
      has_column_privilege('service_role',  'public.shift_templates', 'kind', 'UPDATE') AS svc_update`)
    expect(rows[0]).toEqual({ auth_select: true, auth_update: true, svc_update: true })
  })

  it('re-running the file is a no-op', async () => {
    await db.exec(MIG_628)
    expect((await db.query(KIND_CONSTRAINTS)).rows.map((r) => r.conname))
      .toEqual(['shift_templates_admin_no_minimum', 'shift_templates_kind_check'])
  })
})

describe('the self-check aborts the WHOLE file', () => {
  it('when a nullable kind column already exists, ADD COLUMN IF NOT EXISTS keeps it, the DO block raises, nothing is applied', async () => {
    const other = await boot({ before: 'ALTER TABLE public.shift_templates ADD COLUMN kind text' })
    try {
      // The file is its own BEGIN ... COMMIT; the RAISE leaves it aborted.
      await expect(other.exec(MIG_628)).rejects.toThrow(/mig 628: shift_templates\.kind has the wrong shape/)
      await other.exec('ROLLBACK')
      expect((await other.query(KIND_CONSTRAINTS)).rows).toEqual([])
    } finally {
      await other.close()
    }
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run tests/migration-628-shift-template-kind.test.js`
Expected: the file fails to load with `ENOENT: no such file or directory, open '…/628_shift_template_kind.sql'`.

- [ ] **Step 3: Write the migration**

```sql
-- 628 — SHIFTTYPE.1: a shift template is a CLASS shift or an ADMIN shift.
--
-- NOT APPLIED YET. Apply BEFORE the SHIFTTYPE.1 code deploys: that code names
-- shift_templates.kind in PostgREST selects (the calendar, the publish check,
-- the runway, the spend panel, the Studio Overview), and a select naming a
-- column that does not exist is a 400 on every call. Applied alone this file
-- changes no behaviour: every row reads 'class', which is what every row is
-- today. Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-628-shift-template-kind.test.js), which runs this file
-- verbatim.
--
-- OWNER'S DECISION (Richard, 25 Sep 2026; docs/superpowers/plans/
-- 2026-09-25-scheduler-wave2-3/00-INDEX.md): roster scope is HYBRID. Templates
-- gain a type, class or admin; only admin work that needs a time and a person
-- is placed on the roster. Admin shifts carry NO MINIMUM STAFFING, so an
-- unfilled admin block is never a gap: the publish check, the staffing chips
-- and the runway alert look at class shifts only. Admin blocks stay out of the
-- contractor budget gate but still count toward hours.
--
-- WHAT
--   shift_templates.kind  text NOT NULL DEFAULT 'class'
--     shift_templates_kind_check        CHECK (kind IN ('class', 'admin'))
--     shift_templates_admin_no_minimum  CHECK (kind <> 'admin' OR min_coaches = 0)
--
-- WHY ONLY ON shift_templates (a block reads its kind through its template)
--   shift_blocks.template_id is NOT NULL REFERENCES shift_templates ON DELETE
--   RESTRICT (mig 067), so every block has exactly one template and the embed
--   is always there. min/max_coaches are snapshotted onto blocks so a template
--   edit cannot reclassify the PAST; kind has no such reason: staffing ignores
--   past blocks and hours count both kinds. A snapshot would also need every
--   block writer to copy it, and a forgotten copy is mig 611's bug again.
--
-- WHY A DB CHECK AS WELL AS THE API
--   The API refuses an admin template with a minimum, but it is not the only
--   door: `authenticated` holds UPDATE on shift_templates (table-level grant)
--   and the mig 600 policy shift_templates_upd lets any manager at the
--   location write any column through the browser's client. The CHECK makes
--   "an admin shift has no minimum" true of the data, not of one route.
--   Consequence for writers: class -> admin must set min_coaches = 0 IN THE
--   SAME UPDATE (the API does; the PGlite replay pins it).
--
-- BACKFILL: none. The column is new, so no admin row exists to fix; the
--   DEFAULT gives every existing row 'class'. Operators mark admin templates
--   in the template editor after deploy.
--
-- GRANTS: none changed. shift_templates has only table-level grants (no
--   column-level GRANT or REVOKE appears in any migration), so the new column
--   carries exactly the privileges every other column has. Pre-check (c)
--   confirms that against the catalog, not this text (the mig 153 lesson).
--
-- LOCKS: ADD COLUMN with a constant DEFAULT is catalog-only on PG >= 11 (no
--   rewrite); the two ADD CONSTRAINTs scan the table once each. 18 rows.
--
-- REPLAYING THIS FILE IS A NO-OP (IF NOT EXISTS; DROP IF EXISTS then ADD).
-- One explicit transaction, so a failed self-check leaves NOTHING applied
-- (the 613/614/618/622/624 convention).
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; run IMMEDIATELY before applying, stop if any
-- answer differs from "Expected")
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The column and the constraint names are free:
--       SELECT column_name FROM information_schema.columns
--        WHERE table_schema='public' AND table_name='shift_templates' AND column_name='kind';
--       SELECT conname FROM pg_constraint
--        WHERE conrelid='public.shift_templates'::regclass
--          AND conname IN ('shift_templates_kind_check','shift_templates_admin_no_minimum');
--     Expected: 0 rows, 0 rows.
-- (b) The min/max CHECKs this one sits beside are the mig 067/177 set:
--       SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--        WHERE conrelid='public.shift_templates'::regclass AND contype='c' ORDER BY 1;
--     Expected: shift_templates_days_of_week_check, shift_templates_max_coaches_check
--     (max_coaches BETWEEN 1 AND 50), shift_templates_min_coaches_check
--     (min_coaches >= 0 AND min_coaches <= max_coaches).
-- (c) Grants are table-level only (KEEP THE OUTPUT for the rollback record):
--       SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--         FROM information_schema.table_privileges
--        WHERE table_schema='public' AND table_name='shift_templates'
--          AND grantee IN ('anon','authenticated','service_role') GROUP BY 1 ORDER BY 1;
--       SELECT count(*) FROM information_schema.column_privileges c
--        WHERE c.table_schema='public' AND c.table_name='shift_templates'
--          AND c.grantee IN ('anon','authenticated')
--          AND NOT EXISTS (
--            SELECT 1 FROM information_schema.table_privileges t
--             WHERE t.table_schema='public' AND t.table_name='shift_templates'
--               AND t.grantee = c.grantee AND t.privilege_type = c.privilege_type);
--     Expected: each role holds at least SELECT at table level; the second
--     query returns 0 (no column grant that is not also a table grant).
-- (d) What exists (information, not a gate):
--       SELECT l.name, count(*) AS templates, count(*) FILTER (WHERE t.active) AS active,
--              min(t.min_coaches), max(t.min_coaches)
--         FROM public.shift_templates t JOIN public.locations l ON l.id = t.location_id
--        GROUP BY 1 ORDER BY 1;
--     Expected (00-INDEX, 25 Sep): Stillorgan 18; Hatch Street none.
-- (e) list_migrations shows no 628.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (f) SELECT data_type, is_nullable, column_default FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='shift_templates' AND column_name='kind';
--     Expected: text | NO | 'class'::text
-- (g) SELECT kind, count(*) FROM public.shift_templates GROUP BY 1;
--     Expected: one row, class, count = the total from (d).
-- (h) SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--      WHERE conrelid='public.shift_templates'::regclass
--        AND conname IN ('shift_templates_kind_check','shift_templates_admin_no_minimum') ORDER BY 1;
--     Expected 2 rows:
--       shift_templates_admin_no_minimum  CHECK (((kind <> 'admin'::text) OR (min_coaches = 0)))
--       shift_templates_kind_check        CHECK ((kind = ANY (ARRAY['class'::text, 'admin'::text])))
-- (i) SELECT has_column_privilege('authenticated','public.shift_templates','kind','SELECT'),
--            has_column_privilege('service_role','public.shift_templates','kind','UPDATE');
--     Expected: true, true.
-- (j) get_advisors (security, then performance). Expected: nothing new (no
--     table, policy, view or function was created).
--
-- ROLLBACK (forward-only repo; this is a NEW migration, never an edit here):
--   Revert the SHIFTTYPE.1 code FIRST and let it deploy: while that code is
--   live, dropping the column turns every select naming it into a 400. Then:
--     BEGIN;
--     ALTER TABLE public.shift_templates DROP CONSTRAINT IF EXISTS shift_templates_admin_no_minimum;
--     ALTER TABLE public.shift_templates DROP CONSTRAINT IF EXISTS shift_templates_kind_check;
--     ALTER TABLE public.shift_templates DROP COLUMN IF EXISTS kind;
--     COMMIT;
--   Usually unnecessary: with every row 'class' the column is inert.

BEGIN;

ALTER TABLE public.shift_templates
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'class';

ALTER TABLE public.shift_templates DROP CONSTRAINT IF EXISTS shift_templates_kind_check;
ALTER TABLE public.shift_templates
  ADD CONSTRAINT shift_templates_kind_check
  CHECK (kind IN ('class', 'admin'));

ALTER TABLE public.shift_templates DROP CONSTRAINT IF EXISTS shift_templates_admin_no_minimum;
ALTER TABLE public.shift_templates
  ADD CONSTRAINT shift_templates_admin_no_minimum
  CHECK (kind <> 'admin' OR min_coaches = 0);

COMMENT ON COLUMN public.shift_templates.kind IS
  'SHIFTTYPE.1 (mig 628): class (default) or admin. An admin shift has NO minimum staffing (min_coaches = 0, CHECK shift_templates_admin_no_minimum): it is never an empty or short gap on any staffing surface, and it is excluded from the contractor budget gate and contractor spend. Its hours still count everywhere hours are counted. A shift_block reads its kind through template_id; it is deliberately not snapshotted onto shift_blocks.';

-- Self-check (the mig 153b habit: verify the catalog, not this text).
-- ADD COLUMN IF NOT EXISTS silently KEEPS a column of the same name that some
-- earlier hand edit created; if its shape differs (nullable, no default) the
-- CHECKs above still pass on NULLs and nothing would say so. A RAISE here
-- aborts the transaction, so nothing half-applies.
DO $$
DECLARE
  v_col record;
  v_checks int;
BEGIN
  SELECT data_type, is_nullable, column_default INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'shift_templates' AND column_name = 'kind';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 628: shift_templates.kind is missing';
  END IF;
  IF v_col.data_type <> 'text'
     OR v_col.is_nullable <> 'NO'
     OR v_col.column_default IS DISTINCT FROM '''class''::text' THEN
    RAISE EXCEPTION 'mig 628: shift_templates.kind has the wrong shape (type %, nullable %, default %); a column of that name existed before this file and ADD COLUMN IF NOT EXISTS kept it',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  END IF;

  SELECT count(*) INTO v_checks
    FROM pg_constraint
   WHERE conrelid = 'public.shift_templates'::regclass
     AND contype = 'c'
     AND convalidated
     AND conname IN ('shift_templates_kind_check', 'shift_templates_admin_no_minimum');
  IF v_checks <> 2 THEN
    RAISE EXCEPTION 'mig 628: expected 2 validated CHECKs on shift_templates.kind, found %', v_checks;
  END IF;
END $$;

COMMIT;
```

- [ ] **Step 4: Run it, expect PASS, then the two checks that replay every migration**

Run: `npx vitest run tests/migration-628-shift-template-kind.test.js`
Expected: `9 passed`.

Run: `npm run check:rls-restrictive && npm run check:select-columns`
Expected: both exit 0. No policy changed. After this step, `check:select-columns` knows `shift_templates.kind`, and every later task's selects depend on that.

**If PR 12 (TPLCLONE.1) is already on `main`**, `tests/shift-template-clone.guards.test.js` now fails with `expected [ 'kind' ] to deeply equal []`. That is expected. Go straight to Task 13, which fixes it, before continuing to Task 2.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/628_shift_template_kind.sql tests/migration-628-shift-template-kind.test.js
git commit -m "SHIFTTYPE.1 — mig 628: shift_templates.kind (class | admin), an admin template has no minimum

Column on shift_templates only; a block reads its kind through its template.
DB CHECK as well as the API because the browser still holds UPDATE on the
table (mig 600 shift_templates_upd). No backfill: every row reads class.
PGlite replay proves the header, including the self-check abort.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Do NOT apply the migration yourself. Applying it is the operator's step (see "Migration apply steps").

---

### Task 2: `shared/shift-kind.js`, the one definition of "is this an admin shift"

**Files:**
- Create: `shared/shift-kind.js`
- Create: `shared/shift-kind.test.js`

This module lives in `shared/` because both the phone's Manage mode and the web need it. Its export names were checked against `src/lib`, `shared` and `mobile`: `grep -rn -E "SHIFT_KINDS|DEFAULT_SHIFT_KIND|SHIFT_KIND_LABELS|shiftKindOf|isAdminShift"` finds nothing. So the cross-named sweep in `tests/shared-pair-sync.test.js` has no new pair to classify.

- [ ] **Step 1: Write the failing test**

```js
// SHIFTTYPE.1 — what kind of shift a template or block is.
import { describe, it, expect } from 'vitest'
import { SHIFT_KINDS, DEFAULT_SHIFT_KIND, SHIFT_KIND_LABELS, shiftKindOf, isAdminShift } from './shift-kind.js'

describe('shift kinds', () => {
  it('are class and admin, class by default, each with a label', () => {
    expect(SHIFT_KINDS).toEqual(['class', 'admin'])
    expect(DEFAULT_SHIFT_KIND).toBe('class')
    expect(SHIFT_KIND_LABELS).toEqual({ class: 'Class', admin: 'Admin' })
  })
})

describe('shiftKindOf / isAdminShift', () => {
  it('reads a template row directly', () => {
    expect(shiftKindOf({ kind: 'admin' })).toBe('admin')
    expect(shiftKindOf({ kind: 'class' })).toBe('class')
  })

  it('reads a block through its embedded template', () => {
    expect(shiftKindOf({ block_date: '2026-10-01', shift_templates: { name: 'Stock take', kind: 'admin' } })).toBe('admin')
    expect(isAdminShift({ shift_templates: { kind: 'admin' } })).toBe(true)
    expect(isAdminShift({ shift_templates: { kind: 'class' } })).toBe(false)
  })

  it('anything it cannot read is class: the pre-SHIFTTYPE behaviour, which over-reports and never hides a gap', () => {
    for (const row of [null, undefined, {}, { shift_templates: null }, { shift_templates: {} }, { kind: 'desk' }, { shift_templates: { kind: 'ADMIN' } }]) {
      expect(shiftKindOf(row)).toBe('class')
      expect(isAdminShift(row)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run shared/shift-kind.test.js`
Expected: the file fails to load with `Failed to resolve import "./shift-kind.js"`.

- [ ] **Step 3: Implement**

```js
// SHIFTTYPE.1 (mig 628) — a shift template is a CLASS shift or an ADMIN shift.
//
// Richard, 25 Sep 2026 (scheduler Wave 2 index, binding): the roster is HYBRID.
// Only admin work that needs a time and a person is placed on it, and an admin
// shift carries NO MINIMUM STAFFING: it is never an empty or short gap (the
// staffing chips, the publish check, the runway alert, the Studio Overview and
// the phone's Manage chip look at class shifts only). It is left out of the
// contractor budget gate and contractor spend, and it still counts toward hours.
//
// The column is on shift_templates only; a block reads its kind through its
// template (`block.shift_templates.kind`), so every reader that needs the rule
// embeds `shift_templates(kind)`.
//
// Unreadable = 'class'. A reader that forgot the embed therefore behaves as it
// did before SHIFTTYPE.1 (a false gap, admin hours priced into the budget):
// loud, and never a hidden class gap.
//
// Dependency-free: shared/ is the mobile seam and cannot import src/lib.

export const SHIFT_KINDS = ['class', 'admin']
export const DEFAULT_SHIFT_KIND = 'class'
export const SHIFT_KIND_LABELS = { class: 'Class', admin: 'Admin' }

/**
 * The kind of a shift_templates row, or of a shift_blocks row through its
 * embedded template.
 *
 * @param {object|null|undefined} row  template ({ kind }) or block ({ shift_templates: { kind } })
 * @returns {'class'|'admin'}
 */
export function shiftKindOf(row) {
  const kind = row?.kind ?? row?.shift_templates?.kind
  return kind === 'admin' ? 'admin' : 'class'
}

/** @returns {boolean} */
export function isAdminShift(row) {
  return shiftKindOf(row) === 'admin'
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run shared/shift-kind.test.js tests/shared-pair-sync.test.js`
Expected: `shift-kind` shows `4 passed`, and `shared-pair-sync` passes unchanged.

- [ ] **Step 5: Commit**

```bash
git add shared/shift-kind.js shared/shift-kind.test.js
git commit -m "SHIFTTYPE.1 — shared/shift-kind: one definition of an admin shift, unreadable reads as class

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The staffing rule: an admin block asks no staffing question

**Files:**
- Modify: `shared/roster-staffing.js` (line 28 comment; `futureBlockStaffing`, lines 62-77)
- Modify: `shared/roster-runway.js` (comments after line 21 and at line 174; no code)
- Modify: `src/lib/roster-staffing.js` (line 71)
- Test: `src/lib/roster-staffing.test.js`, `shared/roster-runway.test.js`

`futureBlockStaffing` is the single answer read by the calendar (banner, day headers, cards, month cells), the Today chip, the publish preview, the runway and the phone's Manage chip. If it returns `null` for an admin block, all of them drop admin at once. `null` is already the "nothing to ask" answer a past block gets, and every caller handles it:
- `staffingGaps` (`shared/roster-staffing.js:91`) and `runwayWeeksFromBlocks` (`shared/roster-runway.js:174`) `continue` on it.
- `dayHeaderStatus` (`roster-card-model.js:134`) filters it out.
- `shiftCardModel` and `monthCellLines` draw no status for it.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/roster-staffing.test.js`. That file's `block()` helper defaults to `min_coaches: 2` and `block_date: '2026-09-18'`, and `live()` is defined at its top.

```js
// SHIFTTYPE.1 — an admin shift carries no minimum staffing (Richard, 25 Sep):
// it is never empty and never short, on any surface.
describe('SHIFTTYPE.1 — admin shifts are never a staffing gap', () => {
  const admin = (over = {}) => block({ min_coaches: 0, shift_templates: { name: 'Admin', kind: 'admin' }, ...over })

  it('futureBlockStaffing asks no staffing question of a future admin block, empty or not', () => {
    expect(futureBlockStaffing(admin(), '2026-09-17')).toBeNull()
    expect(futureBlockStaffing(admin({ shift_assignments: [live('a')] }), '2026-09-17')).toBeNull()
    // Even one still carrying a minimum (a block made before its template became admin).
    expect(futureBlockStaffing(admin({ min_coaches: 2, shift_assignments: [live('a')] }), '2026-09-17')).toBeNull()
  })

  it('class blocks are unchanged, and a block with no readable kind is class', () => {
    expect(futureBlockStaffing(block({ shift_templates: { kind: 'class' } }), '2026-09-17').status).toBe('empty')
    expect(futureBlockStaffing(block({ shift_templates: { kind: 'class' }, shift_assignments: [live('a')] }), '2026-09-17'))
      .toEqual({ status: 'short', count: 1, min: 2 })
    expect(futureBlockStaffing(block(), '2026-09-17').status).toBe('empty')
  })

  it('staffingGaps and countStaffingGaps leave admin blocks out', () => {
    const blocks = [
      admin({ id: 'admin-empty', block_date: '2026-09-18' }),
      block({ id: 'class-empty', block_date: '2026-09-18' }),
      block({ id: 'class-short', block_date: '2026-09-19', shift_assignments: [live('a')] }),
    ]
    expect(staffingGaps(blocks, { todayIso: '2026-09-17' }).map((g) => g.block.id)).toEqual(['class-empty', 'class-short'])
    expect(countStaffingGaps(blocks, { todayIso: '2026-09-17' })).toEqual({ empty: 1, short: 1, total: 2 })
    expect(countStaffingGaps([admin(), admin({ id: 'a2' })], { todayIso: '2026-09-17' })).toEqual({ empty: 0, short: 0, total: 0 })
  })

  it('the Today chip reads each block with its template kind and does not count an admin block', async () => {
    const calls = {}
    const chain = {
      select: (s) => { calls.select = s; return chain },
      in: () => chain,
      gte: () => chain,
      lte: () => Promise.resolve({ data: [admin({ block_date: '2026-09-18' }), block({ block_date: '2026-09-19' })], error: null }),
    }
    const res = await fetchStaffingGapsThisWeek({ from: () => chain }, ['loc-1'], { todayIso: '2026-09-17' })
    expect(res).toEqual({ success: true, data: { empty: 1, short: 0, total: 1 } })
    expect(calls.select).toMatch(/shift_templates\(kind\)/)
  })
})
```

Append inside `describe('runwayWeeksFromBlocks', …)` in `shared/roster-runway.test.js`. `rosterRunway` is already imported there.

```js
  // SHIFTTYPE.1 — the runway looks at class shifts only: an admin block is not
  // a shift that needs a coach, so it is neither counted nor alerts.
  it('leaves admin blocks out of every count, so a week unready only in admin is ready', () => {
    const admin = (date, opts) => ({ ...block(date, opts), shift_templates: { kind: 'admin' } })
    const weeks = runwayWeeksFromBlocks([
      block('2026-09-28', { coaches: 1, roster: 'published' }),
      admin('2026-09-29'),                 // empty, unpublished
      admin('2026-09-30', { coaches: 1 }), // staffed, unpublished
    ], '2026-09-19')
    expect(weeks[1]).toEqual({ weekStart: '2026-09-28', blocks: 1, staffed: 1, underMin: 0, published: 1 })
    expect(rosterRunway(weeks, '2026-09-19')).toBeNull()
  })

  it('a week of ONLY admin blocks is "0 blocks": nothing to build, no alert', () => {
    const admin = (date) => ({ ...block(date), shift_templates: { kind: 'admin' } })
    const weeks = runwayWeeksFromBlocks([admin('2026-09-28'), admin('2026-09-29')], '2026-09-19')
    expect(weeks[1]).toMatchObject({ weekStart: '2026-09-28', blocks: 0 })
    expect(rosterRunway(weeks, '2026-09-19')).toBeNull()
  })
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/lib/roster-staffing.test.js shared/roster-runway.test.js`
Expected: `5 failed`:
- `futureBlockStaffing asks no staffing question…` fails with `expected { status: 'empty', count: 0, min: +0 } to be null`.
- `staffingGaps and countStaffingGaps…` and the Today chip test fail on their counts.
- Both runway tests fail on `blocks`.

`class blocks are unchanged…` passes, because it is a pin on current behaviour.

- [ ] **Step 3: Implement**

(a) In `shared/roster-staffing.js`, replace line 28:

```js
// Dependency-free: `shared/` is the mobile seam and cannot import src/lib.
```

with

```js
// Depends only on ./shift-kind.js: `shared/` is the mobile seam and cannot
// import src/lib.

import { isAdminShift } from './shift-kind.js'
```

(b) In the same file, replace the whole `futureBlockStaffing` doc comment and body (lines 62-77) with:

```js
/**
 * The staffing of a block that is today or later. Past blocks return null —
 * a past shift nobody covered is history, not something to act on (the same
 * rule isBlockUnstaffedFuture has always applied).
 *
 * SHIFTTYPE.1 — an ADMIN block also returns null. An admin shift has no
 * minimum staffing (Richard, 25 Sep 2026), so there is no staffing question to
 * ask of it: every surface that reads this (the calendar banner, day headers,
 * cards and month cells, the Today chip, the publish preview, the runway, the
 * phone's Manage chip) already treats null as "nothing to flag". A block whose
 * kind cannot be read is class (shared/shift-kind.js), so a reader that forgot
 * `shift_templates(kind)` flags it as before rather than hiding a class gap.
 *
 * @param {object} block      shift_blocks row: block_date, min_coaches, shift_assignments[], shift_templates.kind
 * @param {string} todayIso   YYYY-MM-DD
 * @returns {{ status: 'empty'|'short'|'ok', count: number, min: number } | null}
 */
export function futureBlockStaffing(block, todayIso) {
  if (!block || !block.block_date || !todayIso) return null
  if (block.block_date < todayIso) return null
  if (isAdminShift(block)) return null
  const count = countLive(block.shift_assignments)
  const min = Number(block.min_coaches) || 0
  return { status: staffingStatus(count, min), count, min }
}
```

(c) In `src/lib/roster-staffing.js`, change line 71 from

```js
    .select('id, location_id, block_date, start_time, min_coaches, shift_assignments(profile_id, status)')
```

to

```js
    // SHIFTTYPE.1 — the template's kind rides along: an admin block is never a gap.
    .select('id, location_id, block_date, start_time, min_coaches, shift_templates(kind), shift_assignments(profile_id, status)')
```

(d) `shared/roster-runway.js` gets comments only, no code. After the DELIBERATE paragraph (after line 21) add:

```js
//
// SHIFTTYPE.1: admin shifts are not on the runway at all. futureBlockStaffing
// returns null for them, so they count toward none of blocks / staffed /
// published, and a week whose only unstaffed or unpublished blocks are admin
// is ready. A week of only admin blocks is "0 blocks", which says nothing.
```

Then change line 174 from

```js
    if (!s) continue // unreadable (or past, which the window excludes anyway)
```

to

```js
    if (!s) continue // unreadable, an admin shift (SHIFTTYPE.1), or past (the window excludes those anyway)
```

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/lib/roster-staffing.test.js shared/roster-runway.test.js src/lib/roster-card-model.test.js mobile/lib/schedule-manage.test.js tests/shared-pair-sync.test.js`
Expected: `0 failed`.
- The card-model and schedule-manage suites prove class behaviour is unchanged everywhere `futureBlockStaffing` is read.
- `shared-pair-sync` still holds `roster-staffing` in `reexport` mode, because no export was added.

- [ ] **Step 5: Commit**

```bash
git add shared/roster-staffing.js shared/roster-runway.js src/lib/roster-staffing.js src/lib/roster-staffing.test.js shared/roster-runway.test.js
git commit -m "SHIFTTYPE.1 — an admin block asks no staffing question: never empty, never short, not on the runway

futureBlockStaffing returns null for an admin block, the answer a past block
already gets, so every surface reading it (calendar, Today chip, publish
preview, runway, phone Manage chip) drops admin with no change of its own.
The Today chip's read embeds shift_templates(kind).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The runway reader reads kind; a studio with only admin templates has nothing to roster

**Files:**
- Modify: `src/lib/roster-runway-data.js` (imports 17-19; lines 52, 61-65, 75)
- Test: `src/lib/roster-runway-data.test.js`

- [ ] **Step 1: Write the failing test**

Append inside `describe('fetchRosterRunways', …)`. That file already defines `makeDb`, `block`, `NORTH`, `SOUTH` and `TODAY`.

```js
  // SHIFTTYPE.1 — the runway is class shifts only.
  it("reads each block's template kind, and a studio whose only active templates are admin has nothing to roster", async () => {
    const db = makeDb({
      templates: [
        { location_id: NORTH, days_of_week: ['mon'], kind: 'class' },
        { location_id: SOUTH, days_of_week: ['mon'], kind: 'admin' },
      ],
      blocks: [block(NORTH, '2026-09-28')],
    })
    const res = await fetchRosterRunways(db, [NORTH, SOUTH], { todayIso: TODAY })
    expect(res.data.byLocation[SOUTH]).toBeNull()
    expect(res.data.byLocation[NORTH]).toMatchObject({ weekStart: '2026-09-28', unstaffed: 1 })

    const tplSelect = db.calls.find((c) => c.table === 'shift_templates').filters.find(([m]) => m === 'select')[1]
    expect(tplSelect).toMatch(/\bkind\b/)
    const blockCall = db.calls.find((c) => c.table === 'shift_blocks')
    // SOUTH's blocks are never read: it has nothing to roster.
    expect(blockCall.filters).toContainEqual(['in', 'location_id', [NORTH]])
    expect(blockCall.filters.find(([m]) => m === 'select')[1]).toMatch(/shift_templates \( kind \)/)
  })
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-runway-data.test.js`
Expected: `1 failed`, with the first failure on `tplSelect`: `expected 'id, location_id, days_of_week' to match /\bkind\b/`.

- [ ] **Step 3: Implement**

(a) Under the imports (line 19) add:

```js
import { isAdminShift } from '@shared/shift-kind'
```

(b) Change line 52 from `.select('id, location_id, days_of_week')` to `.select('id, location_id, days_of_week, kind')`.

(c) Replace lines 61-65:

```js
  const rostered = [...new Set(
    (templates || [])
      .filter((t) => Array.isArray(t.days_of_week) && t.days_of_week.length > 0)
      .map((t) => t.location_id),
  )]
```

with

```js
  // SHIFTTYPE.1 — only a CLASS template puts a studio on the runway. A studio
  // whose only active templates are admin has no shift that needs a coach
  // (admin carries no minimum staffing), so it has nothing to roster.
  const rostered = [...new Set(
    (templates || [])
      .filter((t) => Array.isArray(t.days_of_week) && t.days_of_week.length > 0 && !isAdminShift(t))
      .map((t) => t.location_id),
  )]
```

(d) Change the block select on line 75 to:

```js
      .select('id, location_id, block_date, min_coaches, shift_templates ( kind ), rosters:roster_id ( status ), shift_assignments(profile_id, status)')
```

In the doc comment's first paragraph, after "…must not raise an alert nobody can clear.", add: `A location whose only active templates are admin is skipped the same way (SHIFTTYPE.1).`

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-runway-data.test.js src/lib/roster-runway-notify.test.js src/app/api/schedule/runway/route.test.js && npm run check:select-columns`
Expected: `0 failed`, and `check:select-columns` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-runway-data.js src/lib/roster-runway-data.test.js
git commit -m "SHIFTTYPE.1 — the runway reads template kind; a studio with only admin templates has nothing to roster

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The publish check and the contractor budget gate

**Files:**
- Modify: `src/lib/roster-publish.js` (import after line 21; select line 127; `blockContractorCost` line 261)
- Test: `src/lib/roster-publish.test.js`

Every publish path is priced by one function. `POST /api/schedule/rosters` (`route.js:227`), the approve route (`[id]/approve/route.js:126`), the `/schedule/approvals` page (`page.js:72`) and the approvals provider (`providers/rosters.js:95`) all go through `loadBudgetContext` → `impactFromContext` → `blockContractorCost`. The preview's staffing gaps already drop admin (Task 3). What remains is that the block read needs the kind.

- [ ] **Step 1: Let the mock record the block select, then write the failing tests**

In `mockDb`, inside `if (table === 'shift_blocks') {` (around line 133), change that chain's

```js
          select: () => chain,
```

to

```js
          select: (s) => { f.select = s; return chain },
```

Leave the `select` lines in the `time_off_requests` and `shift_assignments` chains as they are.

Then append:

```js
// SHIFTTYPE.1 — an admin shift is out of the contractor budget gate and is
// never a staffing gap in the publish preview, but it is still a shift in the
// period (it is published with the rest).
describe('projectPublishImpact — admin shifts', () => {
  const admin = (b) => ({ ...b, min_coaches: 0, shift_templates: { name: 'Admin', kind: 'admin' } })
  const cls = (b, min = 1) => ({ ...b, min_coaches: min, shift_templates: { name: 'Morning', kind: 'class' } })
  const PERIOD = { locationId: 'loc1', periodStart: '2026-05-04', periodEnd: '2026-05-10', todayIso: '2026-05-01' }

  it('prices a contractor on a class shift and NOT on an admin shift', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 100 },
      contractors: [dan],
      blocks: [
        cls(block({ id: 'class', date: '2026-05-05', start: '09:00', end: '11:00', coaches: ['dan'] })),   // 2h x 35 = 70
        admin(block({ id: 'admin', date: '2026-05-06', start: '09:00', end: '13:00', coaches: ['dan'] })), // 4h, not priced
      ],
    })
    const r = await projectPublishImpact(db, PERIOD)
    expect(r.periodProjectedEur).toBe(70)
    expect(r.overBudget).toBe(false)
    expect(r.remainingEur).toBe(30)
    expect(r.blockCount).toBe(2)
  })

  it('leaves a published admin shift out of the already-published spend too', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 100 },
      contractors: [dan],
      blocks: [admin(block({ id: 'admin-pub', date: '2026-05-20', start: '09:00', end: '13:00', coaches: ['dan'], roster: { id: 'r-old', status: 'published' } }))],
    })
    const r = await projectPublishImpact(db, PERIOD)
    expect(r.alreadyPublishedEur).toBe(0)
    expect(r.monthProjectedTotalEur).toBe(0)
  })

  it('never lists an admin shift as a staffing gap', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 500 },
      contractors: [dan],
      blocks: [
        admin(block({ id: 'admin-empty', date: '2026-05-05', start: '09:00', end: '10:00' })),
        cls(block({ id: 'class-empty', date: '2026-05-05', start: '11:00', end: '12:00' })),
      ],
    })
    const r = await projectPublishImpact(db, PERIOD)
    expect(r.staffingGaps.map((g) => g.block_id)).toEqual(['class-empty'])
  })

  it("reads each block's template kind", async () => {
    const db = mockDb({ location: { id: 'loc1', monthly_contractor_budget_eur: 500 }, contractors: [dan], blocks: [] })
    await projectPublishImpact(db, PERIOD)
    expect(db.blockQueries[0].select).toMatch(/shift_templates\(name, kind\)/)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/roster-publish.test.js`
Expected: `3 failed`:
- `prices a contractor…` fails with `expected 210 to be 70`.
- `leaves a published admin shift out…` fails with `expected 140 to be 0`.
- The select match fails.

`never lists an admin shift as a staffing gap` already passes because of Task 3; it is a pin.

- [ ] **Step 3: Implement**

(a) Under `import { liveAssignments } from './roster'` (line 21) add:

```js
import { isAdminShift } from '@shared/shift-kind'
```

(b) Change line 127 from `        shift_templates(name),` to `        shift_templates(name, kind),`.

(c) At the top of `blockContractorCost` (line 261), before `let cost = 0`, add:

```js
  // SHIFTTYPE.1 — an admin shift stays out of the contractor budget gate
  // (Richard, 25 Sep 2026). This is the ONE euro projection every publish path
  // reads (POST rosters, approve, the approvals queue), so skipping it here
  // is the whole gate. Its hours still count wherever hours are counted
  // (payroll, week-cost, the hours report); only this figure leaves it out.
  if (isAdminShift(block)) return 0
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/roster-publish.test.js src/app/api/schedule/rosters/route.test.js 'src/app/api/schedule/rosters/[id]/approve/route.test.js' src/lib/approvals/providers/rosters.test.js && npm run check:select-columns`
Expected: `0 failed`, and the check exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-publish.js src/lib/roster-publish.test.js
git commit -m "SHIFTTYPE.1 — admin shifts are out of the contractor budget gate and the publish preview's gaps

blockContractorCost prices an admin block at €0; it is the one projection
every publish path reads (POST, approve, approvals queue). Admin blocks still
count in 'shifts in period'.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The spend panel and week summary: admin is out of contractor €, in hours

**Files:**
- Modify: `src/lib/roster-summary.js`
- Modify: `src/lib/roster-summary-server.js` (line 75)
- Create: `src/lib/roster-summary-server.test.js`
- Test: `src/lib/roster-summary.test.js`, `src/lib/roster-week-cost.test.js` (pin)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/roster-summary.test.js`. Its fixtures `block`, `fteSarah` and `contractorDan` are at the top of the file. `block()` sets `shift_templates: { start_time, end_time }` with no kind, so those fixture blocks are class.

```js
// SHIFTTYPE.1 — admin shifts: out of the contractor spend, still in hours.
describe('SHIFTTYPE.1 — admin shifts in the week and month summaries', () => {
  const asAdmin = (b) => ({ ...b, shift_templates: { ...b.shift_templates, kind: 'admin' } })
  const weekStart = new Date('2026-05-04T00:00:00')
  const today = new Date('2026-05-01T12:00:00')
  const refMay = new Date('2026-05-15T12:00:00')

  it('summarizeMonth: a contractor on an admin shift costs the budget nothing', () => {
    const blocks = [
      block({ id: 'class', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['dan'] }),          // 2h x 35 = 70
      asAdmin(block({ id: 'admin', date: '2026-05-05', start: '09:00', end: '13:00', coaches: ['dan'] })), // not priced
    ]
    const r = summarizeMonth({ blocks, staff: [contractorDan], referenceDate: refMay, monthlyBudgetEur: 100 })
    expect(r.contractorCostEur).toBe(70)
    expect(r.remainingEur).toBe(30)
    expect(r.overBudget).toBe(false)
  })

  it('summarizeMonth: an FTE on an admin shift still carries implicit cost (hours are hours)', () => {
    const blocks = [asAdmin(block({ id: 'admin', date: '2026-05-04', start: '09:00', end: '13:00', coaches: ['sarah'] }))]
    const r = summarizeMonth({ blocks, staff: [fteSarah], referenceDate: refMay, monthlyBudgetEur: 1000 })
    expect(r.fteImplicitCostEur).toBe(100) // 4h x EUR 25
  })

  it("summarizeWeek: admin hours count toward an FTE's allocated hours, and not toward contractor spend", () => {
    const blocks = [
      asAdmin(block({ id: 'a1', date: '2026-05-04', start: '09:00', end: '12:00', coaches: ['sarah', 'dan'] })),
      block({ id: 'c1', date: '2026-05-05', start: '09:00', end: '10:00', coaches: ['sarah', 'dan'] }),
    ]
    const r = summarizeWeek({ blocks, staff: [fteSarah, contractorDan], weekStart, today })
    expect(r.fte[0]).toMatchObject({ profile_id: 'sarah', allocated_hours: 4 })
    expect(r.contractorWeekCostEur).toBe(35) // the 1h class shift only
  })

  it('summarizeWeek: an empty future admin shift is not "unstaffed", but is still a block', () => {
    const blocks = [
      asAdmin(block({ id: 'a-empty', date: '2026-05-06', start: '09:00', end: '10:00' })),
      block({ id: 'c-empty', date: '2026-05-06', start: '11:00', end: '12:00' }),
    ]
    const r = summarizeWeek({ blocks, staff: [], weekStart, today })
    expect(r.unstaffedCount).toBe(1)
    expect(r.blockCount).toBe(2)
  })

  it("blocksToShiftRows carries each row's kind", () => {
    const rows = blocksToShiftRows([
      asAdmin(block({ id: 'a', date: '2026-05-04', start: '09:00', end: '10:00', coaches: ['sarah'] })),
      block({ id: 'c', date: '2026-05-04', start: '11:00', end: '12:00', coaches: ['sarah'] }),
    ])
    expect(rows.map((r) => [r.block_id, r.kind])).toEqual([['a', 'admin'], ['c', 'class']])
  })
})
```

Create `src/lib/roster-summary-server.test.js`:

```js
// SHIFTTYPE.1 — the contractor-spend panel's server read carries each block's
// template kind, so the panel and the publish gate price the same shifts.
import { describe, it, expect } from 'vitest'
import { computeMonthlyContractorSpend } from './roster-summary-server'

function fakeDb({ blocks }) {
  const selects = {}
  const answer = (data) => {
    const q = {}
    for (const m of ['eq', 'gte', 'lte', 'in']) q[m] = () => q
    // locations: .select().eq().single()
    q.single = () => Promise.resolve({ data: { id: 'loc1', monthly_contractor_budget_eur: 100 }, error: null })
    q.then = (res, rej) => Promise.resolve({ data, error: null }).then(res, rej)
    return q
  }
  return {
    selects,
    from(table) {
      return {
        select(s) {
          selects[table] = s
          if (table === 'shift_blocks') return answer(blocks)
          if (table === 'profile_locations') return answer([{ profile_id: 'dan' }])
          if (table === 'profiles') return answer([{ id: 'dan', full_name: 'Dan', active: true, employment_type: 'contractor', hourly_rate: 35 }])
          return answer(null)
        },
      }
    },
  }
}

const blk = (id, date, start, end, kind) => ({
  id, location_id: 'loc1', template_id: 't', block_date: date, start_time: start, end_time: end, max_coaches: 5,
  shift_templates: { start_time: start, end_time: end, kind },
  shift_assignments: [{ profile_id: 'dan', status: 'scheduled' }],
})

describe('computeMonthlyContractorSpend — SHIFTTYPE.1', () => {
  it('selects the template kind and leaves admin shifts out of the spend', async () => {
    const db = fakeDb({ blocks: [blk('c', '2026-05-04', '09:00', '11:00', 'class'), blk('a', '2026-05-05', '09:00', '13:00', 'admin')] })
    const r = await computeMonthlyContractorSpend({ db, locationId: 'loc1', referenceDate: '2026-05-15' })
    expect(db.selects.shift_blocks).toMatch(/shift_templates\(start_time, end_time, kind\)/)
    expect(r.contractorCostEur).toBe(70)
    expect(r.remainingEur).toBe(30)
  })
})
```

Append inside `describe('computeWeeklyFteHours', …)` in `src/lib/roster-week-cost.test.js`. This test is a pin: it passes before and after the change, and must keep passing.

```js
  // SHIFTTYPE.1 — an admin shift still counts toward hours (Richard, 25 Sep).
  it("counts an admin shift toward an FTE's hours like any other", async () => {
    const admin = block({ id: 'b-admin', date: '2026-05-06', start: '09:00:00', end: '13:00:00', coaches: ['sarah'] })
    admin.shift_templates = { ...admin.shift_templates, kind: 'admin' }
    const res = await callWith({
      staff: [SARAH],
      blocks: [block({ id: 'b1', date: '2026-05-04', start: '09:00:00', end: '16:00:00', coaches: ['sarah'] }), admin],
    })
    expect(res.coaches[0]).toMatchObject({ profile_id: 'sarah', allocated_hours: 11, contracted_hours: 10, overtime_hours: 1 })
  })
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/lib/roster-summary.test.js src/lib/roster-summary-server.test.js src/lib/roster-week-cost.test.js`
Expected: `5 failed`:
- `summarizeMonth: a contractor…` fails with `expected 210 to be 70`.
- `summarizeWeek: admin hours…` fails with `expected 140 to be 35`.
- `summarizeWeek: an empty future admin shift…` fails with `expected 2 to be 1`.
- `blocksToShiftRows carries…` fails because `kind` is `undefined`.
- The server test fails on the select match.

The FTE-implicit-cost test and the week-cost pin pass.

- [ ] **Step 3: Implement**

(a) In the budget model comment of `src/lib/roster-summary.js` (lines 16-21), add after the contractor bullet:

```js
//   - SHIFTTYPE.1 (Richard, 25 Sep 2026): an ADMIN shift is out of the
//     contractor budget entirely. Its hours still count as hours (FTE
//     utilisation, implicit cost, week-cost, payroll).
```

(b) After the imports (line 25) add:

```js
import { shiftKindOf, isAdminShift } from '../../shared/shift-kind'
```

(c) In `blocksToShiftRows`, directly under `shift_template_id: block.template_id,` (line 136) add:

```js
        // SHIFTTYPE.1 — class | admin, read through the embedded template.
        // Contractor spend skips admin rows (sumHoursForProfile's classOnly);
        // nothing that counts HOURS looks at it.
        kind: shiftKindOf(block),
```

(d) Replace `sumHoursForProfile` and its comment (lines 160-173) with:

```js
/**
 * Sum (date, hours) tuples for a single profile, across the date
 * range supplied. Returns total hours. `classOnly` (SHIFTTYPE.1) skips
 * admin rows: set ONLY where the hours become contractor euros.
 */
function sumHoursForProfile(rows, profileId, startIso, endIso, { classOnly = false } = {}) {
  let total = 0
  for (const r of rows) {
    if (r.profile_id !== profileId) continue
    if (startIso && r.block_date < startIso) continue
    if (endIso && r.block_date > endIso) continue
    if (classOnly && r.kind === 'admin') continue
    total += shiftHours(r)
  }
  return total
}
```

(e) In the contractor branch of `summarizeWeek` (line 277), replace

```js
      contractorWeekCostEur += allocated * rate
```

with

```js
      // SHIFTTYPE.1 — admin shifts are out of contractor spend.
      contractorWeekCostEur += sumHoursForProfile(rows, s.id, startIso, endIso, { classOnly: true }) * rate
```

(f) `unstaffedCount` (lines 288-290) becomes:

```js
  // SHIFTTYPE.1 — an admin shift has no minimum staffing, so an empty one is
  // not "unstaffed" (it is still counted in blockCount).
  const unstaffedCount = weekBlocks.filter(
    b => !isAdminShift(b) && liveAssignments(b.shift_assignments).length === 0 && b.block_date >= todayIso
  ).length
```

(g) In the contractor branch of `summarizeMonth` (line 328), replace

```js
      contractorCostEur += allocated * rate
```

with

```js
      // SHIFTTYPE.1 — admin shifts are out of the contractor budget.
      contractorCostEur += sumHoursForProfile(rows, s.id, startIso, endIso, { classOnly: true }) * rate
```

Leave the FTE branch (`fteImplicitCostEur += allocated * …`) alone: admin hours are FTE hours.

(h) In `src/lib/roster-summary-server.js`, change line 75 from `      shift_templates(start_time, end_time)` to `      shift_templates(start_time, end_time, kind)`.

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/lib/roster-summary.test.js src/lib/roster-summary-server.test.js src/lib/roster-week-cost.test.js src/components/RosterSummaryPanel.partial-load.test.jsx src/components/RosterSummaryPanel.spendmonth.test.jsx src/app/api/schedule/contractor-spend/route.test.js && npm run check:select-columns`
Expected: `0 failed`, and the check exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-summary.js src/lib/roster-summary-server.js src/lib/roster-summary.test.js src/lib/roster-summary-server.test.js src/lib/roster-week-cost.test.js
git commit -m "SHIFTTYPE.1 — contractor spend panel and week summary leave admin out; hours still count

Rows carry their kind; contractor euros sum class rows only; an empty admin
shift is not unstaffed. FTE hours, implicit cost and week-cost unchanged
(pinned).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Studio Overview: an admin block is never a below-minimum row

**Files:**
- Modify: `src/lib/schedule-overview.js` (new export `underMinEntry`)
- Modify: `src/app/api/schedule/overview/route.js` (imports 29-34; embed 184; loop 234-245)
- Test: `src/lib/schedule-overview.test.js`, `src/app/api/schedule/overview/route.test.js`

The overview route counts below-minimum blocks inline (`route.js:234-245`) and does not read through `futureBlockStaffing`. Its rule is `min > 0 && live < min`, which does not flag an empty block. An admin block made by the generator carries min 0, but a block made before its template became admin can still carry a minimum. So the rule moves into a pure helper that skips admin. `staff_scheduled` (supply) is unchanged (D8).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/schedule-overview.test.js`, and add `underMinEntry` to its import list from `./schedule-overview.js`:

```js
describe('underMinEntry (SHIFTMIN.1 / SHIFTTYPE.1)', () => {
  const b = (over = {}) => ({
    id: 'b1', block_date: '2026-09-22', start_time: '09:30:00', end_time: '10:30:00', min_coaches: 2,
    shift_templates: { name: 'Morning', kind: 'class' },
    shift_assignments: [{ profile_id: 'p1', status: 'scheduled' }, { profile_id: 'p2', status: 'cancelled' }],
    ...over,
  })

  it('names a class block below its minimum, counting live coaches only', () => {
    expect(underMinEntry(b())).toEqual({ id: 'b1', label: 'Morning', time: '09:30–10:30', assigned: 1, min: 2 })
  })

  it('is null at or above the minimum, and with no minimum', () => {
    expect(underMinEntry(b({ min_coaches: 1 }))).toBeNull()
    expect(underMinEntry(b({ min_coaches: 0 }))).toBeNull()
  })

  it('is null for an admin block, even one still carrying a minimum', () => {
    expect(underMinEntry(b({ shift_templates: { name: 'Admin', kind: 'admin' } }))).toBeNull()
  })
})
```

Append inside `describe('GET /api/schedule/overview — role at the requested studio', …)` in the route test:

```js
  // SHIFTTYPE.1 — the day dialog needs each block's kind to leave admin out.
  it("reads each block's template kind", async () => {
    getCurrentUser.mockResolvedValue(MGR_A_STAFF_B(LOC_A))
    const selects = {}
    createServerClient.mockReturnValue({
      from(t) {
        const b = {
          select: (s) => { selects[t] = s; return b },
          eq: () => b, gte: () => b, lte: () => b, in: () => b, or: () => b,
          then: (resolve) => resolve({ data: [], error: null }),
        }
        return b
      },
    })
    expect((await GET(req(LOC_A))).status).toBe(200)
    expect(selects.shift_blocks).toMatch(/shift_templates \( name, color, kind \)/)
  })
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/lib/schedule-overview.test.js src/app/api/schedule/overview/route.test.js`
Expected: the three helper tests fail with `underMinEntry is not a function`, and the route test fails on the select match.

- [ ] **Step 3: Implement**

(a) In `src/lib/schedule-overview.js`, add after its header comment:

```js
import { isAdminShift } from '../../shared/shift-kind'
```

Then, after `classifyDayLoad`, add:

```js
/**
 * SHIFTMIN.1 / SHIFTTYPE.1 — the day dialog's row for a block below its
 * minimum, or null. Moved out of the overview route so the rule is testable.
 *
 * An ADMIN block is never a row (Richard, 25 Sep 2026: admin shifts carry no
 * minimum staffing), whatever min_coaches it still carries. Only live
 * (non-cancelled) assignments with a profile count. A minimum of 0 is "no
 * floor" and never a row. Empty at a positive minimum IS a row (0 of N), as
 * it always was here.
 *
 * @param {object} block  shift_blocks row: id, start_time, end_time, min_coaches,
 *                        shift_templates { name, kind }, shift_assignments[]
 * @returns {{ id: string, label: string, time: string, assigned: number, min: number } | null}
 */
export function underMinEntry(block) {
  if (!block || isAdminShift(block)) return null
  const live = (block.shift_assignments || []).filter((a) => a.status !== 'cancelled' && a.profile_id)
  const min = block.min_coaches || 0
  if (!(min > 0 && live.length < min)) return null
  return {
    id: block.id,
    label: block.shift_templates?.name || 'Shift',
    time: `${String(block.start_time || '').slice(0, 5)}–${String(block.end_time || '').slice(0, 5)}`,
    assigned: live.length,
    min,
  }
}
```

(b) In `src/app/api/schedule/overview/route.js`, add `underMinEntry,` to the `@/lib/schedule-overview` import (lines 29-34). Change line 184 from `        shift_templates ( name, color ),` to `        shift_templates ( name, color, kind ),`. Then replace lines 234-245:

```js
    const min = block.min_coaches || 0
    if (min > 0 && activeAssignments.length < min) {
      if (!underMinByDate.has(block.block_date)) underMinByDate.set(block.block_date, [])
      underMinByDate.get(block.block_date).push({
        id: block.id,
        label: block.shift_templates?.name || 'Shift',
        time: `${String(block.start_time || '').slice(0, 5)}–${String(block.end_time || '').slice(0, 5)}`,
        assigned: activeAssignments.length,
        min,
      })
    }
```

with

```js
    // SHIFTTYPE.1 — the rule lives in underMinEntry (admin is never a row).
    // Supply above still counts an admin-rostered person: they are on site.
    const entry = underMinEntry(block)
    if (entry) {
      if (!underMinByDate.has(block.block_date)) underMinByDate.set(block.block_date, [])
      underMinByDate.get(block.block_date).push(entry)
    }
```

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/lib/schedule-overview.test.js src/app/api/schedule/overview/route.test.js src/components/schedule/StudioOverviewDialog.test.jsx tests/shared-pair-sync.test.js && npm run check:select-columns`
Expected: `0 failed`, and the check exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule-overview.js src/lib/schedule-overview.test.js src/app/api/schedule/overview/route.js src/app/api/schedule/overview/route.test.js
git commit -m "SHIFTTYPE.1 — Studio Overview never lists an admin block as below its minimum

The inline rule moves to a pure underMinEntry that skips admin; supply is
unchanged (an admin-rostered person is on site).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Template API: kind on create and edit; an admin template has no minimum

**Files:**
- Create: `src/lib/shift-template-kind.js`, `src/lib/shift-template-kind.test.js`
- Modify: `src/app/api/schedule/templates/route.js`, `src/app/api/schedule/templates/[id]/route.js`
- Test: `src/app/api/schedule/templates/route.test.js`, `src/app/api/schedule/templates/[id]/route.test.js`

The policy is D3: an explicit contradiction is refused with 400, and an omitted value is normalised.

- [ ] **Step 1: Write the failing rule tests**

```js
// src/lib/shift-template-kind.test.js
// SHIFTTYPE.1 — the kind + min_coaches half of a template write.
import { describe, it, expect } from 'vitest'
import { resolveTemplateKindWrite, adminMinimumRefusal, ADMIN_MINIMUM_ERROR } from './shift-template-kind'

describe('adminMinimumRefusal', () => {
  it('refuses a non-zero minimum on an admin shift, with a sentence the editor can show', () => {
    expect(adminMinimumRefusal('admin', 2)).toEqual({
      status: 400,
      body: { success: false, error: ADMIN_MINIMUM_ERROR, message: expect.stringMatching(/admin shift has no minimum/i) },
    })
    expect(ADMIN_MINIMUM_ERROR).toBe('admin_has_no_minimum')
  })

  it('allows 0 or no minimum on admin, and anything on class', () => {
    for (const m of [undefined, null, 0]) expect(adminMinimumRefusal('admin', m)).toBeNull()
    for (const m of [undefined, 0, 1, 5]) expect(adminMinimumRefusal('class', m)).toBeNull()
  })
})

describe('resolveTemplateKindWrite — create (prior null)', () => {
  it('defaults to class with the SHIFTMIN.1 minimum of 1', () => {
    expect(resolveTemplateKindWrite({ body: {} })).toEqual({ ok: true, patch: { kind: 'class', min_coaches: 1 } })
  })

  it('keeps an explicit class minimum, 0 included', () => {
    expect(resolveTemplateKindWrite({ body: { kind: 'class', min_coaches: 0 } }).patch).toEqual({ kind: 'class', min_coaches: 0 })
    expect(resolveTemplateKindWrite({ body: { min_coaches: 3 } }).patch).toEqual({ kind: 'class', min_coaches: 3 })
  })

  it('an admin template has minimum 0, stated or not', () => {
    expect(resolveTemplateKindWrite({ body: { kind: 'admin' } }).patch).toEqual({ kind: 'admin', min_coaches: 0 })
    expect(resolveTemplateKindWrite({ body: { kind: 'admin', min_coaches: 0 } }).patch).toEqual({ kind: 'admin', min_coaches: 0 })
  })

  it('refuses admin with a minimum rather than quietly dropping it', () => {
    expect(resolveTemplateKindWrite({ body: { kind: 'admin', min_coaches: 2 } }))
      .toMatchObject({ ok: false, status: 400, body: { error: 'admin_has_no_minimum' } })
  })
})

describe('resolveTemplateKindWrite — edit', () => {
  const classT = { kind: 'class', min_coaches: 2 }
  const adminT = { kind: 'admin', min_coaches: 0 }

  it('an edit that touches neither kind nor minimum writes neither', () => {
    expect(resolveTemplateKindWrite({ prior: classT, body: { name: 'x' } }).patch).toEqual({})
    expect(resolveTemplateKindWrite({ prior: adminT, body: { name: 'x' } }).patch).toEqual({})
    expect(resolveTemplateKindWrite({ prior: classT, body: { display_order: 3 } }).patch).toEqual({})
  })

  it('class -> admin sets the minimum to 0 in the same write (the DB CHECK needs both at once)', () => {
    expect(resolveTemplateKindWrite({ prior: classT, body: { kind: 'admin' } }).patch).toEqual({ kind: 'admin', min_coaches: 0 })
  })

  it('admin -> class restores the create default of 1 unless a minimum is given', () => {
    expect(resolveTemplateKindWrite({ prior: adminT, body: { kind: 'class' } }).patch).toEqual({ kind: 'class', min_coaches: 1 })
    expect(resolveTemplateKindWrite({ prior: adminT, body: { kind: 'class', min_coaches: 0 } }).patch).toEqual({ kind: 'class', min_coaches: 0 })
  })

  it('refuses a minimum on a template that stays admin', () => {
    expect(resolveTemplateKindWrite({ prior: adminT, body: { min_coaches: 1 } })).toMatchObject({ ok: false, status: 400 })
    expect(resolveTemplateKindWrite({ prior: adminT, body: { min_coaches: 0 } }).patch).toEqual({ min_coaches: 0 })
  })

  it('a class minimum edit passes straight through; a stored row with no kind is class', () => {
    expect(resolveTemplateKindWrite({ prior: classT, body: { min_coaches: 3 } }).patch).toEqual({ min_coaches: 3 })
    expect(resolveTemplateKindWrite({ prior: { min_coaches: 1 }, body: { min_coaches: 2 } }).patch).toEqual({ min_coaches: 2 })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/shift-template-kind.test.js`
Expected: the file fails to load with `Failed to resolve import "./shift-template-kind"`.

- [ ] **Step 3: Implement the rule**

```js
// src/lib/shift-template-kind.js
// SHIFTTYPE.1 (mig 628) — the kind + min_coaches half of a shift-template (or
// manual slot) write.
//
// An admin shift has NO minimum staffing (Richard, 25 Sep 2026), and the
// database says so too: CHECK shift_templates_admin_no_minimum
// (kind <> 'admin' OR min_coaches = 0). Policy:
//
//   * an EXPLICIT contradiction (kind admin + min_coaches > 0) is refused with
//     a 400 the editor can show. Silently rewriting it would save something
//     the operator did not type and hide a client bug.
//   * an OMITTED value is normalised: admin with no minimum is 0; leaving
//     admin for class with no minimum restores the create default of 1
//     (SHIFTMIN.1). class -> admin writes min_coaches 0 in the SAME update,
//     because the CHECK needs both columns to change in one statement.
//
// Web-only (the phone never writes templates). Named differently from
// shared/shift-kind.js on purpose: a same-named module in both trees is a
// pair tests/shared-pair-sync.test.js would make someone classify.

import { DEFAULT_SHIFT_KIND } from '@shared/shift-kind'

export const ADMIN_MINIMUM_ERROR = 'admin_has_no_minimum'
const ADMIN_MINIMUM_MESSAGE = 'An admin shift has no minimum number of coaches. Set the minimum to 0, or make it a class shift.'
const CLASS_DEFAULT_MIN = 1

/**
 * @param {'class'|'admin'|string} kind
 * @param {number|null|undefined} minCoaches  the value the caller SENT (undefined = not sent)
 * @returns {null | { status: 400, body: { success: false, error: string, message: string } }}
 */
export function adminMinimumRefusal(kind, minCoaches) {
  if (kind !== 'admin') return null
  if (minCoaches === undefined || minCoaches === null || minCoaches === 0) return null
  return { status: 400, body: { success: false, error: ADMIN_MINIMUM_ERROR, message: ADMIN_MINIMUM_MESSAGE } }
}

/**
 * @param {object} args
 * @param {{ kind?: string, min_coaches?: number } | null} [args.prior]  the stored row for an edit; null for a create
 * @param {object} args.body  the validated request body
 * @returns {{ ok: true, patch: { kind?: 'class'|'admin', min_coaches?: number } }
 *         | { ok: false, status: 400, body: object }}
 */
export function resolveTemplateKindWrite({ prior = null, body = {} }) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
  const priorKind = prior ? (prior.kind === 'admin' ? 'admin' : 'class') : null
  const nextKind = has('kind') ? body.kind : (priorKind ?? DEFAULT_SHIFT_KIND)

  const refusal = adminMinimumRefusal(nextKind, has('min_coaches') ? body.min_coaches : undefined)
  if (refusal) return { ok: false, ...refusal }

  const patch = {}
  if (!prior || has('kind')) patch.kind = nextKind

  if (nextKind === 'admin') {
    if (!prior || has('kind') || has('min_coaches')) patch.min_coaches = 0
  } else if (!prior) {
    patch.min_coaches = has('min_coaches') ? body.min_coaches : CLASS_DEFAULT_MIN
  } else if (has('min_coaches')) {
    patch.min_coaches = body.min_coaches
  } else if (priorKind === 'admin' && has('kind')) {
    patch.min_coaches = CLASS_DEFAULT_MIN
  }
  return { ok: true, patch }
}
```

Run: `npx vitest run src/lib/shift-template-kind.test.js`. Expected: `11 passed`.

- [ ] **Step 4: Write the failing route tests**

Append to `src/app/api/schedule/templates/route.test.js`:

```js
// SHIFTTYPE.1 — kind on create.
describe('POST /api/schedule/templates — kind (SHIFTTYPE.1)', () => {
  const MGR = { id: 'm', role: 'manager', profileRole: 'manager', activeLocation: { id: LOC_A }, locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' } }

  it('creates a class template with minimum 1 by default', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, insertSpy } = buildDb()
    createServerClient.mockReturnValue(db)
    expect((await POST(req(body(LOC_A)))).status).toBe(201)
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'class', min_coaches: 1 }))
  })

  it('creates an admin template with minimum 0', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, insertSpy } = buildDb()
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ ...body(LOC_A), kind: 'admin' }))).status).toBe(201)
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'admin', min_coaches: 0 }))
  })

  it('refuses an admin template with a minimum, and inserts nothing', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, insertSpy } = buildDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ ...body(LOC_A), kind: 'admin', min_coaches: 2 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('admin_has_no_minimum')
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('refuses a kind it does not know', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, insertSpy } = buildDb()
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ ...body(LOC_A), kind: 'desk' }))).status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
```

Append to `src/app/api/schedule/templates/[id]/route.test.js`. These tests use that file's `useDb`, `templates()`, `MANAGER_A`, `FUTURE`, `PAST` and `req`.

```js
// SHIFTTYPE.1 — kind on an edit.
describe('PUT /api/schedule/templates/[id] — kind (SHIFTTYPE.1)', () => {
  it('class -> admin writes kind and minimum 0 together, and takes FUTURE blocks to minimum 0', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({
      shift_templates: templates().map((t) => ({ ...t, kind: 'class', min_coaches: 2 })),
      rosters: [],
      shift_blocks: [
        { id: 'blk-future', location_id: 'loc-a', template_id: 'tmpl-a', block_date: FUTURE, min_coaches: 2, max_coaches: 10, shift_assignments: [] },
        { id: 'blk-past', location_id: 'loc-a', template_id: 'tmpl-a', block_date: PAST, min_coaches: 2, max_coaches: 10, shift_assignments: [] },
      ],
    })
    const res = await PUT(req({ kind: 'admin' }), { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(200)
    const tplWrite = db._writes.find((w) => w.table === 'shift_templates' && w.op === 'update')
    expect(tplWrite.payload).toEqual({ kind: 'admin', min_coaches: 0 })
    const blockWrites = db._writes.filter((w) => w.table === 'shift_blocks' && w.op === 'update')
    expect(blockWrites).toHaveLength(1)
    expect(blockWrites[0].payload).toEqual({ min_coaches: 0 })
    expect(blockWrites[0].filters.find((f) => f.type === 'in').val).toEqual(['blk-future'])
  })

  it('refuses a minimum on an admin template with 400 and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates().map((t) => ({ ...t, kind: 'admin', min_coaches: 0 })), rosters: [], shift_blocks: [] })
    const res = await PUT(req({ min_coaches: 2 }), { params: { id: 'tmpl-a' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('admin_has_no_minimum')
    expect(db._writes).toEqual([])
  })

  it('renaming an admin template leaves its kind and minimum alone', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates().map((t) => ({ ...t, kind: 'admin', min_coaches: 0 })), rosters: [], shift_blocks: [] })
    expect((await PUT(req({ name: 'Stock take' }), { params: { id: 'tmpl-a' } })).status).toBe(200)
    const tplWrite = db._writes.find((w) => w.table === 'shift_templates' && w.op === 'update')
    expect(tplWrite.payload).toEqual({ name: 'Stock take' })
  })

  it('refuses a kind it does not know, before any write', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const db = useDb({ shift_templates: templates(), rosters: [], shift_blocks: [] })
    expect((await PUT(req({ kind: 'desk' }), { params: { id: 'tmpl-a' } })).status).toBe(400)
    expect(db._writes).toEqual([])
  })
})
```

Run: `npx vitest run src/app/api/schedule/templates/route.test.js 'src/app/api/schedule/templates/[id]/route.test.js'`
Expected: `8 failed`. The first create test fails with `expected "spy" to be called with arguments: [ ObjectContaining { kind: 'class', … } ]`. The two "refuses a kind it does not know" tests fail as well. The schemas do not declare `kind` yet, and Zod's `z.object()` strips unknown keys, so `kind: 'desk'` is dropped: the POST inserts (201) and the PUT writes an empty update.

- [ ] **Step 5: Implement the routes**

In **`src/app/api/schedule/templates/route.js`:**

(a) After the imports (line 7) add:

```js
import { SHIFT_KINDS } from '@shared/shift-kind'
import { resolveTemplateKindWrite } from '@/lib/shift-template-kind'
```

(b) In `CreateTemplateSchema`, after the `min_coaches` line (27), add:

```js
  // SHIFTTYPE.1 (mig 628) — class (default) or admin. An admin template has
  // no minimum: min_coaches > 0 with kind admin is refused (400), and the
  // database CHECKs it too (shift_templates_admin_no_minimum).
  kind: z.enum(SHIFT_KINDS).optional(),
```

(c) In `POST`, directly after the `hasRoleAtLocation` 403 (after line 72) and before `const db = createServerClient()`, add:

```js
  // SHIFTTYPE.1 — kind + minimum, decided before any write.
  const kindWrite = resolveTemplateKindWrite({ prior: null, body })
  if (!kindWrite.ok) return NextResponse.json(kindWrite.body, { status: kindWrite.status })
```

(d) In the insert (lines 75-90), replace the `min_coaches: body.min_coaches ?? 1,` line and its comment (lines 85-89) with:

```js
    // SHIFTMIN.1 — 1 is the class default and an explicit 0 is legitimate;
    // SHIFTTYPE.1 — an admin template is always 0. resolveTemplateKindWrite
    // decides both.
    kind: kindWrite.patch.kind,
    min_coaches: kindWrite.patch.min_coaches,
```

In **`src/app/api/schedule/templates/[id]/route.js`:**

(a) After the imports (line 14) add:

```js
import { SHIFT_KINDS } from '@shared/shift-kind'
import { resolveTemplateKindWrite } from '@/lib/shift-template-kind'
```

(b) In `TemplateUpdateSchema`, after the `min_coaches` line (27), add:

```js
  // SHIFTTYPE.1 (mig 628) — see resolveTemplateKindWrite for the rule.
  kind: z.enum(SHIFT_KINDS).optional(),
```

(c) Change line 87 from `.select('location_id, days_of_week')` to `.select('location_id, days_of_week, kind, min_coaches')`.

(d) Directly after `const locationId = priorTemplate.location_id` (line 100), add:

```js
  // SHIFTTYPE.1 — kind + minimum. Runs BEFORE changingCapacity is computed
  // below: a switch to admin adds min_coaches: 0 to `updates`, and that must
  // reach the future blocks through the SHIFTMIN-CLAMP.1 path like any other
  // minimum edit. An explicit minimum on an admin template is refused before
  // any write.
  const kindWrite = resolveTemplateKindWrite({ prior: priorTemplate, body: validation.data })
  if (!kindWrite.ok) return NextResponse.json(kindWrite.body, { status: kindWrite.status })
  Object.assign(updates, kindWrite.patch)
```

(e) In the propagation comment above `PUT`, add after the `active:false` bullet (after line 58):

```js
//   - kind (SHIFTTYPE.1): class -> admin also writes min_coaches 0, which
//     propagates to FUTURE blocks like any minimum edit. Past blocks keep
//     their minimum; staffing never reads a past block, and it reads kind
//     through the template, so an admin block's stale minimum is inert.
```

- [ ] **Step 6: Run them, expect PASS**

Run: `npx vitest run src/lib/shift-template-kind.test.js src/app/api/schedule/templates/route.test.js 'src/app/api/schedule/templates/[id]/route.test.js' && npm run check:select-columns && npm run check:route-guards && npm run check:location-scoping`
Expected: `0 failed`, and each check exits 0. The existing reorder test (`a reorder is just a reorder`) still passes, because an empty patch adds no key to `updates`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/shift-template-kind.js src/lib/shift-template-kind.test.js src/app/api/schedule/templates/route.js src/app/api/schedule/templates/route.test.js 'src/app/api/schedule/templates/[id]/route.js' 'src/app/api/schedule/templates/[id]/route.test.js'
git commit -m "SHIFTTYPE.1 — template create/edit take a kind; an admin template has no minimum

Explicit admin + min > 0 is a 400 (admin_has_no_minimum); an omitted minimum
is normalised (admin 0, back to class 1). class -> admin writes both columns
in one UPDATE (the mig 628 CHECK) and takes future blocks to 0 through the
existing clamp path.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Blocks API: the calendar and the phone get the kind; a manual admin slot has no minimum

**Files:**
- Modify: `src/app/api/schedule/blocks/route.js` (import after 24; embed 54 and 242; `slimBlockForCoach` 141; POST 201, 212, 217)
- Test: `src/app/api/schedule/blocks/route.test.js`

- [ ] **Step 1: Write the failing tests**

Append after the `GET … manager view` describe:

```js
// SHIFTTYPE.1 — the calendar and the phone read a block's kind from its
// template. A coach's slim shape keeps it (a coach's admin card gets the admin
// tone); it is not a capacity fact, so the capacity stripping is unchanged.
describe('GET /api/schedule/blocks — shift kind (SHIFTTYPE.1)', () => {
  function capturingDb(rows) {
    const captured = {}
    const q = {}
    for (const op of ['eq', 'in', 'gte', 'lte', 'order']) q[op] = () => q
    q.then = (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej)
    return { captured, from: () => ({ select: (s) => { captured.select = s; return q } }) }
  }
  const ADMIN_BLOCK = { ...PUBLISHED_BLOCK, id: 'b-admin', shift_templates: { ...PUBLISHED_BLOCK.shift_templates, kind: 'admin' } }

  it('embeds the template kind for a manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' } })
    const db = capturingDb([ADMIN_BLOCK])
    createServerClient.mockReturnValue(db)
    const body = await (await GET(req())).json()
    expect(db.captured.select).toMatch(/shift_templates\(id, name, color, role_label, start_time, end_time, days_of_week, max_coaches, kind\)/)
    expect(body.data[0].shift_templates.kind).toBe('admin')
  })

  it("keeps the kind in a coach's slim shape, and still no capacity", async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' } })
    createServerClient.mockReturnValue(capturingDb([ADMIN_BLOCK]))
    const body = await (await GET(req())).json()
    expect(body.data[0].shift_templates.kind).toBe('admin')
    expect('max_coaches' in body.data[0].shift_templates).toBe(false)
    expect('min_coaches' in body.data[0]).toBe(false)
  })
})
```

In `describe('POST /api/schedule/blocks — post-publish blocks join the roster', …)`, give `postDb` a template kind. Change its signature from

```js
  function postDb({ publishedRoster = null, restoreError = null, insertError = null, templateAt = null } = {}) {
```

to

```js
  function postDb({ publishedRoster = null, restoreError = null, insertError = null, templateAt = null, templateKind = 'class' } = {}) {
```

and its template row from

```js
                ? { start_time: '09:00', end_time: '10:00', max_coaches: 5, min_coaches: 1 }
```

to

```js
                ? { start_time: '09:00', end_time: '10:00', max_coaches: 5, min_coaches: templateKind === 'admin' ? 0 : 1, kind: templateKind }
```

Then append inside that describe:

```js
  // SHIFTTYPE.1 — a manual slot of an admin template has no minimum.
  describe('admin template (SHIFTTYPE.1)', () => {
    const MGR = { id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } }

    it("an admin template's slot is created with minimum 0", async () => {
      getCurrentUser.mockResolvedValue(MGR)
      const db = postDb({ templateKind: 'admin' })
      createServerClient.mockReturnValue(db)
      const { POST } = await import('./route.js')
      expect((await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))).status).toBe(201)
      expect(db.captured.insert.min_coaches).toBe(0)
    })

    it("refuses an explicit minimum on an admin template's slot, and inserts nothing", async () => {
      getCurrentUser.mockResolvedValue(MGR)
      const db = postDb({ templateKind: 'admin' })
      createServerClient.mockReturnValue(db)
      const { POST } = await import('./route.js')
      const res = await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06', min_coaches: 2 }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('admin_has_no_minimum')
      expect(db.captured.insert).toBeNull()
    })

    it("a class template's slot still takes the template minimum", async () => {
      getCurrentUser.mockResolvedValue(MGR)
      const db = postDb()
      createServerClient.mockReturnValue(db)
      const { POST } = await import('./route.js')
      await POST(postReq({ location_id: LOC, template_id: TPL, block_date: '2026-06-06' }))
      expect(db.captured.insert.min_coaches).toBe(1)
    })
  })
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/app/api/schedule/blocks/route.test.js`
Expected: `4 failed`:
- The manager select match fails.
- The coach slim shape fails because `kind` is `undefined`.
- The admin minimum fails with `expected 1 to be 0`.
- The refusal fails with `expected 201 to be 400`.

The class test passes.

- [ ] **Step 3: Implement**

(a) After the imports (line 24) add:

```js
import { adminMinimumRefusal } from '@/lib/shift-template-kind'
```

(b) On lines 54 and 242, change `shift_templates(id, name, color, role_label, start_time, end_time, days_of_week, max_coaches),` to `shift_templates(id, name, color, role_label, start_time, end_time, days_of_week, max_coaches, kind),`.

(c) In `slimBlockForCoach`, under `days_of_week: tpl.days_of_week,` (line 141), add:

```js
          // SHIFTTYPE.1 — class | admin. Not a capacity fact: a coach's admin
          // shift is drawn in the admin tone too.
          kind: tpl.kind,
```

(d) In POST, the template read on line 201 becomes `.select('start_time, end_time, max_coaches, min_coaches, kind')`. Directly after the `if (!tpl) { … 404 }` block (after line 212), add:

```js
  // SHIFTTYPE.1 — an admin shift has no minimum staffing. An explicit
  // minimum is a contradiction the caller should hear about (400, the same
  // answer as the template routes); an omitted one is 0.
  const refusal = adminMinimumRefusal(tpl.kind, body.min_coaches)
  if (refusal) return NextResponse.json(refusal.body, { status: refusal.status })
```

Then change line 217 from

```js
  min = min ?? (tpl.min_coaches ?? 1)
```

to

```js
  min = tpl.kind === 'admin' ? 0 : (min ?? (tpl.min_coaches ?? 1))
```

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/app/api/schedule/blocks/route.test.js mobile/lib/schedule-api.test.js && npm run check:select-columns`
Expected: `0 failed`, and the check exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/blocks/route.js src/app/api/schedule/blocks/route.test.js
git commit -m "SHIFTTYPE.1 — blocks feed carries template kind (coaches too); a manual admin slot has no minimum

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Card tone: admin gets its own neutral surface and a word

**Files:**
- Modify: `src/lib/roster-card-model.js` (import after 21; `cardTone` 23-36; `shiftCardModel` 48, 79-80, 87-92, 101)
- Modify: `src/components/schedule/ShiftCard.jsx` (comment 17-19; `TONE_SURFACE` 40-42; a tag after the short badge at line 122)
- Test: `src/lib/roster-card-model.test.js`, `src/components/schedule/ShiftCard.test.jsx`

This is the hook ROSTERLOOK.1 left.
- The admin surface is slate (`bg-slate-500/10`), a neutral that is never amber or red. Amber and red still mean "needs a coach", and an admin shift never needs one.
- The surface also carries a visible "Admin" tag, so tone is never the only signal. This follows the same principle as ROSTER-FIX.6b's dashed border for red.
- Admin never has a staffing badge, so the tag takes that slot.
- The chip colours `bg-slate-500/10 text-slate-700` pass `no-low-contrast-chip`. They are the same pair as the template list's "One-off" chip (`ShiftTemplateManager.jsx:342`).

- [ ] **Step 1: Write the failing tests**

In `src/lib/roster-card-model.test.js`, replace the whole `describe('cardTone', …)` block (lines 17-23) with:

```js
describe('cardTone', () => {
  it("is 'neutral' for a class block, and for anything whose kind cannot be read", () => {
    expect(cardTone(block())).toBe('neutral')
    expect(cardTone(block({ shift_templates: { name: 'Admin', color: '#000000' } }))).toBe('neutral')
    expect(cardTone(null)).toBe('neutral')
  })

  it("is 'admin' for a block whose template is an admin shift (SHIFTTYPE.1)", () => {
    expect(cardTone(block({ shift_templates: { name: 'Ops', kind: 'admin' } }))).toBe('admin')
  })
})
```

Then append:

```js
describe('shiftCardModel — admin shifts (SHIFTTYPE.1)', () => {
  const adminBlock = block({ block_date: '2026-09-22', min_coaches: 0, shift_templates: { name: 'Stock take', kind: 'admin' } })

  it('carries the admin tone and a word for it, for a manager and a coach alike', () => {
    for (const isManager of [true, false]) {
      const m = shiftCardModel(adminBlock, [coach('u2', 'Coach A')], null, { isManager, viewerId: 'u9' })
      expect(m.tone).toBe('admin')
      expect(m.kindLabel).toBe('Admin')
      expect(m.status).toBeNull()
      expect(m.hoverTitle.startsWith('Stock take · Admin · ')).toBe(true)
    }
  })

  it('an unassigned future admin shift says so plainly: never "No coach (past)", never "Needs coach"', () => {
    const m = shiftCardModel(adminBlock, [], null, { isManager: true })
    expect(m.status).toBeNull()
    expect(m.emptyText).toBe('Nobody assigned')
  })

  it('a class card carries no kind label, and its empty text is unchanged', () => {
    expect(shiftCardModel(block(), [], { status: 'empty', count: 0, min: 2 }, { isManager: true }).kindLabel).toBeNull()
    expect(shiftCardModel(block(), [], null, { isManager: true }).emptyText).toBe('No coach (past)')
    expect(shiftCardModel(block(), [], null, { isManager: false }).emptyText).toBe('No coach assigned')
  })
})

describe('dayHeaderStatus — admin shifts (SHIFTTYPE.1)', () => {
  it('a day whose only future shifts are admin says nothing', () => {
    const adminEmpty = block({ id: 'a', block_date: '2026-09-22', min_coaches: 0, shift_templates: { name: 'Ops', kind: 'admin' }, shift_assignments: [] })
    expect(dayHeaderStatus([adminEmpty], { todayIso: TODAY }).tone).toBe('none')
  })
})
```

Append to `src/components/schedule/ShiftCard.test.jsx`:

```js
describe('ShiftCard — admin shifts (SHIFTTYPE.1)', () => {
  it('draws the admin surface and says "Admin" in words, so the tone is never the only signal', () => {
    const model = shiftCardModel({ ...BLOCK, min_coaches: 0, shift_templates: { name: 'Stock take', kind: 'admin' } }, [], null, { isManager: true })
    render(<ShiftCard model={model} dayLabel="Monday 21 September" onActivate={() => {}} />)
    const card = screen.getByTestId('shift-card')
    expect(card.getAttribute('data-tone')).toBe('admin')
    expect(card.className).toMatch(/\bbg-slate-500\/10\b/)
    expect(card.className).not.toMatch(/border-dashed|border-red|border-amber/)
    expect(screen.getByTestId('shift-kind').textContent).toBe('Admin')
    expect(screen.queryByTestId('needs-coach-badge')).toBeNull()
    expect(screen.getByText('Nobody assigned')).toBeTruthy()
  })

  it('a class card keeps the neutral surface and has no kind tag', () => {
    renderCard()
    expect(screen.getByTestId('shift-card').className).toMatch(/\bbg-un1t-bg\b/)
    expect(screen.queryByTestId('shift-kind')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run src/lib/roster-card-model.test.js src/components/schedule/ShiftCard.test.jsx`
Expected: 5 failures:
- `is 'admin' for a block…` fails with `expected 'neutral' to be 'admin'`.
- `carries the admin tone…` fails.
- `an unassigned future admin shift…` fails with `expected 'No coach (past)' to be 'Nobody assigned'`.
- `a class card carries no kind label…` fails with `expected undefined to be null`, because `kindLabel` does not exist yet.
- The ShiftCard admin test fails.

The ShiftCard class test and the `dayHeaderStatus` pin pass (Task 3).

- [ ] **Step 3: Implement**

(a) In the imports of `src/lib/roster-card-model.js`, after line 21 add:

```js
import { isAdminShift, SHIFT_KIND_LABELS } from '../../shared/shift-kind'
```

(b) Replace `cardTone` and its doc comment (lines 23-36) with:

```js
/**
 * The card's surface tone. The template's colour is no longer a fill, because
 * a pastel per template collided with the amber/red that means "needs a
 * coach".
 *
 *   'neutral'  a class shift (and anything whose kind cannot be read)
 *   'admin'    SHIFTTYPE.1 — an admin shift: a DIFFERENT neutral (slate), never
 *              amber or red, because an admin shift has no minimum and never
 *              needs a coach. ShiftCard maps the tone to a surface class and
 *              adds the "Admin" word, so colour is never the only signal.
 *
 * @returns {'neutral'|'admin'}
 */
export function cardTone(block) {
  return isAdminShift(block) ? 'admin' : 'neutral'
}
```

(c) In `shiftCardModel`, directly under `const templateName = …` (line 48), add:

```js
  // SHIFTTYPE.1 — an admin shift is labelled in words for everyone (not a
  // capacity fact), and never carries a staffing status: its caller passes
  // futureBlockStaffing's null for it.
  const isAdmin = isAdminShift(block)
  const kindLabel = isAdmin ? SHIFT_KIND_LABELS.admin : null
```

Replace lines 79-80:

```js
  let emptyText = null
  if (coaches.length === 0 && !status) emptyText = isManager ? 'No coach (past)' : 'No coach assigned'
```

with

```js
  let emptyText = null
  if (coaches.length === 0 && !status) {
    // An admin shift has no status even in the future, so "(past)" would lie.
    emptyText = isAdmin ? 'Nobody assigned' : (isManager ? 'No coach (past)' : 'No coach assigned')
  }
```

In `hoverTitle` (lines 87-92), insert `kindLabel,` directly after `templateName,`. In the returned object, add `kindLabel,` directly after `templateName,` (line 101).

(d) In `src/components/schedule/ShiftCard.jsx`, replace the TONE comment (lines 17-19):

```js
// TONE. `model.tone` comes from cardTone(), 'neutral' for every block today.
// Wave 2 adds 'admin' by returning it there and adding ONE line to
// TONE_SURFACE. The markup below does not change.
```

with

```js
// TONE. `model.tone` comes from cardTone(): 'neutral' for a class shift,
// 'admin' for an admin shift (SHIFTTYPE.1) — slate, never amber or red. An
// admin card never has a staffing badge, so the "Admin" tag takes that slot
// and the tone is never the only signal.
```

`TONE_SURFACE` (lines 40-42) becomes:

```js
const TONE_SURFACE = {
  neutral: 'bg-un1t-bg',
  admin: 'bg-slate-500/10',
}
```

Directly after the `short-staffed-badge` block closes (after line 122, before the "What" comment), add:

```jsx
      {/* SHIFTTYPE.1 — the admin word. An admin shift never has a staffing
          badge (no minimum), so this is the only chip it can carry. */}
      {model.kindLabel && (
        <div
          data-testid="shift-kind"
          className="mt-1 inline-flex items-center rounded bg-slate-500/10 px-1.5 py-0.5 text-[11px] font-medium text-slate-700"
        >
          {model.kindLabel}
        </div>
      )}
```

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/lib/roster-card-model.test.js src/components/schedule/ShiftCard.test.jsx src/components/schedule/MonthCell.test.jsx src/components/schedule/DayHeader.test.jsx src/components/ScheduleCalendar.visibility.test.jsx && npm run check:guardrails`
Expected: `0 failed`, and `check:guardrails` exits 0 (the chip pair is `-500/10` + `-700`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/roster-card-model.js src/lib/roster-card-model.test.js src/components/schedule/ShiftCard.jsx src/components/schedule/ShiftCard.test.jsx
git commit -m "SHIFTTYPE.1 — admin shift cards: slate surface, an 'Admin' tag, no staffing badge

cardTone returns 'admin' (the ROSTERLOOK.1 hook); an unassigned future admin
shift reads 'Nobody assigned', never 'No coach (past)'.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Template editor: a Kind control, a locked minimum for admin, "Admin" on the list

**Files:**
- Modify: `src/components/ShiftTemplateManager.jsx`
- Create: `src/components/ShiftTemplateManager.kind.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// @vitest-environment jsdom
//
// SHIFTTYPE.1 — the template editor's Kind control, and the list's Admin label.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

import ShiftTemplateManager from '@/components/ShiftTemplateManager'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const CLASS_T = {
  id: 't-class', name: 'Morning', start_time: '06:00', end_time: '07:00', color: '#10B981', active: true,
  max_coaches: 10, min_coaches: 2, days_of_week: ['mon'], role_label: null, display_order: 0, kind: 'class',
}
const ADMIN_T = {
  id: 't-admin', name: 'Stock take', start_time: '14:00', end_time: '15:00', color: '#3B82F6', active: true,
  max_coaches: 2, min_coaches: 0, days_of_week: ['fri'], role_label: null, display_order: 1, kind: 'admin',
}

async function renderManager(templates = [CLASS_T, ADMIN_T]) {
  const writes = []
  global.fetch = vi.fn(async (url, opts) => {
    if (opts?.method === 'PUT' || opts?.method === 'POST') {
      writes.push({ url: String(url), method: opts.method, body: JSON.parse(opts.body) })
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: templates }) }
  })
  await act(async () => { render(<ShiftTemplateManager user={MANAGER} />) })
  return writes
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('template list', () => {
  it('labels an admin template "Admin", and its range reads no minimum', async () => {
    await renderManager()
    expect(screen.getAllByText('Admin')).toHaveLength(1)
    expect(screen.getByText('no minimum, up to 2 coaches')).toBeTruthy()
  })
})

describe('template editor — Kind', () => {
  it('an existing class template opens on Class, its minimum editable', async () => {
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    expect(screen.getByRole('radio', { name: /^Class/ }).checked).toBe(true)
    const min = screen.getByLabelText(/Minimum coaches/)
    expect(min.disabled).toBe(false)
    expect(min.value).toBe('2')
  })

  it('choosing Admin sets the minimum to 0, locks it, and saves kind and minimum together', async () => {
    const writes = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    fireEvent.click(screen.getByRole('radio', { name: /^Admin/ }))
    const min = screen.getByLabelText(/Minimum coaches/)
    expect(min.disabled).toBe(true)
    expect(min.value).toBe('0')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })) })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ url: '/api/schedule/templates/t-class', method: 'PUT', body: { kind: 'admin', min_coaches: 0 } })
  })

  it('switching an admin template back to Class restores a minimum of 1', async () => {
    const writes = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Stock take template' }))
    expect(screen.getByRole('radio', { name: /^Admin/ }).checked).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /^Class/ }))
    expect(screen.getByLabelText(/Minimum coaches/).value).toBe('1')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })) })
    expect(writes[0].body).toMatchObject({ kind: 'class', min_coaches: 1 })
  })

  it('a new template starts as Class', async () => {
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: /New Shift/ }))
    expect(screen.getByRole('radio', { name: /^Class/ }).checked).toBe(true)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/components/ShiftTemplateManager.kind.test.jsx`
Expected: `5 failed`. The list test fails with `Unable to find an element with the text: Admin`, and the editor tests fail with `Unable to find an accessible element with the role "radio"`.

- [ ] **Step 3: Implement**

(a) After `DAY_OPTIONS` (line 31), add:

```js
// SHIFTTYPE.1 (mig 628) — what kind of shift a template makes. The hint is
// the rule in the operator's words, so the choice explains itself.
const KIND_OPTIONS = [
  { value: 'class', label: 'Class', hint: 'Needs coaches. Flagged when below its minimum.' },
  { value: 'admin', label: 'Admin', hint: 'No minimum. Never flagged as a gap, outside the contractor budget; hours still count.' },
]
```

(b) In the list row, immediately before `{oneOff ? (` (line 340), insert:

```jsx
                      {t.kind === 'admin' && (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-medium bg-slate-500/10 text-slate-700"
                          title="Admin shift: no minimum, never flagged as a gap, outside the contractor budget. Hours still count."
                        >
                          Admin
                        </span>
                      )}
```

(c) In the `TemplateFormModal` state, directly after the `minCoaches` state (after line 473), add:

```js
  // SHIFTTYPE.1 — an admin template has no minimum; the API refuses one
  // (admin_has_no_minimum), so the field is locked at 0 while Admin is chosen.
  const [kind, setKind] = useState(template?.kind === 'admin' ? 'admin' : 'class')

  function chooseKind(next) {
    if (next === kind) return
    setKind(next)
    if (next === 'admin') setMinCoaches(0)
    // Leaving admin: the same default a new class template gets (SHIFTMIN.1).
    else if (minCoaches === 0) setMinCoaches(1)
  }
```

(d) In the form, directly after the Name field's closing `</div>` (the block that starts at line 502 with `<label …>Name *</label>`), insert:

```jsx
          <fieldset>
            <legend className="block text-xs text-un1t-subtle mb-1">Kind *</legend>
            <div className="grid grid-cols-2 gap-2">
              {KIND_OPTIONS.map((k) => (
                <label
                  key={k.value}
                  className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer bg-un1t-bg ${
                    kind === k.value ? 'border-un1t-text' : 'border-un1t-border'
                  }`}
                >
                  <input
                    type="radio"
                    name="template-kind"
                    value={k.value}
                    checked={kind === k.value}
                    onChange={() => chooseKind(k.value)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-medium text-un1t-text">{k.label}</span>
                    <span className="block text-[11px] text-un1t-subtle">{k.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
```

(e) Rewrite the minimum field (lines 570-586). Give the label and input an id pair, lock the input for admin, and say why. The block becomes:

```jsx
            <div>
              <label htmlFor="template-min-coaches" className="block text-xs text-un1t-subtle mb-1">Minimum coaches *</label>
              <input
                id="template-min-coaches"
                type="number"
                min={0}
                max={maxCoaches}
                value={minCoaches}
                disabled={kind === 'admin'}
                onChange={e => {
                  const v = Math.max(0, Math.min(maxCoaches, parseInt(e.target.value || '0', 10)))
                  setMinCoaches(v)
                }}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text disabled:opacity-60"
              />
              <p className="text-[11px] text-un1t-subtle mt-1.5">
                {kind === 'admin'
                  ? 'Admin shifts have no minimum.'
                  : 'Blocks with fewer assigned flip the Studio Overview to amber. 0 = no floor.'}
              </p>
            </div>
```

(f) In the save payload (line 653), add `kind,` directly after `min_coaches: minCoaches,`.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/components/ShiftTemplateManager.kind.test.jsx src/components/ShiftTemplateManager.list.test.jsx src/components/ShiftTemplateManager.a11y.test.jsx src/components/schedule-managers.errors.test.jsx && npm run lint && npm run check:guardrails`
Expected: `0 failed`, and both commands exit 0. `check:guardrails`' `no-untyped-button-in-form` has nothing to say, because the form is a `<div>` and the new controls are radios, not buttons.

- [ ] **Step 5: Commit**

```bash
git add src/components/ShiftTemplateManager.jsx src/components/ShiftTemplateManager.kind.test.jsx
git commit -m "SHIFTTYPE.1 — template editor gets a Kind control; admin locks the minimum at 0; list says Admin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Phone Manage mode: an admin block reads "Admin", never "No coach" or "1 of 2"

**Files (all OTA bundle paths):**
- Modify: `mobile/lib/schedule-manage.js` (line 6; `blockFillState` 20-47)
- Modify: `mobile/components/schedule/BlockCard.jsx` (lines 9-12)
- Test: `mobile/lib/schedule-manage.test.js`

There is no RN component test runner (memory `phone-mail-reader`). So the decision goes in `mobile/lib/`, and the card only maps a state to colours.

- [ ] **Step 1: Write the failing test**

Append to `mobile/lib/schedule-manage.test.js`. Its `block(assignedCount, min, max, over)` and `TODAY` are at the top of the file.

```js
// SHIFTTYPE.1 — an admin shift has no minimum: never 'empty', never 'short'.
describe('blockFillState — admin shifts (SHIFTTYPE.1)', () => {
  const admin = (n, max = 3) => block(n, 0, max, { shift_templates: { name: 'Stock take', kind: 'admin' } })

  it('reads "Admin" whether or not anyone is on it', () => {
    expect(blockFillState(admin(0), TODAY)).toEqual({ state: 'admin', count: 0, min: 0, max: 3, label: 'Admin' })
    expect(blockFillState(admin(2), TODAY)).toMatchObject({ state: 'admin', count: 2, label: 'Admin' })
  })

  it('even when the block still carries a minimum', () => {
    expect(blockFillState(block(1, 2, 3, { shift_templates: { kind: 'admin' } }), TODAY).state).toBe('admin')
  })

  it('over capacity is still over', () => {
    expect(blockFillState(admin(4, 3), TODAY)).toMatchObject({ state: 'over', label: '4/3' })
  })

  it('a class block is unchanged', () => {
    expect(blockFillState(block(0, 1, 3, { shift_templates: { kind: 'class' } }), TODAY)).toMatchObject({ state: 'empty', label: 'No coach' })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run mobile/lib/schedule-manage.test.js`
Expected: `2 failed`. The first reads `expected { state: 'ok', count: +0, min: +0, max: 3, label: '0/3' } to deeply equal { state: 'admin', … }`. That happens because, after Task 3, `futureBlockStaffing` is null for admin and the state falls through to `'ok'`. The `over` test and the class test already pass; they are pins.

- [ ] **Step 3: Implement**

(a) In `mobile/lib/schedule-manage.js`, under line 6 add:

```js
import { isAdminShift } from 'shared/shift-kind'
```

(b) In the `blockFillState` comment, add under the `'over'` line (26):

```js
//   'admin'           — SHIFTTYPE.1: an admin shift has no minimum staffing, so
//                       it is never 'empty' or 'short'. Capacity still applies:
//                       over max is 'over'.
```

Update the `@returns` state union to `'empty'|'short'|'over'|'admin'|'ok'`. Then insert these as the first lines of the function body, before `const count = …`:

```js
  if (isAdminShift(block)) {
    const count = liveBlockAssignments(block).length
    const max = block?.max_coaches ?? null
    if (max != null && count > max) return { state: 'over', count, min: 0, max, label: `${count}/${max}` }
    return { state: 'admin', count, min: 0, max, label: 'Admin' }
  }
```

(c) In `mobile/components/schedule/BlockCard.jsx`, lines 9-12 become:

```js
// MOBILESCHED.2 — empty and short are different chips, as on the web calendar:
// red "No coach", amber "1 of 2". Over capacity stays red. SHIFTTYPE.1 — an
// admin shift is slate "Admin", the web card's admin tone: never red or amber.
const CHIP_BG = { empty: 'bg-red-500/10', short: 'bg-amber-500/10', over: 'bg-red-500/10', admin: 'bg-slate-500/10', ok: 'bg-un1t-border' }
const CHIP_TX = { empty: 'text-red-700', short: 'text-amber-700', over: 'text-red-700', admin: 'text-slate-700', ok: 'text-un1t-subtle' }
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run mobile/lib/schedule-manage.test.js && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:ota-paths`
Expected: `0 failed`, and each check exits 0.
- `check:mobile-imports` resolves `isAdminShift` from `shared/shift-kind`.
- `check:ota-paths` is clean because no new top-level `mobile/` entry was added.

**This commit WILL publish an OTA on merge.**

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/schedule-manage.js mobile/lib/schedule-manage.test.js mobile/components/schedule/BlockCard.jsx
git commit -m "SHIFTTYPE.1 — phone Manage mode: an admin block reads 'Admin', never 'No coach' or '1 of 2'

OTA path (mobile/lib, mobile/components).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: TPLCLONE.1's copy carries `kind` (PR 12; if PR 12 is on `main`, do this straight after Task 1)

PR 12's plan (`12-TPLCLONE.1.md`) copies templates through `TEMPLATE_CLONE_COLUMNS` in `src/lib/shift-template-clone.js`. It reads the source template with `select('*')` and copies each listed column only when it is not `undefined` (`if (t[col] !== undefined) row[col] = t[col]`). It also ships `tests/shift-template-clone.guards.test.js`. That test fails as soon as `shift_templates` has a column on neither `TEMPLATE_CLONE_COLUMNS` nor `TEMPLATE_CLONE_MANAGED_COLUMNS`, and it reads the same migration replay as `check:select-columns`.

So once PR 12 is merged, Task 1's migration turns that guard red. The red is this task's first failing test. Without this task, an admin template copied to Hatch Street would silently land as class: its min 0 still satisfies both CHECKs, so nothing would object.

- [ ] **Step 1: Is PR 12 on main?**

Run: `git fetch origin main && git log origin/main --oneline --grep 'TPLCLONE.1' && test -f src/lib/shift-template-clone.js && echo present`

- **Nothing printed / no `present`:** skip this task. Add this line to the PR body: "TPLCLONE.1 has not merged. When it rebases onto this, its guard test forces `kind` onto `TEMPLATE_CLONE_COLUMNS`; its `src()` fixture and the 'copies the allow-listed columns verbatim' expectation must gain `kind: 'class'` (13-SHIFTTYPE.1 Task 13)." Also tell the orchestrator.
- **`present`:** continue.

- [ ] **Step 2: Watch the guard fail**

Run: `npx vitest run tests/shift-template-clone.guards.test.js`
Expected: `each column is copied or managed, never both, never neither` fails with `expected [ 'kind' ] to deeply equal []`.

- [ ] **Step 3: A behaviour test that fails too**

In `src/lib/shift-template-clone.test.js`:

(a) Add `kind: 'class',` to the `src()` fixture's default row, directly after `max_coaches: 4,`. After mig 628, prod's `select('*')` always returns `kind`, so the fixture now matches prod.

(b) In `it('copies the allow-listed columns verbatim, and no id, studio or timestamp', …)`, add `kind: 'class',` to the expected `row`, after `max_coaches: 4,`.

(c) Append inside `describe('planTemplateClone', …)`:

```js
  // SHIFTTYPE.1 — an admin template stays admin at the new studio.
  it('copies the kind, so an admin template is still admin (with its 0 minimum)', () => {
    const { toCreate } = planTemplateClone({ sourceTemplates: [src({ kind: 'admin', min_coaches: 0 })], targetTemplates: [] })
    expect(toCreate[0].row).toMatchObject({ kind: 'admin', min_coaches: 0 })
  })
```

Run: `npx vitest run src/lib/shift-template-clone.test.js`
Expected: `2 failed`:
- the verbatim test (`kind` is missing from the copied row);
- the new admin test.

`every copied column is on the allow-list…` still passes, because `kind` is neither listed nor copied yet.

- [ ] **Step 4: Add `kind` to the allow-list**

In `src/lib/shift-template-clone.js`, inside `TEMPLATE_CLONE_COLUMNS`, directly after `'max_coaches',`, add:

```js
  // SHIFTTYPE.1 (mig 628) — an admin template stays admin at the new studio.
  // Safe with the admin CHECK: an admin source already carries min_coaches 0.
  'kind',
```

Run: `npx vitest run src/lib/shift-template-clone.test.js tests/shift-template-clone.guards.test.js src/app/api/schedule/templates/clone/route.test.js`
Expected: `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shift-template-clone.js src/lib/shift-template-clone.test.js
git commit -m "SHIFTTYPE.1 — copying a template to another studio keeps its kind

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: OpenAPI and the roster doc

**Files:**
- Modify: `src/lib/openapi.js` (the `POST /api/schedule/blocks` registration, lines 4350-4376)
- Modify: `docs/roster-v2.md` (append a section)

No route is new, and the template routes are not registered in `openapi.js` (`grep -n "schedule/templates" src/lib/openapi.js` finds nothing). The only contract that changes is the manual-slot route's.

- [ ] **Step 1:** In that registration, append this to the `description` string: ` For an admin template (SHIFTTYPE.1, mig 628) the slot's minimum is always 0; an explicit non-zero min_coaches is refused with 400 \`admin_has_no_minimum\`.` Then change the `400` response description to `'Validation error, unknown template, or a minimum on an admin template (admin_has_no_minimum)'`.

- [ ] **Step 2:** Append to `docs/roster-v2.md`:

```markdown
## Shift kinds (SHIFTTYPE.1, mig 628, 2026-09)

`shift_templates.kind` is `class` (default) or `admin`; a block reads its kind
through its template (not snapshotted). Richard's rule (25 Sep 2026): an admin
shift has **no minimum staffing** (`min_coaches = 0`, DB CHECK
`shift_templates_admin_no_minimum`), so it is never an empty or short gap:
`futureBlockStaffing` returns null for it, which removes it from the calendar
banner, day headers, cards, the Today chip, the publish preview, the runway and
the phone's Manage chip; the Studio Overview's `underMinEntry` skips it. It is
**out of the contractor budget** (`blockContractorCost`, `summarizeMonth`,
`summarizeWeek`) and **in every hours figure** (payroll, week-cost, reports).
An unreadable kind is `class`. The API refuses an explicit minimum on an admin
template or slot (400 `admin_has_no_minimum`) and normalises an omitted one.
```

- [ ] **Step 3:** Run `npx vitest run src/lib/openapi.test.js && npm run lint`. Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/openapi.js docs/roster-v2.md
git commit -m "SHIFTTYPE.1 — document the admin-slot minimum rule and shift kinds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### PR gate

Close the dev server and any other worktree's watchers first (8GB machine).

- [ ] **The 12-command CI mirror (CLAUDE.md "Build, test & ship"):**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every command exits 0, and vitest reports `0 failed`.
- `check:select-columns` proves every new `kind` in a `src/` select resolves against mig 628. `shared/` and `mobile/` are outside its scan, and `shared/` names no column.
- `check:ota-paths` is clean (no new top-level `mobile/` entry).
- `check:mobile-parity` is untouched (no permission key).

- [ ] **The build:**

```bash
npm run build
```

Expected: `✓ Compiled successfully` and the route table. This is the only check that catches a bad `@shared/shift-kind` or `@/lib/shift-template-kind` import (CLAUDE.md: vitest runs on mocked imports).

- [ ] **Independent review** (standing rule). Point the reviewer at:
  - D1–D8 and the readers table.
  - `git diff origin/main -- 'src/**/*.js' | grep -n "shift_templates"`, to confirm every staffing-reader select gained `kind`.
  - The `ShiftCard` admin surface in a browser, at 390px and at the week grid's 980px floor (memory `jsdom-cannot-see-layout`). Use a Vercel preview **after** 628 is applied.

---

### Migration apply steps (after review is approved, BEFORE merge)

The operator is the orchestrating session, acting under Richard's 25 Sep merge authority.

1. `list_projects` → confirm `iyvtbjjxdggiadzwwvdj` is **un1t-crm**, not the sentinel project. `list_migrations` → confirm there is no 628.
2. Run pre-checks **(a)–(d)** from the migration header with `execute_sql`. Stop if any answer differs from "Expected".
3. Write the rollback record to the scratchpad (for example `<scratchpad>/mig-628-rollback.md`): the outputs of (c) and (d), plus the ROLLBACK block from the header, noting "revert code first".
4. `apply_migration` with name `628_shift_template_kind` and the file's contents verbatim.
5. Run post-checks **(f)–(i)**. Then `get_advisors` type `security`, then type `performance`. Expected: nothing new.
6. Only now: rebase the branch, wait for **Test & lint** and **Next build** to go green on the final rebase, and merge.
7. After merge, watch the EAS Update run for the OTA (`eas-update.yml`). One phone update at a time: do not merge the next OTA PR until this run is green (standing rule). Then check `/schedule` on prod for the week of 28 Sep. No admin templates exist yet, so it must look exactly as before.

### PR

**Title:** `SHIFTTYPE.1 — shift templates are class or admin: an admin shift is never a staffing gap and stays out of the contractor budget (mig 628)`

**Body must say, in this order:**
1. **Migration 628 is applied BEFORE merge** (steps above). The code names `shift_templates.kind` in selects, so without the column they 400. The Vercel preview is broken until 628 is applied.
2. **🔴 This merge publishes an OTA at 100%.** `shared/shift-kind.js`, `shared/roster-staffing.js`, `shared/roster-runway.js`, `mobile/lib/schedule-manage.js` and `mobile/components/schedule/BlockCard.jsx` are bundle paths. The phone change is `blockFillState` → `'admin'` plus one chip colour. Older phones read every block as class, which is today's behaviour.
3. The rule, quoting Richard's decision: admin = no minimum and never a gap (every surface listed), out of the contractor budget gate and spend, still in hours.
4. D1 (template-only column, and why there is no snapshot), D3 (DB CHECK because the browser holds UPDATE; refuse explicit, normalise omitted), and D6 (unreadable = class).
5. No backfill. Every template is class until an operator marks one admin in Settings → Shifts, so **nothing changes on screen until someone does.**
6. TPLCLONE.1 status (Task 13).
7. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### CHANGELOG

After `gh pr create`, add ONE row directly under the table header in `docs/CHANGELOG.md`, then commit and push. Never edit another row: `merge=union` duplicates an edited row.

```
| #<PR> | SHIFTTYPE.1 — shift templates are class or admin: an admin shift is never a staffing gap and stays out of the contractor budget | 2026-09-2x. **Mig 628 (applied before merge) + OTA.** `shift_templates.kind` text NOT NULL DEFAULT 'class', CHECK class|admin, CHECK `kind <> 'admin' OR min_coaches = 0` (the browser still holds UPDATE via mig 600, so the API is not the only door); column on templates only, a block reads it through `template_id` (no snapshot: staffing ignores the past, hours count both). `futureBlockStaffing` returns null for an admin block, so the calendar, Today chip, publish preview, runway and phone Manage chip drop it with no change of their own; Studio Overview's rule moved to `underMinEntry` (skips admin); runway skips a studio with only admin templates. Contractor € skip admin at `blockContractorCost` (every publish path), `summarizeMonth`, `summarizeWeek`; hours (payroll, week-cost, reports, FTE implicit cost) count it, pinned. Template API: explicit admin + min > 0 → 400 `admin_has_no_minimum`, omitted → 0 (back to class → 1); same on a manual slot. Cards: `cardTone` → 'admin' (slate) + an "Admin" tag; phone chip "Admin". Template editor Kind control. Unreadable kind = class. No backfill: nothing changes until an operator marks a template admin. |
```

---

### Review notes / open questions

1. **Past blocks follow a kind flip (D1).** Flipping a template between class and admin also reclassifies its past blocks. Staffing is unaffected (it never reads the past), hours are unaffected, and a published roster's stored `projected_contractor_eur` does not change. The current month's contractor-spend panel DOES move, because it re-prices the whole month. If Richard wants history frozen, a later migration can snapshot `kind` onto `shift_blocks`, but that requires the block-writer audit described in D1.
2. **Contractor spend now under-reports real contractor cost by the admin hours.** This is by decision, since admin is outside the budget gate. Contractors are still paid on invoice for admin work. LABOUR.1 (#35) should count admin hours in labour cost, and must not reuse `summarizeMonth` to do it.
3. **Studio Overview supply (D8)** still counts admin-rostered people toward event cover. If Richard wants event demand compared against class-rostered people only, that is a one-line filter in the `staffByDate` loop of `overview/route.js`. Not done here.
4. **BLOCKEDIT.1 (#14, depends on this PR)** edits one block's minimum. It must refuse `min_coaches > 0` on a block whose template is admin, using `adminMinimumRefusal(tpl.kind, body.min_coaches)` from `src/lib/shift-template-kind.js`, and it must read the template's kind to do so.
5. **TPLCLONE.1 (#12):** see Task 13. Its guard test makes the `kind` addition impossible to forget, whichever PR merges first. The only extra work is its fixture and the verbatim expectation.
6. **GRID.1 (#21)** needs "placed admin hours" per coach. `blocksToShiftRows` rows now carry `kind`; GRID.1 should use that and not re-derive it.
7. **WORKTIME.1 (#15)** counts admin hours. Nothing in this PR filters hours, so it needs no change.
8. **Dead staffing readers are left untouched:**
   - `shared/dashboard-data.js:277` `fetchUnstaffedBlocksThisWeek` is zero-only and has no caller outside its own test. `src/lib/roster-staffing.js:50-52` says it was kept only to avoid an OTA.
   - `src/lib/roster.js:427` `isBlockUnstaffedFuture` is called only from tests.
   - Both would call an admin block unstaffed if revived. Deleting both is a small follow-up, and it is an OTA because one of them lives in `shared/`.
9. **The coach's phone schedule list** (`mobile/app/(staff)/(tabs)/schedule.jsx`, fed by `/api/schedule/shifts`, whose `shift_templates (*)` already returns `kind`) draws no admin tone. It also shows no staffing, so nothing is wrong there, but a coach sees a difference between web and phone. Follow-up if wanted.
10. **Month view** shows an empty admin block as the quiet line "9:00 No coach". It is not flagged as a gap, but "No coach" reads oddly for admin work. It is a one-line change in `monthCellLines` if Richard minds.
11. **Which of Stillorgan's 18 templates are admin** is an operator decision after deploy; this PR marks none. Worth asking Richard for the list, so that the first week's runway and staffing chips reflect it.
12. **The `roster_coverage` report** counts admin assignments as shifts. It has no minimum concept, so nothing needs to change, but a reader of the report may later want admin split out.
