# Staff & Access — C2b.1: Extract the PUT's Pure Logic (refactor-first, zero behavior change)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** De-risk the 439-line `PUT /api/staff/[id]` monolith by extracting its **pure, side-effect-free** logic into a tested `src/lib/staff-write.js` module and pointing the route at it — **byte-identical behavior**, proven by characterization tests + the existing suite + a clean build. NO mobile editor, NO orchestration/UniFi/DB-write changes. This is the first, safest step of the write-path extraction.

**Why refactor-first:** the `PUT` bundles payroll comp writes and **physical door-access** (UniFi) side-effects with a subtle assignment-diff. Before any mobile editor sits on it (C2c), the logic must be extracted and tested in isolation so the extraction itself can't change production behavior. This increment extracts ONLY the pure pieces (no DB, no network), which is provably safe: the route calls a function instead of an inline block, with the same inputs and outputs.

**The four pure extractions** (all currently inlined in `src/app/api/staff/[id]/route.js`):
1. `buildStaffProfilePatch(body)` — the `profileUpdates` object builder (route lines 219-228).
2. `assertOwnerAssignmentScope({ isMaster, callerOwnerLocationIds, targetLocationIds, assignments })` — the owner-overlap + per-assignment owner-location + role-assignability authz (lines 165-207).
3. `computeDesiredAssignments({ isMaster, callerOwnerLocationIds, assignments, existingLinks })` — the master=full / owner=subset+preserve desired-state list + single-`is_default` normalization (lines 285-322). **The subtle one** — the original audit flagged this logic as must-preserve.
4. `computeProfileRole({ isMaster, assignmentRoles, fallbackRole })` — highest-role-or-master recompute (lines 460-465).

**Tech Stack:** JS, Vitest (pure functions → fully unit-testable), Next.js route.

**Decomposition:** C2b.1 (this) = pure extractions. **C2b.2** = extract the side-effectful orchestration (the delete-with-revoke + per-row UniFi sync + insert/update + role/flag persistence + audit) into a `updateStaffMember(ctx, input)` service the route delegates to — keeping the `unifi_failed`/502 + comp-dual-write semantics. **C2c** = the mobile role/permission/assignment/door editor on the extracted service. Each its own plan.

**Branch:** `mobile-parity-staff-c2b1` (off `main`).

**Reference before starting:** read `src/app/api/staff/[id]/route.js` lines 92-535 (the whole PUT) and `src/lib/schemas.js` (`OWNER_ASSIGNABLE_ROLES`, `MASTER_ASSIGNABLE_ROLES`). The extracted functions must reproduce the inline behavior EXACTLY.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/lib/staff-write.js` | the 4 pure helpers | Create |
| `src/lib/staff-write.test.js` | characterization tests pinning current behavior | Create |
| `src/app/api/staff/[id]/route.js` | call the helpers in place of the inline blocks | Modify (PUT only) |

---

## Task 1: `buildStaffProfilePatch` + `computeProfileRole`

The two simplest pure functions first.

**Files:** Create `src/lib/staff-write.js`, `src/lib/staff-write.test.js`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/staff-write.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildStaffProfilePatch, computeProfileRole } from './staff-write.js'

describe('buildStaffProfilePatch', () => {
  it('includes only the profile keys present in the body', () => {
    const patch = buildStaffProfilePatch({ full_name: 'Ada', active: true, irrelevant: 'x' })
    expect(patch).toEqual({ full_name: 'Ada', active: true })
  })
  it('includes all nine recognised keys when present, preserving null/false', () => {
    const body = {
      full_name: 'A', permissions: {}, active: false, employment_type: 'contractor',
      annual_salary: null, hourly_rate: 12, contracted_hours_per_week: 40,
      annual_leave_entitlement: 20, overtime_rate: null,
    }
    expect(buildStaffProfilePatch(body)).toEqual(body)
  })
  it('is empty for a body with no recognised keys', () => {
    expect(buildStaffProfilePatch({ is_master: true, assignments: [] })).toEqual({})
  })
})

describe('computeProfileRole', () => {
  it('returns master when isMaster is true regardless of assignments', () => {
    expect(computeProfileRole({ isMaster: true, assignmentRoles: ['staff'], fallbackRole: 'staff' })).toBe('master')
  })
  it('returns the highest-precedence assignment role', () => {
    expect(computeProfileRole({ isMaster: false, assignmentRoles: ['staff', 'owner', 'manager'], fallbackRole: 'staff' })).toBe('owner')
    expect(computeProfileRole({ isMaster: false, assignmentRoles: ['staff', 'head_coach'], fallbackRole: 'staff' })).toBe('head_coach')
  })
  it('falls back when there are no assignments', () => {
    expect(computeProfileRole({ isMaster: false, assignmentRoles: [], fallbackRole: 'manager' })).toBe('manager')
    expect(computeProfileRole({ isMaster: false, assignmentRoles: [], fallbackRole: null })).toBe('staff')
  })
})
```

- [ ] **Step 2: Run → FAIL**

Run: `npx vitest run src/lib/staff-write.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/staff-write.js`:

```js
// Pure logic extracted from PUT /api/staff/[id] (Plan C2b.1). These
// functions have NO DB or network access — they're the testable core
// of the staff-update flow. The route still owns orchestration + the
// UniFi/DB side-effects (extracted in C2b.2). Each function reproduces
// the previously-inline behavior exactly; the characterization tests
// pin it.

// Profile-level columns a staff PUT may patch. Order/identity matches
// the original inline block (route ~lines 219-228). Comp columns are
// included because the route dual-writes them to profiles (and, via a
// separate helper, to profile_compensation).
const PROFILE_PATCH_KEYS = [
  'full_name', 'permissions', 'active', 'employment_type',
  'annual_salary', 'hourly_rate', 'contracted_hours_per_week',
  'annual_leave_entitlement', 'overtime_rate',
]

/** Build the profiles update patch from a validated body — only keys
 * actually present (undefined keys are skipped; null/false are kept). */
export function buildStaffProfilePatch(body) {
  const patch = {}
  for (const key of PROFILE_PATCH_KEYS) {
    if (body[key] !== undefined) patch[key] = body[key]
  }
  return patch
}

const ROLE_PRECEDENCE = { owner: 1, manager: 2, head_coach: 3, staff: 4 }

/** Recompute profiles.role: master flag wins, else the highest-
 * precedence role across the current assignments, else the fallback. */
export function computeProfileRole({ isMaster, assignmentRoles, fallbackRole }) {
  if (isMaster) return 'master'
  const highest = [...(assignmentRoles || [])]
    .sort((a, b) => (ROLE_PRECEDENCE[a] || 99) - (ROLE_PRECEDENCE[b] || 99))[0]
  return highest || fallbackRole || 'staff'
}
```

- [ ] **Step 4: Run → PASS**

Run: `npx vitest run src/lib/staff-write.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/lib/staff-write.js src/lib/staff-write.test.js
git commit -m "STAFF-C2b.1a — extract pure buildStaffProfilePatch + computeProfileRole"
```

---

## Task 2: `assertOwnerAssignmentScope`

**Files:** Modify `src/lib/staff-write.js`, `src/lib/staff-write.test.js`.

- [ ] **Step 1: Add failing tests**

Append to `src/lib/staff-write.test.js`:

```js
import { assertOwnerAssignmentScope } from './staff-write.js'

describe('assertOwnerAssignmentScope', () => {
  const ownerLocs = ['loc-1', 'loc-2']

  it('master bypasses owner-overlap but still rejects an invalid role', () => {
    expect(assertOwnerAssignmentScope({ isMaster: true, callerOwnerLocationIds: [], targetLocationIds: ['x'], assignments: [{ location_id: 'x', role: 'staff' }] })).toBeNull()
    const bad = assertOwnerAssignmentScope({ isMaster: true, callerOwnerLocationIds: [], targetLocationIds: ['x'], assignments: [{ location_id: 'x', role: 'master' }] })
    expect(bad?.status).toBe(403)
  })

  it('owner with no location overlap is rejected', () => {
    const r = assertOwnerAssignmentScope({ isMaster: false, callerOwnerLocationIds: ownerLocs, targetLocationIds: ['loc-9'], assignments: undefined })
    expect(r?.status).toBe(403)
    expect(r.error).toMatch(/owner/i)
  })

  it('owner with overlap and no assignments passes', () => {
    expect(assertOwnerAssignmentScope({ isMaster: false, callerOwnerLocationIds: ownerLocs, targetLocationIds: ['loc-1'], assignments: undefined })).toBeNull()
  })

  it('owner cannot assign at a non-owned location', () => {
    const r = assertOwnerAssignmentScope({ isMaster: false, callerOwnerLocationIds: ownerLocs, targetLocationIds: ['loc-1'], assignments: [{ location_id: 'loc-9', role: 'staff' }] })
    expect(r?.status).toBe(403)
    expect(r.error).toMatch(/where you are an owner/i)
  })

  it('owner cannot grant a role outside OWNER_ASSIGNABLE_ROLES', () => {
    const r = assertOwnerAssignmentScope({ isMaster: false, callerOwnerLocationIds: ownerLocs, targetLocationIds: ['loc-1'], assignments: [{ location_id: 'loc-1', role: 'master' }] })
    expect(r?.status).toBe(403)
  })

  it('owner assigning a valid role at an owned location passes', () => {
    expect(assertOwnerAssignmentScope({ isMaster: false, callerOwnerLocationIds: ownerLocs, targetLocationIds: ['loc-1'], assignments: [{ location_id: 'loc-1', role: 'manager' }] })).toBeNull()
  })
})
```

- [ ] **Step 2: Run → FAIL**

Run: `npx vitest run src/lib/staff-write.test.js`

- [ ] **Step 3: Implement**

Append to `src/lib/staff-write.js`:

```js
import { OWNER_ASSIGNABLE_ROLES, MASTER_ASSIGNABLE_ROLES } from '@/lib/schemas'

/** Owner/master assignment-scope authorization. Returns null when
 * allowed, or { status, error } to return from the route. Pure mirror
 * of the inline guard (route ~lines 165-207):
 *   - owner: must share ≥1 owned location with the target; every body
 *     assignment must be at an owned location with an OWNER_ASSIGNABLE
 *     role.
 *   - master: any location; body roles must be MASTER_ASSIGNABLE. */
export function assertOwnerAssignmentScope({ isMaster, callerOwnerLocationIds, targetLocationIds, assignments }) {
  if (!isMaster) {
    const owned = new Set(callerOwnerLocationIds || [])
    const overlap = (targetLocationIds || []).some(l => owned.has(l))
    if (!overlap) {
      return { status: 403, error: 'You can only edit staff assigned to a location where you are an owner.' }
    }
    if (assignments) {
      for (const a of assignments) {
        if (!owned.has(a.location_id)) {
          return { status: 403, error: 'You can only manage assignments at locations where you are an owner.' }
        }
        if (!OWNER_ASSIGNABLE_ROLES.includes(a.role)) {
          return { status: 403, error: `Role '${a.role}' cannot be granted by an owner.` }
        }
      }
    }
    return null
  }
  // Master path: validate role values only.
  if (assignments) {
    for (const a of assignments) {
      if (!MASTER_ASSIGNABLE_ROLES.includes(a.role)) {
        return { status: 403, error: `Role '${a.role}' is not a valid per-location role.` }
      }
    }
  }
  return null
}
```

- [ ] **Step 4: Run → PASS** · **Step 5: Commit**

Run: `npx vitest run src/lib/staff-write.test.js`
```bash
git add src/lib/staff-write.js src/lib/staff-write.test.js
git commit -m "STAFF-C2b.1b — extract pure assertOwnerAssignmentScope"
```

---

## Task 3: `computeDesiredAssignments` (the subtle one)

**Files:** Modify `src/lib/staff-write.js`, `src/lib/staff-write.test.js`.

- [ ] **Step 1: Add failing tests** (pin the master=full / owner=subset+preserve + single-default behavior)

Append to `src/lib/staff-write.test.js`:

```js
import { computeDesiredAssignments } from './staff-write.js'

describe('computeDesiredAssignments', () => {
  const existing = [
    { location_id: 'loc-1', role: 'staff', is_default: true, unifi_door_access: false, permissions: { x: 1 } },
    { location_id: 'loc-2', role: 'manager', is_default: false, unifi_door_access: true, permissions: { y: 2 } },
  ]

  it('master: desired is exactly the body assignments', () => {
    const out = computeDesiredAssignments({ isMaster: true, callerOwnerLocationIds: [], assignments: [{ location_id: 'loc-1', role: 'owner', is_default: true }], existingLinks: existing })
    expect(out).toEqual([{ location_id: 'loc-1', role: 'owner', is_default: true }])
  })

  it('owner: keeps body rows at owned locations, preserves non-owned existing rows verbatim (incl. permissions)', () => {
    const out = computeDesiredAssignments({
      isMaster: false, callerOwnerLocationIds: ['loc-1'],
      assignments: [{ location_id: 'loc-1', role: 'head_coach', is_default: true }],
      existingLinks: existing,
    })
    expect(out).toContainEqual({ location_id: 'loc-1', role: 'head_coach', is_default: true })
    // loc-2 is not owned → preserved from existing with its permissions
    expect(out).toContainEqual({ location_id: 'loc-2', role: 'manager', is_default: false, unifi_door_access: true, permissions: { y: 2 } })
  })

  it('promotes the first row to default when none is marked', () => {
    const out = computeDesiredAssignments({ isMaster: true, callerOwnerLocationIds: [], assignments: [{ location_id: 'a', role: 'staff' }, { location_id: 'b', role: 'staff' }], existingLinks: [] })
    expect(out[0].is_default).toBe(true)
    expect(out[1].is_default).toBeFalsy()
  })

  it('keeps exactly one default when several are marked', () => {
    const out = computeDesiredAssignments({ isMaster: true, callerOwnerLocationIds: [], assignments: [{ location_id: 'a', role: 'staff', is_default: true }, { location_id: 'b', role: 'staff', is_default: true }], existingLinks: [] })
    expect(out.filter(a => a.is_default)).toHaveLength(1)
    expect(out[0].is_default).toBe(true)
  })

  it('preserves a non-owned existing row with an empty permissions object when it had none', () => {
    const out = computeDesiredAssignments({ isMaster: false, callerOwnerLocationIds: ['loc-1'], assignments: [], existingLinks: [{ location_id: 'loc-2', role: 'staff', is_default: true, unifi_door_access: false, permissions: null }] })
    expect(out).toContainEqual({ location_id: 'loc-2', role: 'staff', is_default: true, unifi_door_access: false, permissions: {} })
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** (exact mirror of route lines 285-322)

Append to `src/lib/staff-write.js`:

```js
/** Compute the FULL desired-state assignment list from the request.
 * Master → the body verbatim. Owner → body rows at owned locations,
 * plus every existing row at a NON-owned location preserved verbatim
 * (role, is_default, door access, and the permissions blob — mig 058).
 * Then normalise to exactly one is_default. Pure mirror of route lines
 * 285-322. `callerOwnerLocationIds` is unused for master. */
export function computeDesiredAssignments({ isMaster, callerOwnerLocationIds, assignments, existingLinks }) {
  const links = existingLinks || []
  const desired = []
  if (isMaster) {
    for (const a of assignments) desired.push(a)
  } else {
    const owned = new Set(callerOwnerLocationIds || [])
    for (const a of assignments) {
      if (owned.has(a.location_id)) desired.push(a)
    }
    for (const link of links) {
      if (!owned.has(link.location_id)) {
        desired.push({
          location_id: link.location_id,
          role: link.role,
          is_default: link.is_default,
          unifi_door_access: link.unifi_door_access,
          permissions: link.permissions || {},
        })
      }
    }
  }

  // Promote one is_default if none set.
  if (desired.length > 0 && !desired.some(a => a.is_default)) {
    desired[0].is_default = true
  }
  // Ensure exactly one is_default.
  let seenDefault = false
  for (const a of desired) {
    if (a.is_default) {
      if (seenDefault) a.is_default = false
      else seenDefault = true
    }
  }
  return desired
}
```

- [ ] **Step 4: Run → PASS** · **Step 5: Commit**

```bash
git add src/lib/staff-write.js src/lib/staff-write.test.js
git commit -m "STAFF-C2b.1c — extract pure computeDesiredAssignments (the assignment-diff core)"
```

---

## Task 4: Point the PUT route at the extracted helpers

Replace the inline blocks with calls. **Byte-identical behavior** — same inputs, same outputs, same order.

**Files:** Modify `src/app/api/staff/[id]/route.js`.

- [ ] **Step 1: Import the helpers** (after the existing imports):

```js
import { buildStaffProfilePatch, assertOwnerAssignmentScope, computeDesiredAssignments, computeProfileRole } from '@/lib/staff-write'
```

- [ ] **Step 2: Replace the owner-scope guard (lines ~165-207).** Replace the whole `if (!user.isMaster) { ... } else if (body.assignments) { ... }` block (the owner-overlap + per-assignment validation, NOT the earlier `canEditStaffMember` block) with:

```js
  {
    const callerOwnerLocationIds = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner')
      .map(([loc]) => loc)
    const targetLocationIds = (targetBefore.profile_locations || []).map(l => l.location_id)
    const scopeErr = assertOwnerAssignmentScope({
      isMaster: user.isMaster,
      callerOwnerLocationIds,
      targetLocationIds,
      assignments: body.assignments,
    })
    if (scopeErr) return NextResponse.json({ success: false, error: scopeErr.error }, { status: scopeErr.status })
  }
```

- [ ] **Step 3: Replace the profileUpdates builder (lines ~219-228).** Replace the nine `if (body.X !== undefined) profileUpdates.X = body.X` lines with:

```js
  const profileUpdates = buildStaffProfilePatch(body)
```

- [ ] **Step 4: Replace the desired-list computation (lines ~270-322).** Inside the `if (body.assignments !== undefined) {` block, replace the `callerScope` derivation + the `const desired = []` construction + the two is_default normalization loops (everything from `const callerScope = ...` through the "Ensure exactly one is_default" loop, UP TO `const desiredIds = new Set(...)`) with:

```js
    const callerOwnerLocationIds = user.isMaster
      ? []
      : Object.entries(user.rolesByLocation || {}).filter(([, r]) => r === 'owner').map(([loc]) => loc)
    const existingByLocation = Object.fromEntries(
      (targetBefore.profile_locations || []).map(l => [l.location_id, l])
    )
    const desired = computeDesiredAssignments({
      isMaster: user.isMaster,
      callerOwnerLocationIds,
      assignments: body.assignments,
      existingLinks: targetBefore.profile_locations || [],
    })
    const desiredIds = new Set(desired.map(a => a.location_id))
```

(Keep `existingByLocation` — the per-row sync loop below uses it. The delete/insert/UniFi loops are UNCHANGED.)

- [ ] **Step 5: Replace the role recompute (lines ~461-465).** Replace the inline `ROLE_PRECEDENCE` + `highest` + `newProfileRole` computation with:

```js
  const newProfileRole = computeProfileRole({
    isMaster: currentMaster,
    assignmentRoles: (refreshed.profile_locations || []).map(l => l.role),
    fallbackRole: refreshed.role,
  })
```

(Keep the `currentMaster` line above it and the `if (newProfileRole !== refreshed.role)` write below it unchanged.)

- [ ] **Step 6: Verify byte-identical behavior**

Run: `npx vitest run src/lib/staff-write.test.js` (helpers green) and the full suite `npm test` (nothing else broke — any existing staff route test must stay green).
Run: `npm run lint` (no unused vars — the old inline `ROLE_PRECEDENCE` const must be gone; grep the file to confirm it's removed).
Run: `npm run build` (the route still compiles).

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/staff/[id]/route.js"
git commit -m "STAFF-C2b.1d — PUT delegates pure logic to staff-write helpers (no behavior change)"
```

---

## Task 5: Gate + PR

- [ ] **Step 1: Full CI mirror + build**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run build`
Expected: all green (existing + new staff-write tests). 1 pre-existing lint warning OK.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin mobile-parity-staff-c2b1
```
Open the PR against `main`, title `STAFF-C2b.1 — extract the staff PUT's pure logic (refactor, zero behavior change)`. Body: the four pure helpers + characterization tests; that the route now delegates to them with byte-identical behavior (no DB/UniFi/orchestration change); that this de-risks the monolith ahead of C2b.2 (orchestration extraction) and C2c (mobile editor). Web-only; no mobile/OTA impact.

---

## Self-review

- **Spec coverage:** extracts the four pure pieces the C2b notes identified, with characterization tests, route delegating — the refactor-first first step. Orchestration extraction + mobile editor are C2b.2 / C2c (outlined).
- **Placeholder scan:** none — full code + exact line-anchored route edits.
- **Type/name consistency:** `buildStaffProfilePatch`, `assertOwnerAssignmentScope` (returns `null | {status,error}`), `computeDesiredAssignments`, `computeProfileRole` defined in Tasks 1-3, consumed in Task 4. The route's `existingByLocation`, `desiredIds`, `currentMaster`, and the delete/insert/UniFi loops are explicitly preserved.
- **Safety:** pure extractions only — no DB, network, UniFi, or comp-write logic changes; the route's observable behavior (responses, side-effects, ordering) is unchanged. Characterization tests pin the tricky desired-assignments + role-recompute behavior. Web-only file; no mobile or OTA impact.
