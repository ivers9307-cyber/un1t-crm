# Per-location pipelines + Hatch waitlist board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pipelines a per-location concept so each location runs its own boards, then ship UN1T Hatch Street a manual waitlist board as the first board built on it.

**Architecture:** A board becomes a `pipelines` row owned by a location, carrying `mode = 'derived' | 'manual'`. Derived boards are classified by pure modules in `shared/pipelines/`; manual boards are fenced off from the classifier entirely and moved by hand. `pipeline_stages` and `deals` gain a `pipeline_id`, and one open deal is allowed per contact **per board**.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres, service-role routes), vitest, Tailwind. Migrations applied via Supabase MCP against project `iyvtbjjxdggiadzwwvdj`.

**Spec:** `docs/superpowers/specs/2026-09-08-per-location-pipelines-design.md`

---

## Ship structure

Two PRs. Each is independently mergeable and leaves the product working.

| PR | Tasks | End state |
| --- | --- | --- |
| **PR 1 — engine** | 1–7 | Zero visible change anywhere. Stillorgan and Hatch both still run one derived `acquisition` board. Gate: a dry-run reclassify at Stillorgan reports `deals_moved: 0`. |
| **PR 2 — Hatch waitlist board** | 8–13 | Hatch runs its manual 5-column waitlist board; its 99 contacts land in New Enquiry; strays archived; constraints tightened. |

## Repo rules that bind this work

Read these before Task 1; they are the ones this plan can trip.

- **Migrations are forward-only**, applied via Supabase MCP `apply_migration` against `iyvtbjjxdggiadzwwvdj` (**not** the sentinel project `tpttqakxmyxrwnqjepfm`). Run `get_advisors` (type=security) after any DDL. Apply the migration *before* the code depending on it deploys.
- **Service-role routes get NO RLS.** Every `/api` route uses `createServerClient()`, which bypasses RLS. The `getCurrentUser` → `hasPermission` → `assertLocationAccessOr404` chain *is* the access control.
- **Supabase builders are thenables, not Promises.** `await db.from(…).catch(…)` throws. Use `try { await … } catch {}`.
- **1,000-row select cap.** Every `.select()` returns ≤1000 rows regardless of `.limit()`. Paginate with `.range()` + explicit `.order()`. `src/lib/pipeline-reclassify.js` is the reference implementation.
- **Destructure `error` on every write.** `check:guardrails` enforces it per-path.
- **Mobile cannot import `src/lib`.** `shared/` is the seam, imported as `shared/<file>` (never a relative `../shared`). Not everything is re-exported; `npm run check:mobile-imports` guards it.
- **`on conflict do nothing` on a seed insert hides schema disagreements** (mig 559's lesson). Conflict-target the column you expect to collide, and count rows afterwards.
- **Do not edit a pushed row in `docs/CHANGELOG.md`** — the file is `merge=union` and editing duplicates it. Append only.

**Local CI mirror** — run before pushing either PR:

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

`next build` is **not** in that mirror and tests run on mocked imports, so a missing export sails through. Run `npm run build` locally before pushing any task that adds an import or a route.

---

## File structure

**Created**

| Path | Responsibility |
| --- | --- |
| `shared/pipelines/index.js` | Board registry: `getBoardModule(moduleName)`, `PIPELINE_MODES`. The only place a module name maps to code. |
| `shared/pipelines/acquisition.js` | The Glofox acquisition board: `stages`, `requiredFields`, `classify()`. Wraps the existing pure classifier. |
| `shared/pipelines/index.test.js` | Registry contract: every registered module exports the three required members. |
| `src/app/api/deals/[id]/stage/route.js` | Session-authed manual stage move. Refuses derived pipelines. |
| `src/app/api/deals/[id]/stage/route.test.js` | Auth, location scoping, derived-pipeline refusal. |
| `supabase/migrations/594_pipelines_table.sql` | `pipelines` table, nullable `pipeline_id` columns, seed + backfill. |
| `supabase/migrations/595_stage_slug_primary_pipeline.sql` | Re-point the mig-155 trigger at the primary pipeline. |
| `supabase/migrations/596_hatch_waitlist_board.sql` | Hatch waitlist pipeline + its 5 stages; demote Hatch acquisition. |
| `supabase/migrations/597_pipelines_tighten.sql` | Hatch deal migration, archive strays, `not null`, unique index, drop `board`. |

**Modified**

| Path | Change |
| --- | --- |
| `shared/pipeline-classifier.js` | `splitStagesByFunnel` stops reading `board`; keeps partitioning on `is_dormant` within one board's stages. |
| `src/lib/pipeline-reclassify.js` | Iterate enabled **derived** pipelines; union `requiredFields`; scope deals per pipeline. |
| `src/lib/glofox-sync.js` | `getOpenDealWithStage` + `ensureDealForContact` take a `pipelineId`. |
| `src/lib/location-seed.js` | Seed a `pipelines` row, then its stages under it. |
| `src/app/(sales)/pipeline/page.js` | Tabs are pipelines; sub-view stays Funnel/Off-funnel within a derived board. |
| `src/components/PipelineViewSwitcher.jsx` | Render tabs from pipeline rows rather than a hardcoded `TABS` array. |
| `src/components/KanbanBoard.jsx` | Drag-drop, enabled only for `mode='manual'`. |
| `src/app/api/public/leads/route.js` | Resolve the location's primary pipeline; re-signup bump on manual boards. |
| `src/app/api/public/class-booking/route.js` | Same `maybeSingle` fix, scoped per pipeline. |
| `src/components/contact/PersonActionBar.jsx` | Hide the Cold action on manual boards. |
| `mobile/lib/pipeline-api.js` | `listPipelines(locationId)`; stage reads scoped by pipeline. |

---

# PR 1 — Engine

## Task 1: `pipelines` table and backfill

**Files:**
- Create: `supabase/migrations/594_pipelines_table.sql`

- [ ] **Step 1: Write the migration**

```sql
-- PIPELINES.1 — a board becomes a row owned by a location.
--
-- The pipeline had ONE hardcoded taxonomy and ONE hardcoded signal source.
-- pipeline_stages.board (mig 558) was a first step: it added a second board at
-- one location, but boards still had no owner, no mode and no identity, and
-- stage rows were seeded across every location by CROSS JOIN (migs 147/150/350)
-- — which is why CCF Autos, a car dealership, holds a "Trial Done" column.
--
-- `key` is identity, `module` is the code binding. The pair lets two locations
-- run a board under the same tab name with different rules.
--
-- `mode` is load-bearing, not a convenience flag. FUNNEL.1 removed drag-drop
-- from the board because the nightly classifier overwrites manual moves. A
-- manual board the classifier can SEE is a manual board whose every staff
-- action is reverted overnight. mode='manual' is the fence that makes manual
-- boards possible at all.
--
-- Nullable pipeline_id here on purpose: mig 597 sets NOT NULL after the code
-- that populates it has shipped. Same add-then-tighten shape as mig 458.

create table if not exists public.pipelines (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations(id) on delete cascade,
  key           text not null,
  name          text not null,
  module        text,
  mode          text not null default 'derived' check (mode in ('derived','manual')),
  is_primary    boolean not null default false,
  display_order int not null default 0,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint pipelines_location_key_unique unique (location_id, key),
  -- a derived board must name its module; a manual board must not have one
  constraint pipelines_module_matches_mode check (
    (mode = 'derived' and module is not null) or
    (mode = 'manual'  and module is null)
  )
);

comment on table public.pipelines is
  'PIPELINES.1 — one row per board per location. mode=manual boards are NEVER '
  'read or written by the classifier (see pipeline-reclassify.js); their deals '
  'move only by hand. Exactly one is_primary row per location owns '
  'contacts.pipeline_stage_slug.';

-- Exactly one primary board per location. Partial, so a location with no
-- primary (a disabled-only location) is allowed.
create unique index if not exists pipelines_one_primary_per_location
  on public.pipelines (location_id) where is_primary;

alter table public.pipeline_stages add column if not exists pipeline_id uuid references public.pipelines(id);
alter table public.deals           add column if not exists pipeline_id uuid references public.pipelines(id);

-- Seed one pipeline per (location, board) that actually HAS stage rows, so the
-- backfill below can never orphan a stage. Locations with no stages (Pride
-- Training Club) get no row.
--
-- enabled: only the two live UN1T locations. CCF Autos / SourceIt / Test Studio
-- keep a DISABLED row purely so their 33 stray stage rows have a parent when
-- mig 597 sets pipeline_id NOT NULL — nothing renders a disabled pipeline.
insert into public.pipelines (location_id, key, name, module, mode, is_primary, display_order, enabled)
select
  ps.location_id,
  ps.board                                              as key,
  case ps.board when 'returning' then 'Returning' else 'Acquisition' end as name,
  case ps.board when 'returning' then 'returning' else 'acquisition' end as module,
  'derived'                                             as mode,
  (ps.board = 'acquisition')                            as is_primary,
  case ps.board when 'returning' then 1 else 0 end      as display_order,
  (l.id in (
    'a0000000-0000-0000-0000-000000000001',   -- UN1T Stillorgan
    '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'    -- UN1T Hatch Street
  ))                                                    as enabled
from (select distinct location_id, board from public.pipeline_stages) ps
join public.locations l on l.id = ps.location_id
on conflict (location_id, key) do nothing;

update public.pipeline_stages ps
   set pipeline_id = p.id
  from public.pipelines p
 where p.location_id = ps.location_id
   and p.key = ps.board
   and ps.pipeline_id is null;

update public.deals d
   set pipeline_id = ps.pipeline_id
  from public.pipeline_stages ps
 where ps.id = d.stage_id
   and d.pipeline_id is null;

-- Count, don't trust. Mig 559's lesson: a seed insert that silently drops a row
-- reports success and ships a board with a missing column.
do $$
declare
  orphan_stages int;
  orphan_deals  int;
  primaries     int;
begin
  select count(*) into orphan_stages from public.pipeline_stages where pipeline_id is null;
  select count(*) into orphan_deals  from public.deals d
    where d.pipeline_id is null and d.stage_id is not null;
  select count(*) into primaries from public.pipelines where is_primary;

  if orphan_stages > 0 then
    raise exception 'PIPELINES.1: % pipeline_stages rows have no pipeline_id', orphan_stages;
  end if;
  if orphan_deals > 0 then
    raise exception 'PIPELINES.1: % deals rows have no pipeline_id', orphan_deals;
  end if;
  if primaries < 1 then
    raise exception 'PIPELINES.1: no primary pipeline was seeded';
  end if;
end $$;
```

- [ ] **Step 2: Apply it via Supabase MCP**

Use `mcp__…__apply_migration` with `project_id: 'iyvtbjjxdggiadzwwvdj'` and `name: '594_pipelines_table'`.
Expected: success. If any `raise exception` fires, the migration rolled back — fix the cause, do not weaken the check.

- [ ] **Step 3: Verify the backfill against live data**

Run via `execute_sql`:

```sql
select l.name, p.key, p.mode, p.is_primary, p.enabled,
       (select count(*) from pipeline_stages s where s.pipeline_id = p.id) as stages,
       (select count(*) from deals d where d.pipeline_id = p.id and d.status='open') as open_deals
from pipelines p join locations l on l.id = p.location_id
order by l.name, p.display_order;
```

Expected: UN1T Stillorgan `acquisition` enabled with 11 live + 15 archived stages and **8,601 open deals**; UN1T Stillorgan `returning` enabled with 5 stages and **0 open deals**; UN1T Hatch Street `acquisition` enabled with 11 stages and **101 open deals**; CCF Autos / SourceIt / Test Studio `acquisition` **disabled**.

- [ ] **Step 4: Run the security advisors**

Use `get_advisors` with `type: 'security'`.
Expected: no NEW findings versus the pre-migration baseline. `pipelines` is service-role-only; if the advisor flags missing RLS on it, add an RLS-enabled + no-policy state to match the sibling config tables rather than opening it to `authenticated`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/594_pipelines_table.sql
git commit -m "PIPELINES.1 — pipelines table, per-location boards, backfill

A board becomes a row owned by a location, carrying mode=derived|manual.
mode is the fence that makes manual boards possible: FUNNEL.1 removed
drag-drop because the classifier overwrites manual moves, so a manual
board the classifier can see is one whose staff actions are reverted
overnight.

pipeline_id is nullable here and tightened in mig 597, the same
add-then-tighten shape as mig 458. Locations with stray gym stages keep
a DISABLED pipeline so those rows have a parent without being rendered.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Board registry and the acquisition module

**Files:**
- Create: `shared/pipelines/acquisition.js`
- Create: `shared/pipelines/index.js`
- Create: `shared/pipelines/index.test.js`

- [ ] **Step 1: Write the failing registry test**

```js
// shared/pipelines/index.test.js
// PIPELINES.2 — the registry contract. A board module that forgets
// requiredFields is the PIPELINE-FLAP defect class in a new costume: the
// orchestrator would select fewer columns than classify() reads, compute on
// nulls, and drag every webhook-placed deal back overnight.

import { describe, it, expect } from 'vitest'
import { getBoardModule, BOARD_MODULES } from './index.js'

describe('board registry', () => {
  it('exposes the acquisition module by name', () => {
    expect(getBoardModule('acquisition')).toBeTruthy()
  })

  it('returns null for an unknown module rather than throwing', () => {
    expect(getBoardModule('nope')).toBeNull()
  })

  it('every registered module satisfies the contract', () => {
    for (const [name, mod] of Object.entries(BOARD_MODULES)) {
      expect(Array.isArray(mod.stages), `${name}.stages`).toBe(true)
      expect(mod.stages.length, `${name}.stages non-empty`).toBeGreaterThan(0)
      expect(Array.isArray(mod.requiredFields), `${name}.requiredFields`).toBe(true)
      expect(mod.requiredFields.length, `${name}.requiredFields non-empty`).toBeGreaterThan(0)
      expect(typeof mod.classify, `${name}.classify`).toBe('function')
      for (const stage of mod.stages) {
        expect(typeof stage.slug, `${name} stage slug`).toBe('string')
        expect(typeof stage.name, `${name} stage name`).toBe('string')
      }
    }
  })

  it('acquisition declares every field its classifier reads', () => {
    const { requiredFields } = getBoardModule('acquisition')
    for (const f of [
      'glofox_membership_status', 'recent_bookings', 'converted_at',
      'pack_customer_at', 'pipeline_dismissed_at', 'gympass_member_id',
      'last_lead_source_at', 'trial_credits_remaining', 'joined_at',
      'last_attended_at',
    ]) {
      expect(requiredFields, `missing ${f}`).toContain(f)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run shared/pipelines/index.test.js`
Expected: FAIL — `Failed to resolve import "./index.js"`.

- [ ] **Step 3: Write the acquisition module**

```js
// shared/pipelines/acquisition.js
// PIPELINES.2 — the Glofox acquisition board, as a board module.
//
// This is a WRAPPER, not a rewrite. classify() delegates to the existing
// classifyContact() so PR 1 can be proven to change nobody's stage (the
// deals_moved: 0 gate in Task 7). Its rules, thresholds and war-story
// comments stay in shared/pipeline-classifier.js.
//
// requiredFields is the one genuinely new thing. It replaces the
// hand-maintained SELECT_COLS list in pipeline-reclassify.js, which carried
// five separate comments warning that omitting a field makes the nightly cron
// classify on nulls and flap webhook-placed deals. The orchestrator now unions
// what each board DECLARES rather than what a human remembered to add.

import { classifyContact } from '../pipeline-classifier.js'

// Mirrors the live prod rows (migs 350/356/391/430). Order 301+ sorts after
// the archived PIPELINE5 200-block.
export const stages = Object.freeze([
  { slug: 'new_lead',     name: 'New Leads',  display_order: 301, color: '#3B82F6', is_dormant: false },
  { slug: 'first_class',  name: '1st Class',  display_order: 302, color: '#10B981', is_dormant: false },
  { slug: 'second_class', name: '2nd Class',  display_order: 303, color: '#14B8A6', is_dormant: false },
  { slug: 'trial_done',   name: 'Trial Done', display_order: 304, color: '#F59E0B', is_dormant: false },
  { slug: 'converted',    name: 'Converted',  display_order: 305, color: '#059669', is_dormant: false },
  { slug: 'member',       name: 'Member',     display_order: 306, color: '#64748B', is_dormant: true },
  { slug: 'pack_member',  name: 'Class Pack', display_order: 307, color: '#0891B2', is_dormant: true },
  { slug: 'classpass',    name: 'ClassPass',  display_order: 308, color: '#A855F7', is_dormant: true },
  { slug: 'dormant',      name: 'Dormant',    display_order: 309, color: '#6B7280', is_dormant: true },
  { slug: 'cold_lead',    name: 'Cold',       display_order: 310, color: '#52525B', is_dormant: true },
  { slug: 'gympass',      name: 'Gympass',    display_order: 311, color: '#F97316', is_dormant: true },
])

// Every contacts column classifyContact() reads. Keep in lockstep with it —
// shared/pipelines/index.test.js pins the ones that flap if dropped.
export const requiredFields = Object.freeze([
  'id',
  'name',
  'email',
  'glofox_membership_status',
  'glofox_membership_state',
  'glofox_membership_expiry',
  'last_attended_at',
  'total_attended_7d',
  'total_attended_30d',
  'last_payment_at',
  'joined_at',
  'created_at',
  'trial_credits_remaining',
  'recent_bookings',
  'converted_at',
  'pack_customer_at',
  'pipeline_dismissed_at',
  'gympass_member_id',
  'last_lead_source_at',
])

// The acquisition board never abstains: classifyContact() always returns a
// slug and 'dormant' is its fallthrough. Kept explicit so the contract is
// visible — a board that CAN abstain returns null and the orchestrator closes
// the deal.
export function classify(contact, now = Date.now()) {
  return classifyContact(contact, now)
}
```

Note: `findStageIdBySlug` is exported from `glofox-sync.js` but every caller is inside that same file (lines 499, 505, 529 — verified 2026-09-08), so Task 5's signature change breaks nothing outside it.

- [ ] **Step 4: Write the registry**

```js
// shared/pipelines/index.js
// PIPELINES.2 — board registry. The ONE place a pipelines.module string maps
// to code, so an unknown or retired module name is a caught, reported miss
// rather than a crashed cron.
//
// In shared/ because mobile cannot import src/lib and the mobile pipeline
// screen needs the taxonomy — the same reason pipeline-classifier.js is here.
// Import as 'shared/pipelines' from mobile, never a relative '../shared'.

import * as acquisition from './acquisition.js'

export const BOARD_MODULES = Object.freeze({ acquisition })

export const PIPELINE_MODES = Object.freeze({ DERIVED: 'derived', MANUAL: 'manual' })

/**
 * Resolve a pipelines.module value to its board module.
 * @param {string|null} name
 * @returns {{stages: object[], requiredFields: string[], classify: Function}|null}
 */
export function getBoardModule(name) {
  if (!name || typeof name !== 'string') return null
  return Object.prototype.hasOwnProperty.call(BOARD_MODULES, name)
    ? BOARD_MODULES[name]
    : null
}
```

Note: the `returning` module is deliberately **not** registered. Mig 594 seeds a `returning` pipeline row at Stillorgan because stage rows exist for it, but the board holds 0 deals and cannot fill (only 6.8% of contacts have `last_attended_at` at all). Task 3 must therefore treat an unresolvable module as "skip and report", not as a crash.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run shared/pipelines/index.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Confirm mobile can import it**

Run: `npm run check:mobile-imports`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add shared/pipelines/
git commit -m "PIPELINES.2 — board registry + acquisition module

A wrapper, not a rewrite: classify() delegates to the existing
classifyContact() so PR 1 can be proven to move nobody.

requiredFields is the new part. It replaces the hand-maintained
SELECT_COLS list whose five warning comments all say the same thing —
omit a field and the nightly cron classifies on nulls and flaps every
webhook-placed deal. Boards now declare what they read.

The returning module is deliberately unregistered: 0 deals, and it
cannot fill (6.8% of contacts have last_attended_at at all).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Orchestrator iterates pipelines and skips manual boards

**Files:**
- Modify: `src/lib/pipeline-reclassify.js`
- Modify: `src/lib/pipeline-reclassify.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/pipeline-reclassify.test.js`:

```js
describe('PIPELINES.3 — per-pipeline orchestration', () => {
  // THE test of this whole change. A manual board the classifier can see is a
  // board whose every staff move is reverted overnight — the exact failure
  // FUNNEL.1 removed drag-drop to prevent.
  it('never reads or writes a manual pipeline', async () => {
    const db = makeDb({
      pipelines: [
        { id: 'p-manual', location_id: 'loc-1', key: 'waitlist', module: null, mode: 'manual', enabled: true, is_primary: true },
      ],
      stages: [{ id: 's-1', slug: 'waitlist_new_enquiry', pipeline_id: 'p-manual' }],
      contacts: [{ id: 'c-1', name: 'Ada', glofox_membership_status: null }],
      deals: [{ id: 'd-1', contact_id: 'c-1', stage_id: 's-1', pipeline_id: 'p-manual', status: 'open' }],
    })

    const res = await reclassifyAllContacts(db, { locationId: 'loc-1', dryRun: true })

    expect(res.ok).toBe(true)
    expect(res.deals_moved).toBe(0)
    expect(res.pipelines_skipped).toContain('waitlist')
    expect(db.writes.filter((w) => w.table === 'deals')).toHaveLength(0)
  })

  it('skips a derived pipeline whose module is not registered, and reports it', async () => {
    const db = makeDb({
      pipelines: [
        { id: 'p-ret', location_id: 'loc-1', key: 'returning', module: 'returning', mode: 'derived', enabled: true, is_primary: false },
      ],
      stages: [{ id: 's-r', slug: 'returning_booked', pipeline_id: 'p-ret' }],
      contacts: [{ id: 'c-1', name: 'Ada' }],
      deals: [],
    })

    const res = await reclassifyAllContacts(db, { locationId: 'loc-1', dryRun: true })

    expect(res.ok).toBe(true)
    expect(res.pipelines_skipped).toContain('returning')
  })

  it('skips a disabled pipeline', async () => {
    const db = makeDb({
      pipelines: [
        { id: 'p-off', location_id: 'loc-1', key: 'acquisition', module: 'acquisition', mode: 'derived', enabled: false, is_primary: true },
      ],
      stages: [{ id: 's-1', slug: 'new_lead', pipeline_id: 'p-off' }],
      contacts: [{ id: 'c-1', name: 'Ada' }],
      deals: [],
    })

    const res = await reclassifyAllContacts(db, { locationId: 'loc-1', dryRun: true })

    expect(res.contacts_seen).toBe(0)
    expect(res.deals_created).toBe(0)
  })
})
```

Extend the existing `makeDb` fake so `db.from('pipelines')` returns the `pipelines` fixture array and every `.select()` on `pipeline_stages` / `deals` honours a `.eq('pipeline_id', …)` filter. Follow the chainable-proxy pattern already in that file; record every write into `db.writes` as `{ table, payload }`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/pipeline-reclassify.test.js -t "PIPELINES.3"`
Expected: FAIL — `res.pipelines_skipped` is `undefined`.

- [ ] **Step 3: Load pipelines and fence manual boards**

In `src/lib/pipeline-reclassify.js`, replace the `SELECT_COLS` constant with a per-run union, and add a pipeline load before the stage load. Replace the top-of-file import block and the `SELECT_COLS` definition with:

```js
import { getBoardModule, PIPELINE_MODES } from '../../shared/pipelines/index.js'
import { logWarn } from './log.js'

// PIPELINES.3 — the columns a run selects are the UNION of what its enabled
// derived boards DECLARE, not a hand-maintained list. The list this replaced
// carried five comments all warning of the same defect: omit a field, the cron
// classifies on nulls, and every webhook-placed deal is dragged back overnight.
function selectColsFor(modules) {
  const cols = new Set(['id', 'name', 'email'])
  for (const mod of modules) for (const f of mod.requiredFields) cols.add(f)
  return [...cols].join(', ')
}
```

Then immediately after the audit-row block (before the stage load), insert:

```js
  // 1b. Which boards run at this location.
  //
  // mode='manual' boards are NEVER read or written here. That fence is the
  // whole reason a manual board can exist: FUNNEL.1 removed drag-drop because
  // this pass overwrites manual moves, so a manual board the classifier can
  // see is one whose every staff action is reverted overnight.
  //
  // A derived board whose module is not registered is SKIPPED and REPORTED,
  // never fatal — mig 594 seeds a 'returning' pipeline whose module is
  // deliberately unregistered (0 deals, and it cannot fill).
  const { data: pipelineRows, error: pipelinesErr } = await db
    .from('pipelines')
    .select('id, key, module, mode, enabled, is_primary')
    .eq('location_id', locationId)
    .eq('enabled', true)
  if (pipelinesErr) {
    await markRun(db, runId, { status: 'failed', error_message: `pipeline load: ${pipelinesErr.message}` }, startedAt)
    return { ok: false, error: `pipeline load: ${pipelinesErr.message}`, run_id: runId }
  }

  const pipelinesSkipped = []
  const activePipelines = []
  for (const p of pipelineRows || []) {
    if (p.mode === PIPELINE_MODES.MANUAL) { pipelinesSkipped.push(p.key); continue }
    const mod = getBoardModule(p.module)
    if (!mod) {
      pipelinesSkipped.push(p.key)
      logWarn('pipeline-reclassify', 'no board module registered', { key: p.key, module: p.module, locationId })
      continue
    }
    activePipelines.push({ ...p, mod })
  }

  if (activePipelines.length === 0) {
    await markRun(db, runId, {
      status: 'success',
      contacts_seen: 0, deals_moved: 0, deals_unchanged: 0, deals_created: 0, errors: 0,
      movement_matrix: {}, samples: [],
    }, startedAt)
    return {
      ok: true, run_id: runId, contacts_seen: 0, deals_moved: 0, deals_unchanged: 0,
      deals_created: 0, errors: 0, movement_matrix: {}, samples: [],
      pipelines_skipped: pipelinesSkipped,
    }
  }

  const selectCols = selectColsFor(activePipelines.map((p) => p.mod))
```

Change the contacts page query from `.select(SELECT_COLS)` to `.select(selectCols)`.

Scope the stage and deal loads to the active pipelines by adding, to each, `.in('pipeline_id', activePipelines.map((p) => p.id))`. Keep the existing `.range()` pagination exactly as it is — the 1,000-row cap still applies.

Add `pipelines_skipped: pipelinesSkipped` to every success return.

- [ ] **Step 4: Run the whole reclassify suite**

Run: `npx vitest run src/lib/pipeline-reclassify.test.js`
Expected: PASS — the three new tests plus all pre-existing ones. Pre-existing tests must not be edited to accommodate the change; if one fails, the change altered single-board behaviour and that is a bug.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline-reclassify.js src/lib/pipeline-reclassify.test.js
git commit -m "PIPELINES.3 — orchestrator runs per pipeline, fences manual boards

The cron now loads the location's enabled pipelines and skips manual
ones entirely: never reads their deals, never writes them. That fence is
what makes a hand-moved board possible, and it has its own test.

Selected columns are the union of what each board declares, retiring the
SELECT_COLS list whose five comments all warned of the same flap.

An unregistered module is skipped and reported, not fatal — mig 594
seeds a returning pipeline whose module is deliberately absent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `pipeline_stage_slug` follows the primary pipeline

**Files:**
- Create: `supabase/migrations/595_stage_slug_primary_pipeline.sql`

> **Also fold into this migration (added 2026-09-08 during execution).** Mig 594 seeded Stillorgan's `returning` pipeline as `enabled = true` with `module = 'returning'`, but Task 2b parked that board and left its module deliberately unregistered. Left as-is it renders an empty tab in Task 6 and is reported as skipped on every cron run. Disable the row so the data matches the decision:
>
> ```sql
> -- PIPELINES.2b parked this board: 0 deals, and it cannot fill (6.8% of
> -- contacts have last_attended_at at all). Its module is deliberately
> -- unregistered, so leaving the row enabled would render an empty tab and
> -- log a skip every night. The stages stay for revival.
> update public.pipelines
>    set enabled = false
>  where key = 'returning';
> ```
>
> The `pipelines_module_matches_mode` check still holds — it is `derived` with a non-null module, just switched off.

- [ ] **Step 1: Write the migration**

```sql
-- PIPELINES.4 — contacts.pipeline_stage_slug follows the PRIMARY board.
--
-- Mig 155's trigger picked `order by d.created_at desc limit 1` — the newest
-- open deal on ANY board. That was unambiguous while a contact could only have
-- one. With a second board it becomes "whichever board most recently created a
-- deal", silently redefining the column that the audience builder and campaign
-- filters read, and that sequence auto-exit re-checks continuously.
--
-- Live exposure today is low and was checked, not assumed: the two active
-- sequences filter on glofox_membership_status or have no audience filter, and
-- the only pipeline_stage_change sequence is still draft. The column is
-- exposed in the audience builder regardless, and auto-exit is a CONTINUING
-- condition — a wrong value there unenrols people quietly.
--
-- Fix: pin it to the location's is_primary pipeline. Falls back to the old
-- behaviour when a contact's location has no primary, so a location that has
-- not been given one behaves exactly as before rather than nulling the column.

create or replace function public.sync_contacts_pipeline_stage_slug()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_id uuid;
  v_slug text;
begin
  v_contact_id := coalesce(new.contact_id, old.contact_id);
  if v_contact_id is null then
    return coalesce(new, old);
  end if;

  select ps.slug
    into v_slug
    from deals d
    join pipeline_stages ps on d.stage_id = ps.id
    join pipelines p        on p.id = ps.pipeline_id
   where d.contact_id = v_contact_id
     and d.status = 'open'
     and p.is_primary
   order by d.created_at desc
   limit 1;

  -- No primary board at this contact's location: keep mig 155's behaviour
  -- rather than blanking a column live audiences read.
  if v_slug is null then
    select ps.slug
      into v_slug
      from deals d
      join pipeline_stages ps on d.stage_id = ps.id
     where d.contact_id = v_contact_id
       and d.status = 'open'
     order by d.created_at desc
     limit 1;
  end if;

  update contacts
     set pipeline_stage_slug = v_slug
   where id = v_contact_id;

  return coalesce(new, old);
end;
$$;
```

- [ ] **Step 2: Apply it via Supabase MCP**

`apply_migration`, `project_id: 'iyvtbjjxdggiadzwwvdj'`, `name: '595_stage_slug_primary_pipeline'`.
Expected: success.

- [ ] **Step 3: Verify no contact's slug changed**

```sql
select count(*) as mismatched
from contacts c
join deals d on d.contact_id = c.id and d.status = 'open'
join pipeline_stages ps on ps.id = d.stage_id
join pipelines p on p.id = ps.pipeline_id and p.is_primary
where c.pipeline_stage_slug is distinct from ps.slug;
```

Expected: **0**. Every contact has exactly one open deal today, on a primary pipeline, so re-pointing the trigger must be a no-op. A non-zero result means the backfill in Task 1 put a deal on the wrong pipeline.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/595_stage_slug_primary_pipeline.sql
git commit -m "PIPELINES.4 — pipeline_stage_slug follows the primary board

Mig 155's trigger took the newest open deal on any board. Unambiguous
with one board; with two it silently redefines the column the audience
builder reads and sequence auto-exit re-checks continuously.

Falls back to the old behaviour when a location has no primary, so this
can never blank a column live audiences depend on.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Remove the two `maybeSingle` open-deal assumptions

**Files:**
- Modify: `src/app/api/public/leads/route.js:118`
- Modify: `src/app/api/public/class-booking/route.js:148`
- Modify: `src/lib/glofox-sync.js:417`
- Modify: `src/app/api/deals/route.js:87`
- Modify: `src/lib/pipeline-reclassify.js:389`

> **Scope correction (2026-09-08, found during Task 3).** There are **five** deal-insert sites, not three. This task originally named three; the two below were missed and are just as load-bearing:
>
> | Site | Why it matters |
> |---|---|
> | `src/app/api/deals/route.js:87` | The n8n integration's deal-create endpoint. |
> | `src/lib/pipeline-reclassify.js:389` | **The cron's own create path.** The worst of the five: Task 3 scopes the cron's deal READ with `.in('pipeline_id', …)`, and SQL `IN` never matches `NULL`. A deal inserted with a null `pipeline_id` is therefore invisible to the next run, which creates *another* open deal for that contact — whose insert is also null, so it duplicates again every night, unbounded, for every new lead. |
>
> Every one of the five must set `pipeline_id` in the same commit. A partial fix is worse than none, because it hides the remaining sites behind a mostly-working cron.
>
> Production currently holds **0** null-`pipeline_id` deals (checked 2026-09-08 after mig 594), but the deployed `main` does not yet set the column, so rows will accumulate between mig 594 and this code deploying. Task 13's migration re-runs the backfill to sweep them — see its Step 1.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/public/leads/multi-deal.test.js`:

```js
// PIPELINES.5 — a contact with two open deals must not 500 the public
// waitlist form. `.maybeSingle()` errors on a second row, and this route is
// the live website lead capture.

import { describe, it, expect } from 'vitest'
import { findOpenDealForPipeline } from '@/lib/deal-lookup'

const fakeDb = (rows) => ({
  from: () => {
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => Promise.resolve({ data: rows, error: null }),
    }
    return q
  },
})

describe('findOpenDealForPipeline', () => {
  it('returns the deal on the requested pipeline', async () => {
    const db = fakeDb([{ id: 'd-2', stage_id: 's-2', pipeline_id: 'p-2' }])
    expect(await findOpenDealForPipeline(db, 'c-1', 'p-2')).toEqual({
      id: 'd-2', stage_id: 's-2', pipeline_id: 'p-2',
    })
  })

  it('returns null when the contact has no deal on that pipeline', async () => {
    expect(await findOpenDealForPipeline(fakeDb([]), 'c-1', 'p-9')).toBeNull()
  })

  it('does not throw when the contact has several open deals', async () => {
    const db = fakeDb([{ id: 'd-1', pipeline_id: 'p-1' }])
    await expect(findOpenDealForPipeline(db, 'c-1', 'p-1')).resolves.toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/public/leads/multi-deal.test.js`
Expected: FAIL — `Failed to resolve import "@/lib/deal-lookup"`.

- [ ] **Step 3: Write the shared lookup**

Create `src/lib/deal-lookup.js`:

```js
// PIPELINES.5 — the one way to find a contact's open deal on a given board.
//
// Three call sites assumed a contact had at most ONE open deal:
//   public/leads/route.js:118        .maybeSingle() — ERRORS on a second row
//   public/class-booking/route.js:148 .maybeSingle() — same
//   glofox-sync.js:417                .limit(1), no order — an ARBITRARY row
//
// The first two are live public forms. None are load-bearing while every
// location runs one board, but the FIRST second board turns them into a 500
// on the website lead capture, so they are fixed before that board exists.

/**
 * @param {object} db          service-role Supabase client
 * @param {string} contactId
 * @param {string} pipelineId
 * @returns {Promise<{id:string, stage_id:string, pipeline_id:string}|null>}
 */
export async function findOpenDealForPipeline(db, contactId, pipelineId) {
  if (!db || !contactId || !pipelineId) return null
  const { data, error } = await db
    .from('deals')
    .select('id, stage_id, pipeline_id')
    .eq('contact_id', contactId)
    .eq('pipeline_id', pipelineId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !Array.isArray(data) || data.length === 0) return null
  return data[0]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/api/public/leads/multi-deal.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Rewire `getOpenDealWithStage`**

In `src/lib/glofox-sync.js`, change the signature to accept a pipeline and use the shared lookup:

```js
export async function getOpenDealWithStage(db, contactId, pipelineId) {
  if (!db || !contactId || !pipelineId) return null
  const { findOpenDealForPipeline } = await import('./deal-lookup.js')
  const deal = await findOpenDealForPipeline(db, contactId, pipelineId)
  if (!deal) return null
  const { data: stages } = await db
    .from('pipeline_stages')
    .select('slug')
    .eq('id', deal.stage_id)
    .limit(1)
  return { id: deal.id, stage_id: deal.stage_id, stage_slug: stages?.[0]?.slug || null }
}
```

In `ensureDealForContact`, resolve the location's primary pipeline once at the top and thread it through — `findStageIdBySlug` also gains a `pipelineId` filter, and the deal INSERT sets `pipeline_id`:

```js
export async function ensureDealForContact(db, locationId, contactId, contactSnapshot, contactName = null) {
  if (!db || !locationId || !contactId) {
    return { action: 'error', error: 'missing arguments' }
  }
  // PIPELINES.5 — placement targets the location's PRIMARY derived board.
  // A manual board is never placed into from here; its deals move by hand.
  const { data: primary } = await db
    .from('pipelines')
    .select('id, mode')
    .eq('location_id', locationId)
    .eq('is_primary', true)
    .eq('enabled', true)
    .limit(1)
  const pipeline = primary?.[0] || null
  if (!pipeline || pipeline.mode !== 'derived') {
    return { action: 'leave', deal_id: null, stage_slug: null }
  }
  const targetSlug = classifyContact(contactSnapshot || {})
  const existing = await getOpenDealWithStage(db, contactId, pipeline.id)
  // …remainder unchanged, except: findStageIdBySlug takes pipeline.id, and the
  // insert payload gains `pipeline_id: pipeline.id`.
}
```

Update `findStageIdBySlug(db, locationId, stageSlug)` to `findStageIdBySlug(db, pipelineId, stageSlug)`, filtering `.eq('pipeline_id', pipelineId)` instead of `.eq('location_id', locationId)`.

- [ ] **Step 6: Rewire both public routes**

In `src/app/api/public/leads/route.js`, replace the deal block at line ~117:

```js
  // Open a deal on the location's PRIMARY board so the lead shows in the
  // pipeline. PIPELINES.5: scoped per pipeline — .maybeSingle() errored the
  // moment a contact held two open deals, and this is the live website form.
  try {
    const { findOpenDealForPipeline } = await import('@/lib/deal-lookup')
    const { data: primary } = await db
      .from('pipelines')
      .select('id, mode')
      .eq('location_id', locationId).eq('is_primary', true).eq('enabled', true)
      .limit(1)
    const pipeline = primary?.[0] || null
    if (pipeline) {
      const openDeal = await findOpenDealForPipeline(db, contactId, pipeline.id)
      if (!openDeal) {
        const { data: stage } = await db
          .from('pipeline_stages')
          .select('id')
          .eq('pipeline_id', pipeline.id)
          .eq('archived', false)
          .order('display_order', { ascending: true })
          .limit(1)
        const entryStage = stage?.[0] || null
        if (entryStage) {
          const { error: insErr } = await db.from('deals').insert({
            title: firstName || 'Website lead',
            contact_id: contactId,
            stage_id: entryStage.id,
            pipeline_id: pipeline.id,
            location_id: locationId,
            status: 'open',
          })
          if (insErr) logWarn('leads', 'deal create failed', { err: insErr.message })
        }
      }
    }
  } catch (e) { logWarn('leads', 'deal create failed', { err: e }) }
```

Apply the identical change at `src/app/api/public/class-booking/route.js:148`, keeping that route's own `title` expression.

Note: the entry column is now "lowest `display_order`, non-archived, on the primary pipeline". On Stillorgan's acquisition board that resolves to `new_lead` (order 301), so behaviour is unchanged — verify in Step 7.

- [ ] **Step 7: Verify the entry column still resolves to `new_lead` at Stillorgan**

```sql
select ps.slug, ps.display_order
from pipelines p
join pipeline_stages ps on ps.pipeline_id = p.id and ps.archived = false
where p.location_id = 'a0000000-0000-0000-0000-000000000001' and p.is_primary
order by ps.display_order limit 1;
```

Expected: `new_lead`, 301.

- [ ] **Step 8: Run the full suite and lint**

Run: `npm test && npm run lint && npm run check:guardrails`
Expected: PASS. `check:guardrails` matters here — Step 6 destructures `error` on the insert, which the bare-write rule requires.

- [ ] **Step 9: Commit**

```bash
git add src/lib/deal-lookup.js src/app/api/public/leads/ src/app/api/public/class-booking/route.js src/lib/glofox-sync.js
git commit -m "PIPELINES.5 — retire the one-open-deal-per-contact assumption

Three sites assumed it. Two are live public forms using .maybeSingle(),
which ERRORS on a second row: the website lead capture and /start class
booking. The third took an arbitrary row via .limit(1) with no ordering
and drove the webhook placement path.

None are load-bearing while every location runs one board — which is
exactly why they get fixed now, before the first second board turns them
into a 500 on the public form.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Board tabs come from pipelines

**Files:**
- Modify: `shared/pipeline-classifier.js` (`splitStagesByFunnel`)
- Modify: `src/app/(sales)/pipeline/page.js`
- Modify: `src/components/PipelineViewSwitcher.jsx`
- Modify: `shared/pipeline-classifier.test.js`

- [ ] **Step 1: Write the failing test**

Append to `shared/pipeline-classifier.test.js`:

```js
describe('PIPELINES.6 — splitStagesByFunnel without the board column', () => {
  it('partitions one board\'s stages on is_dormant only', () => {
    const stages = [
      { id: 'a', slug: 'new_lead',  is_dormant: false, display_order: 301, archived: false },
      { id: 'b', slug: 'member',    is_dormant: true,  display_order: 306, archived: false },
      { id: 'c', slug: 'converted', is_dormant: false, display_order: 305, archived: false },
    ]
    const { funnel, offFunnel } = splitStagesByFunnel(stages)
    expect(funnel.map((s) => s.slug)).toEqual(['new_lead', 'converted'])
    expect(offFunnel.map((s) => s.slug)).toEqual(['member'])
  })

  it('drops archived stages', () => {
    const stages = [
      { id: 'a', slug: 'new_lead', is_dormant: false, display_order: 301, archived: false },
      { id: 'z', slug: 'lapsed',   is_dormant: false, display_order: 206, archived: true },
    ]
    expect(splitStagesByFunnel(stages).funnel.map((s) => s.slug)).toEqual(['new_lead'])
  })
})
```

- [ ] **Step 2: Run to verify the second assertion fails**

Run: `npx vitest run shared/pipeline-classifier.test.js -t "PIPELINES.6"`
Expected: FAIL — the current implementation returns a third `returning` key and reads `s.board`.

- [ ] **Step 3: Simplify `splitStagesByFunnel`**

In `shared/pipeline-classifier.js`, replace the function body's board handling. It now receives the stages of **one** pipeline, so the third axis is gone:

```js
/**
 * Split ONE pipeline's stage rows into its Funnel vs Off-funnel views.
 *
 * PIPELINES.6 — the `board` axis moved to the pipelines table (mig 594), so
 * callers hand us one board's stages and this partitions them on is_dormant,
 * which again means exactly what it meant before mig 558: "parked, not moving
 * through this board".
 */
export function splitStagesByFunnel(stages) {
  const live = (Array.isArray(stages) ? stages : []).filter((s) => s && s.archived !== true)
  const slugOrder = (s) => {
    const list = s.is_dormant ? OFF_FUNNEL_STAGE_SLUGS : FUNNEL_STAGE_SLUGS
    const i = list.indexOf(s.slug)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  const byOrder = (a, b) => {
    const ao = Number.isFinite(a.display_order) ? a.display_order : null
    const bo = Number.isFinite(b.display_order) ? b.display_order : null
    if (ao !== null && bo !== null && ao !== bo) return ao - bo
    if (ao !== null && bo === null) return -1
    if (ao === null && bo !== null) return 1
    return slugOrder(a) - slugOrder(b)
  }
  return {
    funnel: live.filter((s) => !s.is_dormant).sort(byOrder),
    offFunnel: live.filter((s) => Boolean(s.is_dormant)).sort(byOrder),
  }
}
```

Delete `RETURNING_STAGE_SLUGS` usage from the ordering path but **keep the export** — `shared/pipeline-classifier.js` still defines the returning taxonomy for the unregistered module.

- [ ] **Step 4: Load pipelines in the page**

In `src/app/(sales)/pipeline/page.js`, replace the stage load with a pipeline load first:

```js
  // PIPELINES.6 — tabs are the location's enabled boards. Within a derived
  // board, ?view= still switches Funnel vs Off-funnel; a manual board has one
  // view and every column is visible.
  const { data: pipelineRows } = await db
    .from('pipelines')
    .select('id, key, name, mode, display_order')
    .eq('location_id', locationId)
    .eq('enabled', true)
    .order('display_order')
  const pipelines = pipelineRows || []
  const activePipeline =
    pipelines.find((p) => p.key === sp?.pipeline) || pipelines[0] || null

  if (!activePipeline) {
    return (
      <div className="p-6">
        <h2 className="text-2xl font-bold mb-2">Pipeline</h2>
        <p className="text-sm text-un1t-subtle">No pipeline is configured for this location.</p>
      </div>
    )
  }

  const { data: allStages } = await db
    .from('pipeline_stages')
    .select('*')
    .eq('pipeline_id', activePipeline.id)
    .eq('archived', false)
    .order('display_order')

  const isManual = activePipeline.mode === 'manual'
  const { funnel: activeStages, offFunnel: dormantStages } = splitStagesByFunnel(allStages || [])
  // A manual board shows every column in one view — nothing is "off funnel"
  // when a human decides where each card sits.
  const visibleStages = isManual
    ? (allStages || [])
    : (view === 'dormant' ? dormantStages : activeStages)
```

Pass `pipelines`, `activePipeline` and `isManual` down; give `KanbanBoard` a `manual={isManual}` prop and `PipelineViewSwitcher` the pipeline list.

- [ ] **Step 5: Render tabs from the pipeline rows**

Replace the hardcoded `TABS` const and the component body in `src/components/PipelineViewSwitcher.jsx`:

```jsx
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Layers, Archive } from 'lucide-react'

// PIPELINES.6 — the top row is the location's BOARDS, one tab per pipelines
// row. The Funnel / Off-funnel toggle underneath is a view WITHIN a derived
// board and keeps its ?view=dormant param value: bookmarks depend on it.
export default function PipelineViewSwitcher({
  pipelines = [], activePipelineKey, isManual = false,
  view, activeCount = 0, dormantCount = 0,
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function goPipeline(key) {
    if (key === activePipelineKey) return
    const next = new URLSearchParams(params?.toString() || '')
    next.set('pipeline', key)
    next.delete('view')   // a board's view never carries across boards
    router.push(`${pathname}?${next.toString()}`)
  }

  function goView(target) {
    if (target === view) return
    const next = new URLSearchParams(params?.toString() || '')
    if (target === 'active') next.delete('view')
    else next.set('view', target)
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  const tabCls = (on) => `relative px-4 py-2 text-sm font-medium border-b-2 -mb-px inline-flex items-center gap-1.5 transition-colors ${
    on ? 'border-emerald-500 text-un1t-text' : 'border-transparent text-un1t-subtle hover:text-un1t-text'
  }`

  return (
    <div className="mb-4">
      {/* Boards. Hidden when there is only one — a single-tab tab bar is noise. */}
      {pipelines.length > 1 && (
        <div className="border-b border-un1t-border flex items-center gap-1">
          {pipelines.map((p) => (
            <button key={p.id} type="button" onClick={() => goPipeline(p.key)}
                    className={tabCls(p.key === activePipelineKey)}>
              {p.name}
            </button>
          ))}
        </div>
      )}

      {/* Views within a derived board. A manual board has one view: a human
          decides where each card sits, so nothing is "off funnel". */}
      {!isManual && (
        <div className="border-b border-un1t-border flex items-center gap-1">
          {[
            { id: 'active',  label: 'Funnel',     Icon: Layers,  count: activeCount },
            { id: 'dormant', label: 'Off funnel', Icon: Archive, count: dormantCount },
          ].map(({ id, label, Icon, count }) => {
            const on = view === id
            return (
              <button key={id} type="button" onClick={() => goView(id)} className={tabCls(on)}>
                <Icon size={14} />
                {label}
                <span className={`ml-1 inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 text-[10px] font-semibold rounded-full tabular-nums ${
                  on ? 'bg-emerald-500/20 text-emerald-700 border border-emerald-500/40'
                     : 'bg-un1t-border/30 text-un1t-subtle border border-un1t-border'
                }`}>
                  {count.toLocaleString()}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

Note the `returningCount` prop is gone — the returning board is no longer a tab. Remove it from the page's call site too, and drop the now-unused `RotateCcw` import.

- [ ] **Step 6: Verify Stillorgan renders identically**

Run `npm run dev`, then in the Browser pane open `http://localhost:3000/pipeline` as a Stillorgan user.
Expected: one tab, "Acquisition", with the Funnel / Off-funnel toggle beneath it; column counts New Leads 7 / 1st Class 6 / 2nd Class 3 / Trial Done 5 / Converted 22.

Note: per `docs/superpowers/specs/…`, local dev has no database — verify against a Vercel preview deployment instead if the local server cannot read prod data.

- [ ] **Step 7: Run the suite and a real build**

Run: `npm test && npm run lint && npm run build`
Expected: PASS. The build matters — this task adds imports and changes a page.

- [ ] **Step 8: Commit**

```bash
git add shared/pipeline-classifier.js shared/pipeline-classifier.test.js "src/app/(sales)/pipeline/page.js" src/components/PipelineViewSwitcher.jsx src/components/KanbanBoard.jsx
git commit -m "PIPELINES.6 — board tabs come from the pipelines table

splitStagesByFunnel now receives ONE board's stages, so is_dormant means
what it meant before mig 558 added a third axis: parked within this
board. ?view=dormant is unchanged so existing bookmarks still work.

A manual board renders every column in a single view — nothing is 'off
funnel' when a human decides where each card sits.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6b: New-location seeding and the deal count

Two consumers the spec names that nothing above covers. The first is a latent production break.

**Files:**
- Modify: `src/lib/location-seed.js`
- Modify: `src/lib/location-seed.test.js`
- Modify: `src/lib/person-aggregate.js:116`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/location-seed.test.js`:

```js
describe('PIPELINES.6b — a seeded location gets a pipeline', () => {
  it('creates an acquisition pipeline and hangs every stage off it', async () => {
    const writes = []
    const db = {
      from(table) {
        const q = {
          select: () => q, eq: () => q, limit: () => Promise.resolve({ data: [{ id: 'p-new' }], error: null }),
          insert(payload) { writes.push({ table, payload }); return { select: () => ({ single: () => Promise.resolve({ data: { id: 'p-new' }, error: null }) }) } },
          upsert(payload) { writes.push({ table, payload }); return Promise.resolve({ error: null }) },
          update() { return { eq: () => Promise.resolve({ error: null }) } },
        }
        return q
      },
    }

    await seedLocationDefaults(db, { id: 'loc-new', features: {} })

    const pipelineWrite = writes.find((w) => w.table === 'pipelines')
    expect(pipelineWrite, 'no pipelines row seeded').toBeTruthy()
    expect(pipelineWrite.payload.key).toBe('acquisition')
    expect(pipelineWrite.payload.module).toBe('acquisition')
    expect(pipelineWrite.payload.is_primary).toBe(true)

    const stageWrite = writes.find((w) => w.table === 'pipeline_stages')
    expect(stageWrite).toBeTruthy()
    for (const row of stageWrite.payload) {
      expect(row.pipeline_id, `stage ${row.slug} has no pipeline_id`).toBe('p-new')
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/location-seed.test.js -t "PIPELINES.6b"`
Expected: FAIL — `no pipelines row seeded`.

- [ ] **Step 3: Seed the pipeline before its stages**

In `src/lib/location-seed.js`, insert before the existing `pipeline_stages` upsert:

```js
  // PIPELINES.6b — a location's stages need a board to hang off. mig 597 makes
  // pipeline_stages.pipeline_id NOT NULL, so a location seeded without one
  // would fail its stage insert outright — a break that only appears the next
  // time someone adds a location, which is exactly when nobody is looking.
  const { data: seededPipeline, error: pipeErr } = await db
    .from('pipelines')
    .insert({
      location_id: location.id,
      key: 'acquisition',
      name: 'Acquisition',
      module: 'acquisition',
      mode: 'derived',
      is_primary: true,
      display_order: 0,
      enabled: true,
    })
    .select('id')
    .single()

  let pipelineId = seededPipeline?.id || null
  if (pipeErr) {
    // Already seeded (re-run) — read the existing row rather than failing.
    const { data: existing } = await db
      .from('pipelines').select('id')
      .eq('location_id', location.id).eq('key', 'acquisition').limit(1)
    pipelineId = existing?.[0]?.id || null
  }
  if (!pipelineId) {
    throw new Error('seedLocationDefaults: could not resolve the acquisition pipeline')
  }
```

Then add `pipeline_id: pipelineId` to each row in the stage `rows` map.

- [ ] **Step 4: Fix the per-person deal count**

`src/lib/person-aggregate.js:116` counts every deal row for a person, so once someone sits on two boards the profile reads "2 deals" for one relationship. Change the select to carry the board and count distinct boards:

```js
    db.from('deals').select('id, pipeline_id').in('contact_id', memberIds),
```

and replace the count derivation at line ~226:

```js
  // PIPELINES.6b — one deal per board, so a person on two boards is still ONE
  // pipeline relationship. Count distinct boards, not rows.
  const dealsCount = Array.isArray(dealCountRes?.data)
    ? new Set(dealCountRes.data.map((d) => d.pipeline_id ?? d.id)).size
    : 0
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/location-seed.test.js src/lib/person-aggregate.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/location-seed.js src/lib/location-seed.test.js src/lib/person-aggregate.js
git commit -m "PIPELINES.6b — seed a pipeline per new location; count boards not rows

location-seed.js seeded stages with no board. Harmless until mig 597
makes pipeline_id NOT NULL, at which point adding a location fails its
stage insert — a break that only surfaces the next time someone creates
one, which is exactly when nobody is watching for it.

person-aggregate counted deal ROWS, so a person on two boards would read
'2 deals' for one relationship. Counts distinct boards now.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Prove PR 1 changed nobody

**Files:** none — this is the gate.

- [ ] **Step 1: Run a dry-run reclassify against Stillorgan**

Deploy the branch to a Vercel preview, then as a master user open `/admin/glofox-import → Re-classify` and run **Preview** for UN1T Stillorgan. (That admin route is the sanctioned path; a direct service-role script run is permission-blocked.)

- [ ] **Step 2: Read the result**

Expected: `contacts_seen: ~8,594`, **`deals_moved: 0`**, `deals_created: 0`, `errors: 0`, and `pipelines_skipped: ['returning']`.

**`deals_moved: 0` is the pass/fail gate for the whole PR.** Any non-zero value means the acquisition module or the orchestrator changed a classification, and PR 1's entire claim is that it changes nothing. Do not proceed to PR 2 until it is zero; diff the movement matrix to find which slug pair moved.

- [ ] **Step 3: Confirm the nightly cron agrees**

After the next 03:30 run:

```sql
select created_at, source, contacts_seen, deals_moved, deals_created, errors, status
from pipeline_classification_runs
order by created_at desc limit 3;
```

Expected: the newest row has `deals_moved` at or near 0 and `status = 'success'`.

- [ ] **Step 4: Run the full CI mirror and open the PR**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

Then `npm run build`, push, and open the PR. Append a `docs/CHANGELOG.md` row (append only — never edit a pushed row; the file is `merge=union`).

---

# PR 2 — Hatch waitlist board

## Task 8: The waitlist board's stages

**Files:**
- Create: `supabase/migrations/596_hatch_waitlist_board.sql`

- [ ] **Step 1: Write the migration**

```sql
-- WAITLIST.1 — UN1T Hatch Street's manual waitlist board.
--
-- Hatch runs on un1t.online, not Glofox, so classifyContact() reads fields its
-- contacts do not have and 'dormant' is its fallthrough: 98 of 99 website
-- waitlist leads — 83 of them created in the last 60 days — were filed as
-- ghosts. This board replaces that with the truth.
--
-- MANUAL on purpose (Richard, 2026-09-08). Entry is automatic; every move
-- after that is by hand. It is deliberately NOT a funnel: a Hatch lead who
-- books a class books on un1t.online, invisibly to us, so a derived
-- "Converted" column would be a guess. Someone is Converted when a human says
-- so.
--
-- COLUMN SEMANTICS: "No Answer" means WE CALLED AND GOT NO ANSWER — the
-- recorded outcome of an attempt, not a holding pen for people nobody has
-- tried. So New Enquiry means "not yet worked", and column 1 is the to-do
-- list.
--
-- The waitlist_ prefix is required: Hatch's archived gym stages still hold
-- 'new_lead' and 'converted', and pipeline_stages_location_slug_unique is per
-- LOCATION. Same reason mig 558 used returning_.

do $$
declare
  v_loc uuid := '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';  -- UN1T Hatch Street
  v_pipeline uuid;
  v_stages int;
begin
  -- The old gym board stops being Hatch's primary and stops rendering. Its
  -- deals are moved in mig 597, so it is demoted here, not deleted.
  update public.pipelines
     set is_primary = false, enabled = false
   where location_id = v_loc and key = 'acquisition';

  insert into public.pipelines (location_id, key, name, module, mode, is_primary, display_order, enabled)
  values (v_loc, 'waitlist', 'Waitlist', null, 'manual', true, 0, true)
  on conflict (location_id, key) do update
     set mode = 'manual', module = null, is_primary = true, enabled = true
  returning id into v_pipeline;

  -- Conflict-target the slug explicitly. Mig 559's lesson: a bare
  -- `on conflict do nothing` turns a schema disagreement into a missing
  -- column and a green checkmark.
  insert into public.pipeline_stages
    (location_id, pipeline_id, name, slug, display_order, color, is_dormant, archived)
  values
    (v_loc, v_pipeline, 'New Enquiry',              'waitlist_new_enquiry',   501, '#3B82F6', false, false),
    (v_loc, v_pipeline, 'No Answer',                'waitlist_no_answer',     502, '#F59E0B', false, false),
    (v_loc, v_pipeline, 'Interested in membership', 'waitlist_interested',    503, '#10B981', false, false),
    (v_loc, v_pipeline, 'Not interested',           'waitlist_not_interested', 504, '#52525B', false, false),
    (v_loc, v_pipeline, 'Converted',                'waitlist_converted',     505, '#059669', false, false)
  on conflict (location_id, slug) do nothing;

  select count(*) into v_stages
    from public.pipeline_stages where pipeline_id = v_pipeline;
  if v_stages <> 5 then
    raise exception 'WAITLIST.1: expected 5 waitlist stages, found %', v_stages;
  end if;
end $$;
```

- [ ] **Step 2: Apply and verify**

`apply_migration`, `name: '596_hatch_waitlist_board'`. Then:

```sql
select p.key, p.mode, p.is_primary, p.enabled, ps.display_order, ps.name, ps.slug
from pipelines p left join pipeline_stages ps on ps.pipeline_id = p.id
where p.location_id = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
order by p.display_order, ps.display_order;
```

Expected: `waitlist` manual/primary/enabled with exactly 5 stages in the order above; `acquisition` disabled and not primary.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/596_hatch_waitlist_board.sql
git commit -m "WAITLIST.1 — Hatch Street's manual waitlist board

Hatch runs on un1t.online, so the Glofox classifier filed 98 of its 99
website leads — 83 from the last 60 days — as dormant. This replaces
that with a board a human drives.

Manual on purpose: a Hatch lead who books does so on un1t.online,
invisibly to us, so a derived Converted column would be a guess.

'No Answer' means we called and got no answer, so New Enquiry means
'not yet worked' and column 1 is the to-do list.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Session-authed manual stage move

**Files:**
- Create: `src/app/api/deals/[id]/stage/route.js`
- Create: `src/app/api/deals/[id]/stage/route.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/app/api/deals/[id]/stage/route.test.js
// WAITLIST.2 — the manual move endpoint.
//
// PUT /api/deals/[id] exists but is gated by authenticateApiKey(), which
// requires a Bearer API key — the n8n path. A browser cannot call it, so it
// cannot back a drag-drop board. This is the session-authed sibling, modelled
// on /api/contacts/[id]/pipeline-status.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: vi.fn(() => null),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { hasPermission } = await import('@/lib/permissions')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const req = (body) => new Request('http://x/api/deals/d-1/stage', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const props = { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) }

function dbWith({ deal, stage, pipeline }) {
  const writes = []
  const client = {
    writes,
    from(table) {
      const q = {
        select: () => q, eq: () => q, limit: () => q,
        maybeSingle: () => Promise.resolve({
          data: table === 'deals' ? deal : table === 'pipeline_stages' ? stage : pipeline,
          error: null,
        }),
        update(payload) { writes.push({ table, payload }); return { eq: () => Promise.resolve({ error: null }) } },
      }
      return q
    },
  }
  return client
}

beforeEach(() => {
  getCurrentUser.mockResolvedValue({ id: 'u-1', full_name: 'Staff', email: 's@x.com' })
  hasPermission.mockReturnValue(true)
})

describe('POST /api/deals/[id]/stage', () => {
  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(dbWith({}))
    expect((await POST(req({ stage_id: 'x' }), props)).status).toBe(401)
  })

  it('403s a user without the pipeline permission', async () => {
    hasPermission.mockReturnValue(false)
    createServerClient.mockReturnValue(dbWith({}))
    expect((await POST(req({ stage_id: 'x' }), props)).status).toBe(403)
  })

  // The rule that keeps FUNNEL.1's guarantee true.
  it('refuses to move a deal on a derived pipeline', async () => {
    createServerClient.mockReturnValue(dbWith({
      deal: { id: 'd-1', location_id: 'l-1', contact_id: 'c-1', stage_id: 's-old', pipeline_id: 'p-1' },
      stage: { id: 's-new', pipeline_id: 'p-1', slug: 'converted' },
      pipeline: { id: 'p-1', mode: 'derived' },
    }))
    const res = await POST(req({ stage_id: '22222222-2222-4222-8222-222222222222' }), props)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('pipeline_is_derived')
  })

  it('moves a deal on a manual pipeline', async () => {
    const db = dbWith({
      deal: { id: 'd-1', location_id: 'l-1', contact_id: 'c-1', stage_id: 's-old', pipeline_id: 'p-1' },
      stage: { id: 's-new', pipeline_id: 'p-1', slug: 'waitlist_no_answer' },
      pipeline: { id: 'p-1', mode: 'manual' },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ stage_id: '22222222-2222-4222-8222-222222222222' }), props)
    expect(res.status).toBe(200)
    expect(db.writes).toContainEqual({ table: 'deals', payload: { stage_id: 's-new' } })
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run "src/app/api/deals/[id]/stage/route.test.js"`
Expected: FAIL — `Cannot find module './route.js'`.

- [ ] **Step 3: Write the route**

```js
// POST /api/deals/[id]/stage — manual stage move on a MANUAL board.
//
// WAITLIST.2. PUT /api/deals/[id] already resolves a location-scoped stage and
// fires the STAGETRIG.1 trigger, but authenticateApiKey() requires a Bearer API
// key (src/lib/api-auth.js:208) — it is the n8n integration path and a browser
// cannot call it. This is its session-authed sibling.
//
// Authorization: session + `pipeline` permission (the same gate as the board),
// THEN an explicit in-location check. The service-role client bypasses RLS, so
// this chain IS the access control (repo invariant).
//
// It REFUSES a derived pipeline. Allowing one would create a move the next
// classify pass silently reverts — the exact failure FUNNEL.1 removed
// drag-drop to prevent.
//
// stage_entered_at needs no code here: mig 458's trg_deal_stage_entered
// BEFORE-UPDATE trigger stamps it on any stage_id change, from any writer.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logAuditEvent } from '@/lib/audit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const StageMoveSchema = z.object({ stage_id: uuidLike })

export async function POST(request, props) {
  const params = await props.params
  const { id } = params

  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'pipeline')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, StageMoveSchema)
  if (!validation.ok) return validation.response
  const { stage_id: stageId } = validation.data

  const db = createServerClient()

  const { data: deal } = await db
    .from('deals')
    .select('id, location_id, contact_id, stage_id, pipeline_id')
    .eq('id', id)
    .maybeSingle()
  if (!deal) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const guard = assertLocationAccessOr404(user, deal.location_id)
  if (guard) return guard

  // The target stage must live on the SAME board as the deal. Without this a
  // caller could park a waitlist card in a gym column.
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id, slug, pipeline_id')
    .eq('id', stageId)
    .eq('pipeline_id', deal.pipeline_id)
    .maybeSingle()
  if (!stage) {
    return NextResponse.json({ success: false, error: 'unknown_stage_for_pipeline' }, { status: 400 })
  }

  const { data: pipeline } = await db
    .from('pipelines')
    .select('id, mode, key')
    .eq('id', deal.pipeline_id)
    .maybeSingle()
  if (!pipeline || pipeline.mode !== 'manual') {
    return NextResponse.json({ success: false, error: 'pipeline_is_derived' }, { status: 400 })
  }

  if (stage.id === deal.stage_id) {
    return NextResponse.json({ success: true, data: { moved: false, stage_id: stage.id } })
  }

  const { error: moveErr } = await db.from('deals').update({ stage_id: stage.id }).eq('id', id)
  if (moveErr) {
    return NextResponse.json({ success: false, error: moveErr.message }, { status: 500 })
  }

  // STAGETRIG.1 — a manual move is a real stage change the sequence engine
  // should hear about. Best-effort: the move is already saved.
  try {
    const { data: fromStage } = await db
      .from('pipeline_stages').select('slug').eq('id', deal.stage_id).maybeSingle()
    const { triggerSequencesForDealPlacement } = await import('@/lib/sequences/triggers')
    await triggerSequencesForDealPlacement(deal.contact_id, {
      action: 'move',
      from_slug: fromStage?.slug ?? null,
      to_slug: stage.slug,
    })
  } catch (e) {
    logWarn('deals.stage', `pipeline_stage_change trigger failed for deal ${id}`, { err: e })
  }

  await logAuditEvent({
    category: 'business',
    action: 'pipeline.manual_move',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { label: stage.slug, resource: `deals/${id}` },
    locationId: deal.location_id,
    details: { pipeline: pipeline.key, from_stage_id: deal.stage_id, to_stage_id: stage.id },
    request,
  })

  return NextResponse.json({ success: true, data: { moved: true, stage_id: stage.id } })
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run "src/app/api/deals/[id]/stage/route.test.js"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the route guards**

Run: `npm run check:route-guards && npm run check:location-scoping`
Expected: exit 0 for both. If `check:location-scoping` flags the route, confirm it recognises `assertLocationAccessOr404`; register it in `SCOPING_HELPERS` only after verifying the filter really applies — never reach for `EXEMPT`.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/deals/[id]/stage/"
git commit -m "WAITLIST.2 — session-authed manual stage move

PUT /api/deals/[id] is gated by authenticateApiKey (Bearer API key, the
n8n path), so a browser cannot call it and it cannot back drag-drop.
This is its session-authed sibling, modelled on the Cold button's route.

It REFUSES a derived pipeline: allowing one would create a move the next
classify pass silently reverts, which is the failure FUNNEL.1 removed
drag-drop to prevent. That refusal has its own test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Drag-drop on manual boards

**Files:**
- Modify: `src/components/KanbanBoard.jsx`

- [ ] **Step 1: Add the drag handlers**

Replace the FUNNEL.1 read-only comment above the component with:

```jsx
// FUNNEL.1 — a DERIVED board is read-only: every column is classifier-derived,
// so a manual drag would be overwritten by the next classify pass.
// WAITLIST.2 — a MANUAL board is the opposite: nothing derives its columns and
// the classifier never reads it (pipelines.mode='manual'), so drag-drop is the
// only way a card moves. `manual` gates every handler below.
```

Add to the component signature `manual = false`, and inside it:

```jsx
  const [dragDealId, setDragDealId] = useState(null)
  const [dropStageId, setDropStageId] = useState(null)

  // Optimistic move, reconciled by a refresh. On failure the card returns to
  // its column and the operator sees it did not stick — silently keeping it in
  // the new column would show a move the database never took.
  const moveDeal = useCallback(async (dealId, toStageId) => {
    const from = Object.keys(columnDeals).find((sid) =>
      (columnDeals[sid] || []).some((d) => d.id === dealId))
    if (!from || from === toStageId) return

    const card = (columnDeals[from] || []).find((d) => d.id === dealId)
    setColumnDeals((p) => ({
      ...p,
      [from]: (p[from] || []).filter((d) => d.id !== dealId),
      [toStageId]: [card, ...(p[toStageId] || [])],
    }))

    try {
      const res = await fetch(`/api/deals/${encodeURIComponent(dealId)}/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage_id: toStageId }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'move failed')
      router.refresh()
    } catch {
      setColumnDeals((p) => ({
        ...p,
        [toStageId]: (p[toStageId] || []).filter((d) => d.id !== dealId),
        [from]: [card, ...(p[from] || [])],
      }))
    }
  }, [columnDeals, router])
```

On each column `<div>`, when `manual` is true, add:

```jsx
            onDragOver={(e) => { e.preventDefault(); setDropStageId(stage.id) }}
            onDragLeave={() => setDropStageId((s) => (s === stage.id ? null : s))}
            onDrop={(e) => {
              e.preventDefault()
              const id = dragDealId || e.dataTransfer.getData('text/plain')
              setDropStageId(null); setDragDealId(null)
              if (id) moveDeal(id, stage.id)
            }}
```

and append `${manual && dropStageId === stage.id ? ' ring-2 ring-emerald-500/60' : ''}` to the column's className so the drop target is visible.

Wrap each `<DealCard>` in a draggable host when `manual`:

```jsx
                <div
                  key={deal.id}
                  draggable={manual}
                  onDragStart={(e) => {
                    if (!manual) return
                    setDragDealId(deal.id)
                    e.dataTransfer.setData('text/plain', deal.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => setDragDealId(null)}
                  className={manual ? 'cursor-grab active:cursor-grabbing' : undefined}
                >
                  <DealCard deal={deal} locationId={locationId} stageName={stage.name} onOpenContact={openContact} />
                </div>
```

(The existing `key={deal.id}` moves from `DealCard` to this wrapper.)

- [ ] **Step 2: Add the waitlist column colours**

Extend `stageColors` so the waitlist columns are not all the fallback grey:

```js
  waitlist_new_enquiry:   '#3B82F6',
  waitlist_no_answer:     '#F59E0B',
  waitlist_interested:    '#10B981',
  waitlist_not_interested:'#52525B',
  waitlist_converted:     '#059669',
```

- [ ] **Step 3: Verify in the browser**

`npm run dev`, open the Hatch waitlist board against a Vercel preview (local dev has no database). Drag a card from New Enquiry to No Answer.
Expected: the card moves, the column badge updates after the refresh, and a reload keeps it in No Answer. Then confirm a Stillorgan acquisition card is **not** draggable.

- [ ] **Step 4: Run the suite, lint and build**

Run: `npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/KanbanBoard.jsx
git commit -m "WAITLIST.3 — drag-drop, manual boards only

A derived board stays read-only for FUNNEL.1's reason. A manual board is
the opposite: nothing derives its columns and the classifier never reads
it, so dragging is the only way a card moves.

The optimistic move REVERTS on failure rather than keeping the card in
its new column — showing a move the database never took is worse than
showing it did not stick.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: Waitlist entry and the re-signup bump

**Files:**
- Modify: `src/app/api/public/leads/route.js`
- Create: `src/app/api/public/leads/waitlist-entry.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/app/api/public/leads/waitlist-entry.test.js
// WAITLIST.4 — a re-submission bumps the person back to column 1 on a MANUAL
// board only.
//
// Richard, 2026-09-08. Mirrors RETURNPIPE.3, where re-entering a public funnel
// form already revokes a Cold dismissal: being parked is a judgement about
// someone who went quiet, and filling the form in again is that person
// answering. On a DERIVED board nothing changes — the classifier decides.

import { describe, it, expect } from 'vitest'
import { placeWaitlistEntry } from '@/lib/waitlist-entry'

const db = ({ pipeline, entryStage, openDeal }) => {
  const writes = []
  return {
    writes,
    from(table) {
      const q = {
        select: () => q, eq: () => q, order: () => q,
        limit: () => Promise.resolve({
          data: table === 'pipelines' ? (pipeline ? [pipeline] : [])
              : table === 'pipeline_stages' ? (entryStage ? [entryStage] : [])
              : (openDeal ? [openDeal] : []),
          error: null,
        }),
        insert(payload) { writes.push({ op: 'insert', payload }); return Promise.resolve({ error: null }) },
        update(payload) { writes.push({ op: 'update', payload }); return { eq: () => Promise.resolve({ error: null }) } },
      }
      return q
    },
  }
}

describe('placeWaitlistEntry', () => {
  it('creates a deal in column 1 when the contact has none', async () => {
    const d = db({
      pipeline: { id: 'p-1', mode: 'manual' },
      entryStage: { id: 's-1', slug: 'waitlist_new_enquiry' },
      openDeal: null,
    })
    await placeWaitlistEntry(d, { contactId: 'c-1', locationId: 'l-1', title: 'Ada' })
    expect(d.writes[0].op).toBe('insert')
    expect(d.writes[0].payload.stage_id).toBe('s-1')
    expect(d.writes[0].payload.pipeline_id).toBe('p-1')
  })

  it('bumps an existing deal back to column 1 on a manual board', async () => {
    const d = db({
      pipeline: { id: 'p-1', mode: 'manual' },
      entryStage: { id: 's-1', slug: 'waitlist_new_enquiry' },
      openDeal: { id: 'd-1', stage_id: 's-4', pipeline_id: 'p-1' },
    })
    await placeWaitlistEntry(d, { contactId: 'c-1', locationId: 'l-1', title: 'Ada' })
    expect(d.writes).toEqual([{ op: 'update', payload: { stage_id: 's-1' } }])
  })

  it('leaves an existing deal alone on a derived board', async () => {
    const d = db({
      pipeline: { id: 'p-1', mode: 'derived' },
      entryStage: { id: 's-1', slug: 'new_lead' },
      openDeal: { id: 'd-1', stage_id: 's-9', pipeline_id: 'p-1' },
    })
    await placeWaitlistEntry(d, { contactId: 'c-1', locationId: 'l-1', title: 'Ada' })
    expect(d.writes).toEqual([])
  })

  it('does nothing when the location has no enabled primary pipeline', async () => {
    const d = db({ pipeline: null, entryStage: null, openDeal: null })
    await placeWaitlistEntry(d, { contactId: 'c-1', locationId: 'l-1', title: 'Ada' })
    expect(d.writes).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/public/leads/waitlist-entry.test.js`
Expected: FAIL — `Failed to resolve import "@/lib/waitlist-entry"`.

- [ ] **Step 3: Write the helper**

Create `src/lib/waitlist-entry.js`:

```js
// WAITLIST.4 — place a public form entry on the location's primary board.
//
// The waitlist entry point already existed: POST /api/public/leads is the
// public waitlist capture, live since 2026-06-08, and it already opened a deal
// — pointed at 'new_lead' on the gym funnel. This resolves the board instead.
//
// No location id is hardcoded. The un1t.online studio id changed under us once
// already; the same rule applies to our own rows — resolve, never hardcode.
//
// The re-signup bump is MANUAL-ONLY. On a derived board the classifier owns
// placement and a bump would be reverted; on a manual board a person parked in
// "Not interested" who fills the form in again is answering, and the board
// should say so (mirrors RETURNPIPE.3).

import { logWarn } from './log.js'

export async function placeWaitlistEntry(db, { contactId, locationId, title }) {
  if (!db || !contactId || !locationId) return

  const { data: pipelines, error: pErr } = await db
    .from('pipelines')
    .select('id, mode')
    .eq('location_id', locationId)
    .eq('is_primary', true)
    .eq('enabled', true)
    .limit(1)
  if (pErr) { logWarn('waitlist-entry', 'pipeline load failed', { err: pErr.message }); return }
  const pipeline = pipelines?.[0]
  if (!pipeline) return

  const { data: stages, error: sErr } = await db
    .from('pipeline_stages')
    .select('id, slug')
    .eq('pipeline_id', pipeline.id)
    .eq('archived', false)
    .order('display_order', { ascending: true })
    .limit(1)
  if (sErr) { logWarn('waitlist-entry', 'stage load failed', { err: sErr.message }); return }
  const entryStage = stages?.[0]
  if (!entryStage) return

  const { findOpenDealForPipeline } = await import('./deal-lookup.js')
  const existing = await findOpenDealForPipeline(db, contactId, pipeline.id)

  if (!existing) {
    const { error } = await db.from('deals').insert({
      title: title || 'Website lead',
      contact_id: contactId,
      stage_id: entryStage.id,
      pipeline_id: pipeline.id,
      location_id: locationId,
      status: 'open',
    })
    if (error) logWarn('waitlist-entry', 'deal insert failed', { err: error.message })
    return
  }

  if (pipeline.mode !== 'manual') return
  if (existing.stage_id === entryStage.id) return

  const { error } = await db.from('deals').update({ stage_id: entryStage.id }).eq('id', existing.id)
  if (error) logWarn('waitlist-entry', 'deal bump failed', { err: error.message })
}
```

- [ ] **Step 4: Call it from the route**

In `src/app/api/public/leads/route.js`, replace the whole deal block written in Task 5 Step 6 with:

```js
  try {
    const { placeWaitlistEntry } = await import('@/lib/waitlist-entry')
    await placeWaitlistEntry(db, { contactId, locationId, title: firstName || 'Website lead' })
  } catch (e) { logWarn('leads', 'waitlist placement failed', { err: e }) }
```

Apply the same replacement in `src/app/api/public/class-booking/route.js`, passing that route's own title expression.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/app/api/public/leads/ && npm run check:guardrails`
Expected: PASS; guardrails exit 0 (every write destructures `error`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/waitlist-entry.js src/app/api/public/leads/ src/app/api/public/class-booking/route.js
git commit -m "WAITLIST.4 — waitlist entry resolves the board; re-signup bumps

The entry point already existed — /api/public/leads is the public
waitlist capture and already opened a deal, just pointed at the gym
funnel's new_lead. It now resolves the location's primary board and its
first column, with no location id hardcoded.

Re-submission bumps back to column 1 on MANUAL boards only. On a derived
board the classifier owns placement and a bump would be reverted; on a
manual board someone parked in 'Not interested' who fills the form in
again is answering (mirrors RETURNPIPE.3).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 12: Hide the Cold button on manual boards, and update mobile

**Files:**
- Modify: `src/components/DealCard.jsx:87`
- Modify: `src/components/KanbanBoard.jsx`
- Modify: `mobile/lib/pipeline-api.js`

- [ ] **Step 1: Hide the Cold action on a manual board**

The Cold button writes `contacts.pipeline_dismissed_at`, which only the derived classifier reads. On the waitlist board "Not interested" is column 4, so the button is a second, invisible way to say the same thing — and on a manual board it does nothing visible at all.

`PersonActionBar` already treats `cold` as **opt-in via its `actions` prop** (`src/components/PersonActionBar.jsx:46` — note the path, it is not under `contact/`). So nothing changes inside that component; the fix is at the call site.

In `src/components/DealCard.jsx`, accept a `manual` prop and build the action list from it:

```jsx
export default function DealCard({ deal, locationId, stageName, onOpenContact, manual = false }) {
  // WAITLIST.5 — Cold writes pipeline_dismissed_at, which only the derived
  // classifier reads. On a manual board "Not interested" is a column, so the
  // button would be a second, invisible way to say the same thing.
  const personActions = manual
    ? ['message', 'task', 'sequence']
    : ['message', 'task', 'sequence', 'cold']
```

and pass `actions={personActions}` at line ~87 in place of the literal array.

In `KanbanBoard.jsx`, forward the flag: `<DealCard … manual={manual} />`.

**Deliberately left alone:** `ContactDrawer.jsx:132` and `ContactHeaderBand.jsx:123` also opt into `cold`. Hiding it there needs the contact's board mode, which those components do not have and would each cost a lookup. On a Hatch contact the button still writes a stamp nothing reads — inert, not wrong. Listed as a follow-up rather than pretended to be covered.

- [ ] **Step 2: Add `listPipelines` to the mobile API**

In `mobile/lib/pipeline-api.js`:

```js
// PIPELINES.6 — boards are rows now. The screen lists the location's enabled
// pipelines and scopes its stage read to the chosen one, so mobile can never
// render two boards' columns merged into one list.
export async function listPipelines(locationId) {
  let q = supabase.from('pipelines')
    .select('id, key, name, mode, display_order')
    .eq('enabled', true)
    .order('display_order', { ascending: true })
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  return error ? { success: false, error: error.message } : { success: true, data }
}
```

Change `listStages(locationId)` to `listStages(pipelineId)`, filtering `.eq('pipeline_id', pipelineId)` instead of `.eq('location_id', locationId)`, and update `mobile/app/(staff)/pipeline/[dealId].jsx` plus the pipeline list screen to fetch pipelines first and pass the chosen id through.

Mobile stays **read-only** on manual boards in this PR — no drag-drop on the phone. The web board is the working surface; adding a second write path before the first is proven doubles the surface for a move the classifier could contest.

- [ ] **Step 3: Run the mobile checks**

Run: `npm run check:mobile-imports && npm run check:mobile-lint && npm run check:mobile-parity`
Expected: exit 0 for all three. `check:mobile-parity` will force an explicit decision about the new capability — record "web-only for now" where it asks.

- [ ] **Step 4: Commit**

```bash
git add src/components/contact/PersonActionBar.jsx mobile/
git commit -m "WAITLIST.5 — hide Cold on manual boards; mobile reads pipelines

The Cold button writes pipeline_dismissed_at, which only the derived
classifier reads. On the waitlist board 'Not interested' is column 4, so
the button is a second invisible way to say the same thing and does
nothing visible at all.

Mobile lists pipelines and scopes stages to one, so it can never merge
two boards' columns into one list. It stays read-only on manual boards:
the web board is the working surface, and a second write path before the
first is proven doubles the surface for nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 13: Move Hatch's 99, archive the strays, tighten the constraints

**Files:**
- Create: `supabase/migrations/597_pipelines_tighten.sql`

- [ ] **Step 1: Write the migration**

```sql
-- WAITLIST.6 — move Hatch onto its board, archive the strays, tighten.
--
-- Runs ONLY after the code from PR 1 + PR 2 has deployed and the Task 7 gate
-- passed (deals_moved: 0). Same guarded add-then-tighten shape as mig 350→351.
--
-- Hatch's 101 open deals sit in dormant (98), member (2) and new_lead (1) on a
-- gym funnel that does not apply to them. All go to New Enquiry: "No Answer"
-- means we called and got no answer, so New Enquiry means "not yet worked",
-- and none of them have been.

do $$
declare
  v_loc      uuid := '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';
  v_pipeline uuid;
  v_entry    uuid;
  v_moved    int;
  v_orphans  int;
begin
  select id into v_pipeline from public.pipelines where location_id = v_loc and key = 'waitlist';
  if v_pipeline is null then
    raise exception 'WAITLIST.6: Hatch waitlist pipeline missing — apply mig 596 first';
  end if;

  select id into v_entry from public.pipeline_stages
   where pipeline_id = v_pipeline and slug = 'waitlist_new_enquiry';
  if v_entry is null then
    raise exception 'WAITLIST.6: waitlist_new_enquiry stage missing';
  end if;

  update public.deals
     set stage_id = v_entry, pipeline_id = v_pipeline
   where location_id = v_loc and status = 'open';
  get diagnostics v_moved = row_count;
  raise notice 'WAITLIST.6: moved % Hatch deals to New Enquiry', v_moved;

  -- Hatch's gym stages are done. Archive rather than delete: closed deals
  -- still point at them.
  update public.pipeline_stages
     set archived = true
   where location_id = v_loc and pipeline_id <> v_pipeline;

  -- The 33 stray gym stage rows at the non-gym locations. Their pipelines are
  -- already disabled (mig 594), so nothing renders; archiving makes that
  -- visible in the data too.
  update public.pipeline_stages ps
     set archived = true
    from public.pipelines p
   where p.id = ps.pipeline_id and p.enabled = false;
end $$;

-- Re-run the mig 594 backfill before tightening.
--
-- Between mig 594 (which added the column) and PR 1 deploying (which taught
-- all five insert sites to populate it), the live code created deals with a
-- null pipeline_id. They are invisible to the cron's `.in('pipeline_id', …)`
-- read — SQL IN never matches NULL — so each one would be duplicated nightly
-- until swept. Idempotent: a no-op if nothing accumulated.
update public.deals d
   set pipeline_id = ps.pipeline_id
  from public.pipeline_stages ps
 where ps.id = d.stage_id
   and d.pipeline_id is null;

-- Tighten only once nothing is orphaned.
do $$
declare v_n int;
begin
  select count(*) into v_n from public.pipeline_stages where pipeline_id is null;
  if v_n > 0 then raise exception 'WAITLIST.6: % stages still have no pipeline_id', v_n; end if;
  select count(*) into v_n from public.deals where pipeline_id is null and stage_id is not null;
  if v_n > 0 then raise exception 'WAITLIST.6: % deals still have no pipeline_id', v_n; end if;
end $$;

alter table public.pipeline_stages alter column pipeline_id set not null;

-- One open deal per contact PER BOARD. Partial so closed deals never collide.
create unique index if not exists deals_one_open_per_contact_pipeline
  on public.deals (contact_id, pipeline_id) where status = 'open';

-- `board` is superseded by pipelines.key. No RLS policy on deals or
-- pipeline_stages references it — verified 2026-09-08 against pg_policy.
alter table public.pipeline_stages drop column if exists board;
```

- [ ] **Step 2: Check for duplicate open deals before applying**

The unique index will fail if any contact holds two open deals on one pipeline. Two such contacts exist estate-wide (measured 2026-09-08):

```sql
select contact_id, pipeline_id, count(*)
from deals where status = 'open'
group by contact_id, pipeline_id having count(*) > 1;
```

Expected: 0 rows after Task 1's backfill. If rows come back, close the older deal of each pair (`update deals set status = 'lost' where id = …`) and re-run before applying.

- [ ] **Step 3: Apply and verify**

`apply_migration`, `name: '597_pipelines_tighten'`. Then:

```sql
select ps.name, ps.slug, count(d.id) as open_deals
from pipeline_stages ps
left join deals d on d.stage_id = ps.id and d.status = 'open'
where ps.pipeline_id = (select id from pipelines
                        where location_id = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4' and key = 'waitlist')
group by ps.name, ps.slug, ps.display_order order by ps.display_order;
```

Expected: New Enquiry **101**, the other four columns 0.

- [ ] **Step 4: Run the security advisors**

`get_advisors` with `type: 'security'`.
Expected: no new findings.

- [ ] **Step 5: Confirm the classifier still leaves Hatch alone**

Run a dry-run reclassify for UN1T Hatch Street.
Expected: `contacts_seen: 0`, `deals_moved: 0`, `pipelines_skipped: ['waitlist']`. Hatch has no enabled derived board, so the orchestrator does nothing — and crucially it must **not** move the 101 cards a human is about to start sorting.

- [ ] **Step 6: Run the full CI mirror and open PR 2**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

Then `npm run build`, push, open the PR, and append a `docs/CHANGELOG.md` row (append only).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/597_pipelines_tighten.sql
git commit -m "WAITLIST.6 — Hatch onto its board, strays archived, constraints tightened

101 Hatch deals move from a gym funnel that never applied to them into
New Enquiry — the truthful column, since none have been worked.

pipeline_id goes NOT NULL, one open deal per contact PER BOARD becomes a
constraint rather than a convention, and pipeline_stages.board is
dropped: superseded by pipelines.key, and no RLS policy references it
(verified against pg_policy).

Guarded throughout — every tightening step raises rather than proceeding
on orphaned rows.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Post-merge verification

- [ ] Nightly `pipeline-classify` cron reports `deals_moved` ≈ 0 at Stillorgan and skips `waitlist` at Hatch.
- [ ] A live waitlist submission at Hatch lands in New Enquiry within seconds.
- [ ] A second submission from the same person, after being dragged to "Not interested", bumps them back to New Enquiry.
- [ ] A Stillorgan card is not draggable; a Hatch card is, and survives a reload.
- [ ] `contacts.pipeline_stage_slug` for a moved Hatch contact reads its waitlist slug.

## Known follow-ups (not in scope)

- Hatch's `acquisition` board, blocked on franchise credentials — `2026-09-01-un1t-online-hatch-integration-design.md`.
- Per-column count badges on the Hatch board, if ~99 cards prove hard to read without them.
- Whether `waitlist_not_interested` should become `is_dormant` once it accumulates.
- Hide the Cold action on `ContactDrawer.jsx:132` and `ContactHeaderBand.jsx:123` for manual-board contacts. Inert rather than wrong today: it writes a stamp nothing reads.
- Mobile drag-drop on manual boards, once the web board is proven in use.
- The `returning` module remains unregistered with its stages archived; revisit only if attendance coverage rises above 6.8% of contacts.
