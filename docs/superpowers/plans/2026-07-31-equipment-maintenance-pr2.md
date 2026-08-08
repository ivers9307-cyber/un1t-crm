# Equipment Maintenance — PR 2 (the inspection run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a staff member open the due list, work through an asset's checklist marking each item pass or fail, attach photos, and submit — raising one issue for any faults, optionally taking the asset out of service, and rolling the schedule forward.

**Architecture:** Draft inspections are created lazily on first open, snapshotting the type's checklist so a mid-walk-round type edit can't shift state. Ticks persist as they happen; photos upload only at submit, inside the same request that creates the `issues` row, because the storage path is namespaced by `issue_id`. Resolving that issue returns the asset to service.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + Storage, service-role), Expo/RN for mobile, Zod, Vitest.

**Scope:** PR 2 of 3. Crons, notification keys and the compliance log are PR 3. **No new migrations** — PR 1's migration 467 already created `equipment_inspections`.

**Spec:** `docs/superpowers/specs/2026-07-31-equipment-maintenance-inspections-design.md`
**PR 1:** merged as #1184. Read its plan (`…-pr1.md`) for the schema and the pure-library API.

---

## What already exists — do not rebuild

| Thing | Where |
|---|---|
| `equipment_inspections` table (`items`, `results`, `status`, `due_on`, `issue_id`, `unique(equipment_id, due_on)`) | mig 467 |
| `validateResults`, `buildIssueDescription`, `shouldReturnToService`, `isDue`, `rollForward` | `src/lib/equipment.js` — **built and tested in PR 1, no caller yet. This PR wires them up.** |
| `equipment-db.js` helpers for settings/types/equipment | `src/lib/equipment-db.js` |
| Photo upload → `issue-photos` bucket → `insertIssueWithAttachments` | `src/app/api/issues/route.js:88-140`, `src/lib/issues.js:149` |
| Issue claim/resolve/close + `notify_issue_*` pushes | `src/app/api/issues/**` |
| `/maintenance` shell with a **Due tab stub** to replace | `src/app/maintenance/page.js`, `src/components/maintenance/MaintenanceView.jsx` |

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/equipment-inspections.js` | Draft resolution and submit orchestration: snapshot items, merge a tick into `results`, and the ordered submit sequence. Pure where it can be; takes a `db` where it can't. |
| `src/lib/equipment-inspections.test.js` | Unit tests. |
| `src/lib/equipment-db.js` | **Extend** with inspection queries (`getDraftFor`, `insertDraft`, `updateInspection`, `listDueEquipment`). |
| `src/lib/issues.js` | **Extend** `insertIssueWithAttachments` with an optional `equipmentId`. |
| `src/app/api/equipment/due/route.js` | GET the due list. |
| `src/app/api/equipment/[id]/inspection/route.js` | POST create-or-fetch the draft. |
| `src/app/api/equipment/inspections/[id]/route.js` | PATCH one tick. |
| `src/app/api/equipment/inspections/[id]/submit/route.js` | POST multipart submit. |
| `src/app/api/issues/[id]/resolve/route.js` | **Extend** — return the asset to service. |
| `src/components/maintenance/DueTab.jsx` | Web due list (replaces the stub). |
| `src/components/maintenance/InspectionRunner.jsx` | Web tick-through UI. |
| `mobile/lib/maintenance-api.js` | Mobile API wrappers. |
| `mobile/app/maintenance/index.jsx`, `[id].jsx`, `_layout.jsx` | Mobile due list + run screen. |
| `mobile/components/dashboard/DueInspectionsCard.jsx` | Dashboard card. |

---

## Invariants that will bite on this PR specifically

- **`rollForward` throws `RangeError`** when a type's `interval_weeks` is out of range. The submit route **must catch it and return 400** with "This equipment type has an invalid inspection interval — fix it in Equipment setup", not let it surface as a 500. PR 1's plan flagged this as a required follow-up.
- **Submit ordering is load-bearing.** Create the issue (with photos) FIRST, then mark the inspection submitted and roll the asset forward. If the issue insert fails, the inspection stays `draft` and nothing advances, so the inspector retries with their ticks intact. `unique (equipment_id, due_on)` stops a retry double-advancing.
- **Photos upload only at submit.** The bucket path is `{location_id}/{issue_id}/…`, so no valid path exists until the issue does. Drafts persist ticks and notes only — never bytes.
- **Mobile cannot import `src/lib`.** `shared/` is the seam, imported as `shared/…` (never a relative `../shared` — Metro won't resolve out of the project root). If mobile needs `validateResults`, re-export it through `shared/` and add it to the parity story. A mobile import of a non-exported name resolves to `undefined` and only crashes at runtime; `npm run check:mobile-imports` guards it.
- **Mobile `/api` wrappers must use `authHeaders()`/`api()`** — a hand-rolled `Bearer` drops `x-impersonate-target` and breaks "View as user".
- **Never embed `profiles` from a mobile-direct Supabase select** — `authenticated` has no grant, the whole select 500s. Route through `/api/*`.
- **Service-role routes have no RLS.** Detail routes return **404 not 403** for another location's row.
- **Audit:** `logAuditEvent({ category, action, actor, target, locationId, details })` — `details` not `metadata`, and a non-profile UUID in `target.id` **silently drops the row**. Entity ids go in `target.resource`.
- **`bookings`-style dates are Dublin calendar strings.** Use `dublinTodayStr()`. Never `new Date().toISOString().slice()`.
- **Every `<button>` in a `<form>` defaults to `type="submit"`.**
- **`Table` columns resolve via `render` or `accessor`, never `key`.** This shipped a blank column in PR 1 — check every column you add.
- **Chips:** `bg-<c>-500/10 text-<c>-700`.

---

## Task 1: Extend the DB helpers

**Files:** Modify `src/lib/equipment-db.js`

- [ ] **Step 1: Add the inspection queries**

Append to `src/lib/equipment-db.js`:

```js
// ---- inspections ---------------------------------------------------

const INSPECTION_COLUMNS =
  'id, location_id, equipment_id, type_id, inspector_id, due_on, items, results, ' +
  'status, submitted_at, issue_id, created_at, updated_at'

/** The draft for this asset's CURRENT cycle, if one exists. */
export async function getDraftFor(db, { equipmentId, dueOn }) {
  const { data, error } = await db
    .from('equipment_inspections')
    .select(INSPECTION_COLUMNS)
    .eq('equipment_id', equipmentId)
    .eq('due_on', dueOn)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function getInspection(db, id) {
  const { data, error } = await db
    .from('equipment_inspections')
    .select(`${INSPECTION_COLUMNS}, equipment!equipment_id ( id, name, location_id, status, next_due_on ), equipment_types!type_id ( id, name, interval_weeks )`)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function insertDraft(db, row) {
  const { data, error } = await db
    .from('equipment_inspections')
    .insert(row)
    .select(INSPECTION_COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function updateInspection(db, id, patch) {
  const { data, error } = await db
    .from('equipment_inspections')
    .update(patch)
    .eq('id', id)
    .select(INSPECTION_COLUMNS)
    .single()
  if (error) throw error
  return data
}

/**
 * Assets due for inspection at a location as of `today`.
 * Mirrors isDue(): in-service only, next_due_on <= today. The
 * equipment_due_idx predicate (status <> 'retired') is deliberately
 * wider — index for cheapness, isDue() for truth — so we filter
 * status here rather than relying on the index shape.
 *
 * Row-count note: 30-80 assets per studio, well under the 1000-row
 * PostgREST cap, so this does not paginate.
 */
export async function listDueEquipment(db, locationId, today) {
  const { data, error } = await db
    .from('equipment')
    .select(`${EQUIPMENT_COLUMNS}, equipment_types!type_id ( id, name, interval_weeks, items )`)
    .eq('location_id', locationId)
    .eq('status', 'in_service')
    .lte('next_due_on', today)
    .order('next_due_on', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  return data || []
}

/** Assets currently off the floor — shown in their own section. */
export async function listOutOfServiceEquipment(db, locationId) {
  const { data, error } = await db
    .from('equipment')
    .select(`${EQUIPMENT_COLUMNS}, equipment_types!type_id ( id, name )`)
    .eq('location_id', locationId)
    .eq('status', 'out_of_service')
    .order('name', { ascending: true })
  if (error) throw error
  return data || []
}
```

- [ ] **Step 2: Verify and commit**

```bash
npm run lint
git add src/lib/equipment-db.js
git commit -m "EQUIP-MAINT.2 — inspection + due-list DB helpers"
```

---

## Task 2: `insertIssueWithAttachments` accepts an equipment link

**Files:** Modify `src/lib/issues.js`, `src/lib/issues.test.js`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/issues.test.js` (match the file's existing mocking style — read it first):

```js
it('sets equipment_id when the issue came from a failed inspection', async () => {
  const insert = vi.fn().mockReturnValue({
    select: () => ({ single: async () => ({ data: { id: 'iss-1' }, error: null }) }),
  })
  const db = { from: () => ({ insert }) }

  await insertIssueWithAttachments(db, {
    locationId: 'loc-1',
    submitterId: 'prof-1',
    description: 'Treadmill 3 failed inspection',
    equipmentId: 'eq-1',
  })

  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ equipment_id: 'eq-1' }))
})

it('omits equipment_id entirely for an ordinary staff-reported issue', async () => {
  const insert = vi.fn().mockReturnValue({
    select: () => ({ single: async () => ({ data: { id: 'iss-2' }, error: null }) }),
  })
  const db = { from: () => ({ insert }) }

  await insertIssueWithAttachments(db, {
    locationId: 'loc-1', submitterId: 'prof-1', description: 'Bathroom light out',
  })

  expect(insert.mock.calls[0][0]).not.toHaveProperty('equipment_id')
})
```

- [ ] **Step 2: Run it, watch it fail**

`npx vitest run src/lib/issues.test.js -t equipment_id` → FAIL.

- [ ] **Step 3: Implement**

In `src/lib/issues.js`, change the signature and insert payload:

```js
export async function insertIssueWithAttachments(db, {
  locationId, submitterId, description, attachments = [], equipmentId = null,
}) {
  const { data: issue, error: issueErr } = await db
    .from('issues')
    .insert({
      location_id: locationId,
      submitter_id: submitterId,
      description,
      status: ISSUE_STATUS.OPEN,
      // EQUIP-MAINT.2 — only present when raised by a failed equipment
      // inspection. Omitted (not null) for ordinary reports so the
      // insert payload is unchanged for the existing caller.
      ...(equipmentId ? { equipment_id: equipmentId } : {}),
    })
    .select('id, location_id, submitter_id, description, status, equipment_id, created_at')
    .single()
```

Leave the rest of the function untouched.

- [ ] **Step 4: Run and commit**

```bash
npx vitest run src/lib/issues.test.js
git add src/lib/issues.js src/lib/issues.test.js
git commit -m "EQUIP-MAINT.2 — issues can carry an equipment link"
```

---

## Task 3: Inspection lib — draft snapshot and tick merge

**Files:** Create `src/lib/equipment-inspections.js`, `src/lib/equipment-inspections.test.js`

- [ ] **Step 1: Write the failing test**

```js
// EQUIP-MAINT.2 — unit tests for inspection draft + tick logic.

import { describe, it, expect } from 'vitest'
import { buildDraftRow, mergeTick, isFullyMarked } from './equipment-inspections.js'

const TYPE = {
  id: 'type-1',
  name: 'Treadmill',
  interval_weeks: 4,
  items: [
    { id: 'a', label: 'Check belt wear', order: 0 },
    { id: 'b', label: 'Emergency stop works', order: 1 },
  ],
}
const ASSET = { id: 'eq-1', location_id: 'loc-1', type_id: 'type-1', next_due_on: '2026-08-04' }

describe('buildDraftRow', () => {
  it('snapshots the type items so a later type edit cannot shift the run', () => {
    const row = buildDraftRow({ asset: ASSET, type: TYPE, inspectorId: 'prof-1' })
    expect(row.items).toEqual(TYPE.items)
    // A snapshot, not a live reference.
    TYPE.items.push({ id: 'c', label: 'added later', order: 2 })
    expect(row.items).toHaveLength(2)
    TYPE.items.pop()
  })

  it('keys the draft to the asset current cycle', () => {
    const row = buildDraftRow({ asset: ASSET, type: TYPE, inspectorId: 'prof-1' })
    expect(row).toMatchObject({
      equipment_id: 'eq-1', location_id: 'loc-1', type_id: 'type-1',
      due_on: '2026-08-04', status: 'draft', results: {},
    })
  })

  it('throws when the type has no checklist items', () => {
    expect(() => buildDraftRow({ asset: ASSET, type: { ...TYPE, items: [] }, inspectorId: 'p' }))
      .toThrow(/checklist/i)
  })
})

describe('mergeTick', () => {
  const base = { a: { state: 'pass', at: 't0', by: 'p1' } }

  it('adds a new mark without disturbing existing ones', () => {
    const out = mergeTick(base, { itemId: 'b', state: 'pass', at: 't1', by: 'p1' })
    expect(out.a).toEqual(base.a)
    expect(out.b).toMatchObject({ state: 'pass', at: 't1', by: 'p1' })
  })

  it('overwrites a previous mark on the same item', () => {
    const out = mergeTick(base, { itemId: 'a', state: 'fail', note: 'frayed', at: 't2', by: 'p1' })
    expect(out.a).toMatchObject({ state: 'fail', note: 'frayed' })
  })

  it('does not mutate the input', () => {
    const snapshot = JSON.parse(JSON.stringify(base))
    mergeTick(base, { itemId: 'b', state: 'pass', at: 't1', by: 'p1' })
    expect(base).toEqual(snapshot)
  })

  it('drops the note when the item is marked pass', () => {
    const out = mergeTick(base, { itemId: 'b', state: 'pass', note: 'leftover', at: 't', by: 'p' })
    expect(out.b).not.toHaveProperty('note')
  })
})

describe('isFullyMarked', () => {
  const items = [{ id: 'a' }, { id: 'b' }]
  it('is false while an item is unmarked', () => {
    expect(isFullyMarked(items, { a: { state: 'pass' } })).toBe(false)
  })
  it('is true once every item carries a valid state', () => {
    expect(isFullyMarked(items, { a: { state: 'pass' }, b: { state: 'fail' } })).toBe(true)
  })
  it('ignores results for items not in the snapshot', () => {
    expect(isFullyMarked(items, { a: { state: 'pass' }, b: { state: 'pass' }, ghost: { state: 'pass' } })).toBe(true)
  })
})
```

- [ ] **Step 2: Run, watch it fail**

- [ ] **Step 3: Implement**

```js
// EQUIP-MAINT.2 — draft construction and tick merging for an
// inspection run. Pure: no DB, no clock. Callers pass `at`.

/**
 * Build the row for a new draft inspection.
 * `items` is a deep copy of the type's checklist AT THIS MOMENT — the
 * whole point of the snapshot is that an admin editing the type
 * mid-walk-round cannot shift state under the inspector.
 */
export function buildDraftRow({ asset, type, inspectorId }) {
  const items = Array.isArray(type?.items) ? type.items : []
  if (items.length === 0) {
    throw new Error(`Equipment type "${type?.name ?? '?'}" has no checklist items.`)
  }
  return {
    location_id: asset.location_id,
    equipment_id: asset.id,
    type_id: type.id,
    inspector_id: inspectorId,
    due_on: asset.next_due_on,
    items: JSON.parse(JSON.stringify(items)),
    results: {},
    status: 'draft',
  }
}

/** Apply one mark to a results object, returning a new object. */
export function mergeTick(results, { itemId, state, note, at, by }) {
  const entry = { state, at, by }
  // A note only means something on a fail; carrying one on a pass
  // would leak a stale explanation into the issue description if the
  // inspector changed their mind.
  if (state === 'fail' && note) entry.note = note
  return { ...(results || {}), [itemId]: entry }
}

/** Does every item in the snapshot carry a valid pass/fail mark? */
export function isFullyMarked(items, results) {
  if (!Array.isArray(items)) return false
  return items.every((it) => {
    const s = results?.[it.id]?.state
    return s === 'pass' || s === 'fail'
  })
}
```

- [ ] **Step 4: Run and commit**

```bash
npx vitest run src/lib/equipment-inspections.test.js
git add src/lib/equipment-inspections.js src/lib/equipment-inspections.test.js
git commit -m "EQUIP-MAINT.2 — draft snapshot + tick merge"
```

---

## Task 4: Due list route

**Files:** Create `src/app/api/equipment/due/route.js`

- [ ] **Step 1: Write the route**

```js
// EQUIP-MAINT.2 — what is due for inspection at the active location.
//
// Computed, not pre-generated: one indexed comparison against
// equipment.next_due_on. Nothing to orphan when kit is retired or
// re-typed.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { listDueEquipment, listOutOfServiceEquipment, getSettings } from '@/lib/equipment-db'
import { dublinTodayStr } from '@/lib/dublin-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, locationId }) => {
    const settings = await getSettings(db, locationId)
    // Dormant location: no settings row or switched off. Return an
    // explicit shape rather than an empty list, so the UI can say
    // "not set up" instead of "nothing due".
    if (!settings || !settings.enabled) {
      return NextResponse.json({
        success: true,
        data: { enabled: false, today: dublinTodayStr(), due: [], outOfService: [] },
      })
    }

    const today = dublinTodayStr()
    const [due, outOfService] = await Promise.all([
      listDueEquipment(db, locationId, today),
      listOutOfServiceEquipment(db, locationId),
    ])

    return NextResponse.json({
      success: true,
      data: { enabled: true, today, inspectionDayOfWeek: settings.inspection_day_of_week, due, outOfService },
    })
  }
)
```

- [ ] **Step 2: Verify and commit**

```bash
npm run lint && npm run check:route-guards
git add src/app/api/equipment/due
git commit -m "EQUIP-MAINT.2 — due list route"
```

---

## Task 5: Draft create-or-fetch route

**Files:** Create `src/app/api/equipment/[id]/inspection/route.js`

- [ ] **Step 1: Write the route**

```js
// EQUIP-MAINT.2 — open (or resume) the inspection for an asset's
// current cycle.
//
// Lazily created on first open so an abandoned walk-round leaves a
// draft with ticks, not nothing — and so nothing is pre-generated for
// assets nobody inspects.
//
// Idempotent by construction: unique (equipment_id, due_on) means a
// double-tap returns the same draft rather than minting a second.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getEquipment, getType, getDraftFor, insertDraft } from '@/lib/equipment-db'
import { buildDraftRow } from '@/lib/equipment-inspections'
import { EQUIPMENT_STATUS } from '@/lib/equipment'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, user, locationId, params }) => {
    const asset = await getEquipment(db, params?.id)
    // 404 not 403 — ids must not be enumerable.
    if (!asset || asset.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    if (asset.status !== EQUIPMENT_STATUS.IN_SERVICE) {
      return NextResponse.json(
        { success: false, error: 'This equipment is not in service.' },
        { status: 409 }
      )
    }

    const existing = await getDraftFor(db, { equipmentId: asset.id, dueOn: asset.next_due_on })
    if (existing) {
      if (existing.status === 'submitted') {
        return NextResponse.json(
          { success: false, error: 'This inspection has already been submitted.' },
          { status: 409 }
        )
      }
      return NextResponse.json({ success: true, data: existing })
    }

    const type = await getType(db, asset.type_id)
    if (!type) {
      return NextResponse.json({ success: false, error: 'Equipment type not found.' }, { status: 404 })
    }

    let row
    try {
      row = buildDraftRow({ asset, type, inspectorId: user.id })
    } catch (err) {
      // No checklist items on the type — an operator setup gap, not a
      // server fault. Say what to do about it.
      return NextResponse.json(
        { success: false, error: `${err.message} Add checks in Equipment setup first.` },
        { status: 409 }
      )
    }

    let draft
    try {
      draft = await insertDraft(db, row)
    } catch (err) {
      // Lost a race on unique (equipment_id, due_on) — the other
      // request won, so return its draft rather than erroring.
      if (err?.code === '23505') {
        const won = await getDraftFor(db, { equipmentId: asset.id, dueOn: asset.next_due_on })
        if (won) return NextResponse.json({ success: true, data: won })
      }
      throw err
    }

    return NextResponse.json({ success: true, data: draft })
  }
)
```

- [ ] **Step 2: Verify and commit**

```bash
npm run lint && npm run check:route-guards
git add "src/app/api/equipment/[id]/inspection"
git commit -m "EQUIP-MAINT.2 — create-or-resume an inspection draft"
```

---

## Task 6: Tick route

**Files:** Create `src/app/api/equipment/inspections/[id]/route.js`

- [ ] **Step 1: Write the route**

```js
// EQUIP-MAINT.2 — record one pass/fail mark on a draft inspection.
//
// One item per request, so a dropped connection loses one tick rather
// than the whole walk-round.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { getInspection, updateInspection } from '@/lib/equipment-db'
import { mergeTick } from '@/lib/equipment-inspections'
import { RESULT_NOTE_MAX } from '@/lib/equipment'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TickBody = z.object({
  itemId: z.string().min(1),
  state: z.enum(['pass', 'fail']),
  note: z.string().trim().max(RESULT_NOTE_MAX).optional().nullable(),
})

export const PATCH = withAuth(
  { permission: 'equipment_inspect', location: true, schema: TickBody },
  async ({ db, user, locationId, params, input }) => {
    const inspection = await getInspection(db, params?.id)
    if (!inspection || inspection.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    if (inspection.status !== 'draft') {
      return NextResponse.json(
        { success: false, error: 'This inspection has already been submitted.' },
        { status: 409 }
      )
    }
    // The mark must correspond to an item in THIS run's snapshot —
    // otherwise a stale client could write keys that no longer exist.
    if (!inspection.items.some((it) => it.id === input.itemId)) {
      return NextResponse.json(
        { success: false, error: 'That check is not part of this inspection.' },
        { status: 400 }
      )
    }
    if (input.state === 'fail' && !input.note?.trim()) {
      return NextResponse.json(
        { success: false, error: 'A fault needs a short note describing the problem.' },
        { status: 400 }
      )
    }

    const results = mergeTick(inspection.results, {
      itemId: input.itemId,
      state: input.state,
      note: input.note?.trim() || undefined,
      at: new Date().toISOString(),
      by: user.id,
    })

    const updated = await updateInspection(db, inspection.id, { results })
    return NextResponse.json({ success: true, data: updated })
  }
)
```

`new Date().toISOString()` here is a **timestamp**, not a date extraction — the guardrail lint only blocks `.toISOString().slice/split`. This is correct and intentional.

- [ ] **Step 2: Verify and commit**

```bash
npm run lint && npm run check:guardrails && npm run check:route-guards
git add "src/app/api/equipment/inspections/[id]/route.js"
git commit -m "EQUIP-MAINT.2 — tick a checklist item"
```

---

## Task 7: Submit route — the heart of this PR

**Files:** Create `src/app/api/equipment/inspections/[id]/submit/route.js`

Read `src/app/api/issues/route.js:88-140` first — the photo upload + rollback loop is copied from there, deliberately.

- [ ] **Step 1: Write the route**

```js
// EQUIP-MAINT.2 — submit a completed inspection.
//
// ORDERING IS LOAD-BEARING. Create the issue (with its photos) FIRST,
// then mark the inspection submitted and roll the asset forward. If
// the issue insert fails the inspection stays 'draft' and nothing
// advances, so the inspector retries with their ticks intact.
// unique (equipment_id, due_on) stops a retry double-advancing.
//
// Photos upload only here, never on the draft: the bucket path is
// {location_id}/{issue_id}/… so no valid path exists until the issue
// does. That means no temp storage and no orphan-byte cleanup job.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getInspection, updateInspection, updateEquipment, getEquipment } from '@/lib/equipment-db'
import {
  validateResults, buildIssueDescription, rollForward, EQUIPMENT_STATUS,
} from '@/lib/equipment'
import {
  insertIssueWithAttachments, buildAttachmentPath, validateSubmission,
  MAX_PHOTOS_PER_ISSUE,
} from '@/lib/issues'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logAuditEvent } from '@/lib/audit'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// 3 x 10MB over 4G blows the 30s default — same headroom as the
// issues POST route.
export const maxDuration = 60

const STORAGE_BUCKET = 'issue-photos'

export const POST = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, user, locationId, params, request }) => {
    const inspection = await getInspection(db, params?.id)
    if (!inspection || inspection.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    if (inspection.status !== 'draft') {
      return NextResponse.json(
        { success: false, error: 'This inspection has already been submitted.' },
        { status: 409 }
      )
    }

    let form
    try { form = await request.formData() }
    catch {
      return NextResponse.json(
        { success: false, error: 'Expected multipart/form-data.' },
        { status: 400 }
      )
    }

    const takeOutOfService = String(form.get('takeOutOfService') || '') === 'true'
    const extraNote = String(form.get('note') || '')

    // Results come from the client as JSON so the whole run submits
    // atomically even if individual ticks were lost to a flaky
    // connection.
    let results
    try { results = JSON.parse(String(form.get('results') || '{}')) }
    catch {
      return NextResponse.json({ success: false, error: 'Malformed results.' }, { status: 400 })
    }

    const check = validateResults({ items: inspection.items, results })
    if (!check.ok) {
      return NextResponse.json(
        { success: false, error: check.error, ...(check.missing ? { missing: check.missing } : {}) },
        { status: 400 }
      )
    }

    const asset = inspection.equipment
    const type = inspection.equipment_types

    // Compute the next due date BEFORE any write, so an invalid
    // interval fails the request cleanly instead of half-way through.
    let nextDueOn
    try {
      nextDueOn = rollForward({
        dueOn: inspection.due_on,
        intervalWeeks: type?.interval_weeks,
        today: dublinTodayStr(),
      })
    } catch (err) {
      if (err instanceof RangeError) {
        return NextResponse.json(
          {
            success: false,
            error: 'This equipment type has an invalid inspection interval — fix it in Equipment setup.',
          },
          { status: 400 }
        )
      }
      throw err
    }

    // ---- faults: photos, then the issue --------------------------
    let issueId = null
    if (check.failed.length > 0) {
      const photoFiles = []
      for (let i = 0; i < MAX_PHOTOS_PER_ISSUE; i++) {
        const f = form.get(`photo_${i}`)
        if (f && typeof f === 'object' && 'size' in f && f.size > 0) photoFiles.push(f)
      }

      const description = buildIssueDescription({
        equipmentName: asset?.name || 'Equipment',
        typeName: type?.name || 'Unknown type',
        dueOn: inspection.due_on,
        failed: check.failed,
        extraNote,
      })

      const v = validateSubmission({
        description,
        photos: photoFiles.map((f) => ({
          filename: f.name || 'photo', size: f.size, type: (f.type || '').toLowerCase(),
        })),
      })
      if (!v.ok) {
        return NextResponse.json({ success: false, error: v.error, code: v.code }, { status: 400 })
      }

      const newIssueId = crypto.randomUUID()
      const uploadedPaths = []
      const attachments = []
      for (let i = 0; i < photoFiles.length; i++) {
        const file = photoFiles[i]
        const path = buildAttachmentPath({
          locationId,
          issueId: newIssueId,
          attachmentId: crypto.randomUUID(),
          filename: file.name || `photo-${i}`,
        })
        const ab = await file.arrayBuffer()
        const { error: upErr } = await db.storage
          .from(STORAGE_BUCKET)
          .upload(path, Buffer.from(ab), { contentType: file.type || 'image/jpeg', upsert: false })
        if (upErr) {
          for (const p of uploadedPaths) {
            await db.storage.from(STORAGE_BUCKET).remove([p]).catch(() => {})
          }
          return NextResponse.json(
            { success: false, error: `Photo ${i + 1} upload failed.`, code: 'photo_upload_failed' },
            { status: 500 }
          )
        }
        uploadedPaths.push(path)
        attachments.push({
          storage_path: path, bucket: STORAGE_BUCKET,
          size_bytes: file.size, mime_type: (file.type || 'image/jpeg').toLowerCase(),
        })
      }

      const out = await insertIssueWithAttachments(db, {
        locationId,
        submitterId: user.id,
        description: v.normalised.description,
        attachments,
        equipmentId: asset?.id,
      })
      if (!out.ok) {
        for (const p of uploadedPaths) {
          await db.storage.from(STORAGE_BUCKET).remove([p]).catch(() => {})
        }
        // Inspection stays 'draft' — the inspector keeps their ticks
        // and can retry.
        return NextResponse.json({ success: false, error: out.error }, { status: out.status || 500 })
      }
      issueId = out.issue.id

      // The owner notification rides the EXISTING issues push — no new
      // category. Best-effort: never block the response.
      try {
        await sendPushToRolesAtLocation(locationId, ['owner', 'master'], {
          title: 'Equipment fault reported',
          body: `${asset?.name || 'Equipment'} failed inspection.`,
          data: { type: 'issue', issueId },
          category: 'notify_issue_submitted',
        })
      } catch (err) {
        logWarn('equipment', 'fault push failed', { issueId, error: err.message })
      }
    }

    // ---- now commit the inspection + the asset --------------------
    const submitted = await updateInspection(db, inspection.id, {
      results,
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      inspector_id: user.id,
      issue_id: issueId,
    })

    const assetPatch = {
      last_inspected_on: dublinTodayStr(),
      next_due_on: nextDueOn,
    }
    if (takeOutOfService && issueId) {
      assetPatch.status = EQUIPMENT_STATUS.OUT_OF_SERVICE
      assetPatch.out_of_service_issue_id = issueId
    }
    await updateEquipment(db, asset.id, assetPatch)

    await logAuditEvent({
      category: 'business',
      action: 'equipment.inspection_submitted',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: asset?.name, resource: `equipment/${asset?.id}` },
      locationId,
      details: {
        inspection_id: submitted.id,
        due_on: inspection.due_on,
        failed_count: check.failed.length,
        issue_id: issueId,
        out_of_service: Boolean(assetPatch.status),
        next_due_on: nextDueOn,
      },
    })

    return NextResponse.json({
      success: true,
      data: { inspection: submitted, issueId, nextDueOn, outOfService: Boolean(assetPatch.status) },
    })
  }
)
```

- [ ] **Step 2: Confirm `sendPushToRolesAtLocation`'s real signature**

Run: `grep -n "export async function sendPushToRolesAtLocation" -A 14 src/lib/push.js`

The category key `notify_issue_submitted` must already exist in `MOBILE_PERMISSIONS` — it does (PR 1 reused it deliberately). **An unregistered category resolves FALSE for every role but master**, meaning the push silently reaches only the person who tested it. Do not invent a new category here.

If the real signature differs from the call above, follow the real one.

- [ ] **Step 3: Verify and commit**

```bash
npm run lint && npm run check:route-guards && npm run check:guardrails && npm run build
git add "src/app/api/equipment/inspections/[id]/submit"
git commit -m "EQUIP-MAINT.2 — submit an inspection, raise the fault, roll the schedule"
```

---

## Task 8: Return the asset to service when the issue resolves

**Files:** Modify `src/app/api/issues/[id]/resolve/route.js`

- [ ] **Step 1: Write the failing test**

Add to `src/app/api/issues/[id]/resolve/route.test.js`:

```js
it('returns the asset to service when the resolved issue is what removed it', async () => {
  getInboxIssue.mockResolvedValue({ ...ISSUE, equipment_id: 'eq-1' })
  getEquipment.mockResolvedValue({
    id: 'eq-1', status: 'out_of_service', out_of_service_issue_id: 'issue-1',
  })
  await POST(req({ notes: 'Belt replaced' }), { params: { id: 'issue-1' } })
  expect(updateEquipment).toHaveBeenCalledWith(expect.anything(), 'eq-1', {
    status: 'in_service', out_of_service_issue_id: null,
  })
})

it('leaves an asset alone when a DIFFERENT issue took it off the floor', async () => {
  getInboxIssue.mockResolvedValue({ ...ISSUE, equipment_id: 'eq-1' })
  getEquipment.mockResolvedValue({
    id: 'eq-1', status: 'out_of_service', out_of_service_issue_id: 'issue-OTHER',
  })
  await POST(req({ notes: 'unrelated' }), { params: { id: 'issue-1' } })
  expect(updateEquipment).not.toHaveBeenCalled()
})

it('does not touch equipment for an ordinary issue with no equipment link', async () => {
  getInboxIssue.mockResolvedValue({ ...ISSUE, equipment_id: null })
  await POST(req({ notes: 'done' }), { params: { id: 'issue-1' } })
  expect(updateEquipment).not.toHaveBeenCalled()
})
```

Add `vi.mock('@/lib/equipment-db', () => ({ getEquipment: vi.fn(), updateEquipment: vi.fn() }))` and import them.

- [ ] **Step 2: Run, watch it fail**

- [ ] **Step 3: Implement**

After the successful resolve in the route, before the response:

```js
// EQUIP-MAINT.2 — an equipment fault resolving puts the asset back on
// the floor. shouldReturnToService demands an exact issue-id match, so
// kit taken off manually (no linked issue) stays off, and resolving an
// unrelated issue on the same asset does nothing. Best-effort: a
// failure here must not fail the resolve the operator just performed.
if (existing.equipment_id) {
  try {
    const asset = await getEquipment(db, existing.equipment_id)
    if (shouldReturnToService(asset, existing.id)) {
      await updateEquipment(db, asset.id, {
        status: EQUIPMENT_STATUS.IN_SERVICE,
        out_of_service_issue_id: null,
      })
    }
  } catch (err) {
    logWarn('equipment', 'return-to-service failed', {
      issueId: existing.id, equipmentId: existing.equipment_id, error: err.message,
    })
  }
}
```

> **⚠️ CONFIRMED GAP — do this first or the whole hook is dead code.**
> `getInboxIssue` selects `HANDLER_SELECT_COLUMNS` (`src/lib/issues.js:254-263`),
> and that list is **explicit and does NOT include `equipment_id`**. So
> `existing.equipment_id` reads as `undefined`, the `if` never enters, and the
> asset silently stays off the floor forever — with no error anywhere.
>
> **Add `equipment_id` to `HANDLER_SELECT_COLUMNS`** as part of this task, and
> write a test asserting the column list contains it, so a future tidy-up of
> that string can't quietly re-break the hook.

- [ ] **Step 4: Run and commit**

```bash
npx vitest run "src/app/api/issues/[id]/resolve/route.test.js"
git add "src/app/api/issues/[id]/resolve" src/lib/issues.js
git commit -m "EQUIP-MAINT.2 — resolving an equipment fault returns the asset to service"
```

---

## Task 9: Route tests for the run

**Files:** Create tests for the four new routes.

- [ ] **Step 1: Write them**

Reuse the mock harness from `src/app/api/equipment/[id]/route.test.js` (its `withAuth` mock parses the Zod `schema` into `ctx.input` — the repo's older harness does not).

Cover, at minimum:

**Draft route** — a cross-location asset returns **404 not 403**; an out-of-service asset returns 409; a second POST returns the SAME draft id rather than creating another; a type with no items returns 409 naming the setup gap.

**Tick route** — an itemId absent from the snapshot returns 400; `state: 'fail'` with no note returns 400; a submitted inspection returns 409; a successful tick preserves previously-marked items.

**Submit route** — an unmarked item returns 400 and lists `missing`; an all-pass run creates **no** issue and still rolls `next_due_on`; a run with a failure creates exactly **one** issue carrying `equipment_id`; `takeOutOfService` without any failure does **not** take the asset out of service; a type with `interval_weeks: 0` returns **400, not 500**; a failed issue insert leaves the inspection `draft`.

**Due route** — a dormant location returns `enabled: false`.

- [ ] **Step 2: Prove they are not vacuous**

Break one behaviour (e.g. make submit skip the `validateResults` check), watch the relevant test fail, revert. Report what you saw.

- [ ] **Step 3: Run and commit**

```bash
npx vitest run src/app/api/equipment
git add src/app/api/equipment
git commit -m "EQUIP-MAINT.2 — route tests for the inspection run"
```

---

## Task 10: Web UI — due list and runner

**Files:** Create `src/components/maintenance/DueTab.jsx`, `src/components/maintenance/InspectionRunner.jsx`; modify `MaintenanceView.jsx`

- [ ] **Step 1: Replace the Due stub**

`MaintenanceView.jsx` currently renders a placeholder card on the Due tab. Replace it with `<DueTab />`. The Due tab is visible to anyone with `equipment_inspect` — do NOT gate it behind `canAdmin`.

- [ ] **Step 2: Build `DueTab`**

Fetches `GET /api/equipment/due`. Three states:
- `enabled: false` → an `EmptyState` saying inspections aren't set up for this studio yet (and, if the viewer is an admin, pointing at the Types tab).
- Empty due list → an `EmptyState` confirming nothing is due.
- Otherwise a `Table` of due assets, overdue first. **Every column needs `render` or `accessor`** — `key` alone renders blank (this shipped a bug in PR 1). Columns: name (`accessor: 'name'`), type (`render`), zone (`render`), next due with an amber chip when overdue (`render`), and an "Inspect" `Button` (`render`, `type="button"`).

Below it, an "Out of service" section listing `outOfService` assets with a red chip and a link to the issue.

- [ ] **Step 3: Build `InspectionRunner`**

Opens in a `Modal`. On open, `POST /api/equipment/{id}/inspection` to create-or-resume, then render the snapshot's items in `order`.

Per item: Pass / Fail buttons (both `type="button"`). Choosing Fail reveals a required note field. Each choice `PATCH`es the tick immediately so progress survives a closed tab — but hold the full `results` in local state too, because submit posts them together.

Footer: photo picker (max 3, only meaningful when something failed), an optional overall note, a "Take out of service" checkbox (disabled unless at least one item failed — the API ignores the flag without a fault, and a disabled control explains why better than a silent no-op), and Submit.

Submit posts multipart to `…/submit` with `results` as JSON plus `photo_0..2`. On a 400 carrying `missing`, highlight those rows rather than showing a bare error. On success, close and refresh the due list.

Wrap every fetch in `try`/`catch` so a network failure surfaces an error instead of a permanent spinner.

- [ ] **Step 4: Verify and commit**

```bash
npm run build && npm run check:guardrails && npm run lint
git add src/components/maintenance src/app/maintenance
git commit -m "EQUIP-MAINT.2 — web due list + inspection runner"
```

---

## Task 11: Mobile — due list and run screen

**Files:** Create `mobile/lib/maintenance-api.js`, `mobile/app/maintenance/{_layout,index,[id]}.jsx`, `mobile/components/dashboard/DueInspectionsCard.jsx`

Read `mobile/app/checklists/today.jsx` and `mobile/lib/checklists-api.js` first — mirror their structure, and `mobile/app/issues/new.jsx` for the photo-picker pattern.

- [ ] **Step 1: API wrappers**

`mobile/lib/maintenance-api.js` must build headers via `authHeaders()`/`api()` from the existing mobile helpers — a hand-rolled `Bearer` drops `x-impersonate-target` and breaks "View as user". Wrap the four routes.

- [ ] **Step 2: Screens**

`index.jsx` — the due list, grouped overdue-first, tapping a row opens the run. `[id].jsx` — the run: items with Pass/Fail, required note on fail, photo attach, out-of-service toggle, submit. `_layout.jsx` — matching the `checklists/_layout.jsx` shape.

Gate on the `equipment_inspect` mobile permission.

- [ ] **Step 3: Dashboard card**

`DueInspectionsCard.jsx` alongside `TodayChecklistCard` — "N due for inspection", tapping opens the list. Render nothing when the count is zero or the location is dormant.

- [ ] **Step 4: Verify and commit**

```bash
npm run check:mobile-imports && npm run check:mobile-parity && npm run build
git add mobile
git commit -m "EQUIP-MAINT.2 — mobile due list, inspection run, dashboard card"
```

If you added anything to `shared/`, re-run `check:mobile-imports` — a mobile import of a non-exported name resolves to `undefined` and only crashes at runtime.

---

## Task 12: OpenAPI + full CI

**Files:** Modify `src/lib/openapi.js`

- [ ] **Step 1: Register the four new routes**

`/api/equipment/due` (GET), `/api/equipment/{id}/inspection` (POST), `/api/equipment/inspections/{id}` (PATCH), `/api/equipment/inspections/{id}/submit` (POST). Match the surrounding style.

- [ ] **Step 2: Full CI mirror + build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
npm run build
```

- [ ] **Step 3: Commit, push, open the PR**

```bash
git add src/lib/openapi.js
git commit -m "EQUIP-MAINT.2 — register inspection routes in openapi"
git push -u origin HEAD
gh pr create --base main --title "EQUIP-MAINT.2 — the inspection run" --fill
```

Report the PR URL.

---

## Verification checklist before claiming done

- [ ] An all-pass inspection creates **no** issue but still advances `next_due_on`
- [ ] A failed inspection creates **exactly one** issue carrying `equipment_id`
- [ ] `interval_weeks: 0` returns **400, not 500**
- [ ] A cross-location asset returns **404, not 403** on every new route
- [ ] Resolving the linked issue returns the asset to service; resolving an unrelated one does not
- [ ] Every `Table` column has `render` or `accessor`
- [ ] All six CI checks plus `npm run build` pass

## Deferred to PR 3

The reminder and sweep crons, `notify_inspection_due` / `notify_inspection_overdue` keys (each needing a `cron_heartbeats` row and a `stampHeartbeat` call), and the compliance log tab with CSV export.
