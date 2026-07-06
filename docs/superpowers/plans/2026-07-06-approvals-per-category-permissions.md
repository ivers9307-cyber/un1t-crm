# Per-category Approval Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single all-or-nothing `approvals_inbox` grant with six independently-grantable per-category approval permissions, enforced in the approvals inbox aggregation and each category's source approve/decline route.

**Architecture:** Six new `WEB_PERMISSIONS` keys drive both tab visibility (via a `permissionKey` on each approvals provider, gated once in the registry) and approve-ability (via `hasPermissionForLocation` on each source route). `approvals_inbox` is repurposed to a *derived* "can open the aggregator" check (feature-on-at-location AND holds ≥1 of the six) and stays the sole location-gated key. Role defaults are seeded to reproduce today's source-route approver sets, so nothing changes for anyone until an operator edits the per-location Roles UI.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres), Vitest, plain-JS `shared/` module shared with the Expo mobile app, `scripts/check-mobile-parity.mjs` parity linter.

**Spec:** `docs/superpowers/specs/2026-07-06-approvals-per-category-permissions-design.md`

**Key constants (from the real code, verified):**
- `MANAGER_ROLES = ['master','owner','manager','head_coach']` (`src/lib/schemas.js:120`)
- Category → permission key → default-holding roles:

| Category | provider key | permission key | default roles (besides master) |
|---|---|---|---|
| Contractor invoices | `contractor_invoices` | `approvals_contractor_invoices` | owner |
| Employee expenses | `fte_expenses` | `approvals_fte_expenses` | owner |
| Agent requests | `agent_requests` | `approvals_agent_requests` | owner, manager, head_coach |
| Time off | `time_off` | `approvals_time_off` | owner, manager, head_coach |
| Shift swaps | `shift_swaps` | `approvals_shift_swaps` | owner, manager, head_coach |
| Roster approvals | `rosters` | `approvals_rosters` | owner |

**Commit discipline:** every task ends with a commit on branch `approvals-per-category` (already checked out in worktree `~/code/un1t-crm-approvals`). Run the CI mirror before the final task; `next build` before pushing.

---

## Task 1: Add the six permission keys, metadata, defaults, and helpers to `shared/permissions.js`

**Files:**
- Modify: `shared/permissions.js`
- Test: `shared/__tests__/permissions.test.js` (or the existing shared-permissions test file — locate with `ls shared/__tests__ src/**/__tests__ | grep -i permission`; if none exists, create `shared/__tests__/permissions.approvals.test.js`)

- [ ] **Step 1: Write the failing test**

Create/append this test. It pins the six keys, the seeded role defaults (behaviour-preserving), the exported helpers, and the location-gate exemption.

```javascript
import { describe, it, expect } from 'vitest'
import {
  WEB_PERMISSION_KEYS,
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  APPROVAL_CATEGORY_PERMISSION,
  APPROVAL_SUBPERMISSION_KEYS,
  isFeatureGatedByLocation,
} from '../permissions.js'

const SUB_KEYS = [
  'approvals_contractor_invoices',
  'approvals_fte_expenses',
  'approvals_agent_requests',
  'approvals_time_off',
  'approvals_shift_swaps',
  'approvals_rosters',
]

describe('per-category approval permissions', () => {
  it('registers the six sub-keys and the provider→permission map', () => {
    for (const k of SUB_KEYS) expect(WEB_PERMISSION_KEYS).toContain(k)
    expect(APPROVAL_SUBPERMISSION_KEYS).toEqual(SUB_KEYS)
    expect(APPROVAL_CATEGORY_PERMISSION).toEqual({
      contractor_invoices: 'approvals_contractor_invoices',
      fte_expenses: 'approvals_fte_expenses',
      agent_requests: 'approvals_agent_requests',
      time_off: 'approvals_time_off',
      shift_swaps: 'approvals_shift_swaps',
      rosters: 'approvals_rosters',
    })
  })

  it('the six sub-keys are NOT location-gated (approvals_inbox is the only gate)', () => {
    for (const k of SUB_KEYS) expect(isFeatureGatedByLocation(k)).toBe(false)
    expect(isFeatureGatedByLocation('approvals_inbox')).toBe(true)
  })

  it('seeds role defaults from current source-route approver sets', () => {
    const finance = ['approvals_contractor_invoices', 'approvals_fte_expenses', 'approvals_rosters']
    const managerish = ['approvals_agent_requests', 'approvals_time_off', 'approvals_shift_swaps']

    // owner + master: all six
    for (const role of ['owner', 'master']) {
      for (const k of SUB_KEYS) expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE[role][k]).toBe(true)
    }
    // manager + head_coach: agent/time_off/swaps only
    for (const role of ['manager', 'head_coach']) {
      for (const k of managerish) expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE[role][k]).toBe(true)
      for (const k of finance) expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE[role][k]).toBe(false)
    }
    // staff + reception: none
    for (const role of ['staff', 'reception']) {
      for (const k of SUB_KEYS) expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE[role][k]).toBe(false)
    }
  })

  it('no longer seeds approvals_inbox as a role grant', () => {
    for (const role of Object.keys(DEFAULT_WEB_PERMISSIONS_BY_ROLE)) {
      expect('approvals_inbox' in DEFAULT_WEB_PERMISSIONS_BY_ROLE[role]).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- permissions`
Expected: FAIL — `APPROVAL_CATEGORY_PERMISSION` undefined / keys missing.

- [ ] **Step 3: Edit `WEB_PERMISSIONS` — mark the parent and add the six**

In `shared/permissions.js`, change the existing `approvals_inbox` entry (around line 152) to add `locationGateOnly: true`, and immediately after it insert the six sub-keys with `group: 'approvals'`:

```javascript
  { key: 'approvals_inbox', label: 'Approvals',                 locationGateOnly: true,
    hint: 'Central inbox aggregating contractor invoices, FTE expenses, time-off and swap requests awaiting your review. Visible to anyone holding at least one per-category approval permission below.' },
  // APPROVALS-PERCAT.1 — per-category approval grants. Each maps 1:1 to an
  // approvals provider (src/lib/approvals/registry.js) and gates BOTH the
  // inbox tab and that category's source approve/decline route. `group`
  // renders them under an "Approvals" subsection in the grant editors;
  // they are NOT location-gated (see isFeatureGatedByLocation) — the
  // approvals_inbox feature card governs the aggregator only.
  { key: 'approvals_contractor_invoices', group: 'approvals', label: '… Contractor invoices', hint: 'Approve or decline contractor invoices. Owner + master by default.' },
  { key: 'approvals_fte_expenses',        group: 'approvals', label: '… Employee expenses',    hint: 'Approve or decline FTE expense claims. Owner + master by default.' },
  { key: 'approvals_agent_requests',      group: 'approvals', label: '… Agent requests',       hint: 'Approve or decline customer-agent requests (pause / cancel / booking drafts). Manager + head coach + owner + master by default.' },
  { key: 'approvals_time_off',            group: 'approvals', label: '… Time off',             hint: 'Approve or reject staff time-off requests. Manager + head coach + owner + master by default.' },
  { key: 'approvals_shift_swaps',         group: 'approvals', label: '… Shift swaps',          hint: 'Approve shift-swap requests. Manager + head coach + owner + master by default.' },
  { key: 'approvals_rosters',             group: 'approvals', label: '… Roster approvals',     hint: 'Approve over-budget draft rosters. Owner + master by default.' },
```

- [ ] **Step 4: Update `DEFAULT_WEB_PERMISSIONS_BY_ROLE`**

In each role map, DELETE the existing `approvals_inbox: …,` line and replace it with the six sub-keys per the table. Use these exact blocks per role:

master (all true):
```javascript
    approvals_contractor_invoices: true, approvals_fte_expenses: true, approvals_agent_requests: true,
    approvals_time_off: true, approvals_shift_swaps: true, approvals_rosters: true,
```
owner (all true): same as master block above.

manager (agent/time_off/swaps true; finance false):
```javascript
    approvals_contractor_invoices: false, approvals_fte_expenses: false, approvals_agent_requests: true,
    approvals_time_off: true, approvals_shift_swaps: true, approvals_rosters: false,
```
head_coach: same as manager block above (agent/time_off/swaps true; finance false).

staff (all false):
```javascript
    approvals_contractor_invoices: false, approvals_fte_expenses: false, approvals_agent_requests: false,
    approvals_time_off: false, approvals_shift_swaps: false, approvals_rosters: false,
```
reception: same as staff block above (all false).

- [ ] **Step 5: Add the map + key-set exports and exempt sub-keys from the location gate**

After the `WEB_PERMISSIONS` array (before `DEFAULT_WEB_PERMISSIONS_BY_ROLE` is fine, or near `WEB_PERMISSION_KEYS`), add:

```javascript
// APPROVALS-PERCAT.1 — provider key → per-category permission key. The
// single definition of the category↔permission relationship, consumed by
// the registry (tab gating) and each source route (approve-ability).
export const APPROVAL_CATEGORY_PERMISSION = Object.freeze({
  contractor_invoices: 'approvals_contractor_invoices',
  fte_expenses: 'approvals_fte_expenses',
  agent_requests: 'approvals_agent_requests',
  time_off: 'approvals_time_off',
  shift_swaps: 'approvals_shift_swaps',
  rosters: 'approvals_rosters',
})

// Ordered list of the six per-category permission keys (matches
// APPROVAL_CATEGORY_PERMISSION values). Used to derive approvals_inbox
// visibility (holds ≥1) and to exempt them from the location gate.
export const APPROVAL_SUBPERMISSION_KEYS = Object.freeze(
  Object.values(APPROVAL_CATEGORY_PERMISSION)
)
```

Then update `isFeatureGatedByLocation` (currently around line 903) so the six sub-keys are never location-gated:

```javascript
export function isFeatureGatedByLocation(key) {
  // Notification preferences are personal — never location-gated.
  if (NOTIFY_KEYS.includes(key)) return false
  // APPROVALS-PERCAT.1 — per-category approval grants are pure grants,
  // not location features; the approvals_inbox card is the only gate.
  if (APPROVAL_SUBPERMISSION_KEYS.includes(key)) return false
  return true
}
```

(If the current body is `return !NOTIFY_KEYS.includes(key)`, replace it wholesale with the block above. `APPROVAL_SUBPERMISSION_KEYS` must be declared above this function — it is, per Step 5 placement; if you placed the exports below, move them above `isFeatureGatedByLocation` or the reference throws at module load.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- permissions`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add shared/permissions.js shared/__tests__
git commit -m "APPROVALS-PERCAT.1 — six per-category approval keys, defaults, helpers"
```

---

## Task 2: Redefine `approvals_inbox` as a derived check in the web adapter

**Files:**
- Modify: `src/lib/permissions.js`
- Test: `src/lib/__tests__/permissions.test.js` (locate the existing test for `hasPermission`; if absent, create `src/lib/__tests__/permissions.approvals.test.js`)

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from 'vitest'
import { hasPermission } from '../permissions.js'

// Minimal user shapes. resolvePermission reads role, activeLocation.features,
// activeAssignment.permissions, activeRoleTemplate.
function user({ role = 'staff', features = {}, perms = {} } = {}) {
  return {
    role,
    activeLocation: { id: 'loc1', features },
    activeAssignment: { permissions: perms },
    activeRoleTemplate: null,
  }
}

describe('derived approvals_inbox', () => {
  it('true when feature on and the user holds ≥1 category (role default)', () => {
    // manager holds agent/time_off/swaps by default
    expect(hasPermission(user({ role: 'manager' }), 'approvals_inbox')).toBe(true)
  })

  it('false when the user holds no category', () => {
    // staff holds none by default
    expect(hasPermission(user({ role: 'staff' }), 'approvals_inbox')).toBe(false)
  })

  it('true for staff granted a single category via per-user override', () => {
    const u = user({ role: 'staff', perms: { approvals_time_off: true } })
    expect(hasPermission(u, 'approvals_inbox')).toBe(true)
    expect(hasPermission(u, 'approvals_time_off')).toBe(true)
    expect(hasPermission(u, 'approvals_contractor_invoices')).toBe(false)
  })

  it('false when the approvals feature is disabled at the location, even for owner', () => {
    const u = user({ role: 'owner', features: { approvals_inbox: false } })
    expect(hasPermission(u, 'approvals_inbox')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/permissions`
Expected: FAIL — `approvals_inbox` resolves via the (now-absent) role default → the first three assertions fail.

- [ ] **Step 3: Add the derived branch to `hasPermission`**

In `src/lib/permissions.js`, extend the imports from `@shared/permissions`:

```javascript
import {
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
  resolvePermission,
  isFeatureEnabledAtLocation,
  APPROVAL_SUBPERMISSION_KEYS,
} from '@shared/permissions'
```

Then, inside `hasPermission`, immediately after the `if (!user) return false` line and before the `master && settings` escape hatch, add:

```javascript
  // APPROVALS-PERCAT.1 — approvals_inbox is now DERIVED: the aggregator
  // is visible iff the Approvals feature is enabled at the active location
  // AND the user holds at least one per-category approval grant. Every
  // consumer (nav, page guard, command palette, today-feed badge) routes
  // through hasPermission, so this one definition covers them all.
  if (key === 'approvals_inbox') {
    if (!isFeatureEnabledAtLocation(user.activeLocation, 'approvals_inbox')) return false
    return APPROVAL_SUBPERMISSION_KEYS.some((k) => hasPermission(user, k))
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/permissions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/permissions.js src/lib/__tests__
git commit -m "APPROVALS-PERCAT.1 — approvals_inbox becomes a derived (any-of-six) check"
```

---

## Task 3: Gate providers by `permissionKey` in the registry

**Files:**
- Modify: `src/lib/approvals/registry.js`
- Test: `src/lib/approvals/__tests__/registry.test.js` (create if absent)

- [ ] **Step 1: Write the failing test**

The registry filters providers by `provider.permissionKey` via `hasPermission`. Assert that `getPendingApprovals` only queries providers the user is permitted for. Stub each provider's `fetchPending` by role using real `hasPermission`.

```javascript
import { describe, it, expect } from 'vitest'
import { getPendingApprovals } from '../registry.js'

// Fake db is never used because our test users lack an active location for
// the query — instead we assert on which provider tabs appear. Providers
// self-scope on viewerActiveLocationId; give the user an active location so
// fetchPending proceeds, and a stubbed db that returns empty result sets.
const db = {
  from() { return this },
  select() { return this },
  eq() { return this },
  in() { return this },
  order() { return this },
  is() { return this },
  then(res) { return Promise.resolve({ data: [], count: 0, error: null }).then(res) },
}

function user(role, perms = {}) {
  return {
    role,
    activeLocation: { id: 'loc1', features: {} },
    activeAssignment: { permissions: perms },
    activeRoleTemplate: null,
    rolesByLocation: { loc1: role },
  }
}

describe('registry per-category gating', () => {
  it('a staff member with no grants sees no approval tabs', async () => {
    const { providers } = await getPendingApprovals(db, user('staff'))
    const keys = providers.map((p) => p.key)
    expect(keys).not.toContain('time_off')
    expect(keys).not.toContain('contractor_invoices')
  })

  it('a staff member granted only time_off sees just the time_off tab (of the six)', async () => {
    const { providers } = await getPendingApprovals(db, user('staff', { approvals_time_off: true }))
    const keys = providers.map((p) => p.key)
    expect(keys).toContain('time_off')
    expect(keys).not.toContain('shift_swaps')
    expect(keys).not.toContain('contractor_invoices')
  })

  it('an owner sees all six category tabs', async () => {
    const { providers } = await getPendingApprovals(db, user('owner'))
    const keys = providers.map((p) => p.key)
    for (const k of ['contractor_invoices', 'fte_expenses', 'agent_requests', 'time_off', 'shift_swaps', 'rosters']) {
      expect(keys).toContain(k)
    }
  })
})
```

> Note: the stubbed `db` above is a minimal thenable matching supabase-js's builder shape. If a provider uses a call this stub doesn't chain, add the missing method returning `this`. The assertions only care about which providers are *visible*, so empty result sets are fine.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- approvals/registry`
Expected: FAIL — before Task 4 the providers still self-gate on role, so `staff + approvals_time_off` returns no `time_off` tab (the provider's own role check blocks it).

> This test depends on Task 4 (providers must stop self-gating). Implement Task 3 and Task 4 together, then run this test at the end of Task 4. Mark Step 2 here as "will pass after Task 4".

- [ ] **Step 3: Import `hasPermission` and gate the visibility filter**

At the top of `src/lib/approvals/registry.js` add:

```javascript
import { hasPermission } from '@/lib/permissions'
```

Replace the `visible` filter in `getPendingApprovals` (lines 89–91):

```javascript
  const visible = APPROVALS_PROVIDERS.filter((p) => {
    // APPROVALS-PERCAT.1 — category providers gate on their permissionKey;
    // providers without one keep their isVisible() gate (invoices_queue, issues).
    if (p.permissionKey) return hasPermission(user, p.permissionKey)
    return typeof p.isVisible !== 'function' || p.isVisible(user)
  })
```

Apply the identical replacement to the `visible` filter in `getPendingApprovalsCount` (lines 128–130).

- [ ] **Step 4: Commit (paired with Task 4)**

Do not commit yet — Task 4 removes the now-redundant provider role checks. Commit at the end of Task 4.

---

## Task 4: Add `permissionKey` to the six providers and remove their role checks

**Files:**
- Modify: `src/lib/approvals/providers/contractor-invoices.js`
- Modify: `src/lib/approvals/providers/fte-expenses.js`
- Modify: `src/lib/approvals/providers/agent-requests.js`
- Modify: `src/lib/approvals/providers/time-off.js`
- Modify: `src/lib/approvals/providers/shift-swaps.js`
- Modify: `src/lib/approvals/providers/rosters.js`
- Test: covered by `src/lib/approvals/__tests__/registry.test.js` (Task 3)

For EACH provider: add a `permissionKey` field next to `key`, and DELETE the role early-return in both `fetchPending` and `countPending` (keep the `activeId` guard, which scopes the query to the active location). Remove any now-unused role constant + `canApproveAtActiveLocation` import.

- [ ] **Step 1: contractor-invoices.js**

Add after `key: 'contractor_invoices',`:
```javascript
  permissionKey: 'approvals_contractor_invoices',
```
Delete both occurrences of:
```javascript
    if (!canApproveAtActiveLocation(user, FINANCE_APPROVER_ROLES)) {
      return { count: 0, items: [] }
    }
```
and in `countPending`:
```javascript
    if (!canApproveAtActiveLocation(user, FINANCE_APPROVER_ROLES)) return 0
```
Delete the now-unused `const FINANCE_APPROVER_ROLES = ['owner']` and drop `canApproveAtActiveLocation` from the `import { … } from '../registry'` line (keep `viewerActiveLocationId`).

- [ ] **Step 2: fte-expenses.js** — identical pattern to Step 1, with `permissionKey: 'approvals_fte_expenses'`.

- [ ] **Step 3: agent-requests.js**

Add `permissionKey: 'approvals_agent_requests',` after `key`.
DELETE the `isVisible(user)` method entirely:
```javascript
  isVisible(user) {
    return canApproveAtActiveLocation(user, HANDLER_ROLES)
  },
```
DELETE the role early-return in `fetchPending` and `countPending`:
```javascript
    if (!canApproveAtActiveLocation(user, HANDLER_ROLES)) {
      return { count: 0, items: [] }
    }
```
```javascript
    if (!canApproveAtActiveLocation(user, HANDLER_ROLES)) return 0
```
Delete `const HANDLER_ROLES = MANAGER_ROLES`, the `import { MANAGER_ROLES } from '@/lib/schemas'`, and drop `canApproveAtActiveLocation` from the registry import (keep `viewerActiveLocationId`).

- [ ] **Step 4: time-off.js** — add `permissionKey: 'approvals_time_off',`; delete both `SCHEDULE_APPROVER_ROLES` early-returns and the constant; drop `canApproveAtActiveLocation` import.

- [ ] **Step 5: shift-swaps.js** — add `permissionKey: 'approvals_shift_swaps',`; delete both `SCHEDULE_APPROVER_ROLES` early-returns and the constant; drop `canApproveAtActiveLocation` import.

- [ ] **Step 6: rosters.js** — add `permissionKey: 'approvals_rosters',`; delete both `ROSTER_APPROVER_ROLES` early-returns and the constant; drop `canApproveAtActiveLocation` import.

- [ ] **Step 7: Run the registry test**

Run: `npm test -- approvals/registry`
Expected: PASS (all three cases from Task 3).

- [ ] **Step 8: Guard against a leftover unused import breaking lint**

Run: `npm run lint`
Expected: no `no-unused-vars` errors in the six provider files. If `canApproveAtActiveLocation` is still imported but unused anywhere, remove it. `invoices-queue.js` and `issues.js` keep their `isVisible` and are untouched.

- [ ] **Step 9: Commit**

```bash
git add src/lib/approvals/registry.js src/lib/approvals/providers src/lib/approvals/__tests__
git commit -m "APPROVALS-PERCAT.1 — gate approval providers by permissionKey in the registry"
```

---

## Task 5: Add the six keys to the mobile-parity allowlist

**Files:**
- Modify: `scripts/check-mobile-parity.mjs`
- Test: `npm run check:mobile-parity`

- [ ] **Step 1: Run the parity check to see it fail**

Run: `npm run check:mobile-parity`
Expected: FAIL — six new `WEB_PERMISSIONS` keys have no mobile counterpart and are not on `WEB_ONLY_OK`.

- [ ] **Step 2: Add six `WEB_ONLY_OK` entries**

In the `WEB_ONLY_OK` object (around line 73), add:

```javascript
  approvals_contractor_invoices: 'Per-category approval grant (APPROVALS-PERCAT.1). The mobile approvals inbox stays on the single `approvals` key; per-category enforcement rides the shared source routes, so no mobile counterpart yet.',
  approvals_fte_expenses:        'Per-category approval grant (APPROVALS-PERCAT.1). Mobile approvals inbox stays on the single `approvals` key; per-category mobile UI is a follow-up.',
  approvals_agent_requests:      'Per-category approval grant (APPROVALS-PERCAT.1). Mobile approvals inbox stays on the single `approvals` key; per-category mobile UI is a follow-up.',
  approvals_time_off:            'Per-category approval grant (APPROVALS-PERCAT.1). Mobile approvals inbox stays on the single `approvals` key; per-category mobile UI is a follow-up.',
  approvals_shift_swaps:         'Per-category approval grant (APPROVALS-PERCAT.1). Mobile approvals inbox stays on the single `approvals` key; per-category mobile UI is a follow-up.',
  approvals_rosters:             'Per-category approval grant (APPROVALS-PERCAT.1). Mobile approvals inbox stays on the single `approvals` key; per-category mobile UI is a follow-up.',
```

- [ ] **Step 3: Run the parity check to verify it passes**

Run: `npm run check:mobile-parity`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-mobile-parity.mjs
git commit -m "APPROVALS-PERCAT.1 — allowlist six per-category keys in mobile-parity"
```

---

## Task 6: Enforce `approvals_contractor_invoices` on the contractor-invoice routes

**Files:**
- Modify: `src/app/api/invoices/[id]/approve/route.js`
- Modify: `src/app/api/invoices/[id]/decline/route.js`
- Test: manual (see Task 15). These routes hit the DB + `getCurrentUser`; there is no existing pure-unit harness, so verification is via the CI mirror + the Task 15 manual matrix.

- [ ] **Step 1: Add the import**

At the top of each route add (or extend an existing `@/lib/permissions` import):
```javascript
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
```

- [ ] **Step 2: Replace the role check in approve/route.js**

Replace (lines ~45–50):
```javascript
  if (user.role !== 'master') {
    const ownerLocations = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner').map(([loc]) => loc)
    if (!ownerLocations.includes(inv.location_id)) {
      return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
    }
  }
```
with:
```javascript
  // APPROVALS-PERCAT.1 — permission is the only gate. 404 (not 403)
  // preserves the IDOR posture: a caller without rights can't tell the
  // invoice exists.
  if (!hasPermissionForLocation(user, inv.location_id, APPROVAL_CATEGORY_PERMISSION.contractor_invoices)) {
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
  }
```

- [ ] **Step 3: Replace the identical block in decline/route.js** (lines ~46–51) with the same replacement.

- [ ] **Step 4: Verify it builds and lints**

Run: `npm run lint && npm run build`
Expected: clean (no unused `NextResponse`/imports; route compiles).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/invoices
git commit -m "APPROVALS-PERCAT.1 — gate contractor-invoice approve/decline on approvals_contractor_invoices"
```

---

## Task 7: Enforce `approvals_fte_expenses` on the expense routes

**Files:**
- Modify: `src/app/api/expenses/[id]/approve/route.js`
- Modify: `src/app/api/expenses/[id]/decline/route.js`

- [ ] **Step 1: Add imports** (both files):
```javascript
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
```

- [ ] **Step 2: Replace the `canApprove` helper + its call (approve/route.js)**

Delete the `canApprove` function (lines ~26–30) and replace its invocation (lines ~48–50):
```javascript
  if (!canApprove(user, claim)) {
    return NextResponse.json({ success: false, error: 'Master or owner-at-location only.' }, { status: 403 })
  }
```
with:
```javascript
  // APPROVALS-PERCAT.1 — permission is the only gate.
  if (!hasPermissionForLocation(user, claim.location_id, APPROVAL_CATEGORY_PERMISSION.fte_expenses)) {
    return NextResponse.json({ success: false, error: 'You do not have permission to approve expenses.' }, { status: 403 })
  }
```

- [ ] **Step 3: Same for decline/route.js** — delete the `canDecline` helper (lines ~24–28) and replace its call (lines ~49–50) with the same block, wording "decline expenses".

- [ ] **Step 4: Lint + build**

Run: `npm run lint && npm run build`
Expected: clean (no leftover unused helper).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/expenses
git commit -m "APPROVALS-PERCAT.1 — gate expense approve/decline on approvals_fte_expenses"
```

---

## Task 8: Fully gate the agent-requests action route

**Files:**
- Modify: `src/app/api/agent/membership-requests/[id]/route.js`

Per the agent-requests decision: this route is now gated on `approvals_agent_requests` (default manager+). Plain staff lose the comms-page action — this is intended.

- [ ] **Step 1: Add imports**
```javascript
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
```

- [ ] **Step 2: Replace the location-membership check with the permission check**

Replace (lines ~43–46):
```javascript
  const allowed = getUserLocationIds(user) // masters carry every active location in user.locations
  if (allowed !== null && !allowed.includes(row.location_id)) {
    // 404 not 403 — detail routes never confirm a foreign id exists.
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
```
with:
```javascript
  // APPROVALS-PERCAT.1 — agent requests are now fully gated on the
  // per-category permission (default manager+). 404 preserves the
  // detail-route IDOR posture (never confirm a foreign id exists).
  if (!hasPermissionForLocation(user, row.location_id, APPROVAL_CATEGORY_PERMISSION.agent_requests)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
```

If `getUserLocationIds` becomes unused after this change, remove its import (check with `grep -n getUserLocationIds` in the file first — it may still be used elsewhere in the handler).

- [ ] **Step 3: Lint + build**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/agent/membership-requests
git commit -m "APPROVALS-PERCAT.1 — fully gate agent-requests action on approvals_agent_requests"
```

---

## Task 9: Enforce `approvals_time_off` on the time-off route

**Files:**
- Modify: `src/app/api/schedule/time-off/[id]/route.js`

Only the approve/reject authority switches to the permission. The requester self-cancel path stays untouched.

- [ ] **Step 1: Add imports**
```javascript
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
```
(`MANAGER_ROLES` is still imported and still used by the self-cancel branch at lines ~40 and ~44 — leave that import in place.)

- [ ] **Step 2: Replace the approve/reject gate**

Replace (lines ~51–54):
```javascript
  // If approving or rejecting, record who did it
  if (status === 'approved' || status === 'rejected') {
    if (!MANAGER_ROLES.includes(user.role)) {
      return NextResponse.json({ success: false, error: 'Only managers can approve or reject requests' }, { status: 403 })
    }
```
with:
```javascript
  // If approving or rejecting, record who did it
  if (status === 'approved' || status === 'rejected') {
    // APPROVALS-PERCAT.1 — permission is the only gate for the decision.
    if (!hasPermissionForLocation(user, existing.location_id, APPROVAL_CATEGORY_PERMISSION.time_off)) {
      return NextResponse.json({ success: false, error: 'You do not have permission to approve or reject time-off requests.' }, { status: 403 })
    }
```
(Keep the rest of the block — the `reviewed_by`/`reviewed_at` recording that follows — unchanged. Verify `existing.location_id` is present on the loaded row; the row is selected earlier in the handler as `existing`. If the select does not include `location_id`, add it to that `.select(...)`.)

- [ ] **Step 3: Lint + build**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/schedule/time-off
git commit -m "APPROVALS-PERCAT.1 — gate time-off approve/reject on approvals_time_off"
```

---

## Task 10: Enforce `approvals_shift_swaps` on the swap approval transition

**Files:**
- Modify: `src/lib/swap-lifecycle.js` (add a `canApprove` arg to `resolveSwapTransition`)
- Modify: `src/app/api/schedule/swaps/[id]/route.js` (compute + pass `canApprove`)
- Test: `src/lib/__tests__/swap-lifecycle.test.js` (extend if present; else add a focused test)

- [ ] **Step 1: Write the failing test**

Add to the swap-lifecycle test (adjust the import path/args to match existing tests):
```javascript
import { describe, it, expect } from 'vitest'
import { resolveSwapTransition } from '../swap-lifecycle.js'

describe('resolveSwapTransition canApprove override', () => {
  const baseSwap = { id: 's1', status: 'awaiting_approval', location_id: 'loc1' }

  it('denies approve when canApprove is false even for a manager role', () => {
    const d = resolveSwapTransition({
      swap: baseSwap,
      requestedStatus: 'approved',
      user: { id: 'u1', role: 'manager' },
      userLocationIds: ['loc1'],
      reviewNote: null,
      canApprove: false,
    })
    expect(d.ok).toBe(false)
    expect(d.status).toBe(403)
  })

  it('allows approve when canApprove is true even for a non-manager role', () => {
    const d = resolveSwapTransition({
      swap: baseSwap,
      requestedStatus: 'approved',
      user: { id: 'u1', role: 'staff' },
      userLocationIds: ['loc1'],
      reviewNote: null,
      canApprove: true,
    })
    expect(d.ok).toBe(true)
  })

  it('defaults canApprove to the MANAGER_ROLES check when omitted (back-compat)', () => {
    const d = resolveSwapTransition({
      swap: baseSwap,
      requestedStatus: 'approved',
      user: { id: 'u1', role: 'manager' },
      userLocationIds: ['loc1'],
      reviewNote: null,
    })
    expect(d.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- swap-lifecycle`
Expected: FAIL — `canApprove` is ignored.

- [ ] **Step 3: Thread `canApprove` through `resolveSwapTransition`**

In `src/lib/swap-lifecycle.js`, change the signature to accept `canApprove` and default it to the existing manager check. Where the function currently computes (line ~40):
```javascript
  const isManager = MANAGER_ROLES.includes(user.role)
```
add, right after it:
```javascript
  // APPROVALS-PERCAT.1 — the "approve" transition is gated by the
  // approvals_shift_swaps permission (passed in by the route). Claim /
  // accept / reject-by-target keep using isManager. Default preserves the
  // old behaviour for any caller that doesn't pass canApprove.
  const mayApprove = typeof canApprove === 'boolean' ? canApprove : isManager
```
and add `canApprove` to the destructured args object of the function signature. Then in the approve branch (line ~112) change:
```javascript
    if (!isManager) return deny(403, 'Only a manager can approve')
```
to:
```javascript
    if (!mayApprove) return deny(403, 'You do not have permission to approve swaps')
```

- [ ] **Step 4: Pass the permission from the route**

In `src/app/api/schedule/swaps/[id]/route.js` add imports:
```javascript
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
```
and change the `resolveSwapTransition({...})` call (lines ~39–45) to pass `canApprove`:
```javascript
  const decision = resolveSwapTransition({
    swap,
    requestedStatus: body.status,
    user,
    userLocationIds: getUserLocationIds(user),
    reviewNote: body.review_note ?? null,
    canApprove: hasPermissionForLocation(user, swap.location_id, APPROVAL_CATEGORY_PERMISSION.shift_swaps),
  })
```
(Confirm the loaded `swap` object includes `location_id`; if not, add it to the select that populates `swap`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- swap-lifecycle`
Expected: PASS.

- [ ] **Step 6: Lint + build**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/swap-lifecycle.js src/app/api/schedule/swaps src/lib/__tests__
git commit -m "APPROVALS-PERCAT.1 — gate shift-swap approve on approvals_shift_swaps"
```

---

## Task 11: Enforce `approvals_rosters` on the roster approve route

**Files:**
- Modify: `src/app/api/schedule/rosters/[id]/approve/route.js`

- [ ] **Step 1: Add imports**
```javascript
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
```

- [ ] **Step 2: Remove the coarse pre-load owner gate**

Delete the early role gate (lines ~21–26):
```javascript
  const isMaster = user.role === 'master'
  const isOwnerSomewhere = (user.assignmentsByLocation || user.profileLocations || [])
    .some?.(l => (l.role || '') === 'owner')
  if (!isMaster && !isOwnerSomewhere && user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Only owners can approve rosters.' }, { status: 403 })
  }
```
If `isMaster` is referenced later in the handler (it is, in the per-location block below), keep the single line `const isMaster = user.role === 'master'` and delete only the `isOwnerSomewhere` + `if (...)` gate.

- [ ] **Step 3: Replace the per-location ownership block with the permission check**

Replace (lines ~47–57):
```javascript
  // Per-location ownership check for non-master.
  if (!isMaster) {
    const userLocationIds = getUserLocationIds(user)
    if (!userLocationIds.includes(roster.location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden — not an owner at this location.' }, { status: 403 })
    }
    // Make sure the user is specifically OWNER at this location
    // (not just in_location). Phase 5 spec gates this on owner role.
    const role = user.rolesByLocation?.[roster.location_id]
    if (role !== 'owner') {
      return NextResponse.json({ success: false, error: 'Approval requires the owner role at this location.' }, { status: 403 })
    }
  }
```
with:
```javascript
  // APPROVALS-PERCAT.1 — permission is the only gate (roster.location_id
  // resolved after the roster row loaded above).
  if (!hasPermissionForLocation(user, roster.location_id, APPROVAL_CATEGORY_PERMISSION.rosters)) {
    return NextResponse.json({ success: false, error: 'You do not have permission to approve rosters.' }, { status: 403 })
  }
```
If `isMaster` is now unused, delete its declaration; if `getUserLocationIds` is now unused in the file, remove its import (grep first).

- [ ] **Step 4: Lint + build**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedule/rosters
git commit -m "APPROVALS-PERCAT.1 — gate roster approval on approvals_rosters"
```

---

## Task 12: Group the six under "Approvals" in the per-location Roles editor

**Files:**
- Modify: `src/components/RolePermissions.jsx`

- [ ] **Step 1: Filter the main web list and add an Approvals section**

At the `webItems` assignment (line ~120):
```javascript
  const webItems = WEB_PERMISSIONS
```
replace with:
```javascript
  // APPROVALS-PERCAT.1 — approvals_inbox is location-gate-only (edited in
  // Location Features, not here); the six per-category grants render in
  // their own "Approvals" group below.
  const webItems = WEB_PERMISSIONS.filter((p) => !p.locationGateOnly && p.group !== 'approvals')
  const approvalItems = WEB_PERMISSIONS.filter((p) => p.group === 'approvals')
```

Then, immediately after the existing "Web features" `</section>` (after line ~246), add a new section:
```javascript
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-un1t-subtle mb-1">Approvals</h3>
          <div className="divide-y divide-un1t-border/60">
            {approvalItems.map((p) => (
              <Toggle
                key={p.key}
                label={p.label}
                hint={p.hint}
                on={blob[p.key] === true}
                changed={blob[p.key] !== baseline[p.key]}
                busy={saving}
                onToggle={() => setKey(p.key, false, !(blob[p.key] === true))}
              />
            ))}
          </div>
        </section>
```

- [ ] **Step 2: Verify in the browser (Task 15) — for now, build + lint**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/RolePermissions.jsx
git commit -m "APPROVALS-PERCAT.1 — Approvals group in the per-location Roles editor"
```

---

## Task 13: Group the six under "Approvals" in the per-user StaffForm picker

**Files:**
- Modify: `src/components/StaffForm.jsx`

- [ ] **Step 1: Split the permission list**

`allPermissions` is `WEB_PERMISSIONS` (imported at line 15). Just before the web-permissions render loop (line ~932, where `{allPermissions.map(perm => {` begins), introduce two derived lists. Find the enclosing block and replace the single `allPermissions.map(...)` with a grant list that excludes the parent + approvals group, followed by an Approvals subsection. Concretely:

Add near the top of the component body (after other `const` derivations):
```javascript
  // APPROVALS-PERCAT.1 — hide the location-gate-only approvals_inbox from
  // the per-user grant picker; render the six per-category grants grouped.
  const webGrantItems = allPermissions.filter((p) => !p.locationGateOnly && p.group !== 'approvals')
  const approvalGrantItems = allPermissions.filter((p) => p.group === 'approvals')
```

- [ ] **Step 2: Point the existing loop at `webGrantItems` and add the group**

Change the existing render loop header from:
```javascript
{allPermissions.map(perm => {
```
to:
```javascript
{webGrantItems.map(perm => {
```
Then, immediately after that loop's closing `})}`, add a heading + a second loop that reuses the SAME row markup (copy the row JSX from the existing loop verbatim, swapping the source list) so styling stays identical:
```javascript
<div className="mt-3 mb-1 text-xs font-semibold uppercase tracking-wide text-un1t-subtle">Approvals</div>
{approvalGrantItems.map(perm => {
  const selectedLoc = locations.find(l => l.id === selectedPermLocationId)
  const offHere = isFeatureGatedByLocation(perm.key) && selectedLoc?.features?.[perm.key] === false
  const overridden = (selectedPerms[perm.key] === true) !== (selectedRoleBase[perm.key] === true)
  return (
    <label key={perm.key} className={`flex items-center justify-between py-1.5 cursor-pointer ${offHere ? 'opacity-60' : ''}`}>
      <span className="text-sm">
        {perm.label}
        {overridden && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 ml-1.5 align-middle" title="Per-user override — differs from this person's role permissions at this location" />
        )}
      </span>
      <button
        type="button"
        onClick={() => togglePermission(perm.key)}
        disabled={!selectedPermLocationId}
        className={`w-10 h-5 rounded-full transition-colors shrink-0 ${selectedPerms[perm.key] ? 'bg-green-500' : 'bg-un1t-border'} ${!selectedPermLocationId ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <div className={`w-4 h-4 rounded-full bg-white transition-transform ${selectedPerms[perm.key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </label>
  )
})}
```
(`offHere` will always be false for the six since they aren't location-gated, but the code mirrors the existing row for consistency. `isFeatureGatedByLocation` is already imported at line ~16.)

- [ ] **Step 3: Lint + build**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/StaffForm.jsx
git commit -m "APPROVALS-PERCAT.1 — Approvals group in the per-user permission picker"
```

---

## Task 14: Migration — strip the inert `approvals_inbox` grant key

**Files:**
- Create: `supabase/migrations/378_approvals_percat_strip_inbox_grant.sql`

Apply via Supabase MCP `apply_migration` against project `iyvtbjjxdggiadzwwvdj` (un1t-crm), NOT the sentinel project. Confirm with `list_projects` first.

- [ ] **Step 1: Write the migration file**

```sql
-- APPROVALS-PERCAT.1 (mig 378) — approvals_inbox is now a DERIVED web
-- permission (any-of-six), no longer a stored grant. Strip the inert key
-- from the two grant blobs. Data-only, forward-only, idempotent.
-- locations.features.approvals_inbox is intentionally left untouched — it
-- remains the location feature gate for the aggregator inbox.

update profile_locations
   set permissions = permissions - 'approvals_inbox'
 where permissions ? 'approvals_inbox';

update location_role_permissions
   set permissions = permissions - 'approvals_inbox'
 where permissions ? 'approvals_inbox';
```

- [ ] **Step 2: Apply via MCP**

Use the Supabase MCP `apply_migration` tool with name `378_approvals_percat_strip_inbox_grant` and the SQL above.

- [ ] **Step 3: Verify no rows retain the key**

Run via MCP `execute_sql`:
```sql
select
  (select count(*) from profile_locations where permissions ? 'approvals_inbox') as pl_remaining,
  (select count(*) from location_role_permissions where permissions ? 'approvals_inbox') as lrp_remaining,
  (select count(*) from locations where features ? 'approvals_inbox') as loc_features_untouched;
```
Expected: `pl_remaining = 0`, `lrp_remaining = 0`, `loc_features_untouched` unchanged (non-zero if any location had the card set).

- [ ] **Step 4: Advisors (per estate convention)**

Run MCP `get_advisors` (type=security). Expected: no NEW advisories attributable to this change (data-only, no DDL). Note any pre-existing ones are unrelated.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/378_approvals_percat_strip_inbox_grant.sql
git commit -m "APPROVALS-PERCAT.1 — mig 378: strip inert approvals_inbox grant key"
```

---

## Task 15: Full verification + manual matrix

**Files:** none (verification only)

- [ ] **Step 1: Run the full CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```
Expected: all six green.

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: Turbopack build succeeds (catches import-resolution the mocked tests miss — especially the new `@shared/permissions` imports across routes).

- [ ] **Step 3: Manual behaviour matrix (dev server, `npm run dev`)**

Verify with a test user at Stillorgan:

| Scenario | Expected |
|---|---|
| Owner opens `/approvals` | All six tabs visible, counts as before |
| Manager opens `/approvals` | Agent requests, Time off, Shift swaps tabs only |
| Head coach opens `/approvals` | Now visible (was hidden): Agent requests, Time off, Shift swaps |
| Staff opens `/approvals` | Redirected to `/dashboard` (no grants) |
| Grant a staff member `Time off` only via Settings → location → Roles (or per-user in StaffForm) | They now see `/approvals` with only the Time off tab; can approve a time-off request; get 403 approving a contractor invoice via its source page |
| Settings → location → Location Features | Only the single "Approvals" card shows (no six sub-cards); toggling it off hides the aggregator but source-page approvals still work |
| Settings → location → Roles → Approvals group | Six toggles present, amber dot appears when changed from the role default |

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin approvals-per-category
gh pr create --base main --fill
```
Report the PR URL. Note in the PR description: the two intended behaviour changes — (1) head_coach now sees the Approvals inbox for categories they could already approve; (2) plain staff can no longer action agent requests from the comms page (agent-requests decision).

---

## Self-review checklist (completed by plan author)

- **Spec coverage:** §1 keys → Task 1; §1 derived visibility → Task 2; §2 defaults → Task 1; §3 registry → Tasks 3–4; §3 source routes (all six) → Tasks 6–11; §4 Roles/StaffForm UI → Tasks 12–13; §4 LocationFeatures (no change — sub-keys auto-excluded) → verified in Task 15 Step 3; §5 migration → Task 14; parity → Task 5; §7 testing → Tasks 1–3, 10 + Task 15. Mobile (`approvals` key unchanged) — no task needed. All spec sections covered.
- **Placeholders:** none — every code step shows the exact before/after.
- **Type/name consistency:** `APPROVAL_CATEGORY_PERMISSION` (object, provider-key-keyed) and `APPROVAL_SUBPERMISSION_KEYS` (array) used consistently across Tasks 1–13; permission key strings identical everywhere; provider `permissionKey` field name consistent.
