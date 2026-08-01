# Equipment Maintenance — PR 3 (crons, notifications, compliance log) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push a reminder on the studio's inspection day, chase owners when an inspection wasn't submitted, and give owners a filterable history of every inspection.

**Architecture:** Two daily Vercel crons, both `CRON_SECRET`-gated and both stamping a heartbeat. All decision logic (is today the inspection day, what's outstanding, what the push should say) lives in a pure `src/lib/equipment-cron.js` so it can be tested without a database or a clock.

**Tech Stack:** Next.js 16 route handlers, Supabase, Vercel Cron, Expo push, Vitest.

**Scope:** PR 3 of 3, and the last. **CSV export is explicitly out of scope** — the operator asked for the log on screen only.

**Spec:** `docs/superpowers/specs/2026-07-31-equipment-maintenance-inspections-design.md`
**Prior PRs:** #1184 (schema + register admin) and #1185 (the inspection run), both merged.

---

## What already exists — do not rebuild

| Thing | Where |
|---|---|
| `equipment_settings.inspection_day_of_week` + `enabled` | mig 467 |
| `equipment_inspections` with `status`, `due_on`, `submitted_at`, `issue_id` | mig 467 |
| `listDueEquipment`, `getSettings`, `getInspection`, … | `src/lib/equipment-db.js` |
| `isDue`, `rollForward`, `dowOf` | `src/lib/equipment.js` |
| `/maintenance` tab shell with Due / Equipment / Types | `src/components/maintenance/MaintenanceView.jsx` |
| `stampHeartbeat(name)` | `src/lib/cron-heartbeat.js` |
| `sendPushToRolesAtLocation(locationId, roles, payload)`, `sendPush`, `sendPushOnce` | `src/lib/push.js`, `src/lib/push-dedup.js` |

---

## The four things that will bite

**1. An UNREGISTERED push category fails CLOSED, not open.** `resolvePermission`'s last tier is `defaults[role][key] === true`, so a `notify_<name>` that isn't in `MOBILE_PERMISSIONS` **and** in `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE` resolves **false for every role except `master`** — which bypasses the tiers. The push then reaches only the person who tested it (a master) and silently nobody else. This has bitten this repo twice, on `app_update` and `test`, within a day of each other. Both new keys must be registered in **all six** role blocks (`master`, `staff`, `reception`, `head_coach`, `manager`, `owner`).

**2. A cron with a `cron_heartbeats` row MUST call `stampHeartbeat(name)` on success**, or it reads "stale" while running perfectly and un1t-sentinel alerts on it. `grep -L stampHeartbeat src/app/api/cron/*/route.js` should list only `health-check` and `ad-insights-backfill`.

**3. Seed the heartbeat rows BEFORE the crons deploy.** If the migration lands after the cron starts ticking, `stampHeartbeat`'s UPDATE matches zero rows, logs a warning, and the cron is invisible to `cron_health` — the exact silent-death failure mode the heartbeat table exists to prevent. Apply mig 470 before merging.

**4. Vercel cron schedules are UTC; the business runs on Dublin time.** A fixed UTC hour drifts by one hour against Dublin across the BST boundary. That is acceptable here — a reminder at 07:00 vs 08:00 local is immaterial — but the *day* must not drift, which is why both crons run mid-day-ish in UTC terms rather than near midnight, and why every date decision goes through `dublinTodayStr()`. Do not schedule either cron between 22:00 and 02:00 UTC.

Also standing: `CRON_SECRET` Bearer auth on both; per-row error isolation so one bad location can't stop the loop; `{ success, data?, error? }` response shape; `Table` columns resolve via `render`/`accessor`, never `key` alone.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/470_equipment_cron_heartbeats.sql` | Seed two `cron_heartbeats` rows. |
| `shared/permissions.js` | `notify_inspection_due`, `notify_inspection_overdue` in all six mobile role blocks. |
| `src/lib/equipment-cron.js` | Pure: is today the inspection day, which assets are outstanding, push copy. |
| `src/lib/equipment-cron.test.js` | Unit tests. |
| `src/lib/equipment-db.js` | **Extend**: `listEnabledSettings`, `listOutstanding`, `listInspectionLog`. |
| `src/app/api/cron/equipment-inspection-reminder/route.js` | Morning reminder. |
| `src/app/api/cron/equipment-inspection-sweep/route.js` | Evening chase. |
| `vercel.json` | Two cron entries. |
| `src/app/api/equipment/inspections/route.js` | GET the compliance log. |
| `src/components/maintenance/LogTab.jsx` | The log tab. |
| `src/lib/openapi.js` | Register the log route. |

---

## Task 1: Migration 470 — seed the heartbeats

**Files:** Create `supabase/migrations/470_equipment_cron_heartbeats.sql`

- [ ] **Step 1: Confirm 470 is free**

`ls supabase/migrations | tail -2` → highest should be `469_equipment_asset_tag_reuse.sql`.

- [ ] **Step 2: Write it**

```sql
-- EQUIP-MAINT.3 — heartbeat rows for the two inspection crons.
--
-- A cron with no cron_heartbeats row makes stampHeartbeat()'s UPDATE
-- match zero rows: it logs a warning, never appears in cron_health, and
-- un1t-sentinel's stale-cron monitoring is blind to it. That is the
-- silent-death failure mode mig 053 exists to prevent, and mig 406 had
-- to retrofit four crons that shipped without it.
--
-- APPLY THIS BEFORE THE CRONS DEPLOY.
--
-- Both are daily: 86400 expected interval. Grace of 7200 (2h) mirrors
-- the daily Glofox crons (migs 172, 324) — generous enough that a
-- delayed Vercel tick doesn't page anyone.
--
-- last_ok_at defaults to NOW() so cron_health reports healthy until the
-- first real tick stamps it (same rationale as the mig 053 seeds).

insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) values
  ('equipment-inspection-reminder', 86400, 7200,
   'EQUIP-MAINT.3 — pushes "N due for inspection today" to equipment_inspect holders, on each location''s inspection weekday. Vercel cron 0 6 * * * UTC'),
  ('equipment-inspection-sweep',    86400, 7200,
   'EQUIP-MAINT.3 — evening chase: tells owner+master what was due and not submitted. Vercel cron 0 19 * * * UTC')
on conflict (name) do nothing;
```

- [ ] **Step 3: Apply and verify**

Apply via Supabase MCP `apply_migration` against **un1t-crm** (`iyvtbjjxdggiadzwwvdj` — confirm with `list_projects`; the sentinel project is `tpttqakxmyxrwnqjepfm`). Then `get_advisors` (type=security) — expect no new findings; this migration creates no objects.

Confirm with `execute_sql`:
```sql
select name, expected_interval_seconds, grace_seconds from public.cron_heartbeats
where name like 'equipment-inspection-%';
```
Expect two rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/470_equipment_cron_heartbeats.sql
git commit -m "EQUIP-MAINT.3 — seed cron heartbeats for the inspection crons (mig 470)"
```

---

## Task 2: Notification keys

**Files:** Modify `shared/permissions.js`

- [ ] **Step 1: Count the role blocks first**

Run: `grep -nE "^  [a-z_]+: \{" shared/permissions.js` inside `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE`. There are **six**: `master`, `staff`, `reception`, `head_coach`, `manager`, `owner`. Do not trust a list in a plan — count them. And note `src/lib/shared-permissions.test.js` now derives its roles from the map (PR #1183), so an omission *will* be caught — but only for keys, so still add both to every block.

- [ ] **Step 2: Add the keys**

In `MOBILE_PERMISSIONS`, near the other `isNotify` entries:

```js
// EQUIP-MAINT.3 — inspection reminders. Registered here because an
// UNREGISTERED category resolves FALSE for every role but master, so
// an unregistered push reaches only whoever tested it and silently
// nobody else (bit app_update and test within a day of each other).
{ key: 'notify_inspection_due',     label: '… Equipment inspections due', hint: 'Notify on your studio inspection day when equipment is due to be checked', mobileOnly: true, isNotify: true },
{ key: 'notify_inspection_overdue', label: '… Inspections not done',      hint: 'Notify owners when equipment was due for inspection and no one submitted it', mobileOnly: true, isNotify: true },
```

In `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE`, for **all six** blocks:
- `notify_inspection_due: true` for every role — anyone who can inspect should hear that it's inspection day.
- `notify_inspection_overdue`: `true` for `master` and `owner`; `false` for `staff`, `reception`, `head_coach`, `manager`. This is a chase aimed at the people accountable for it, not a broadcast.

- [ ] **Step 3: Verify**

```bash
npm run check:mobile-parity && npm test -- shared
```
Both must pass. If a test says a role is missing a key, add it — never relax the test.

- [ ] **Step 4: Commit**

```bash
git add shared/permissions.js
git commit -m "EQUIP-MAINT.3 — notify_inspection_due + notify_inspection_overdue"
```

---

## Task 3: Pure cron logic

**Files:** Create `src/lib/equipment-cron.js`, `src/lib/equipment-cron.test.js`

- [ ] **Step 1: Write the failing test**

```js
// EQUIP-MAINT.3 — unit tests for the inspection cron decision logic.
// Pure: no DB, no clock. Every function takes `today` explicitly.

import { describe, it, expect } from 'vitest'
import {
  isInspectionDay,
  selectOutstanding,
  buildReminderBody,
  buildOverdueBody,
} from './equipment-cron.js'

describe('isInspectionDay', () => {
  // 2026-08-04 is a Tuesday (dow 2).
  it('is true when today falls on the configured weekday', () => {
    expect(isInspectionDay({ inspection_day_of_week: 2, enabled: true }, '2026-08-04')).toBe(true)
  })

  it('is false on any other weekday', () => {
    expect(isInspectionDay({ inspection_day_of_week: 2, enabled: true }, '2026-08-05')).toBe(false)
  })

  it('is false when the location is disabled, even on the right weekday', () => {
    expect(isInspectionDay({ inspection_day_of_week: 2, enabled: false }, '2026-08-04')).toBe(false)
  })

  it('is false for a missing settings row', () => {
    expect(isInspectionDay(null, '2026-08-04')).toBe(false)
  })

  it('handles Sunday (dow 0) rather than treating it as falsy', () => {
    // 2026-08-02 is a Sunday.
    expect(isInspectionDay({ inspection_day_of_week: 0, enabled: true }, '2026-08-02')).toBe(true)
  })
})

describe('selectOutstanding', () => {
  const assets = [
    { id: 'a', name: 'Treadmill 1', next_due_on: '2026-08-04', status: 'in_service' },
    { id: 'b', name: 'Rower 2',     next_due_on: '2026-07-28', status: 'in_service' },
    { id: 'c', name: 'Bike 3',      next_due_on: '2026-09-01', status: 'in_service' },
  ]

  it('returns due assets with no submitted inspection for their cycle', () => {
    const out = selectOutstanding({ assets, submitted: [], today: '2026-08-04' })
    expect(out.map((a) => a.id)).toEqual(['b', 'a'])  // most overdue first
  })

  it('excludes an asset whose current cycle was submitted', () => {
    const submitted = [{ equipment_id: 'a', due_on: '2026-08-04' }]
    const out = selectOutstanding({ assets, submitted, today: '2026-08-04' })
    expect(out.map((a) => a.id)).toEqual(['b'])
  })

  it('does NOT count a submission for a DIFFERENT cycle as covering this one', () => {
    // Submitted last cycle, but the asset has rolled forward and is due again.
    const submitted = [{ equipment_id: 'b', due_on: '2026-06-30' }]
    const out = selectOutstanding({ assets, submitted, today: '2026-08-04' })
    expect(out.map((a) => a.id)).toEqual(['b', 'a'])
  })

  it('excludes assets not yet due', () => {
    const out = selectOutstanding({ assets, submitted: [], today: '2026-08-04' })
    expect(out.map((a) => a.id)).not.toContain('c')
  })

  it('returns [] when nothing is outstanding', () => {
    const submitted = [
      { equipment_id: 'a', due_on: '2026-08-04' },
      { equipment_id: 'b', due_on: '2026-07-28' },
    ]
    expect(selectOutstanding({ assets, submitted, today: '2026-08-04' })).toEqual([])
  })
})

describe('buildReminderBody', () => {
  it('names the single asset when there is exactly one', () => {
    expect(buildReminderBody([{ name: 'Treadmill 1' }])).toMatch(/Treadmill 1/)
  })

  it('counts without listing when there are several', () => {
    const body = buildReminderBody([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    expect(body).toMatch(/3/)
    expect(body).not.toMatch(/\ba\b.*\bb\b.*\bc\b/)
  })

  it('uses a singular noun for one and a plural for many', () => {
    expect(buildReminderBody([{ name: 'x' }])).not.toMatch(/pieces/)
    expect(buildReminderBody([{ name: 'x' }, { name: 'y' }])).toMatch(/pieces/)
  })
})

describe('buildOverdueBody', () => {
  it('states the count and that nothing was submitted', () => {
    const body = buildOverdueBody([{ name: 'a' }, { name: 'b' }])
    expect(body).toMatch(/2/)
    expect(body.length).toBeLessThanOrEqual(180)
  })

  it('stays within a push-sized string even with many assets', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `Asset ${i}` }))
    expect(buildOverdueBody(many).length).toBeLessThanOrEqual(180)
  })
})
```

- [ ] **Step 2: Run, watch it fail**

- [ ] **Step 3: Implement**

```js
// EQUIP-MAINT.3 — decision logic for the two inspection crons.
//
// Pure: no DB, no clock, no push. `today` is always passed in as a
// Dublin calendar string (YYYY-MM-DD) so every branch is testable and
// nothing depends on the server's timezone.

import { dowOf } from './equipment-dates.js'

/** Is `today` this location's inspection weekday, and is it switched on? */
export function isInspectionDay(settings, today) {
  if (!settings || !settings.enabled) return false
  const dow = settings.inspection_day_of_week
  // Explicit null/undefined check, not falsy — 0 is Sunday.
  if (dow === null || dow === undefined) return false
  return dowOf(today) === dow
}

/**
 * Assets that are due and have no SUBMITTED inspection for their
 * current cycle, most overdue first.
 *
 * Matching is on (equipment_id, due_on) — a submission for an earlier
 * cycle must not count as covering the current one, or an asset that
 * rolled forward would never be chased again.
 */
export function selectOutstanding({ assets = [], submitted = [], today }) {
  const done = new Set(submitted.map((s) => `${s.equipment_id}::${s.due_on}`))
  return assets
    .filter((a) => a.status === 'in_service')
    .filter((a) => a.next_due_on <= today)
    .filter((a) => !done.has(`${a.id}::${a.next_due_on}`))
    .sort((x, y) => (x.next_due_on < y.next_due_on ? -1 : x.next_due_on > y.next_due_on ? 1 : 0))
}

/** Push body for the inspection-day reminder. */
export function buildReminderBody(assets = []) {
  if (assets.length === 1) return `${assets[0].name} is due for inspection today.`
  return `${assets.length} pieces of equipment are due for inspection today.`
}

/**
 * Push body for the evening chase. Capped so it stays a push, not an
 * essay — the operator opens the app for the detail.
 */
export function buildOverdueBody(assets = []) {
  const n = assets.length
  const noun = n === 1 ? 'piece of equipment' : 'pieces of equipment'
  return `${n} ${noun} were due for inspection and no one submitted a check.`
}
```

- [ ] **Step 4: Run and commit**

```bash
npx vitest run src/lib/equipment-cron.test.js
TZ=America/Los_Angeles npx vitest run src/lib/equipment-cron.test.js
git add src/lib/equipment-cron.js src/lib/equipment-cron.test.js
git commit -m "EQUIP-MAINT.3 — pure cron decision logic"
```

---

## Task 4: DB helpers for the crons and the log

**Files:** Modify `src/lib/equipment-db.js`

- [ ] **Step 1: Add three helpers**

```js
// ---- cron + compliance log -----------------------------------------

/** Every location with the feature switched on. Small set (one row per location). */
export async function listEnabledSettings(db) {
  const { data, error } = await db
    .from('equipment_settings')
    .select('location_id, inspection_day_of_week, enabled')
    .eq('enabled', true)
  if (error) throw error
  return data || []
}

/**
 * Submitted inspections at a location covering the cycles currently in
 * play. Bounded by `sinceDueOn` so this stays small — the sweep only
 * cares about cycles that are due now, not the whole history.
 */
export async function listSubmittedSince(db, locationId, sinceDueOn) {
  const { data, error } = await db
    .from('equipment_inspections')
    .select('equipment_id, due_on')
    .eq('location_id', locationId)
    .eq('status', 'submitted')
    .gte('due_on', sinceDueOn)
    .order('due_on', { ascending: false })
  if (error) throw error
  return data || []
}

/**
 * All non-retired assets at a location, for the crons' outstanding
 * calculation. 30-80 rows per studio, well under the 1000-row cap.
 */
export async function listActiveEquipment(db, locationId) {
  const { data, error } = await db
    .from('equipment')
    .select('id, name, status, next_due_on, type_id')
    .eq('location_id', locationId)
    .neq('status', 'retired')
    .order('next_due_on', { ascending: true })
  if (error) throw error
  return data || []
}

/**
 * The compliance log: submitted inspections newest first, with the
 * asset, the type and the inspector's name.
 *
 * Paginated with .range() because this DOES grow past the 1000-row cap
 * over time — 60 assets x fortnightly is ~1,500 rows a year.
 */
export async function listInspectionLog(db, locationId, { limit = 100, offset = 0, equipmentId = null } = {}) {
  let q = db
    .from('equipment_inspections')
    .select(
      'id, equipment_id, due_on, submitted_at, results, items, issue_id, ' +
      'equipment!equipment_id ( id, name, zone ), ' +
      'equipment_types!type_id ( id, name ), ' +
      'profiles!inspector_id ( id, full_name )',
      { count: 'exact' }
    )
    .eq('location_id', locationId)
    .eq('status', 'submitted')
  if (equipmentId) q = q.eq('equipment_id', equipmentId)
  const { data, error, count } = await q
    .order('submitted_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) throw error
  return { rows: data || [], total: count ?? 0 }
}
```

> **Note on the `profiles` embed:** this runs on the **service-role** client inside an `/api` route, where the embed is fine. The "never embed `profiles`" invariant applies to **mobile-direct** Supabase selects (the `authenticated` role has no grant, so the whole select 500s). Do not copy this helper into a mobile-direct call.

- [ ] **Step 2: Verify and commit**

```bash
npm run lint
git add src/lib/equipment-db.js
git commit -m "EQUIP-MAINT.3 — cron + compliance-log queries"
```

---

## Task 5: The reminder cron

**Files:** Create `src/app/api/cron/equipment-inspection-reminder/route.js`

Read `src/app/api/cron/checklist-sweep/route.js` first — it is the closest sibling and shows the auth, batching, per-row isolation and heartbeat shape.

- [ ] **Step 1: Write it**

```js
// EQUIP-MAINT.3 — Vercel cron, daily 06:00 UTC.
//
// For each enabled location whose inspection weekday is today (Dublin),
// count what is due and push it to everyone holding equipment_inspect.
// Silent when the count is zero — a "nothing due" push trains people to
// ignore the channel.
//
// Per-location error isolation: one bad location never stops the loop.
// Push delivery is best-effort; sendPush returns counts and never throws.
//
// Auth: CRON_SECRET Bearer, same as every other cron.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { listEnabledSettings, listActiveEquipment, listSubmittedSince } from '@/lib/equipment-db'
import { isInspectionDay, selectOutstanding, buildReminderBody } from '@/lib/equipment-cron'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logAuditEvent } from '@/lib/audit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ROLES = ['owner', 'master', 'manager', 'head_coach', 'staff', 'reception']

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const today = dublinTodayStr()
  const results = []

  let settingsRows = []
  try {
    settingsRows = await listEnabledSettings(db)
  } catch (err) {
    logWarn('equipment-cron', 'listEnabledSettings failed', { error: err.message })
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }

  for (const settings of settingsRows) {
    if (!isInspectionDay(settings, today)) continue
    try {
      const [assets, submitted] = await Promise.all([
        listActiveEquipment(db, settings.location_id),
        listSubmittedSince(db, settings.location_id, today),
      ])
      const outstanding = selectOutstanding({ assets, submitted, today })
      if (outstanding.length === 0) {
        results.push({ locationId: settings.location_id, due: 0, pushed: false })
        continue
      }

      await sendPushToRolesAtLocation(settings.location_id, ROLES, {
        title: 'Equipment inspections due',
        body: buildReminderBody(outstanding),
        data: { type: 'equipment_inspection' },
        // Registered in MOBILE_PERMISSIONS — an unregistered category
        // resolves false for every role but master.
        category: 'notify_inspection_due',
      })

      await logAuditEvent({
        category: 'business',
        action: 'equipment.inspection_reminder_sent',
        actor: null,
        target: { resource: `location/${settings.location_id}` },
        locationId: settings.location_id,
        details: { due_count: outstanding.length, today },
      })
      results.push({ locationId: settings.location_id, due: outstanding.length, pushed: true })
    } catch (err) {
      logWarn('equipment-cron', 'reminder failed for location', {
        locationId: settings.location_id, error: err.message,
      })
      results.push({ locationId: settings.location_id, error: err.message })
    }
  }

  await stampHeartbeat('equipment-inspection-reminder')
  return NextResponse.json({ success: true, data: { today, locations: results } })
}
```

- [ ] **Step 2: Confirm the push payload shape**

Run `grep -n "export async function sendPush" -A 25 src/lib/push.js` and confirm `category` belongs in the payload. If it is a separate option, move it — do not guess.

- [ ] **Step 3: Verify and commit**

```bash
npm run lint && npm run check:route-guards && npm run check:guardrails
grep -L stampHeartbeat src/app/api/cron/*/route.js
```
That last command must list only `health-check` and `ad-insights-backfill`.

```bash
git add src/app/api/cron/equipment-inspection-reminder
git commit -m "EQUIP-MAINT.3 — inspection-day reminder cron"
```

---

## Task 6: The sweep cron

**Files:** Create `src/app/api/cron/equipment-inspection-sweep/route.js`

- [ ] **Step 1: Write it**

Same shape as Task 5, with these differences:

- Runs for **every** enabled location, not only on the inspection weekday — an asset can be overdue on any day.
- Recipients are `['owner', 'master']` only, with category `notify_inspection_overdue`.
- Body from `buildOverdueBody`.
- Audit action `equipment.inspection_overdue`.
- **It flips no state.** The asset simply stays overdue and stays top of the due list. Do not mark anything `incomplete` — unlike `checklist_instances`, an inspection has no such status and adding one would need a migration.
- `stampHeartbeat('equipment-inspection-sweep')` at the end.

**Deduping — the signatures do not compose the way you'd expect.** Verified:

```js
sendPushToRolesAtLocation(locationId, roles, payload)   // fans out to roles, no dedup
sendPushOnce(db, eventKey, userIds, payload)            // dedups, but takes USER IDS
```

So you cannot wrap one in the other. Resolve the recipients first, then dedup:

```js
import { resolveRoleRecipientIds } from '@/lib/push'
import { sendPushOnce } from '@/lib/push-dedup'

const ids = await resolveRoleRecipientIds(db, settings.location_id, ['owner', 'master'])
if (ids.length) {
  await sendPushOnce(db, `equip-overdue:${settings.location_id}:${today}`, ids, {
    title: 'Equipment inspections not done',
    body: buildOverdueBody(outstanding),
    data: { type: 'equipment_inspection_overdue' },
    category: 'notify_inspection_overdue',
  })
}
```

The event key includes `today` so a Vercel retry on the same day is a no-op while tomorrow's run still fires.

**One behavioural difference to accept knowingly:** `sendPushToRolesAtLocation` passes `{ locationId }` through to `sendPush`, which scopes the per-category opt-out to *that* location. `sendPushOnce` takes no opts, so the opt-out is judged against the recipient's default assignment instead. For an owner/master chase that is immaterial — they hold one studio in practice — but do not copy this pattern to a fan-out across many locations without re-checking it.

- [ ] **Step 2: Verify and commit**

```bash
npm run lint && npm run check:route-guards
git add src/app/api/cron/equipment-inspection-sweep
git commit -m "EQUIP-MAINT.3 — overdue-inspection sweep cron"
```

---

## Task 7: Register the crons in `vercel.json`

**Files:** Modify `vercel.json`

- [ ] **Step 1: Add both entries**

```json
{ "path": "/api/cron/equipment-inspection-reminder", "schedule": "0 6 * * *" },
{ "path": "/api/cron/equipment-inspection-sweep",    "schedule": "0 19 * * *" }
```

Schedules are **UTC**. 06:00 UTC is 07:00 Dublin in summer, 06:00 in winter; 19:00 UTC is 20:00/19:00. Both are far from midnight, so the Dublin *day* never differs from the UTC day at tick time — which is what matters, since every date decision uses `dublinTodayStr()`.

- [ ] **Step 2: Verify the JSON parses and the names match the heartbeat rows**

```bash
node -e "const v=require('./vercel.json'); const n=v.crons.filter(c=>c.path.includes('equipment')); console.log(n); console.log('total crons:', v.crons.length)"
```

The two `path` basenames must match the two `cron_heartbeats.name` values from mig 470 exactly, or the heartbeat never stamps.

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "EQUIP-MAINT.3 — schedule the two inspection crons"
```

---

## Task 8: Compliance log route

**Files:** Create `src/app/api/equipment/inspections/route.js`

- [ ] **Step 1: Write it**

```js
// EQUIP-MAINT.3 — the compliance log: every submitted inspection at
// the active location, newest first. This is the view you put in front
// of an insurer or an H&S auditor.
//
// Paginated: unlike the register, this grows without bound (60 assets
// on a fortnightly cycle is ~1,500 rows a year) and every .select()
// caps at 1000 rows regardless of .limit().

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { listInspectionLog } from '@/lib/equipment-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_LIMIT = 100

export const GET = withAuth(
  { permission: 'equipment_admin', location: true },
  async ({ db, locationId, request }) => {
    const url = new URL(request.url)
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, MAX_LIMIT)
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
    const equipmentId = url.searchParams.get('equipmentId') || null

    const { rows, total } = await listInspectionLog(db, locationId, { limit, offset, equipmentId })
    return NextResponse.json({ success: true, data: { rows, total, limit, offset } })
  }
)
```

Gated on `equipment_admin` rather than `equipment_inspect`: the log is an oversight surface, and PR 1 set the split as admin = owner + master.

- [ ] **Step 2: Verify and commit**

```bash
npm run lint && npm run check:route-guards
git add src/app/api/equipment/inspections/route.js
git commit -m "EQUIP-MAINT.3 — compliance log route"
```

---

## Task 9: Log tab

**Files:** Create `src/components/maintenance/LogTab.jsx`; modify `MaintenanceView.jsx`

- [ ] **Step 1: Add the tab**

A fourth tab, **Log**, gated on `canAdmin` alongside Equipment and Types.

- [ ] **Step 2: Build `LogTab`**

Fetches `GET /api/equipment/inspections`. A `Table`, newest first:

| Column | Resolves via |
|---|---|
| Equipment | `render: (r) => r.equipment?.name` |
| Type | `render: (r) => r.equipment_types?.name` |
| Due | `accessor: 'due_on'` |
| Submitted | `render` — date portion of `submitted_at` |
| Inspector | `render: (r) => r.profiles?.full_name \|\| '—'` |
| Result | `render` — a green "Passed" chip, or a red "N fault(s)" chip counting `results` entries with `state === 'fail'` |

**Every column needs `render` or `accessor`** — `key` alone renders blank. Extend `src/components/maintenance/columns.test.js` with a `buildLogColumns` case, following the existing pattern.

Simple pagination (Previous / Next against `total`, both `type="button"`), plus an optional filter by equipment. Wrap every fetch in `try`/`catch` with loading cleared in a `finally`.

**No CSV export** — explicitly out of scope for this PR.

- [ ] **Step 3: Verify and commit**

```bash
npm run build && npm run check:guardrails && npm run lint
git add src/components/maintenance src/app/maintenance
git commit -m "EQUIP-MAINT.3 — compliance log tab"
```

---

## Task 10: Cron tests

**Files:** Create tests for both cron routes

- [ ] **Step 1: Write them**

Cover:
- **No `CRON_SECRET` / wrong bearer → 401** on both.
- Reminder: a location whose weekday is **not** today is skipped entirely (no push).
- Reminder: zero outstanding → **no push sent**.
- Reminder: outstanding → push sent once with category `notify_inspection_due`.
- Reminder: one location throwing does **not** stop the next location being processed (per-row isolation).
- Sweep: pushes only `owner` + `master`.
- Sweep: **flips no state** — assert no `update` call is made against `equipment` or `equipment_inspections`.
- Both: `stampHeartbeat` is called with the exact name matching mig 470.

- [ ] **Step 2: Prove they are not vacuous**

Break one behaviour (e.g. make the reminder push even when the count is zero), watch the relevant test fail, revert. Report what you saw.

- [ ] **Step 3: Run and commit**

```bash
npx vitest run src/app/api/cron/equipment-inspection-reminder src/app/api/cron/equipment-inspection-sweep
git add src/app/api/cron
git commit -m "EQUIP-MAINT.3 — cron tests"
```

---

## Task 11: OpenAPI, full CI, PR

**Files:** Modify `src/lib/openapi.js`

- [ ] **Step 1: Register `/api/equipment/inspections` (GET)**

Crons are not registered in openapi — check how existing cron routes are handled and follow suit.

- [ ] **Step 2: Full CI mirror + build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
npm run build
```

- [ ] **Step 3: Confirm every cron stamps**

```bash
grep -L stampHeartbeat src/app/api/cron/*/route.js
```
Must list only `health-check` and `ad-insights-backfill`.

- [ ] **Step 4: Commit, push, open the PR**

```bash
git add src/lib/openapi.js
git commit -m "EQUIP-MAINT.3 — register the compliance log route in openapi"
git push -u origin HEAD
gh pr create --base main --title "EQUIP-MAINT.3 — inspection crons, reminders and compliance log" --fill
```

Report the PR URL.

---

## Verification checklist before claiming done

- [ ] Mig 470 applied to prod; two `cron_heartbeats` rows confirmed by query
- [ ] `vercel.json` cron paths match those two names **exactly**
- [ ] Both notify keys present in all six mobile role blocks
- [ ] `grep -L stampHeartbeat src/app/api/cron/*/route.js` lists only the two known exemptions
- [ ] Zero-due produces no push
- [ ] The sweep changes no state
- [ ] Every `Table` column resolves via `render` or `accessor`
- [ ] All six CI checks plus `npm run build` pass

## Explicitly out of scope

**CSV export.** The operator asked for the log on screen only. Do not add an export button, an export route, or a `text/csv` response.
