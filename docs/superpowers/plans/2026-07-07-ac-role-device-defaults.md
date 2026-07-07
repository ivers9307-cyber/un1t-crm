# Role-level AC Device Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AC-unit allowlist come from a per-(location, role) default configured in the Roles tab, resolved through a three-tier stack (code default → role template → per-user override), so operators stop ticking devices on every profile.

**Architecture:** A new `ac_device_ids uuid[]` column on `location_role_permissions` (the existing per-(location, role, employment_type) template table) holds the role default. A pure `resolveAcAllowlist` helper in `shared/` mirrors `resolvePermission`'s tier order. `getCurrentUser` resolves the template AC list per location (employment-type variant over base) and carries it on the user; `authoriseDevice` and the device-list route consult the resolver. The Roles tab gets an AC-device picker; the per-profile StaffForm picker gains an explicit "inherit" state. A migration flips the blanket mig-210 empty-array backfill to `NULL` so existing staff inherit.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres), Vitest, `shared/permissions.js` (plain JS, web+mobile), Zod (`@/lib/schemas`).

**Spec:** `docs/superpowers/specs/2026-07-07-ac-role-device-defaults-design.md`

**Semantics (invariant across tiers):** for a device allowlist value — `NULL` = "not set, inherit"; `[]` = "explicit none"; `[ids]` = "exactly those". Code defaults supply the "all" that manager/owner rely on today.

**Ship discipline:** every task commits on branch `ac-role-device-defaults` (worktree `~/code/un1t-crm-ac-roles`). Migration is created as a file but **applied at deploy time, gated on the user** (like mig 378). Full `next build` runs once at the end.

---

## Task 1: `resolveAcAllowlist` + code defaults in `shared/permissions.js`

**Files:**
- Modify: `shared/permissions.js`
- Test: `shared/__tests__/ac-allowlist.test.js` (new; the repo also colocates as `src/lib/*.test.js`, but shared helpers are tested under `shared/__tests__` per Task-1 of the approvals work — follow whichever the repo now has for `shared/`)

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AC_ACCESS_BY_ROLE,
  resolveAcAllowlist,
  isAcDeviceAllowed,
  filterAcDevices,
} from '../permissions.js'

describe('resolveAcAllowlist', () => {
  it('master always resolves to ALL', () => {
    expect(resolveAcAllowlist({ role: 'master', userList: [], templateList: [] })).toBe('ALL')
  })
  it('per-user array wins over template and default (incl explicit none)', () => {
    expect(resolveAcAllowlist({ role: 'manager', userList: ['d1'], templateList: ['d2'] })).toEqual(['d1'])
    expect(resolveAcAllowlist({ role: 'manager', userList: [], templateList: ['d2'] })).toEqual([])
  })
  it('template used when per-user is null (inherit)', () => {
    expect(resolveAcAllowlist({ role: 'staff', userList: null, templateList: ['d3'] })).toEqual(['d3'])
    expect(resolveAcAllowlist({ role: 'staff', userList: null, templateList: [] })).toEqual([])
  })
  it('code default used when both null: manager/owner=ALL, others=none', () => {
    expect(resolveAcAllowlist({ role: 'manager', userList: null, templateList: null })).toBe('ALL')
    expect(resolveAcAllowlist({ role: 'owner', userList: null, templateList: null })).toBe('ALL')
    expect(resolveAcAllowlist({ role: 'staff', userList: null, templateList: null })).toEqual([])
    expect(resolveAcAllowlist({ role: 'head_coach', userList: null, templateList: null })).toEqual([])
    expect(resolveAcAllowlist({ role: 'reception', userList: null, templateList: null })).toEqual([])
  })
  it('isAcDeviceAllowed honours ALL and membership', () => {
    expect(isAcDeviceAllowed('ALL', 'x')).toBe(true)
    expect(isAcDeviceAllowed(['a', 'b'], 'b')).toBe(true)
    expect(isAcDeviceAllowed(['a', 'b'], 'z')).toBe(false)
    expect(isAcDeviceAllowed([], 'z')).toBe(false)
  })
  it('filterAcDevices returns all for ALL, else the subset', () => {
    const devices = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(filterAcDevices('ALL', devices)).toEqual(devices)
    expect(filterAcDevices(['b', 'c'], devices)).toEqual([{ id: 'b' }, { id: 'c' }])
    expect(filterAcDevices([], devices)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, confirm FAIL** — `npm test -- ac-allowlist` → FAIL (undefined exports).

- [ ] **Step 3: Implement in `shared/permissions.js`** (add near the other exported helpers, e.g. after `resolvePermission`):

```javascript
// ============================================================
// AC-ROLE.1 — AC device allowlist resolution
//
// The set of AC units a user may operate resolves through the same
// tier order as resolvePermission: per-user override (mig 210,
// profile_locations.ac_device_ids) → role template (mig 379,
// location_role_permissions.ac_device_ids) → code default.
//
// Allowlist value semantics at every tier:
//   null  → not set, inherit the next tier
//   []    → explicit "none"
//   [ids] → exactly those device ids
// The code default supplies the "all" that manager/owner rely on
// (returned as the sentinel string 'ALL').
// ============================================================

export const DEFAULT_AC_ACCESS_BY_ROLE = Object.freeze({
  master: 'all',
  owner: 'all',
  manager: 'all',
  head_coach: 'none',
  staff: 'none',
  reception: 'none',
})

// Returns the sentinel 'ALL' or a concrete array of allowed ids.
export function resolveAcAllowlist({ role, userList, templateList, defaults = DEFAULT_AC_ACCESS_BY_ROLE }) {
  if (role === 'master') return 'ALL'
  if (Array.isArray(userList)) return userList        // tier 2: per-user override ([] = none)
  if (Array.isArray(templateList)) return templateList // tier 2.5: role template
  return defaults?.[role] === 'all' ? 'ALL' : []       // tier 3: code default
}

export function isAcDeviceAllowed(resolved, deviceId) {
  return resolved === 'ALL' || (Array.isArray(resolved) && resolved.includes(deviceId))
}

export function filterAcDevices(resolved, devices) {
  if (resolved === 'ALL') return devices
  const allowed = new Set(Array.isArray(resolved) ? resolved : [])
  return devices.filter((d) => allowed.has(d.id))
}
```

- [ ] **Step 4: Run it, confirm PASS** — `npm test -- ac-allowlist`. Then `npm run lint`.

- [ ] **Step 5: Commit**
```bash
git add shared/permissions.js shared/__tests__
git commit -m "AC-ROLE.1 — resolveAcAllowlist + code defaults + helpers"
```

---

## Task 2: Migration file (column + backfill flip)

**Files:**
- Create: `supabase/migrations/379_ac_device_ids_role_template.sql`

- [ ] **Step 1: Write the migration**

```sql
-- AC-ROLE.1 (mig 379) — role-level AC device defaults.
--
-- 1. Add ac_device_ids to the per-(location, role, employment_type)
--    template table. NULL = inherit code default, [] = none,
--    [ids] = those (same semantics as profile_locations.ac_device_ids).
-- 2. Flip the blanket mig-210 empty-array backfill on profile_locations
--    to NULL so those staff INHERIT the role default instead of being
--    pinned to "none". Deliberate non-empty per-person lists and the
--    manager/owner NULLs are untouched. Day-one access is unchanged
--    (staff -> none via code default; manager/owner -> all).

alter table location_role_permissions
  add column if not exists ac_device_ids uuid[];

update profile_locations
   set ac_device_ids = null
 where ac_device_ids = '{}';
```

- [ ] **Step 2: Do NOT apply yet.** Application to prod happens at deploy (Task 11), gated on the user — the same order discipline as mig 378.

- [ ] **Step 3: Commit**
```bash
git add supabase/migrations/379_ac_device_ids_role_template.sql
git commit -m "AC-ROLE.1 — mig 379: ac_device_ids role-template column + backfill flip"
```

---

## Task 3: `getCurrentUser` — resolve + carry the role-template AC list

**Files:**
- Modify: `src/lib/auth.js` (the role-template block, ~lines 425–465, and the user-object return ~lines 495–496)

- [ ] **Step 1: Extend the template query + resolve the AC list**

Replace the existing block (verbatim current):
```javascript
  const roleTemplatesByLocation = {}
  if (!isMaster) {
    const templateLocationIds = Object.keys(rolesByLocation)
    if (templateLocationIds.length > 0) {
      try {
        const { data: templateRows } = await db
          .from('location_role_permissions')
          .select('location_id, role, employment_type, permissions')
          .in('location_id', templateLocationIds)
        const rowFor = (locId, emp) => (templateRows || []).find(r =>
          r.location_id === locId && r.role === rolesByLocation[locId] && r.employment_type === emp
        )?.permissions || null
        for (const locId of templateLocationIds) {
          const merged = mergeTemplates(
            rowFor(locId, 'all'),
            profile.employment_type ? rowFor(locId, profile.employment_type) : null
          )
          if (merged) roleTemplatesByLocation[locId] = merged
        }
      } catch {
        // Defensive: a failed template fetch degrades to code
        // defaults (empty map) rather than failing the request.
      }
    }
  }
  const activeRoleTemplate = activeLocation?.id
    ? roleTemplatesByLocation[activeLocation.id] || null
    : null
```
with:
```javascript
  const roleTemplatesByLocation = {}
  const acDeviceTemplatesByLocation = {}
  if (!isMaster) {
    const templateLocationIds = Object.keys(rolesByLocation)
    if (templateLocationIds.length > 0) {
      try {
        const { data: templateRows } = await db
          .from('location_role_permissions')
          .select('location_id, role, employment_type, permissions, ac_device_ids')
          .in('location_id', templateLocationIds)
        const findRow = (locId, emp) => (templateRows || []).find(r =>
          r.location_id === locId && r.role === rolesByLocation[locId] && r.employment_type === emp
        ) || null
        const rowFor = (locId, emp) => findRow(locId, emp)?.permissions || null
        for (const locId of templateLocationIds) {
          const merged = mergeTemplates(
            rowFor(locId, 'all'),
            profile.employment_type ? rowFor(locId, profile.employment_type) : null
          )
          if (merged) roleTemplatesByLocation[locId] = merged
          // AC-ROLE.1 — resolve the role-template AC device list:
          // employment-type variant wins if set (non-null), else the
          // 'all' row, else inherit (null). Stored ABSOLUTE, not diffed.
          const allRow = findRow(locId, 'all')
          const varRow = profile.employment_type ? findRow(locId, profile.employment_type) : null
          const acList = Array.isArray(varRow?.ac_device_ids)
            ? varRow.ac_device_ids
            : (Array.isArray(allRow?.ac_device_ids) ? allRow.ac_device_ids : null)
          if (acList !== null) acDeviceTemplatesByLocation[locId] = acList
        }
      } catch {
        // Defensive: a failed template fetch degrades to code
        // defaults (empty maps) rather than failing the request.
      }
    }
  }
  const activeRoleTemplate = activeLocation?.id
    ? roleTemplatesByLocation[activeLocation.id] || null
    : null
  const activeAcDeviceTemplate = activeLocation?.id
    ? (acDeviceTemplatesByLocation[activeLocation.id] ?? null)
    : null
```

- [ ] **Step 2: Attach to the returned user object.** Find where `roleTemplatesByLocation` and `activeRoleTemplate` are added to the returned user (the ~line 495–496 region) and add the two new fields alongside:
```javascript
    roleTemplatesByLocation,
    activeRoleTemplate,
    acDeviceTemplatesByLocation,
    activeAcDeviceTemplate,
```
(Match the exact object-literal style already used there — same indentation and trailing commas.)

- [ ] **Step 3: Build check** — `npm run build` is deferred to Task 11; here run `npm run lint` and `npm test` to confirm nothing regressed (getCurrentUser has integration coverage via route tests).

- [ ] **Step 4: Commit**
```bash
git add src/lib/auth.js
git commit -m "AC-ROLE.1 — getCurrentUser resolves + carries role-template AC device list"
```

---

## Task 4: `authoriseDevice` + `loadDeviceForUser` use the resolver

**Files:**
- Modify: `src/lib/ac-devices.js`
- Test: the existing ac-devices test file (`ls src/lib | grep ac-devices` — likely `src/lib/ac-devices.test.js`; extend it)

- [ ] **Step 1: Write failing tests** (append to the ac-devices test file; adjust import names to match the file):

```javascript
import { describe, it, expect } from 'vitest'
import { authoriseDevice } from './ac-devices.js'

describe('authoriseDevice with role-template fallback (AC-ROLE.1)', () => {
  const user = { id: 'u1', role: 'staff' }
  it('staff with null per-user list falls to the role template', () => {
    const a = { role: 'staff', ac_device_ids: null }
    expect(authoriseDevice({ user, assignment: a, deviceId: 'd1', templateList: ['d1'] }).ok).toBe(true)
    expect(authoriseDevice({ user, assignment: a, deviceId: 'd2', templateList: ['d1'] }).ok).toBe(false)
  })
  it('per-user explicit list overrides the template', () => {
    const a = { role: 'staff', ac_device_ids: ['d2'] }
    expect(authoriseDevice({ user, assignment: a, deviceId: 'd2', templateList: ['d1'] }).ok).toBe(true)
    expect(authoriseDevice({ user, assignment: a, deviceId: 'd1', templateList: ['d1'] }).ok).toBe(false)
  })
  it('staff with null list and no template resolves to none (code default)', () => {
    const a = { role: 'staff', ac_device_ids: null }
    expect(authoriseDevice({ user, assignment: a, deviceId: 'd1', templateList: null }).ok).toBe(false)
  })
  it('manager with null list and no template still gets all (code default)', () => {
    const mgr = { id: 'm', role: 'manager' }
    const a = { role: 'manager', ac_device_ids: null }
    expect(authoriseDevice({ user: mgr, assignment: a, deviceId: 'anything', templateList: null }).ok).toBe(true)
  })
  it('master is always allowed', () => {
    expect(authoriseDevice({ user: { role: 'master' }, assignment: null, deviceId: 'd', templateList: null }).ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run, confirm FAIL** — `npm test -- ac-devices` (the template-fallback cases fail; today the fn ignores templateList).

- [ ] **Step 3: Refactor `authoriseDevice`** (replace the current body, ac-devices.js:337–368):
```javascript
export function authoriseDevice({ user, assignment, deviceId, templateList = null }) {
  if (user?.role === 'master') return { ok: true, role: 'master' }

  if (!assignment) {
    return {
      ok: false,
      status: 403,
      code: 'not_assigned_to_location',
      error: 'You are not assigned to this location.',
    }
  }

  const role = assignment.role || user?.profileRole || user?.role || null
  // AC-ROLE.1 — resolve through per-user override → role template →
  // code default (manager/owner = all). Replaces the old inline
  // "NULL + manager/owner ⇒ all" special-case.
  const resolved = resolveAcAllowlist({ role, userList: assignment.ac_device_ids ?? null, templateList })
  if (isAcDeviceAllowed(resolved, deviceId)) {
    return { ok: true, role }
  }

  return {
    ok: false,
    status: 403,
    code: 'device_not_in_allowlist',
    error: 'You are not authorised to control this AC unit. Ask an admin to add it to your access list.',
  }
}
```
Add to the imports at the top of `src/lib/ac-devices.js`:
```javascript
import { resolveAcAllowlist, isAcDeviceAllowed } from '@shared/permissions'
```

- [ ] **Step 4: Thread the template list through `loadDeviceForUser`.** In `loadDeviceForUser` (ac-devices.js:45–88), change the `authoriseDevice` call (currently `const auth = authoriseDevice({ user, assignment, deviceId: device.id })`) to:
```javascript
  const auth = authoriseDevice({
    user,
    assignment,
    deviceId: device.id,
    templateList: user?.acDeviceTemplatesByLocation?.[device.location_id] ?? null,
  })
```

- [ ] **Step 5: Run tests, confirm PASS** — `npm test -- ac-devices`. Then `npm run lint`.

- [ ] **Step 6: Commit**
```bash
git add src/lib/ac-devices.js src/lib/ac-devices.test.js
git commit -m "AC-ROLE.1 — authoriseDevice resolves per-user -> role template -> code default"
```

---

## Task 5: Device-list GET route uses the resolver

**Files:**
- Modify: `src/app/api/studio-management/ac/devices/route.js`

- [ ] **Step 1: Replace the inline filter** (the `let visible = ...` block, ~lines 66–85) with:
```javascript
    // AC-ROLE.1 — filter to what the caller may actually control:
    // per-user override → role template → code default (via resolver).
    let visible = devices || []
    if (user.role !== 'master') {
      const { data: pl } = await db
        .from('profile_locations')
        .select('role, ac_device_ids')
        .eq('profile_id', user.id)
        .eq('location_id', locationId)
        .maybeSingle()
      const role = pl?.role || user.profileRole || user.role
      const resolved = resolveAcAllowlist({
        role,
        userList: pl?.ac_device_ids ?? null,
        templateList: user?.acDeviceTemplatesByLocation?.[locationId] ?? null,
      })
      visible = filterAcDevices(resolved, visible)
    }
```
Add the import (top of the route file, alongside its other imports):
```javascript
import { resolveAcAllowlist, filterAcDevices } from '@shared/permissions'
```

- [ ] **Step 2: Lint** — `npm run lint`. (This route has no pure-unit harness; the resolver itself is unit-tested in Task 1, and the E2E behaviour is in the Task 11 manual matrix.)

- [ ] **Step 3: Commit**
```bash
git add src/app/api/studio-management/ac/devices/route.js
git commit -m "AC-ROLE.1 — AC device list route filters via the resolver"
```

---

## Task 6: role-permissions GET/PUT carry `ac_device_ids`

**Files:**
- Modify: `src/app/api/locations/[id]/role-permissions/route.js`

- [ ] **Step 1: Extend the `Body` zod schema.** Near the top of the file the `Body` schema validates `{ role, employment_type, permissions }`. Add an optional, nullable device-id array (reuse `uuidLike` from `@/lib/schemas` — import it if not already):
```javascript
  ac_device_ids: z.array(uuidLike).nullable().optional(),
```
(Add `uuidLike` to the existing `@/lib/schemas` import if absent.)

- [ ] **Step 2: GET — return the stored AC list per role + variant.** In the GET handler change the select to include the column:
```javascript
    .select('role, employment_type, permissions, ac_device_ids, updated_at')
```
Then in the `byRole` build, add `ac_device_ids` to both the base and each variant object:
```javascript
      variants[emp] = {
        template,
        effective: hydratePermissions(null, role, mergeTemplates(allTemplate, template)),
        ac_device_ids: row?.ac_device_ids ?? null,
        updated_at: row?.updated_at || null,
      }
    }
    byRole[role] = {
      template: allTemplate,
      effective: hydratePermissions(null, role, allTemplate),
      ac_device_ids: allRow?.ac_device_ids ?? null,
      updated_at: allRow?.updated_at || null,
      variants,
    }
```

- [ ] **Step 3: PUT — persist the AC list; keep the row alive if either side is non-empty.** After the `const sparse = diffPermissionsBlob(...)` line, add:
```javascript
  // AC-ROLE.1 — the role-level AC device allowlist for this slice is
  // stored ABSOLUTE (null = inherit, [] = none, [ids] = those), NOT
  // diffed. If the caller omitted the key, preserve the existing value.
  let acDeviceIds = validation.data.ac_device_ids
  if (acDeviceIds === undefined) {
    const { data: existingAc } = await db
      .from('location_role_permissions')
      .select('ac_device_ids')
      .eq('location_id', params.id)
      .eq('role', role)
      .eq('employment_type', employmentType)
      .maybeSingle()
    acDeviceIds = existingAc?.ac_device_ids ?? null
  }
```
Change the `respond` helper to carry the AC list:
```javascript
  const respond = (template, acIds) => NextResponse.json({
    success: true,
    data: {
      role,
      employment_type: employmentType,
      template,
      ac_device_ids: acIds ?? null,
      effective: hydratePermissions(null, role, mergeTemplates(baseTemplate, template)),
    },
  })
```
Change the empty-check + delete branch so the row is only removed when BOTH sides are empty:
```javascript
  const isEmpty = Object.keys(sparse).length === 0 && acDeviceIds === null
  if (isEmpty) {
    const { error } = await db
      .from('location_role_permissions')
      .delete()
      .eq('location_id', params.id)
      .eq('role', role)
      .eq('employment_type', employmentType)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    return respond({}, null)
  }
```
Change the upsert to include the column and select it back:
```javascript
  const { data, error } = await db
    .from('location_role_permissions')
    .upsert({
      location_id: params.id,
      role,
      employment_type: employmentType,
      permissions: sparse,
      ac_device_ids: acDeviceIds,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'location_id,role,employment_type' })
    .select('role, permissions, ac_device_ids')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return respond(data.permissions, data.ac_device_ids)
```

- [ ] **Step 4: Lint** — `npm run lint`.

- [ ] **Step 5: Commit**
```bash
git add src/app/api/locations/'[id]'/role-permissions/route.js
git commit -m "AC-ROLE.1 — role-permissions GET/PUT carry ac_device_ids"
```

---

## Task 7: Relax the AC-devices options route to master-or-owner-at-location

**Files:**
- Modify: `src/app/api/locations/[id]/ac-devices/route.js`

Owners can edit role templates (`canEditRoleTemplates` = master or owner-at-location) but the device-options list this GET returns is currently master-only — an owner configuring the role AC default would get 403. Relax it to match.

- [ ] **Step 1: Replace the master-only gate.** The current gate is `if (user.role !== 'master') return 403`. Replace with master-or-owner-at-this-location:
```javascript
  // AC-ROLE.1 — master OR an owner at this location may list AC
  // devices (owners configure the role-level AC default in the Roles
  // tab; this only exposes device labels/ids, not control).
  const isMaster = user.role === 'master'
  const ownsLocation = Object.entries(user.rolesByLocation || {})
    .some(([loc, r]) => r === 'owner' && loc === params.id)
  if (!isMaster && !ownsLocation) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
```
(Use the route's actual params variable name for the location id — confirm by reading the file; it may be `params.id` or a destructured `locationId`. `user.rolesByLocation` is populated by `getCurrentUser`.)

- [ ] **Step 2: Lint** — `npm run lint`.

- [ ] **Step 3: Commit**
```bash
git add src/app/api/locations/'[id]'/ac-devices/route.js
git commit -m "AC-ROLE.1 — allow owner-at-location to list AC devices for role config"
```

---

## Task 8: Extract `AcDeviceAllowlistPicker` + add the tri-state

**Files:**
- Create: `src/components/AcDeviceAllowlistPicker.jsx`
- Modify: `src/components/StaffForm.jsx` (remove the inline component, import the extracted one)

- [ ] **Step 1: Create the extracted component with a tri-state.** Move the existing `AcDeviceAllowlistPicker` (currently StaffForm.jsx ~1935–2076) into its own file, adding: a `value` that can be `null` (inherit), `[]` (none), or `[ids]`; an `inheritLabel` prop; and a mode selector. Full file:

```jsx
'use client'

// AC-ROLE.1 — AC device allowlist picker, shared by StaffForm (per-user
// override) and RolePermissions (per-role default). Tri-state value:
//   null  → inherit (StaffForm: inherit the role default;
//                     RolePermissions: inherit the code default)
//   []    → explicit none
//   [ids] → exactly those device ids
// `inheritLabel` names the inherit option for the surface.

import { useState } from 'react'

export default function AcDeviceAllowlistPicker({ locationId, locationName, value, onChange, inheritLabel = 'Inherit default' }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [devices, setDevices] = useState(null)

  const inheriting = value === null || value === undefined
  const selected = Array.isArray(value) ? value : []
  const selectedSet = new Set(selected)

  const currentLabel = (() => {
    if (inheriting) return inheritLabel
    if (selected.length === 0) return 'No AC units (explicit none)'
    if (!devices) return `${selected.length} AC unit${selected.length === 1 ? '' : 's'} selected`
    const names = selected.map((id) => devices.find((d) => d.id === id)?.label || id).slice(0, 3)
    const more = selected.length - names.length
    return more > 0 ? `${names.join(', ')} +${more} more` : names.join(', ')
  })()

  async function fetchDevices() {
    if (loading) return
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/ac-devices`, { cache: 'no-store' })
      const json = await res.json()
      if (!json.success) throw new Error(json.message || json.error || 'Fetch failed')
      setDevices(json.devices || json.data || [])
    } catch (e) {
      setError(e.message || 'Could not load AC devices')
    } finally {
      setLoading(false)
    }
  }

  function handleToggle() {
    const next = !open
    setOpen(next)
    if (next && devices === null) fetchDevices()
  }
  function toggleDevice(deviceId) {
    const base = inheriting ? [] : selected
    if (selectedSet.has(deviceId)) onChange(base.filter((id) => id !== deviceId))
    else onChange([...base, deviceId])
  }
  function selectAll() { if (devices) onChange(devices.map((d) => d.id)) }
  function selectNone() { onChange([]) }
  function setInherit() { onChange(null) }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center justify-between text-left rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm hover:border-un1t-muted"
      >
        <div className="min-w-0">
          <div className="text-xs text-un1t-subtle">Studio Management AC units</div>
          <div className="truncate">{currentLabel}</div>
        </div>
        <span className="text-un1t-subtle text-xs ml-2">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="rounded-md border border-un1t-border bg-un1t-bg p-2 space-y-1">
          <div className="flex items-center gap-3 px-2 py-1 text-[11px]">
            <button type="button" onClick={setInherit} className={inheriting ? 'text-blue-300 font-semibold' : 'text-un1t-subtle hover:text-un1t-text'}>
              {inheritLabel}
            </button>
            <span className="text-un1t-muted">·</span>
            <button type="button" onClick={selectAll} className="text-blue-300 hover:text-blue-200">All</button>
            <button type="button" onClick={selectNone} className="text-blue-300 hover:text-blue-200">None</button>
          </div>
          <div className="border-t border-un1t-border/50 my-1" />
          {loading && <div className="text-xs text-un1t-subtle px-2 py-1.5">Loading AC devices from {locationName}…</div>}
          {error && <div className="text-xs text-red-700 px-2 py-1.5">{error}</div>}
          {!loading && !error && devices && (
            <div className="max-h-64 overflow-y-auto">
              {devices.length === 0 && (
                <div className="text-xs text-un1t-subtle px-2 py-1.5">
                  No AC devices configured at this location. Add devices under Settings → Locations → AC Devices first.
                </div>
              )}
              {devices.map((d) => {
                const isOn = !inheriting && selectedSet.has(d.id)
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDevice(d.id)}
                    className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-un1t-border/40 flex items-center gap-2"
                  >
                    <span className={`inline-block w-3.5 h-3.5 rounded border flex items-center justify-center text-[10px] ${isOn ? 'bg-blue-500 border-blue-500 text-white' : 'border-un1t-border text-transparent'}`}>
                      {isOn ? '✓' : ''}
                    </span>
                    <span className="truncate">{d.label}</span>
                    <span className="ml-auto text-[10px] uppercase tracking-wider text-un1t-muted font-mono shrink-0">
                      {d.provider === 'thinq' ? 'LG ThinQ' : 'Sensibo'}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```
(Note: the options route returns `{ success, data }` in `studio-management` but `{ success, devices }` in `locations/[id]/ac-devices` — the `json.devices || json.data` line handles both. Confirm the shape from Task 7's route; keep both for safety.)

- [ ] **Step 2: Update StaffForm** to import the extracted component and delete the inline definition. Add near StaffForm's other imports:
```javascript
import AcDeviceAllowlistPicker from './AcDeviceAllowlistPicker'
```
Delete the inline `function AcDeviceAllowlistPicker(...) { ... }` (the ~1935–2076 block). Leave the render site (710–719) unchanged for now (Task 9 adds the inherit wiring).

- [ ] **Step 3: Lint + build the two files compile** — `npm run lint`. (Full `next build` at Task 11.)

- [ ] **Step 4: Commit**
```bash
git add src/components/AcDeviceAllowlistPicker.jsx src/components/StaffForm.jsx
git commit -m "AC-ROLE.1 — extract AcDeviceAllowlistPicker with tri-state (inherit/none/list)"
```

---

## Task 9: StaffForm — enable the inherit (null) state

**Files:**
- Modify: `src/components/StaffForm.jsx`

- [ ] **Step 1: Pass a real tri-state value + inherit label to the picker.** Change the render site (currently ~710–719) so the picker receives `null` when the assignment inherits, and labels inherit as the role default:
```jsx
              {isEdit && configured && (
                <AcDeviceAllowlistPicker
                  locationId={a.location_id}
                  locationName={loc.name}
                  value={a.ac_device_ids === undefined ? null : a.ac_device_ids}
                  inheritLabel="Inherit from role default"
                  onChange={(ac_device_ids) =>
                    updateAssignment(a.location_id, { ac_device_ids })
                  }
                />
              )}
```

- [ ] **Step 2: Preserve null through submit.** The submit payload builder (currently line 417 forces an array) must send the actual tri-state so the server can store `null` (inherit). Replace:
```javascript
        ac_device_ids: Array.isArray(a.ac_device_ids) ? a.ac_device_ids : [],
```
with:
```javascript
        // AC-ROLE.1 — send the tri-state as-is: null = inherit role
        // default, [] = explicit none, [ids] = those. Always present so
        // buildAssignmentRow writes it (it already round-trips null).
        ac_device_ids: a.ac_device_ids === undefined ? null : a.ac_device_ids,
```

- [ ] **Step 3: Confirm the load path preserves null.** Find where assignments are initialised from the server staff record (grep `ac_device_ids` in StaffForm.jsx and any parent that builds `form.assignments`). If the initial assignment object coerces `ac_device_ids` to `[]`, change it to preserve the DB value (`null` stays `null`). If the value simply isn't set on load, that's fine — `undefined` renders as inherit and submits as `null`. Report which case applies.

- [ ] **Step 4: Lint** — `npm run lint`.

- [ ] **Step 5: Commit**
```bash
git add src/components/StaffForm.jsx
git commit -m "AC-ROLE.1 — StaffForm AC picker supports inherit-from-role (null)"
```

---

## Task 10: RolePermissions — AC devices section per (role, segment)

**Files:**
- Modify: `src/components/RolePermissions.jsx`

- [ ] **Step 1: Track the AC value per slice + read it from the server data.** Add an `acEdits` state and derive the current AC value for the active slice. After the existing `const blob = edits[editKey] || serverBlob` line:
```javascript
  const [acEdits, setAcEdits] = useState({})
  const serverAc = segment === 'all'
    ? (data?.[activeRole]?.ac_device_ids ?? null)
    : (data?.[activeRole]?.variants?.[segment]?.ac_device_ids ?? null)
  const currentAc = (editKey in acEdits) ? acEdits[editKey] : serverAc
  function setAc(next) {
    setAcEdits((prev) => ({ ...prev, [editKey]: next }))
    setSavedAt(null)
  }
```

- [ ] **Step 2: Send `ac_device_ids` in the save PUT + clear its edit on success.** In `save()`, change the PUT body:
```javascript
        body: JSON.stringify({ role: activeRole, employment_type: segment, permissions: blob, ac_device_ids: currentAc }),
```
and in the success path, alongside the existing `delete next[editKey]` for `edits`, also clear the AC edit:
```javascript
      setAcEdits((prev) => {
        const next = { ...prev }
        delete next[editKey]
        return next
      })
```

- [ ] **Step 3: Render the AC section.** Import the extracted picker at the top of RolePermissions.jsx:
```javascript
import AcDeviceAllowlistPicker from './AcDeviceAllowlistPicker'
```
Add a new `<section>` after the Approvals section (after its closing `</section>`, ~line 268):
```jsx
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-un1t-subtle mb-1">AC devices</h3>
          <p className="text-[11px] text-un1t-subtle mb-2">
            Default AC units this role controls at this location. Takes effect only when
            Studio Management is on for the role. Individual profiles can override.
          </p>
          <AcDeviceAllowlistPicker
            locationId={locationId}
            locationName=""
            value={currentAc}
            inheritLabel="Inherit code default"
            onChange={setAc}
          />
        </section>
```

- [ ] **Step 4: Lint** — `npm run lint`.

- [ ] **Step 5: Commit**
```bash
git add src/components/RolePermissions.jsx
git commit -m "AC-ROLE.1 — Roles tab: per-role AC device default picker"
```

---

## Task 11: Full verification + migration apply (deploy-gated)

**Files:** none (verification + deploy)

- [ ] **Step 1: CI mirror**
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```
Expected: all green. (No new WEB_PERMISSIONS keys were added — the AC role default is a column, not a permission key — so `check:mobile-parity` needs no new `WEB_ONLY_OK` entry. Confirm it stays green.)

- [ ] **Step 2: Production build** — `npm run build`. Expected: compiles (validates the new component + all `@shared/permissions` imports).

- [ ] **Step 3: Manual matrix (dev server).** Verify at Stillorgan:

| Scenario | Expected |
|---|---|
| Manager, no templates, per-user AC null | Controls all AC (code default) |
| Staff, no templates, per-user AC null | Controls none |
| Roles tab → Staff → AC devices → pick unit A → save | A staff member (per-user inherit) now controls only A; not B |
| StaffForm → a staff member → AC picker → "Inherit from role default" | Picker shows inherit; that person follows the role default |
| StaffForm → same person → pick unit B explicitly | That person controls only B regardless of the role default |
| Owner (non-master) opens the Roles tab AC picker | Device list loads (Task 7 auth) |
| Settings → Location Features | unchanged; no AC row added there |

- [ ] **Step 4: Apply the migration (deploy-time, gated on the user).** This is a prod DB change — **do not apply without the user's go.** When authorised: apply `mig 379` via Supabase MCP `apply_migration` against project `iyvtbjjxdggiadzwwvdj` (confirm via `list_projects`; never the sentinel `tpttqakxmyxrwnqjepfm`). Then verify + advisors:
```sql
select
  (select count(*) from information_schema.columns
     where table_name='location_role_permissions' and column_name='ac_device_ids') as col_added,
  (select count(*) from profile_locations where ac_device_ids = '{}') as empty_arrays_remaining;
```
Expected: `col_added=1`, `empty_arrays_remaining=0`. Run `get_advisors` (security) — expect no new advisories (DDL adds a nullable column, no RLS change). Order: apply **after** the code deploys (the new code treats a leftover `[]` as explicit-none, so flipping to null before deploy would briefly change nothing harmful, but keep the same discipline as mig 378).

- [ ] **Step 5: Push / integrate** per the finishing-a-development-branch step (the controller drives this; not a subagent task).

---

## Self-review checklist (completed by plan author)

- **Spec coverage:** §1 storage → Task 2 (+6 for GET/PUT); §2 resolver → Task 1; §2 employment-type variant resolution → Task 3 (getCurrentUser) + Task 6 (GET/PUT per variant); §3 enforcement (authoriseDevice, list route, loadDeviceForUser/getCurrentUser) → Tasks 3–5; §4 Roles UI → Task 10 (+7 owner auth, +8 picker); §5 per-profile inherit → Tasks 8–9; §6 migration → Task 2 + Task 11 apply; §7 testing → Tasks 1, 4 + Task 11 matrix. All covered.
- **Placeholder scan:** none — each step has concrete code. The two "confirm the file's variable name / load path" steps (Tasks 7, 9) are verification instructions with the exact change shown, not deferred work.
- **Type/name consistency:** `resolveAcAllowlist` / `isAcDeviceAllowed` / `filterAcDevices` / `DEFAULT_AC_ACCESS_BY_ROLE` used identically across Tasks 1, 4, 5; `acDeviceTemplatesByLocation` / `activeAcDeviceTemplate` consistent across Tasks 3–5; the `null` = inherit, `[]` = none, `[ids]` = those convention holds at every tier and in both UIs.
