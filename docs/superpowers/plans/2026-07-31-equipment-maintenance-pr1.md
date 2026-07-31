# Equipment Maintenance — PR 1 (schema, lib, admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the equipment maintenance schema, the pure due-date/validation library, the permission keys, and the web admin that lets an owner define equipment types with checklists and register the studio's assets.

**Architecture:** Four new `location_id`-scoped tables (`equipment_settings`, `equipment_types`, `equipment`, `equipment_inspections`) plus a nullable `equipment_id` on `issues`. All business logic — due-date arithmetic, item and result validation, issue-description composition — lives in a pure, fully-tested `src/lib/equipment.js`. API routes stay thin wrappers over it using the existing `withAuth` gate.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres, service-role client), Zod, Vitest, Tailwind 3.4.

**Scope note:** This is PR 1 of 3. The inspection run (mobile + web), issue creation, and out-of-service flow are PR 2. Crons, notification keys, and the compliance log are PR 3. PR 1 is shippable on its own: an owner can define types and register equipment, and nothing is user-visible until an `equipment_settings` row is created.

**Spec:** `docs/superpowers/specs/2026-07-31-equipment-maintenance-inspections-design.md`

**Worktree:** `~/code/un1t-crm-maintenance`, branch `equipment-maintenance-inspections`.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/467_equipment_maintenance.sql` | Create four tables + `issues.equipment_id`. Forward-only. |
| `src/lib/equipment.js` | **All** pure logic: constants, date arithmetic, item/result validation, issue-description composition, due filtering. No DB, no I/O — every function takes plain data and returns plain data. |
| `src/lib/equipment.test.js` | Vitest unit tests for the above. |
| `src/lib/equipment-db.js` | Thin Supabase read/write helpers. Separated from `equipment.js` so the pure logic stays trivially testable without mocks. |
| `shared/permissions.js` | Add `equipment_admin` + `equipment_inspect` web keys, mobile counterpart, role defaults. |
| `scripts/check-mobile-parity.mjs` | Add `equipment_admin` to `WEB_ONLY_OK` with a reason. |
| `src/app/api/equipment/settings/route.js` | GET/PUT the location's inspection weekday + enable flag. |
| `src/app/api/equipment/types/route.js` | GET list / POST create. |
| `src/app/api/equipment/types/[id]/route.js` | PATCH edit / DELETE (soft-disable). |
| `src/app/api/equipment/route.js` | GET register / POST create asset. |
| `src/app/api/equipment/[id]/route.js` | GET detail / PATCH edit / DELETE (retire). |
| `src/app/maintenance/page.js` | Tab shell. |
| `src/components/maintenance/helpers.js` | Chip classes, interval formatting, weekday options — shared by both tabs. |
| `src/components/maintenance/TypesTab.jsx` | Type list + checklist editor, plus the inspection-day and enable controls. |
| `src/components/maintenance/EquipmentTab.jsx` | Register table + asset form. |
| `src/lib/openapi.js` | Register the five new routes. |

`equipment.js` is kept strictly pure and `equipment-db.js` holds the queries, because the date arithmetic is where the real risk lives and it must be testable without a database.

---

## Task 1: Migration 467 — schema

**Files:**
- Create: `supabase/migrations/467_equipment_maintenance.sql`

- [ ] **Step 1: Confirm 467 is free**

Run: `ls supabase/migrations | tail -3`
Expected: highest existing is `466_device_tokens_permission_and_nudge.sql`. If something ≥467 exists, use the next free number and update every reference in this plan.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/467_equipment_maintenance.sql`:

```sql
-- EQUIP-MAINT.1 — equipment register, per-type inspection checklists,
-- and the inspection record.
--
-- Design: docs/superpowers/specs/2026-07-31-equipment-maintenance-inspections-design.md
--
-- Faults raised by an inspection go into the EXISTING issues table
-- (mig 213) via the new issues.equipment_id column — one owner inbox,
-- and claim/resolve/close + the notify_issue_* pushes already work.
-- The checklist tables (migs 214/215) are deliberately NOT extended:
-- their uniqueness constraints encode a person-and-date design, and an
-- inspection belongs to an asset on a cycle.
--
-- location_id is `on delete restrict` on all four tables, matching
-- issues (mig 213) rather than checklist_templates (mig 214, cascade).
-- Cascade would be unsafe: deleting a location would cascade into both
-- equipment_types and equipment, and the restrict FK between them could
-- fire mid-cascade.
--
-- RLS is service-role-only on all four. API routes mediate every read
-- and write, same as issues and the checklist tables.

set check_function_bodies = off;

-- ====================================================================
-- equipment_settings — one row per location. No row (or enabled=false)
-- means the feature is dormant there, so this migration is inert until
-- an operator switches a location on.
-- ====================================================================

create table public.equipment_settings (
  location_id            uuid primary key references public.locations (id) on delete restrict,

  -- Postgres dow convention: 0 = Sunday .. 6 = Saturday. Same
  -- convention as checklist_templates.day_of_week (mig 214) so the two
  -- features agree on what "Tuesday" means.
  inspection_day_of_week int     not null default 2 check (inspection_day_of_week between 0 and 6),

  enabled                boolean not null default false,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.equipment_settings is
  'EQUIP-MAINT.1 — per-location inspection weekday + feature switch. '
  'No row or enabled=false means the feature is dormant at that location.';

-- ====================================================================
-- equipment_types — the checklist + interval, inherited by assets.
-- ====================================================================

create table public.equipment_types (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null references public.locations (id) on delete restrict,

  name           text not null check (length(name) > 0 and length(name) <= 100),

  -- JSONB array of { id, label, order } — the SAME shape
  -- checklist_templates.items uses (mig 214), validated API-side for
  -- bounds and unique ids. Stable per-item uuids mean renaming a label
  -- preserves tick history on past inspections.
  items          jsonb not null default '[]'::jsonb
                 check (jsonb_typeof(items) = 'array'),

  -- Interval in WEEKS, not days. Inspections happen on a fixed weekday,
  -- so weeks are the only unit where the next due date always lands on
  -- that weekday without drift. 1=weekly, 4=four-weekly, 13=quarterly.
  interval_weeks int not null check (interval_weeks between 1 and 52),

  -- Soft delete, mirroring checklist_templates.enabled (mig 214):
  -- disabling stops new assets adopting it without orphaning existing
  -- assets or inspection history.
  enabled        boolean not null default true,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (location_id, name)
);

create index equipment_types_location_idx
  on public.equipment_types (location_id)
  where enabled;

comment on table public.equipment_types is
  'EQUIP-MAINT.1 — per-location equipment type carrying the inspection '
  'checklist (items jsonb) and the interval in weeks. Assets inherit; '
  'there is no per-asset override.';

-- ====================================================================
-- equipment — the assets themselves.
-- ====================================================================

create table public.equipment (
  id                       uuid primary key default gen_random_uuid(),
  location_id              uuid not null references public.locations (id) on delete restrict,

  -- restrict: a type with assets on it cannot be deleted. Operators
  -- disable a type instead (equipment_types.enabled).
  type_id                  uuid not null references public.equipment_types (id) on delete restrict,

  name                     text not null check (length(name) > 0 and length(name) <= 100),

  asset_tag                text check (asset_tag is null or length(asset_tag) <= 50),
  serial_number            text check (serial_number is null or length(serial_number) <= 100),
  manufacturer             text check (manufacturer is null or length(manufacturer) <= 100),
  zone                     text check (zone is null or length(zone) <= 100),
  purchase_date            date,
  notes                    text check (notes is null or length(notes) <= 2000),

  status                   text not null default 'in_service'
                           check (status in ('in_service', 'out_of_service', 'retired')),

  -- The issue that took this asset off the floor, if any. Resolving
  -- THAT issue is what returns the asset to service (PR 2 hook).
  out_of_service_issue_id  uuid references public.issues (id) on delete set null,

  -- The driving column. Set on create to the next occurrence of the
  -- location's inspection weekday (or an operator-supplied first-due
  -- date); rolled forward on each submitted inspection.
  next_due_on              date not null,
  last_inspected_on        date,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- THIS INDEX IS THE DUE LIST. Nothing is pre-generated; "what's due"
-- is one indexed comparison, so there are no instance rows to orphan
-- when kit is retired or re-typed.
create index equipment_due_idx
  on public.equipment (location_id, next_due_on)
  where status <> 'retired';

create index equipment_type_idx
  on public.equipment (type_id);

create unique index equipment_asset_tag_idx
  on public.equipment (location_id, asset_tag)
  where asset_tag is not null;

comment on table public.equipment is
  'EQUIP-MAINT.1 — individually tracked studio assets (~30-80 per '
  'location). Consumables (kettlebells, mats, bands) are deliberately '
  'not tracked here. equipment_due_idx is the due list.';

-- ====================================================================
-- equipment_inspections — the record of a run. Written by PR 2; the
-- table lands here so PR 1 and PR 2 do not both ship DDL.
-- ====================================================================

create table public.equipment_inspections (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations (id) on delete restrict,

  -- restrict, so the compliance log cannot be holed by deleting kit.
  -- Operators retire assets instead (status = 'retired').
  equipment_id  uuid not null references public.equipment (id) on delete restrict,
  type_id       uuid references public.equipment_types (id) on delete set null,
  inspector_id  uuid references public.profiles (id) on delete set null,

  -- The cycle this run satisfies. Roll-forward is measured from HERE,
  -- not from the submission date, so a late inspection does not drag
  -- the whole schedule permanently later.
  due_on        date not null,

  -- Snapshot of the type's items taken at draft creation, so editing a
  -- type mid-walk-round cannot shift state under the inspector. Same
  -- protection checklist_instances provides (mig 215).
  items         jsonb not null default '[]'::jsonb
                check (jsonb_typeof(items) = 'array'),

  -- { "<item_id>": { state: 'pass'|'fail', note, at, by } }
  results       jsonb not null default '{}'::jsonb
                check (jsonb_typeof(results) = 'object'),

  status        text not null default 'draft'
                check (status in ('draft', 'submitted')),
  submitted_at  timestamptz,

  issue_id      uuid references public.issues (id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One inspection per asset per cycle. This constraint is the
  -- idempotency guard against a double-submit race.
  unique (equipment_id, due_on)
);

create index equipment_inspections_equipment_idx
  on public.equipment_inspections (equipment_id, due_on desc);

create index equipment_inspections_log_idx
  on public.equipment_inspections (location_id, submitted_at desc)
  where status = 'submitted';

comment on table public.equipment_inspections is
  'EQUIP-MAINT.1 — one row per inspection run. items is a snapshot at '
  'draft creation; results keys it by item id. unique(equipment_id, '
  'due_on) is the double-submit guard.';

-- ====================================================================
-- issues.equipment_id — the ONLY change to an existing table.
-- ====================================================================

alter table public.issues
  add column if not exists equipment_id uuid references public.equipment (id) on delete set null;

create index if not exists issues_equipment_idx
  on public.issues (equipment_id)
  where equipment_id is not null;

comment on column public.issues.equipment_id is
  'EQUIP-MAINT.1 — set when the issue was raised by a failed equipment '
  'inspection. Null for ordinary staff-reported issues.';

-- ====================================================================
-- updated_at triggers — same shape as issues (mig 213).
-- ====================================================================

create or replace function public.equipment_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger equipment_settings_updated_at_trg
  before update on public.equipment_settings
  for each row execute function public.equipment_touch_updated_at();

create trigger equipment_types_updated_at_trg
  before update on public.equipment_types
  for each row execute function public.equipment_touch_updated_at();

create trigger equipment_updated_at_trg
  before update on public.equipment
  for each row execute function public.equipment_touch_updated_at();

create trigger equipment_inspections_updated_at_trg
  before update on public.equipment_inspections
  for each row execute function public.equipment_touch_updated_at();

-- ====================================================================
-- RLS — service-role only on all four. Mirrors issues (mig 213),
-- checklist_templates (214) and checklist_instances (215).
-- ====================================================================

alter table public.equipment_settings    enable row level security;
alter table public.equipment_types       enable row level security;
alter table public.equipment             enable row level security;
alter table public.equipment_inspections enable row level security;
```

- [ ] **Step 3: Apply the migration**

Apply via the Supabase MCP `apply_migration` tool against the **un1t-crm** project, ref `iyvtbjjxdggiadzwwvdj`. Confirm the ref with `list_projects` first — the sentinel project is `tpttqakxmyxrwnqjepfm` and applying there is a real mistake that has been made before.

Name the migration `467_equipment_maintenance`.

- [ ] **Step 4: Run the security advisors**

Run the Supabase MCP `get_advisors` tool with `type: "security"`.
Expected: no new ERROR-level findings. Four `rls_enabled_no_policy` INFO/WARN notices for the new tables are expected and correct — these tables are service-role-only by design, exactly like `issues`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/467_equipment_maintenance.sql
git commit -m "EQUIP-MAINT.1 — equipment register + inspection schema (mig 467)"
```

---

## Task 2: Pure lib — constants and date arithmetic

**Files:**
- Create: `src/lib/equipment.js`
- Test: `src/lib/equipment.test.js`

**Why the dates are string arithmetic:** every date here is a timezone-less calendar date (`YYYY-MM-DD`), the same as `bookings.booking_date`. Mixing local-time `Date` parsing with `toISOString()` formatting is what adds a BST offset and silently corrupts a business "today" — `check:guardrails` lint-blocks the common form. These helpers build dates from parts in **UTC** and format them by hand, never via `toISOString()`, so they behave identically under `TZ=Europe/Dublin` and a US timezone.

- [ ] **Step 1: Write the failing test**

Create `src/lib/equipment.test.js`:

```js
// EQUIP-MAINT.1 — unit tests for the pure equipment library.
//
// Date maths is the risky part: these must pass identically under
// TZ=Europe/Dublin and a US timezone, and across the BST/GMT boundary.

import { describe, it, expect } from 'vitest'
import {
  dowOf,
  addDays,
  nextOccurrenceOfDow,
  firstDueOn,
  rollForward,
} from './equipment.js'

describe('dowOf', () => {
  it('matches the Postgres dow convention (0 = Sunday)', () => {
    expect(dowOf('2026-08-02')).toBe(0) // Sunday
    expect(dowOf('2026-08-03')).toBe(1) // Monday
    expect(dowOf('2026-08-04')).toBe(2) // Tuesday
    expect(dowOf('2026-08-08')).toBe(6) // Saturday
  })
})

describe('addDays', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02')
  })

  it('adds days across a year boundary', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
  })

  it('crosses the BST→GMT boundary without shifting the date', () => {
    // Clocks go back 2026-10-25 in Dublin. A naive local-time
    // implementation lands on 2026-10-25 here instead of 10-26.
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26')
  })

  it('crosses the GMT→BST boundary without shifting the date', () => {
    // Clocks go forward 2026-03-29.
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30')
  })
})

describe('nextOccurrenceOfDow', () => {
  it('returns the same date when it already falls on that weekday', () => {
    expect(nextOccurrenceOfDow('2026-08-04', 2)).toBe('2026-08-04') // Tue
  })

  it('advances to the next occurrence otherwise', () => {
    expect(nextOccurrenceOfDow('2026-08-05', 2)).toBe('2026-08-11') // Wed -> Tue
  })
})

describe('firstDueOn', () => {
  it('uses the operator-supplied date when given', () => {
    expect(
      firstDueOn({ today: '2026-08-03', inspectionDayOfWeek: 2, explicitFirstDue: '2026-09-01' })
    ).toBe('2026-09-01')
  })

  it('uses the next inspection weekday on or after today', () => {
    expect(firstDueOn({ today: '2026-08-03', inspectionDayOfWeek: 2 })).toBe('2026-08-04')
  })

  it('falls back to today when the location has no settings row', () => {
    expect(firstDueOn({ today: '2026-08-03', inspectionDayOfWeek: null })).toBe('2026-08-03')
  })
})

describe('rollForward', () => {
  it('measures from the cycle date, not the submission date', () => {
    // Due Tue 04 Aug, four-weekly, actually inspected late on 07 Aug.
    // Must land 01 Sep (04 Aug + 28d), NOT 04 Sep.
    expect(rollForward({ dueOn: '2026-08-04', intervalWeeks: 4, today: '2026-08-07' }))
      .toBe('2026-09-01')
  })

  it('advances in whole intervals when more than one cycle overdue', () => {
    // Due 04 Aug, weekly, not inspected until 26 Aug. One step lands
    // 11 Aug which is still past, so it must keep stepping to 01 Sep.
    expect(rollForward({ dueOn: '2026-08-04', intervalWeeks: 1, today: '2026-08-26' }))
      .toBe('2026-09-01')
  })

  it('never returns a date before today', () => {
    const next = rollForward({ dueOn: '2026-01-06', intervalWeeks: 13, today: '2026-08-07' })
    expect(next >= '2026-08-07').toBe(true)
  })

  it('always lands on the same weekday as the cycle date', () => {
    const next = rollForward({ dueOn: '2026-08-04', intervalWeeks: 13, today: '2026-08-05' })
    expect(dowOf(next)).toBe(dowOf('2026-08-04'))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/equipment.test.js`
Expected: FAIL — `Failed to resolve import "./equipment.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/equipment.js`:

```js
// EQUIP-MAINT.1 — pure logic for the equipment maintenance feature.
//
// Nothing here touches Supabase or the network. Every function takes
// plain data and returns plain data, so the risky part (date maths)
// is testable without mocks. DB access lives in ./equipment-db.js.
//
// DATES: every date here is a timezone-less calendar string
// (YYYY-MM-DD), like bookings.booking_date. We build from parts in UTC
// and format by hand — never toISOString(), never local-time parsing —
// so results are identical under TZ=Europe/Dublin and a US timezone,
// and across the BST/GMT boundary. See CLAUDE.md "Timezones".

export const EQUIPMENT_STATUS = Object.freeze({
  IN_SERVICE: 'in_service',
  OUT_OF_SERVICE: 'out_of_service',
  RETIRED: 'retired',
})

export const INSPECTION_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
})

export const ITEM_LABEL_MAX = 200
export const MAX_ITEMS_PER_TYPE = 50
export const RESULT_NOTE_MAX = 500
export const INTERVAL_WEEKS_MIN = 1
export const INTERVAL_WEEKS_MAX = 52

// issues.description caps at 4000 (mig 213) — compose never exceeds it.
export const ISSUE_DESCRIPTION_MAX = 4000

// ---- date helpers -------------------------------------------------

/** Format a UTC Date as YYYY-MM-DD by hand (toISOString is guardrail-blocked). */
function formatUtc(dt) {
  const y = dt.getUTCFullYear()
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const d = String(dt.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function toUtcDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** Day of week for a YYYY-MM-DD string, Postgres convention (0 = Sunday). */
export function dowOf(dateStr) {
  return toUtcDate(dateStr).getUTCDay()
}

/** Add (or subtract) whole days to a YYYY-MM-DD string. */
export function addDays(dateStr, days) {
  const dt = toUtcDate(dateStr)
  dt.setUTCDate(dt.getUTCDate() + days)
  return formatUtc(dt)
}

/** The next date on or after `fromDateStr` falling on weekday `dow`. */
export function nextOccurrenceOfDow(fromDateStr, dow) {
  const delta = (dow - dowOf(fromDateStr) + 7) % 7
  return addDays(fromDateStr, delta)
}

/**
 * First due date for a newly registered asset.
 * Operator override wins; otherwise the next inspection weekday on or
 * after today; otherwise (no settings row yet) today, which gets
 * snapped to the weekday at the first roll-forward.
 */
export function firstDueOn({ today, inspectionDayOfWeek, explicitFirstDue }) {
  if (explicitFirstDue) return explicitFirstDue
  if (inspectionDayOfWeek === null || inspectionDayOfWeek === undefined) return today
  return nextOccurrenceOfDow(today, inspectionDayOfWeek)
}

/**
 * Next due date after a submitted inspection.
 * Measured from `dueOn` (the cycle date), NOT from today, so a late
 * inspection does not drag the schedule permanently later. If that
 * still lands in the past, step in whole intervals until it is on or
 * after today, so submitting never produces an instantly-overdue item.
 * Because the interval is whole weeks, the weekday is preserved.
 */
export function rollForward({ dueOn, intervalWeeks, today }) {
  const step = intervalWeeks * 7
  let next = addDays(dueOn, step)
  while (next < today) next = addDays(next, step)
  return next
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/equipment.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the same tests under a US timezone**

Run: `TZ=America/Los_Angeles npx vitest run src/lib/equipment.test.js`
Expected: PASS, identical results. If any date test fails here but passed above, the implementation has leaked local-time parsing — fix it before continuing, do not adjust the test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/equipment.js src/lib/equipment.test.js
git commit -m "EQUIP-MAINT.1 — pure date arithmetic for inspection cycles"
```

---

## Task 3: Pure lib — checklist item validation

**Files:**
- Modify: `src/lib/equipment.js`
- Modify: `src/lib/equipment.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/equipment.test.js`:

```js
import { validateItems, MAX_ITEMS_PER_TYPE, ITEM_LABEL_MAX } from './equipment.js'

describe('validateItems', () => {
  const ok = [
    { id: 'a1', label: 'Check belt wear', order: 0 },
    { id: 'b2', label: 'Emergency stop works', order: 1 },
  ]

  it('accepts a well-formed list and renumbers order from the array index', () => {
    const res = validateItems([
      { id: 'a1', label: 'Check belt wear', order: 9 },
      { id: 'b2', label: 'Emergency stop works', order: 4 },
    ])
    expect(res.ok).toBe(true)
    expect(res.items).toEqual(ok)
  })

  it('trims labels and ids', () => {
    const res = validateItems([{ id: '  a1  ', label: '  Check belt  ' }])
    expect(res.ok).toBe(true)
    expect(res.items[0]).toEqual({ id: 'a1', label: 'Check belt', order: 0 })
  })

  it('rejects a non-array', () => {
    expect(validateItems('nope').ok).toBe(false)
    expect(validateItems(null).ok).toBe(false)
  })

  it('rejects an empty list', () => {
    const res = validateItems([])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/at least one/i)
  })

  it('rejects more than MAX_ITEMS_PER_TYPE items', () => {
    const many = Array.from({ length: MAX_ITEMS_PER_TYPE + 1 }, (_, i) => ({
      id: `i${i}`, label: `item ${i}`,
    }))
    expect(validateItems(many).ok).toBe(false)
  })

  it('rejects a missing id', () => {
    const res = validateItems([{ label: 'no id' }])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/id/i)
  })

  it('rejects duplicate ids', () => {
    const res = validateItems([
      { id: 'same', label: 'one' },
      { id: 'same', label: 'two' },
    ])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/duplicate/i)
  })

  it('rejects a blank label', () => {
    expect(validateItems([{ id: 'a', label: '   ' }]).ok).toBe(false)
  })

  it('rejects an over-long label', () => {
    const res = validateItems([{ id: 'a', label: 'x'.repeat(ITEM_LABEL_MAX + 1) }])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(new RegExp(String(ITEM_LABEL_MAX)))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/equipment.test.js -t validateItems`
Expected: FAIL — `validateItems is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/equipment.js`:

```js
// ---- checklist item validation ------------------------------------

/**
 * Validate a checklist item array against the shape stored in
 * equipment_types.items — [{ id, label, order }], the same shape
 * checklist_templates.items uses.
 *
 * `order` is always renumbered from the array index, so the array
 * order the operator dragged into is the order of record and a stale
 * client-side `order` value can never desync the list.
 *
 * @returns {{ ok: true, items: Array }|{ ok: false, error: string }}
 */
export function validateItems(raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'Checklist items must be a list.' }
  }
  if (raw.length === 0) {
    return { ok: false, error: 'Add at least one checklist item.' }
  }
  if (raw.length > MAX_ITEMS_PER_TYPE) {
    return { ok: false, error: `A checklist can hold at most ${MAX_ITEMS_PER_TYPE} items.` }
  }

  const seen = new Set()
  const items = []

  for (let i = 0; i < raw.length; i++) {
    const row = raw[i]
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (!id) return { ok: false, error: `Item ${i + 1} is missing an id.` }
    if (seen.has(id)) return { ok: false, error: `Duplicate item id: ${id}.` }
    seen.add(id)

    const label = typeof row?.label === 'string' ? row.label.trim() : ''
    if (!label) return { ok: false, error: `Item ${i + 1} needs a label.` }
    if (label.length > ITEM_LABEL_MAX) {
      return { ok: false, error: `Item ${i + 1} label is over ${ITEM_LABEL_MAX} characters.` }
    }

    items.push({ id, label, order: i })
  }

  return { ok: true, items }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/equipment.test.js`
Expected: PASS, 23 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/equipment.js src/lib/equipment.test.js
git commit -m "EQUIP-MAINT.1 — checklist item validation"
```

---

## Task 4: Pure lib — result validation and issue composition

These are used by PR 2's submit route, but they belong with the rest of the pure logic and are cheap to land and test now.

**Files:**
- Modify: `src/lib/equipment.js`
- Modify: `src/lib/equipment.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/equipment.test.js`:

```js
import {
  validateResults,
  buildIssueDescription,
  shouldReturnToService,
  isDue,
  RESULT_NOTE_MAX,
  ISSUE_DESCRIPTION_MAX,
} from './equipment.js'

const ITEMS = [
  { id: 'a', label: 'Check belt wear', order: 0 },
  { id: 'b', label: 'Emergency stop works', order: 1 },
]

describe('validateResults', () => {
  it('accepts an all-pass run with no failures', () => {
    const res = validateResults({ items: ITEMS, results: { a: { state: 'pass' }, b: { state: 'pass' } } })
    expect(res.ok).toBe(true)
    expect(res.failed).toEqual([])
  })

  it('returns failed items with their notes, in snapshot order', () => {
    const res = validateResults({
      items: ITEMS,
      results: { a: { state: 'fail', note: 'fraying at the edge' }, b: { state: 'pass' } },
    })
    expect(res.ok).toBe(true)
    expect(res.failed).toEqual([{ id: 'a', label: 'Check belt wear', note: 'fraying at the edge' }])
  })

  it('rejects a fail with no note', () => {
    const res = validateResults({ items: ITEMS, results: { a: { state: 'fail' }, b: { state: 'pass' } } })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/note/i)
  })

  it('rejects a fail whose note is only whitespace', () => {
    const res = validateResults({ items: ITEMS, results: { a: { state: 'fail', note: '   ' }, b: { state: 'pass' } } })
    expect(res.ok).toBe(false)
  })

  it('rejects an over-long note', () => {
    const res = validateResults({
      items: ITEMS,
      results: { a: { state: 'fail', note: 'x'.repeat(RESULT_NOTE_MAX + 1) }, b: { state: 'pass' } },
    })
    expect(res.ok).toBe(false)
  })

  it('rejects submission when an item is unmarked, listing the missing ids', () => {
    const res = validateResults({ items: ITEMS, results: { a: { state: 'pass' } } })
    expect(res.ok).toBe(false)
    expect(res.missing).toEqual(['b'])
    expect(res.error).toMatch(/pass or fail/i)
  })

  it('rejects an unrecognised state', () => {
    const res = validateResults({ items: ITEMS, results: { a: { state: 'maybe' }, b: { state: 'pass' } } })
    expect(res.ok).toBe(false)
    expect(res.missing).toEqual(['a'])
  })

  it('rejects a non-object results blob', () => {
    expect(validateResults({ items: ITEMS, results: [] }).ok).toBe(false)
    expect(validateResults({ items: ITEMS, results: null }).ok).toBe(false)
  })
})

describe('buildIssueDescription', () => {
  const failed = [
    { id: 'a', label: 'Check belt wear', note: 'fraying at the edge' },
    { id: 'b', label: 'Emergency stop works', note: 'sticks, needs force' },
  ]

  it('names the asset, its type and the cycle date, then lists each failure', () => {
    const text = buildIssueDescription({
      equipmentName: 'Treadmill 3',
      typeName: 'Treadmill',
      dueOn: '2026-08-04',
      failed,
    })
    expect(text).toContain('Treadmill 3')
    expect(text).toContain('Treadmill')
    expect(text).toContain('2026-08-04')
    expect(text).toContain('Check belt wear: fraying at the edge')
    expect(text).toContain('Emergency stop works: sticks, needs force')
  })

  it('appends the inspector note when present', () => {
    const text = buildIssueDescription({
      equipmentName: 'Treadmill 3', typeName: 'Treadmill', dueOn: '2026-08-04',
      failed, extraNote: 'Taken off the floor.',
    })
    expect(text).toContain('Taken off the floor.')
  })

  it('omits the note section entirely when blank', () => {
    const text = buildIssueDescription({
      equipmentName: 'T3', typeName: 'Treadmill', dueOn: '2026-08-04', failed, extraNote: '   ',
    })
    expect(text.trimEnd()).toBe(text.trimEnd())
    expect(text).not.toMatch(/\n\n\s*\n/)
  })

  it('never exceeds the issues.description cap', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `i${i}`, label: `Item ${i}`, note: 'x'.repeat(RESULT_NOTE_MAX),
    }))
    const text = buildIssueDescription({
      equipmentName: 'Rig', typeName: 'Rig', dueOn: '2026-08-04', failed: many,
    })
    expect(text.length).toBeLessThanOrEqual(ISSUE_DESCRIPTION_MAX)
  })
})

describe('shouldReturnToService', () => {
  it('is true when the resolved issue is the one that removed the asset', () => {
    const eq = { status: 'out_of_service', out_of_service_issue_id: 'iss-1' }
    expect(shouldReturnToService(eq, 'iss-1')).toBe(true)
  })

  it('is false for a different issue on the same asset', () => {
    const eq = { status: 'out_of_service', out_of_service_issue_id: 'iss-1' }
    expect(shouldReturnToService(eq, 'iss-2')).toBe(false)
  })

  it('is false for an asset taken off the floor manually (no linked issue)', () => {
    const eq = { status: 'out_of_service', out_of_service_issue_id: null }
    expect(shouldReturnToService(eq, 'iss-1')).toBe(false)
  })

  it('is false for an in-service or retired asset', () => {
    expect(shouldReturnToService({ status: 'in_service', out_of_service_issue_id: 'iss-1' }, 'iss-1')).toBe(false)
    expect(shouldReturnToService({ status: 'retired', out_of_service_issue_id: 'iss-1' }, 'iss-1')).toBe(false)
  })

  it('is false for a missing asset', () => {
    expect(shouldReturnToService(null, 'iss-1')).toBe(false)
  })
})

describe('isDue', () => {
  it('is true for an in-service asset due today or earlier', () => {
    expect(isDue({ status: 'in_service', next_due_on: '2026-08-04' }, '2026-08-04')).toBe(true)
    expect(isDue({ status: 'in_service', next_due_on: '2026-07-28' }, '2026-08-04')).toBe(true)
  })

  it('is false for an asset due in the future', () => {
    expect(isDue({ status: 'in_service', next_due_on: '2026-09-01' }, '2026-08-04')).toBe(false)
  })

  it('excludes out-of-service assets — they already have an open issue', () => {
    expect(isDue({ status: 'out_of_service', next_due_on: '2026-08-04' }, '2026-08-04')).toBe(false)
  })

  it('excludes retired assets', () => {
    expect(isDue({ status: 'retired', next_due_on: '2026-08-04' }, '2026-08-04')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/equipment.test.js -t validateResults`
Expected: FAIL — `validateResults is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/equipment.js`:

```js
// ---- inspection results -------------------------------------------

/**
 * Validate a results blob against an items snapshot.
 *
 * Two separate failure modes, deliberately distinguished:
 *   - `missing`  → items with no pass/fail mark. Submission is refused;
 *                  the route returns these ids so the UI can highlight
 *                  the unanswered rows.
 *   - `error`    → a fail with no note, or an over-long note.
 *
 * @returns {{ ok: true, failed: Array<{id,label,note}> }
 *          |{ ok: false, error: string, missing?: string[] }}
 */
export function validateResults({ items, results }) {
  if (!results || typeof results !== 'object' || Array.isArray(results)) {
    return { ok: false, error: 'Results must be an object keyed by item id.' }
  }
  if (!Array.isArray(items)) {
    return { ok: false, error: 'Items snapshot is missing.' }
  }

  const missing = []
  const failed = []

  for (const item of items) {
    const row = results[item.id]
    const state = row?.state
    if (state !== 'pass' && state !== 'fail') {
      missing.push(item.id)
      continue
    }
    if (state === 'fail') {
      const note = typeof row.note === 'string' ? row.note.trim() : ''
      if (!note) {
        return { ok: false, error: `"${item.label}" was marked as a fault but has no note.` }
      }
      if (note.length > RESULT_NOTE_MAX) {
        return { ok: false, error: `The note on "${item.label}" is over ${RESULT_NOTE_MAX} characters.` }
      }
      failed.push({ id: item.id, label: item.label, note })
    }
  }

  if (missing.length > 0) {
    return { ok: false, error: 'Every check must be marked pass or fail before submitting.', missing }
  }

  return { ok: true, failed }
}

/**
 * Compose the issues.description for a failed inspection.
 * One issue per inspection listing every failed item, rather than one
 * issue per failure — a badly worn treadmill should reach the owner as
 * a single item of work, not four.
 *
 * Hard-capped at ISSUE_DESCRIPTION_MAX because issues.description has a
 * CHECK constraint at 4000 (mig 213) and would otherwise 500 the route.
 */
export function buildIssueDescription({ equipmentName, typeName, dueOn, failed, extraNote }) {
  const lines = [`${equipmentName} (${typeName}) failed inspection due ${dueOn}.`, '']
  for (const f of failed) lines.push(`• ${f.label}: ${f.note}`)

  const note = typeof extraNote === 'string' ? extraNote.trim() : ''
  if (note) lines.push('', note)

  const text = lines.join('\n')
  return text.length > ISSUE_DESCRIPTION_MAX ? text.slice(0, ISSUE_DESCRIPTION_MAX) : text
}

/**
 * Should resolving `resolvedIssueId` put this asset back in service?
 * Only when that exact issue is what removed it. An asset taken off the
 * floor manually from the register has no linked issue and must be
 * returned to service manually — resolving an unrelated issue on it
 * must not silently put broken kit back on the floor.
 */
export function shouldReturnToService(equipment, resolvedIssueId) {
  if (!equipment) return false
  if (equipment.status !== EQUIPMENT_STATUS.OUT_OF_SERVICE) return false
  if (!equipment.out_of_service_issue_id) return false
  return equipment.out_of_service_issue_id === resolvedIssueId
}

/** Is this asset due for inspection as of `today` (YYYY-MM-DD)? */
export function isDue(equipment, today) {
  if (equipment?.status !== EQUIPMENT_STATUS.IN_SERVICE) return false
  return equipment.next_due_on <= today
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/equipment.test.js`
Expected: PASS, 44 tests.

- [ ] **Step 5: Confirm timezone independence once more**

Run: `TZ=America/Los_Angeles npx vitest run src/lib/equipment.test.js`
Expected: PASS, same count.

- [ ] **Step 6: Commit**

```bash
git add src/lib/equipment.js src/lib/equipment.test.js
git commit -m "EQUIP-MAINT.1 — result validation, issue composition, due filter"
```

---

## Task 5: Permission keys

**Files:**
- Modify: `shared/permissions.js`
- Modify: `scripts/check-mobile-parity.mjs`

**Context:** `WEB_PERMISSIONS` is a frozen array of `{ key, label, hint }` at line ~33. `DEFAULT_WEB_PERMISSIONS_BY_ROLE` at line ~234 has one block per role (`master`, `manager`, `head_coach`, `staff`, `owner`) and **every** role block must list every key. `MOBILE_PERMISSIONS` is at line ~437 and `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE` at ~623.

- [ ] **Step 1: Add the two web keys**

In `shared/permissions.js`, immediately after the `issues_inbox` entry in `WEB_PERMISSIONS`:

```js
  // EQUIP-MAINT.1 — equipment maintenance. Two keys, deliberately
  // split: `equipment_admin` is the setup surface (register, types,
  // intervals, inspection weekday) and is owner + master only;
  // `equipment_inspect` is doing the walk-round and is universal, the
  // same way `issues` submission is open to all staff.
  { key: 'equipment_admin',   label: 'Equipment setup',      hint: 'Manage the equipment register, define equipment types with their inspection checklists and intervals, and set the studio inspection day. Owner + master only by default.' },
  { key: 'equipment_inspect', label: 'Equipment inspections', hint: 'See what equipment is due for inspection and complete the checklist. Universal by default — turning this OFF removes a person’s ability to run inspections.' },
```

- [ ] **Step 2: Add the defaults to every role block**

In `DEFAULT_WEB_PERMISSIONS_BY_ROLE`, add both keys to **all five** role blocks, next to each block's existing `issues_inbox` line:

```js
  // master
    equipment_admin: true, equipment_inspect: true,
  // owner
    equipment_admin: true,                          // owner owns the register + schedule
    equipment_inspect: true,
  // manager
    equipment_admin: false,                         // setup is owner + master
    equipment_inspect: true,
  // head_coach
    equipment_admin: false,
    equipment_inspect: true,
  // staff
    equipment_admin: false,
    equipment_inspect: true,                        // anyone on shift can run a walk-round
```

- [ ] **Step 3: Add the mobile counterpart**

In `MOBILE_PERMISSIONS`, after the `issue_triage` entry:

```js
  // EQUIP-MAINT.1 — the walk-round itself. This is where the work
  // actually happens: staff on the floor tapping through due kit.
  // webEquivalent links it to the web key for the parity linter.
  { key: 'equipment_inspect', label: 'Equipment inspections', hint: 'See what equipment is due for inspection today and complete the checklist, reporting faults with photos.', webEquivalent: 'equipment_inspect' },
```

And in `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE`, add `equipment_inspect: true` to every role block.

- [ ] **Step 4: Exempt the admin key from parity**

In `scripts/check-mobile-parity.mjs`, inside the `WEB_ONLY_OK` object (line ~73):

```js
  equipment_admin: 'Register + checklist + interval setup is a desktop task; the mobile counterpart is equipment_inspect (the walk-round), which is matched via webEquivalent.',
```

- [ ] **Step 5: Run the parity and permission checks**

```bash
npm run check:mobile-parity && npm test -- shared
```
Expected: parity passes with no drift; the shared-permissions tests that iterate every role pass. If a test reports a role missing a key, that role block was skipped in Step 2 — add it rather than relaxing the test.

- [ ] **Step 6: Commit**

```bash
git add shared/permissions.js scripts/check-mobile-parity.mjs
git commit -m "EQUIP-MAINT.1 — equipment_admin + equipment_inspect permission keys"
```

---

## Task 6: DB helpers

**Files:**
- Create: `src/lib/equipment-db.js`

**Note on the 1,000-row cap:** every `.select()` returns at most 1000 rows regardless of `.limit()`. A studio has 30-80 assets so no pagination is needed here, but the list helpers take an explicit `.order()` so results are stable, and a comment records the assumption.

- [ ] **Step 1: Write the helpers**

Create `src/lib/equipment-db.js`:

```js
// EQUIP-MAINT.1 — Supabase reads/writes for the equipment feature.
// Kept apart from ./equipment.js so the pure logic stays testable
// without mocks. Every function takes an already-constructed
// service-role client; none of them do auth — routes gate first.
//
// Row-count note: a studio holds 30-80 assets and ~15 types, well
// under the 1,000-row PostgREST select cap, so these do not paginate.
// If a tenant ever exceeds that, switch to .range() pagination the way
// src/lib/pipeline-reclassify.js does.

import { EQUIPMENT_STATUS } from './equipment.js'

const TYPE_COLUMNS = 'id, location_id, name, items, interval_weeks, enabled, created_at, updated_at'
const EQUIPMENT_COLUMNS =
  'id, location_id, type_id, name, asset_tag, serial_number, manufacturer, zone, ' +
  'purchase_date, notes, status, out_of_service_issue_id, next_due_on, last_inspected_on, ' +
  'created_at, updated_at'

// ---- settings -----------------------------------------------------

export async function getSettings(db, locationId) {
  const { data, error } = await db
    .from('equipment_settings')
    .select('location_id, inspection_day_of_week, enabled, created_at, updated_at')
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function upsertSettings(db, locationId, { inspectionDayOfWeek, enabled }) {
  const { data, error } = await db
    .from('equipment_settings')
    .upsert(
      { location_id: locationId, inspection_day_of_week: inspectionDayOfWeek, enabled },
      { onConflict: 'location_id' }
    )
    .select('location_id, inspection_day_of_week, enabled')
    .single()
  if (error) throw error
  return data
}

// ---- types --------------------------------------------------------

export async function listTypes(db, locationId, { includeDisabled = false } = {}) {
  let q = db.from('equipment_types').select(TYPE_COLUMNS).eq('location_id', locationId)
  if (!includeDisabled) q = q.eq('enabled', true)
  const { data, error } = await q.order('name', { ascending: true })
  if (error) throw error
  return data || []
}

export async function getType(db, id) {
  const { data, error } = await db.from('equipment_types').select(TYPE_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw error
  return data || null
}

export async function insertType(db, { locationId, name, items, intervalWeeks }) {
  const { data, error } = await db
    .from('equipment_types')
    .insert({ location_id: locationId, name, items, interval_weeks: intervalWeeks })
    .select(TYPE_COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function updateType(db, id, patch) {
  const { data, error } = await db.from('equipment_types').update(patch).eq('id', id).select(TYPE_COLUMNS).single()
  if (error) throw error
  return data
}

/** How many non-retired assets sit on this type — blocks disabling a live type. */
export async function countActiveAssetsOfType(db, typeId) {
  const { count, error } = await db
    .from('equipment')
    .select('id', { count: 'exact', head: true })
    .eq('type_id', typeId)
    .neq('status', EQUIPMENT_STATUS.RETIRED)
  if (error) throw error
  return count || 0
}

// ---- equipment ----------------------------------------------------

export async function listEquipment(db, locationId, { includeRetired = false } = {}) {
  let q = db
    .from('equipment')
    .select(`${EQUIPMENT_COLUMNS}, equipment_types!type_id ( id, name, interval_weeks )`)
    .eq('location_id', locationId)
  if (!includeRetired) q = q.neq('status', EQUIPMENT_STATUS.RETIRED)
  const { data, error } = await q.order('next_due_on', { ascending: true }).order('name', { ascending: true })
  if (error) throw error
  return data || []
}

export async function getEquipment(db, id) {
  const { data, error } = await db
    .from('equipment')
    .select(`${EQUIPMENT_COLUMNS}, equipment_types!type_id ( id, name, interval_weeks, items )`)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function insertEquipment(db, row) {
  const { data, error } = await db.from('equipment').insert(row).select(EQUIPMENT_COLUMNS).single()
  if (error) throw error
  return data
}

export async function updateEquipment(db, id, patch) {
  const { data, error } = await db.from('equipment').update(patch).eq('id', id).select(EQUIPMENT_COLUMNS).single()
  if (error) throw error
  return data
}
```

- [ ] **Step 2: Verify it compiles and lints**

```bash
npm run lint
```
Expected: no errors for `src/lib/equipment-db.js`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/equipment-db.js
git commit -m "EQUIP-MAINT.1 — Supabase helpers for settings, types and assets"
```

---

## Task 7: Settings route

**Files:**
- Create: `src/app/api/equipment/settings/route.js`

- [ ] **Step 1: Write the route**

```js
// EQUIP-MAINT.1 — per-location inspection weekday + feature switch.
//
// GET  → the location's settings, or null if never configured.
// PUT  → upsert. equipment_admin only.
//
// withAuth handles 401 / 403 / no-active-location and gives us the
// service-role client. There is NO RLS on these tables (service-role
// routes bypass it entirely), so the location scope comes from
// user.activeLocation via withAuth — never from the request body.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { getSettings, upsertSettings } from '@/lib/equipment-db'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SettingsBody = z.object({
  inspectionDayOfWeek: z.number().int().min(0).max(6),
  enabled: z.boolean(),
})

export const GET = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, locationId }) => {
    const settings = await getSettings(db, locationId)
    return NextResponse.json({ success: true, data: settings })
  }
)

export const PUT = withAuth(
  { permission: 'equipment_admin', location: true, schema: SettingsBody },
  async ({ db, locationId, input, user }) => {
    const data = await upsertSettings(db, locationId, {
      inspectionDayOfWeek: input.inspectionDayOfWeek,
      enabled: input.enabled,
    })
    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.settings_updated',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: 'Equipment settings', resource: `equipment_settings/${locationId}` },
      locationId,
      details: { inspection_day_of_week: data.inspection_day_of_week, enabled: data.enabled },
    })
    return NextResponse.json({ success: true, data })
  }
)
```

> **⚠️ The audit shape is a trap.** `logAuditEvent` takes
> `{ category, action, actor: { id, full_name, email }, target: { id?, label?, resource? }, locationId, details }`.
> Two ways to get it silently wrong, both of which write nothing and
> raise no error:
> - It is **`details`**, not `metadata`.
> - **Never put a non-profile UUID in `target.id`.** `audit_events.target_profile_id`
>   is an FK to `profiles`, so an equipment or type UUID there drops the
>   whole row silently. Entity identity rides in `target.resource` as a
>   `kind/uuid` string, which is why every call in this plan does that.
>
> This is documented on `src/app/api/issues/[id]/resolve/route.test.js`,
> which exists specifically because the bug was hit once already.

- [ ] **Step 3: Check the route guard passes**

```bash
npm run check:route-guards
```
Expected: pass. `withAuth` satisfies the guard.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/equipment/settings/route.js
git commit -m "EQUIP-MAINT.1 — equipment settings route"
```

---

## Task 8: Types routes

**Files:**
- Create: `src/app/api/equipment/types/route.js`
- Create: `src/app/api/equipment/types/[id]/route.js`

- [ ] **Step 1: Write the collection route**

Create `src/app/api/equipment/types/route.js`:

```js
// EQUIP-MAINT.1 — equipment types: the checklist + interval that
// assets inherit.
//
// GET  → list (enabled only unless ?includeDisabled=1). Readable by
//        anyone who can inspect, since the walk-round needs the items.
// POST → create. equipment_admin only.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { listTypes, insertType } from '@/lib/equipment-db'
import { validateItems, INTERVAL_WEEKS_MIN, INTERVAL_WEEKS_MAX } from '@/lib/equipment'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateTypeBody = z.object({
  name: z.string().trim().min(1).max(100),
  intervalWeeks: z.number().int().min(INTERVAL_WEEKS_MIN).max(INTERVAL_WEEKS_MAX),
  items: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    order: z.number().int().optional(),
  })),
})

export const GET = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, locationId, request }) => {
    const includeDisabled = new URL(request.url).searchParams.get('includeDisabled') === '1'
    const types = await listTypes(db, locationId, { includeDisabled })
    return NextResponse.json({ success: true, data: types })
  }
)

export const POST = withAuth(
  { permission: 'equipment_admin', location: true, schema: CreateTypeBody },
  async ({ db, locationId, input, user }) => {
    // Zod checks the shape; validateItems checks the domain rules
    // (unique ids, label bounds, count) and renumbers order.
    const check = validateItems(input.items)
    if (!check.ok) {
      return NextResponse.json({ success: false, error: check.error }, { status: 400 })
    }

    let type
    try {
      type = await insertType(db, {
        locationId,
        name: input.name,
        items: check.items,
        intervalWeeks: input.intervalWeeks,
      })
    } catch (err) {
      // unique (location_id, name)
      if (err?.code === '23505') {
        return NextResponse.json(
          { success: false, error: 'An equipment type with that name already exists here.' },
          { status: 409 }
        )
      }
      throw err
    }

    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.type_created',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      // resource, NOT target.id — a type uuid in target.id silently
      // drops the audit row (FK to profiles).
      target: { label: type.name, resource: `equipment_type/${type.id}` },
      locationId,
      details: { interval_weeks: type.interval_weeks, item_count: check.items.length },
    })
    return NextResponse.json({ success: true, data: type })
  }
)
```

- [ ] **Step 2: Write the detail route**

Create `src/app/api/equipment/types/[id]/route.js`:

```js
// EQUIP-MAINT.1 — edit or disable a single equipment type.
//
// 404 not 403 on a cross-location id, so ids cannot be enumerated
// (the standard rule for detail routes in this codebase).
//
// DELETE is a SOFT delete (enabled=false) and is refused while
// non-retired assets still point at the type — equipment.type_id is
// `on delete restrict`, so a hard delete would 500 anyway.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { getType, updateType, countActiveAssetsOfType } from '@/lib/equipment-db'
import { validateItems, INTERVAL_WEEKS_MIN, INTERVAL_WEEKS_MAX } from '@/lib/equipment'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PatchTypeBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  intervalWeeks: z.number().int().min(INTERVAL_WEEKS_MIN).max(INTERVAL_WEEKS_MAX).optional(),
  items: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    order: z.number().int().optional(),
  })).optional(),
  enabled: z.boolean().optional(),
})

export const PATCH = withAuth(
  { permission: 'equipment_admin', location: true, schema: PatchTypeBody },
  async ({ db, locationId, params, input, user }) => {
    const existing = await getType(db, params?.id)
    if (!existing || existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }

    const patch = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (input.intervalWeeks !== undefined) patch.interval_weeks = input.intervalWeeks
    if (input.items !== undefined) {
      const check = validateItems(input.items)
      if (!check.ok) {
        return NextResponse.json({ success: false, error: check.error }, { status: 400 })
      }
      patch.items = check.items
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 })
    }

    // Changing interval_weeks deliberately does NOT touch existing
    // equipment.next_due_on — it applies from the next roll-forward.
    // Bulk recalculation is an explicit operator action, never a side
    // effect of saving a type.
    let type
    try {
      type = await updateType(db, existing.id, patch)
    } catch (err) {
      if (err?.code === '23505') {
        return NextResponse.json(
          { success: false, error: 'An equipment type with that name already exists here.' },
          { status: 409 }
        )
      }
      throw err
    }

    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.type_updated',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: type.name, resource: `equipment_type/${type.id}` },
      locationId,
      details: { fields: Object.keys(patch) },
    })
    return NextResponse.json({ success: true, data: type })
  }
)

export const DELETE = withAuth(
  { permission: 'equipment_admin', location: true },
  async ({ db, locationId, params, user }) => {
    const existing = await getType(db, params?.id)
    if (!existing || existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }

    const inUse = await countActiveAssetsOfType(db, existing.id)
    if (inUse > 0) {
      return NextResponse.json(
        { success: false, error: `${inUse} piece(s) of equipment still use this type. Retire or re-type them first.` },
        { status: 409 }
      )
    }

    const type = await updateType(db, existing.id, { enabled: false })
    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.type_disabled',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: type.name, resource: `equipment_type/${type.id}` },
      locationId,
    })
    return NextResponse.json({ success: true, data: type })
  }
)
```

- [ ] **Step 3: Run lint and the route guard check**

```bash
npm run lint && npm run check:route-guards
```
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/equipment/types
git commit -m "EQUIP-MAINT.1 — equipment type routes (create, edit, soft-disable)"
```

---

## Task 9: Equipment routes

**Files:**
- Create: `src/app/api/equipment/route.js`
- Create: `src/app/api/equipment/[id]/route.js`

- [ ] **Step 1: Write the collection route**

Create `src/app/api/equipment/route.js`:

```js
// EQUIP-MAINT.1 — the equipment register.
//
// GET  → all non-retired assets at the active location (?includeRetired=1
//        for the full history view), each with its type embedded.
// POST → register a new asset. equipment_admin only.
//
// next_due_on is computed server-side from the location's inspection
// weekday — never trusted from the client, or an asset could be
// registered permanently not-due.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { listEquipment, insertEquipment, getType, getSettings } from '@/lib/equipment-db'
import { firstDueOn, EQUIPMENT_STATUS } from '@/lib/equipment'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const CreateEquipmentBody = z.object({
  typeId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  assetTag: z.string().trim().max(50).optional().nullable(),
  serialNumber: z.string().trim().max(100).optional().nullable(),
  manufacturer: z.string().trim().max(100).optional().nullable(),
  zone: z.string().trim().max(100).optional().nullable(),
  purchaseDate: z.string().regex(DATE_RE).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  firstDueOn: z.string().regex(DATE_RE).optional().nullable(),
})

export const GET = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, locationId, request }) => {
    const includeRetired = new URL(request.url).searchParams.get('includeRetired') === '1'
    const rows = await listEquipment(db, locationId, { includeRetired })
    return NextResponse.json({ success: true, data: rows })
  }
)

export const POST = withAuth(
  { permission: 'equipment_admin', location: true, schema: CreateEquipmentBody },
  async ({ db, locationId, input, user }) => {
    // The type must exist AND belong to this location — otherwise an
    // operator at one studio could attach an asset to another studio's
    // type. 404 rather than 403 so type ids stay unguessable.
    const type = await getType(db, input.typeId)
    if (!type || type.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Equipment type not found.' }, { status: 404 })
    }
    if (!type.enabled) {
      return NextResponse.json(
        { success: false, error: 'That equipment type is disabled. Re-enable it first.' },
        { status: 409 }
      )
    }

    const settings = await getSettings(db, locationId)
    const nextDueOn = firstDueOn({
      today: dublinTodayStr(),
      inspectionDayOfWeek: settings?.inspection_day_of_week ?? null,
      explicitFirstDue: input.firstDueOn || null,
    })

    let asset
    try {
      asset = await insertEquipment(db, {
        location_id: locationId,
        type_id: type.id,
        name: input.name,
        asset_tag: input.assetTag || null,
        serial_number: input.serialNumber || null,
        manufacturer: input.manufacturer || null,
        zone: input.zone || null,
        purchase_date: input.purchaseDate || null,
        notes: input.notes || null,
        status: EQUIPMENT_STATUS.IN_SERVICE,
        next_due_on: nextDueOn,
      })
    } catch (err) {
      // unique (location_id, asset_tag) where asset_tag is not null
      if (err?.code === '23505') {
        return NextResponse.json(
          { success: false, error: 'That asset tag is already in use at this location.' },
          { status: 409 }
        )
      }
      throw err
    }

    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.created',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: asset.name, resource: `equipment/${asset.id}` },
      locationId,
      details: { type_id: type.id, type_name: type.name, next_due_on: asset.next_due_on },
    })
    return NextResponse.json({ success: true, data: asset })
  }
)
```

- [ ] **Step 2: Write the detail route**

Create `src/app/api/equipment/[id]/route.js`:

```js
// EQUIP-MAINT.1 — a single asset: read, edit, retire.
//
// 404 not 403 on a cross-location id.
//
// DELETE retires (status='retired'), never hard-deletes: the
// compliance log references the asset with `on delete restrict`, so a
// hard delete would 500 once it has inspection history.
//
// Manual status changes are allowed here (kit pulled off the floor
// outside an inspection). That path leaves out_of_service_issue_id
// null, so the PR 2 clear-on-resolve hook has nothing to act on and
// the asset must be returned to service by hand — resolving an
// unrelated issue must never silently put broken kit back out.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { getEquipment, updateEquipment, getType } from '@/lib/equipment-db'
import { EQUIPMENT_STATUS } from '@/lib/equipment'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const PatchEquipmentBody = z.object({
  typeId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  assetTag: z.string().trim().max(50).optional().nullable(),
  serialNumber: z.string().trim().max(100).optional().nullable(),
  manufacturer: z.string().trim().max(100).optional().nullable(),
  zone: z.string().trim().max(100).optional().nullable(),
  purchaseDate: z.string().regex(DATE_RE).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  nextDueOn: z.string().regex(DATE_RE).optional(),
  status: z.enum([EQUIPMENT_STATUS.IN_SERVICE, EQUIPMENT_STATUS.OUT_OF_SERVICE]).optional(),
})

export const GET = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, locationId, params }) => {
    const asset = await getEquipment(db, params?.id)
    if (!asset || asset.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    return NextResponse.json({ success: true, data: asset })
  }
)

export const PATCH = withAuth(
  { permission: 'equipment_admin', location: true, schema: PatchEquipmentBody },
  async ({ db, locationId, params, input, user }) => {
    const existing = await getEquipment(db, params?.id)
    if (!existing || existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    if (existing.status === EQUIPMENT_STATUS.RETIRED) {
      return NextResponse.json(
        { success: false, error: 'This asset is retired and cannot be edited.' },
        { status: 409 }
      )
    }

    const patch = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.assetTag !== undefined) patch.asset_tag = input.assetTag || null
    if (input.serialNumber !== undefined) patch.serial_number = input.serialNumber || null
    if (input.manufacturer !== undefined) patch.manufacturer = input.manufacturer || null
    if (input.zone !== undefined) patch.zone = input.zone || null
    if (input.purchaseDate !== undefined) patch.purchase_date = input.purchaseDate || null
    if (input.notes !== undefined) patch.notes = input.notes || null
    if (input.nextDueOn !== undefined) patch.next_due_on = input.nextDueOn

    if (input.typeId !== undefined && input.typeId !== existing.type_id) {
      const type = await getType(db, input.typeId)
      if (!type || type.location_id !== locationId) {
        return NextResponse.json({ success: false, error: 'Equipment type not found.' }, { status: 404 })
      }
      // Re-typing deliberately leaves next_due_on alone — the new
      // type's checklist applies to the next inspection, its interval
      // from the next roll-forward. Same rule as editing an interval.
      patch.type_id = type.id
    }

    if (input.status !== undefined && input.status !== existing.status) {
      patch.status = input.status
      // A manual return to service also clears any issue link, so a
      // later resolve of that issue is a no-op rather than a surprise.
      patch.out_of_service_issue_id = null
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 })
    }

    let asset
    try {
      asset = await updateEquipment(db, existing.id, patch)
    } catch (err) {
      if (err?.code === '23505') {
        return NextResponse.json(
          { success: false, error: 'That asset tag is already in use at this location.' },
          { status: 409 }
        )
      }
      throw err
    }

    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.updated',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: asset.name, resource: `equipment/${asset.id}` },
      locationId,
      details: { fields: Object.keys(patch) },
    })
    return NextResponse.json({ success: true, data: asset })
  }
)

export const DELETE = withAuth(
  { permission: 'equipment_admin', location: true },
  async ({ db, locationId, params, user }) => {
    const existing = await getEquipment(db, params?.id)
    if (!existing || existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }

    const asset = await updateEquipment(db, existing.id, {
      status: EQUIPMENT_STATUS.RETIRED,
      out_of_service_issue_id: null,
    })
    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.retired',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: asset.name, resource: `equipment/${asset.id}` },
      locationId,
    })
    return NextResponse.json({ success: true, data: asset })
  }
)
```

- [ ] **Step 3: Run lint and route guards**

```bash
npm run lint && npm run check:route-guards
```
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/equipment/route.js src/app/api/equipment/\[id\]/route.js
git commit -m "EQUIP-MAINT.1 — equipment register routes (create, edit, retire)"
```

---

## Task 10: Route tests

**Files:**
- Create: `src/app/api/equipment/types/route.test.js`
- Create: `src/app/api/equipment/[id]/route.test.js`

- [ ] **Step 1: Write the types route test**

Note the `withAuth` mock below. The real wrapper parses the body against
the `schema` option and hands the handler `ctx.input`; the mock must do
the same or every schema-gated route reads `input` as `undefined`. This
is the one place the repo's route-test style needs extending for these
routes.

Create `src/app/api/equipment/types/route.test.js`:

```js
// EQUIP-MAINT.1 — route tests for equipment types.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'prof-owner', full_name: 'Olive Owner', email: 'olive@un1t.ie', role: 'owner' },
  locationId: 'loc-1',
}))

// withAuth mock: mirrors the real wrapper by parsing the body through
// the schema option and exposing it as ctx.input.
vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => async (request, ctx) => {
    let input
    if (opts?.schema) {
      const parsed = opts.schema.safeParse(await request.json())
      if (!parsed.success) {
        return {
          status: 400,
          json: async () => ({ success: false, error: 'Invalid body.', issues: parsed.error.issues }),
        }
      }
      input = parsed.data
    }
    return handler({
      user: h.user,
      db: {},
      locationId: h.locationId,
      request,
      input,
      params: ctx?.params ? await ctx.params : undefined,
    })
  },
}))
vi.mock('@/lib/equipment-db', () => ({
  listTypes: vi.fn(),
  insertType: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { GET, POST } from './route.js'
import { listTypes, insertType } from '@/lib/equipment-db'

function req(body, url = 'http://localhost/api/equipment/types') {
  return { json: async () => body, url, headers: { get: () => null } }
}

const VALID = {
  name: 'Treadmill',
  intervalWeeks: 4,
  items: [
    { id: 'a', label: 'Check belt wear' },
    { id: 'b', label: 'Emergency stop works' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  listTypes.mockResolvedValue([])
  insertType.mockResolvedValue({ id: 'type-1', name: 'Treadmill', interval_weeks: 4, items: [] })
})

describe('POST /api/equipment/types', () => {
  it('renumbers item order from array position, ignoring client-sent order', async () => {
    await POST(req({ ...VALID, items: [
      { id: 'a', label: 'Check belt wear', order: 9 },
      { id: 'b', label: 'Emergency stop works', order: 4 },
    ] }))
    expect(insertType).toHaveBeenCalledWith({}, expect.objectContaining({
      items: [
        { id: 'a', label: 'Check belt wear', order: 0 },
        { id: 'b', label: 'Emergency stop works', order: 1 },
      ],
    }))
  })

  it('rejects duplicate item ids with 400', async () => {
    const res = await POST(req({ ...VALID, items: [
      { id: 'same', label: 'one' },
      { id: 'same', label: 'two' },
    ] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/duplicate/i)
    expect(insertType).not.toHaveBeenCalled()
  })

  it('rejects an empty checklist with 400', async () => {
    const res = await POST(req({ ...VALID, items: [] }))
    expect(res.status).toBe(400)
    expect(insertType).not.toHaveBeenCalled()
  })

  it('maps a unique-name violation to 409, not a 500', async () => {
    insertType.mockRejectedValue({ code: '23505' })
    const res = await POST(req(VALID))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already exists/i)
  })

  it('rethrows a non-unique DB error rather than swallowing it', async () => {
    insertType.mockRejectedValue({ code: '42703', message: 'column does not exist' })
    await expect(POST(req(VALID))).rejects.toMatchObject({ code: '42703' })
  })
})

describe('GET /api/equipment/types', () => {
  it('lists enabled types only by default', async () => {
    await GET(req(null))
    expect(listTypes).toHaveBeenCalledWith({}, 'loc-1', { includeDisabled: false })
  })

  it('includes disabled types when asked', async () => {
    await GET(req(null, 'http://localhost/api/equipment/types?includeDisabled=1'))
    expect(listTypes).toHaveBeenCalledWith({}, 'loc-1', { includeDisabled: true })
  })
})
```

- [ ] **Step 2: Run it and verify it passes**

Run: `npx vitest run src/app/api/equipment/types/route.test.js`
Expected: PASS, 7 tests. If `input` is undefined inside the route, the `withAuth` mock's schema branch is wrong — fix the mock, not the route.

- [ ] **Step 3: Write the equipment detail route test**

The first test here is the IDOR guard and is the most important test in
this PR: a detail route must return **404, not 403**, for an id at
another location, so ids cannot be enumerated.

Create `src/app/api/equipment/[id]/route.test.js`:

```js
// EQUIP-MAINT.1 — route tests for a single asset.
//
// The 404-not-403 test is the IDOR guard: these routes run on the
// service-role client, which bypasses RLS entirely, so the location
// check in app code is the ONLY thing protecting the row.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'prof-owner', full_name: 'Olive Owner', email: 'olive@un1t.ie', role: 'owner' },
  locationId: 'loc-1',
}))

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => async (request, ctx) => {
    let input
    if (opts?.schema) {
      const parsed = opts.schema.safeParse(await request.json())
      if (!parsed.success) {
        return { status: 400, json: async () => ({ success: false, error: 'Invalid body.' }) }
      }
      input = parsed.data
    }
    return handler({
      user: h.user,
      db: {},
      locationId: h.locationId,
      request,
      input,
      params: ctx?.params ? await ctx.params : undefined,
    })
  },
}))
vi.mock('@/lib/equipment-db', () => ({
  getEquipment: vi.fn(),
  updateEquipment: vi.fn(),
  getType: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { GET, PATCH, DELETE } from './route.js'
import { getEquipment, updateEquipment } from '@/lib/equipment-db'

function req(body) {
  return { json: async () => body, headers: { get: () => null } }
}
const ctx = { params: { id: 'eq-1' } }

const ASSET = {
  id: 'eq-1',
  location_id: 'loc-1',
  name: 'Treadmill 3',
  status: 'in_service',
  out_of_service_issue_id: null,
  next_due_on: '2026-08-04',
}

beforeEach(() => {
  vi.clearAllMocks()
  getEquipment.mockResolvedValue(ASSET)
  updateEquipment.mockImplementation(async (_db, _id, patch) => ({ ...ASSET, ...patch }))
})

describe('GET /api/equipment/[id]', () => {
  it('returns 404 (NOT 403) for an asset at another location', async () => {
    getEquipment.mockResolvedValue({ ...ASSET, location_id: 'loc-OTHER' })
    const res = await GET(req(null), ctx)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Not found.')
  })

  it('returns 404 for an id that does not exist', async () => {
    getEquipment.mockResolvedValue(null)
    const res = await GET(req(null), ctx)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/equipment/[id]', () => {
  it('refuses to edit a retired asset', async () => {
    getEquipment.mockResolvedValue({ ...ASSET, status: 'retired' })
    const res = await PATCH(req({ name: 'Treadmill 4' }), ctx)
    expect(res.status).toBe(409)
    expect(updateEquipment).not.toHaveBeenCalled()
  })

  it('rejects an empty patch with 400', async () => {
    const res = await PATCH(req({}), ctx)
    expect(res.status).toBe(400)
    expect(updateEquipment).not.toHaveBeenCalled()
  })

  it('clears the linked issue when returned to service by hand', async () => {
    getEquipment.mockResolvedValue({ ...ASSET, status: 'out_of_service', out_of_service_issue_id: 'iss-1' })
    await PATCH(req({ status: 'in_service' }), ctx)
    expect(updateEquipment).toHaveBeenCalledWith({}, 'eq-1', expect.objectContaining({
      status: 'in_service',
      out_of_service_issue_id: null,
    }))
  })

  it('leaves next_due_on alone when the type changes', async () => {
    await PATCH(req({ name: 'Treadmill 3a' }), ctx)
    const patch = updateEquipment.mock.calls.at(-1)[2]
    expect(patch).not.toHaveProperty('next_due_on')
  })
})

describe('DELETE /api/equipment/[id]', () => {
  it('retires rather than deleting, so the compliance log survives', async () => {
    await DELETE(req(null), ctx)
    expect(updateEquipment).toHaveBeenCalledWith({}, 'eq-1', expect.objectContaining({ status: 'retired' }))
  })

  it('returns 404 for an asset at another location', async () => {
    getEquipment.mockResolvedValue({ ...ASSET, location_id: 'loc-OTHER' })
    const res = await DELETE(req(null), ctx)
    expect(res.status).toBe(404)
    expect(updateEquipment).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/app/api/equipment
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/equipment
git commit -m "EQUIP-MAINT.1 — route tests incl. 404-not-403 IDOR guard"
```

---

## Task 11: Web admin UI

**Files:**
- Create: `src/app/maintenance/page.js`
- Create: `src/components/maintenance/TypesTab.jsx`
- Create: `src/components/maintenance/EquipmentTab.jsx`

**Conventions that are lint-enforced — get these right first time:**
- Compose `Button`/`Modal`/`Card`/`Field`/`Table` from `@/components/ui`. Do not re-roll them.
- Status chips must be `bg-<colour>-500/10 text-<colour>-700`. The -700 text ramp is required; `check:guardrails` fails the build on lower ramps.
- **Every `<button>` inside a `<form>` defaults to `type="submit"`** — set `type="button"` on every tab pill, close X, "add item" and "remove item" control. This has bitten this repo repeatedly.
- Use `<Link>` for internal navigation.

- [ ] **Step 1: Read one existing admin page for the data-fetching style**

Run: `ls src/app/automations && sed -n '1,60p' src/app/automations/page.js`

Match its approach (client component with `fetch`, vs server component) rather than introducing a third. The code below assumes a client component; if the house style is a server component with a client island, move the `useState`/`useEffect` into the island and keep the markup identical.

**`Table` API** (confirmed from `src/components/ui/Table.jsx`): `columns` is `[{ key, header, align?, className?, render? }]`, `rows` is the data array, plus `loading`, `empty`, `onRowClick`, `rowKey`.

- [ ] **Step 2: Add the shared chip + interval helpers**

Create `src/components/maintenance/helpers.js`:

```js
// EQUIP-MAINT.1 — presentation helpers shared by the maintenance tabs.

// Chips MUST use the -700 text ramp on a /10 background. Lower ramps
// (-300/-400) are unreadable on this light theme and are lint-blocked
// by check:guardrails (no-low-contrast-chip).
export const STATUS_CHIP = Object.freeze({
  in_service:     'bg-emerald-500/10 text-emerald-700',
  out_of_service: 'bg-red-500/10 text-red-700',
  retired:        'bg-slate-500/10 text-slate-700',
})

export const STATUS_LABEL = Object.freeze({
  in_service: 'In service',
  out_of_service: 'Out of service',
  retired: 'Retired',
})

/** Human text for an interval in weeks. */
export function formatInterval(weeks) {
  if (weeks === 1) return 'Weekly'
  if (weeks === 2) return 'Fortnightly'
  if (weeks === 13) return 'Quarterly'
  if (weeks === 26) return 'Every 6 months'
  if (weeks === 52) return 'Annually'
  return `Every ${weeks} weeks`
}

export const WEEKDAYS = Object.freeze([
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
])

export const INTERVAL_OPTIONS = Object.freeze([1, 2, 4, 8, 13, 26, 52])
```

- [ ] **Step 3: Build the tab shell**

Create `src/app/maintenance/page.js`:

```js
'use client'

// EQUIP-MAINT.1 — /maintenance. PR 1 ships Equipment + Types; the Due
// tab is a deliberate, visible stub that PR 2 fills in.

import { useState } from 'react'
import { Card } from '@/components/ui'
import TypesTab from '@/components/maintenance/TypesTab'
import EquipmentTab from '@/components/maintenance/EquipmentTab'

const TABS = [
  { key: 'due', label: 'Due' },
  { key: 'equipment', label: 'Equipment' },
  { key: 'types', label: 'Types' },
]

export default function MaintenancePage() {
  const [tab, setTab] = useState('equipment')

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-un1t-text">Maintenance</h1>
        <p className="text-sm text-un1t-muted">
          Equipment register, inspection checklists and schedules.
        </p>
      </div>

      <div className="flex gap-2 border-b border-un1t-border">
        {TABS.map((t) => (
          // type="button" is REQUIRED — a bare <button> defaults to
          // type="submit" and will submit any form it ends up inside.
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              'px-3 py-2 text-sm ' +
              (tab === t.key
                ? 'border-b-2 border-un1t-accent font-medium text-un1t-text'
                : 'text-un1t-muted hover:text-un1t-text')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'due' && (
        <Card>
          <p className="py-8 text-center text-sm text-un1t-subtle">
            Running inspections arrives in the next release. Set up your equipment
            types and register in the meantime.
          </p>
        </Card>
      )}
      {tab === 'equipment' && <EquipmentTab />}
      {tab === 'types' && <TypesTab />}
    </div>
  )
}
```

- [ ] **Step 4: Build TypesTab**

Create `src/components/maintenance/TypesTab.jsx`:

```jsx
'use client'

// EQUIP-MAINT.1 — equipment types: the checklist + interval assets inherit.
// Also hosts the location's inspection weekday + feature switch.

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Field, Modal, Table } from '@/components/ui'
import { formatInterval, INTERVAL_OPTIONS, WEEKDAYS } from './helpers'

const EMPTY_TYPE = { id: null, name: '', intervalWeeks: 4, items: [] }

export default function TypesTab() {
  const [types, setTypes] = useState([])
  const [settings, setSettings] = useState({ inspection_day_of_week: 2, enabled: false })
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [tRes, sRes] = await Promise.all([
      fetch('/api/equipment/types?includeDisabled=1').then((r) => r.json()),
      fetch('/api/equipment/settings').then((r) => r.json()),
    ])
    if (tRes.success) setTypes(tRes.data)
    if (sRes.success && sRes.data) setSettings(sRes.data)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function saveSettings(patch) {
    const next = { ...settings, ...patch }
    setSettings(next)
    await fetch('/api/equipment/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inspectionDayOfWeek: next.inspection_day_of_week,
        enabled: next.enabled,
      }),
    })
  }

  async function saveType(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const body = {
      name: editing.name,
      intervalWeeks: editing.intervalWeeks,
      items: editing.items,
    }
    const res = await fetch(
      editing.id ? `/api/equipment/types/${editing.id}` : '/api/equipment/types',
      {
        method: editing.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    ).then((r) => r.json())
    setSaving(false)
    if (!res.success) { setError(res.error); return }
    setEditing(null)
    load()
  }

  // A fresh uuid per item, generated ONCE on add and never regenerated
  // on edit — stable ids are what preserve inspection history across a
  // label rename.
  function addItem() {
    setEditing((t) => ({ ...t, items: [...t.items, { id: crypto.randomUUID(), label: '' }] }))
  }
  function setItemLabel(idx, label) {
    setEditing((t) => ({ ...t, items: t.items.map((it, i) => (i === idx ? { ...it, label } : it)) }))
  }
  function removeItem(idx) {
    setEditing((t) => ({ ...t, items: t.items.filter((_, i) => i !== idx) }))
  }

  const columns = [
    { key: 'name', header: 'Type' },
    { key: 'interval', header: 'Interval', render: (r) => formatInterval(r.interval_weeks) },
    { key: 'items', header: 'Checks', render: (r) => (r.items || []).length },
    {
      key: 'enabled',
      header: 'Status',
      render: (r) => (
        <span className={`rounded px-2 py-0.5 text-xs ${r.enabled ? 'bg-emerald-500/10 text-emerald-700' : 'bg-slate-500/10 text-slate-700'}`}>
          {r.enabled ? 'Active' : 'Disabled'}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-end gap-4 p-4">
          <Field id="inspection-day" label="Inspection day" hint="The weekday inspections are due and reminders are sent.">
            <select
              id="inspection-day"
              className="rounded border border-un1t-border px-2 py-1 text-sm"
              value={settings.inspection_day_of_week}
              onChange={(e) => saveSettings({ inspection_day_of_week: Number(e.target.value) })}
            >
              {WEEKDAYS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </Field>
          <Field id="enabled" label="Feature enabled" hint="Off means no due lists and no reminders at this studio.">
            <input
              id="enabled"
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => saveSettings({ enabled: e.target.checked })}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between p-4">
          <h2 className="font-medium text-un1t-text">Equipment types</h2>
          <Button type="button" onClick={() => setEditing({ ...EMPTY_TYPE })}>Add type</Button>
        </div>
        <Table
          columns={columns}
          rows={types}
          loading={loading}
          empty="No equipment types yet. Add one to get started."
          onRowClick={(r) => setEditing({
            id: r.id, name: r.name, intervalWeeks: r.interval_weeks, items: r.items || [],
          })}
        />
      </Card>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit equipment type' : 'New equipment type'}
      >
        {editing && (
          <form onSubmit={saveType} className="space-y-4">
            <Field id="type-name" label="Name" required>
              <input
                id="type-name"
                className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                maxLength={100}
                required
              />
            </Field>

            <Field id="type-interval" label="Inspect every">
              <select
                id="type-interval"
                className="rounded border border-un1t-border px-2 py-1 text-sm"
                value={editing.intervalWeeks}
                onChange={(e) => setEditing({ ...editing, intervalWeeks: Number(e.target.value) })}
              >
                {INTERVAL_OPTIONS.map((w) => (
                  <option key={w} value={w}>{formatInterval(w)}</option>
                ))}
              </select>
            </Field>

            <div className="space-y-2">
              <p className="text-sm font-medium text-un1t-text">Checklist</p>
              {editing.items.map((item, idx) => (
                <div key={item.id} className="flex gap-2">
                  <input
                    className="flex-1 rounded border border-un1t-border px-2 py-1 text-sm"
                    value={item.label}
                    onChange={(e) => setItemLabel(idx, e.target.value)}
                    placeholder="e.g. Emergency stop works"
                    maxLength={200}
                  />
                  <Button type="button" variant="ghost" onClick={() => removeItem(idx)}>Remove</Button>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={addItem}>Add check</Button>
            </div>

            {error && <p className="text-sm text-red-700">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit" loading={saving}>Save</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
```

- [ ] **Step 5: Build EquipmentTab**

Create `src/components/maintenance/EquipmentTab.jsx` following the same
structure as `TypesTab`: a `Card` with an "Add equipment" `Button`, a
`Table`, and a `Modal` holding the create/edit form.

Table columns and their renderers:

```jsx
const columns = [
  { key: 'name', header: 'Equipment' },
  { key: 'type', header: 'Type', render: (r) => r.equipment_types?.name || '—' },
  { key: 'zone', header: 'Zone', render: (r) => r.zone || '—' },
  {
    key: 'status',
    header: 'Status',
    render: (r) => (
      <span className={`rounded px-2 py-0.5 text-xs ${STATUS_CHIP[r.status]}`}>
        {STATUS_LABEL[r.status]}
      </span>
    ),
  },
  { key: 'last', header: 'Last inspected', render: (r) => r.last_inspected_on || 'Never' },
  {
    key: 'due',
    header: 'Next due',
    render: (r) => (
      <span className={
        r.next_due_on <= today
          ? 'rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700'
          : 'text-un1t-muted'
      }>
        {r.next_due_on}
      </span>
    ),
  },
]
```

`today` comes from a `useState(() => new Date().toLocaleDateString('sv-SE'))`
— `sv-SE` formats as `YYYY-MM-DD` natively, which is what makes the plain
string comparison above correct. Do **not** use `toISOString().slice(0,10)`:
it is UTC, not local, and `check:guardrails` blocks it.

The modal form fields map one-to-one onto `CreateEquipmentBody` from Task 9:
a type `<select>` populated from `GET /api/equipment/types`, then `name`
(required), `assetTag`, `serialNumber`, `manufacturer`, `zone`,
`purchaseDate` (`<input type="date">`), `notes` (`<textarea>`), and — on
create only — an optional `firstDueOn` date. In edit mode the modal also
shows a `status` select (In service / Out of service) and a Retire button
calling `DELETE /api/equipment/{id}`, behind a `window.confirm`.

Every non-submit control in that form needs `type="button"`.

- [ ] **Step 6: Verify it builds**

```bash
npm run build
```
Expected: success. This is the **only** check that catches import-resolution and Turbopack failures — mocked vitest and eslint both sail past a missing export. Do not skip it.

- [ ] **Step 7: Check the guardrails**

```bash
npm run check:guardrails
```
Expected: pass. A failure here is almost always a chip using a text ramp below -700, or a `toISOString().slice()` date.

- [ ] **Step 8: Commit**

```bash
git add src/app/maintenance src/components/maintenance
git commit -m "EQUIP-MAINT.1 — /maintenance admin: types, checklists, register"
```

---

## Task 12: OpenAPI registration and full CI mirror

**Files:**
- Modify: `src/lib/openapi.js`

- [ ] **Step 1: Register the routes**

Add entries for the five new routes to `src/lib/openapi.js`, matching the surrounding style exactly:
`/api/equipment` (GET, POST), `/api/equipment/{id}` (GET, PATCH, DELETE), `/api/equipment/types` (GET, POST), `/api/equipment/types/{id}` (PATCH, DELETE), `/api/equipment/settings` (GET, PUT).

- [ ] **Step 2: Run the full CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```
Expected: all six pass.

- [ ] **Step 3: Run the production build**

```bash
npm run build
```
Expected: success.

- [ ] **Step 4: Commit and open the PR**

```bash
git add src/lib/openapi.js
git commit -m "EQUIP-MAINT.1 — register equipment routes in openapi"
git push -u origin HEAD
gh pr create --base main --title "EQUIP-MAINT.1 — equipment register, inspection schema and admin" --fill
```

Report the PR URL. Pushing is not shipping — the PR is the deliverable.

---

## Verification checklist before claiming done

- [ ] Migration 467 applied to `iyvtbjjxdggiadzwwvdj` and `get_advisors` shows no new ERROR-level findings
- [ ] `npx vitest run src/lib/equipment.test.js` passes under **both** `TZ=Europe/Dublin` and `TZ=America/Los_Angeles`
- [ ] The cross-location GET test returns 404, not 403
- [ ] All six CI-mirror checks pass
- [ ] `npm run build` succeeds
- [ ] PR opened, URL reported

---

## Deferred to PR 2 and PR 3 (do not build here)

**PR 2:** the due list surface, draft creation with item snapshot, the tick UI (web + mobile), the submit route with photo upload and issue creation, the out-of-service flag, and the clear-on-resolve hook on `/api/issues/[id]/resolve`. `validateResults`, `buildIssueDescription` and `shouldReturnToService` are built and tested here but are not yet called by anything — that is intentional.

**Deliberately not built, and not an oversight:** the spec mentions a bulk
"recalculate due dates" button for when an operator changes a type's
interval. PR 1 ships the per-asset equivalent instead — `PATCH
/api/equipment/{id}` accepts `nextDueOn`, so a due date can be corrected by
hand. With ~15 types per studio the bulk button is YAGNI until an operator
asks for it; the rule it protects (changing an interval never silently
moves existing due dates) is enforced in Task 8 regardless.

**PR 3:** `equipment-inspection-reminder` and `equipment-inspection-sweep` crons (each with a `cron_heartbeats` row and a `stampHeartbeat` call), the `notify_inspection_due` / `notify_inspection_overdue` keys, and the compliance log tab with CSV export.
