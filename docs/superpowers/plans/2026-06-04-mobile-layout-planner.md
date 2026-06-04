# Mobile Layout Planner — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator arrange each staff member's mobile bottom bar (which enabled features fill the 3 slots vs. live under "More"), via role × employment-type defaults + per-person override in StaffForm.

**Architecture:** A pure, shared resolver (`shared/mobile-nav.js`) turns `{ role, employmentType, enabledKeys, override }` into `{ bar, more, allowed }`. The mobile app **resolves layout client-side** (the override already rides inside the per-assignment `permissions.mobile` blob that `/api/mobile/me` serializes — **no API change needed**), and `(tabs)/_layout.jsx` + `more.jsx` render from the result. StaffForm gains a planner that writes `permissions.mobile.layout`. Resolution intersects with the user's *enabled* features, so the default templates reproduce today's bar for every role except owner (intentionally lean).

> **Refinement vs. the design spec §8:** the spec proposed serializing `{ bar, more }` from `/api/mobile/me`. We resolve client-side instead — strictly simpler, no server logic to duplicate, and the override already ships in the serialized `permissions.mobile.layout` sub-key. Layout is UI-only (RLS is the security boundary — see the MOBILE-AUDIT.5 note in `mobile/lib/permissions.js`), so client-side resolution is safe.

**Tech Stack:** Plain JS (no TS — type annotations fail to parse), Vitest (`shared/*.test.js`, runs in the web suite), Expo Router `Tabs`, React (StaffForm). `shared/mobile-nav.js` is imported by both `src/` (web) and `mobile/`.

**Branch:** `mobile-layout-planner` (already created; the design spec is committed there).

**Spec:** `docs/superpowers/specs/2026-06-04-mobile-layout-planner-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/mobile-nav.js` *(create)* | Nav-feature registry, `BAR_ELIGIBLE`, `DEFAULT_MOBILE_LAYOUT`, pure `resolveMobileLayout`. |
| `shared/mobile-nav.test.js` *(create)* | Resolver unit tests (vitest). |
| `mobile/lib/mobile-layout.js` *(create)* | `resolveLayoutForUser(profile, activeLocation)` — computes `enabledKeys` via `canMobile`, reads the override, calls the shared resolver. |
| `mobile/app/(tabs)/_layout.jsx` *(modify)* | Render tabs data-driven from the resolved `bar` (order + visibility). |
| `mobile/app/(tabs)/more.jsx` *(modify)* | Render More rows from the resolved `more` set. |
| `src/components/MobileBarPlanner.jsx` *(create)* | The bottom-bar planner sub-component (slot selects + allowed checkboxes). |
| `src/components/StaffForm.jsx` *(modify)* | Mount `<MobileBarPlanner>` in the Mobile App Features section; wire to `patchSelectedMobilePerms`. |

---

## Task 1: Nav registry + defaults (`shared/mobile-nav.js`)

**Files:**
- Create: `shared/mobile-nav.js`
- Test: `shared/mobile-nav.test.js`

- [ ] **Step 1: Create `shared/mobile-nav.js` with the registry, eligibility set, and default templates**

```js
// Mobile navigation model (MOBILE-LAYOUT.1).
//
// One source of truth for the navigable surfaces the iOS app can place in
// the bottom bar vs. the "More" drawer, the role × employment-type default
// layouts, and the pure resolver that combines them with the user's enabled
// feature set + their admin/per-person override.
//
// This is UI arrangement only — RLS is the security boundary (see the
// MOBILE-AUDIT.5 note in mobile/lib/permissions.js). Layout never grants
// access; it only decides where an already-enabled feature appears.

// Each navigable feature.
//   key:            the layout/nav key (also the (tabs) route name for tabs)
//   label:          shown in the StaffForm planner
//   permKeys:       OR-list of permission keys that enable it (canMobile keys)
//   employmentType: if set, only enabled for that employment_type
//   barEligible:    can it occupy a bottom-bar slot in Phase 1?
//                   (true == it is already an expo-router (tabs) route)
export const MOBILE_NAV_FEATURES = Object.freeze([
  { key: 'schedule', label: 'Schedule',  permKeys: ['schedule'],                   barEligible: true },
  { key: 'whatsapp', label: 'WhatsApp',  permKeys: ['whatsapp'],                   barEligible: true },
  { key: 'studio',   label: 'Studio',    permKeys: ['studio_management'],          barEligible: true },
  { key: 'pipeline', label: 'Pipeline',  permKeys: ['pipeline'],                   barEligible: true },
  { key: 'bookings', label: 'Bookings',  permKeys: ['bookings'],                   barEligible: true },
  { key: 'invoices', label: 'Invoices',  permKeys: ['invoices'], employmentType: 'contractor', barEligible: true },
  { key: 'expenses', label: 'Expenses',  permKeys: ['expenses'], employmentType: 'fte',        barEligible: true },
  // More-only in Phase 1 (pushed routes outside the (tabs) group).
  { key: 'tasks',     label: 'Tasks',            permKeys: ['tasks'],                       barEligible: false },
  { key: 'radar',     label: 'Radar',            permKeys: ['churn_radar', 'lead_radar'],   barEligible: false },
  { key: 'issues',    label: 'Report a problem', permKeys: ['issues'],                      barEligible: false },
  { key: 'contracts', label: 'Contracts',        permKeys: ['contracts'],                   barEligible: false },
  { key: 'policies',  label: 'Policies',         permKeys: ['policies'],                    barEligible: false },
])

// Canonical key order — used to give the "More" list a stable, sensible
// order (mirrors today's More sections: ops → finance → insights → report
// → documents).
export const MOBILE_NAV_ORDER = Object.freeze(MOBILE_NAV_FEATURES.map(f => f.key))

export const BAR_ELIGIBLE = Object.freeze(
  MOBILE_NAV_FEATURES.filter(f => f.barEligible).map(f => f.key)
)

// Default templates, role × employment-type. Built DRY from a per-role base
// plus the employment-appropriate finance surface in `allowed` (invoices for
// contractors, expenses for FTE) — so the resolved layout differs by
// employment type without per-type hand-maintenance. Owners are intentionally
// lean (Schedule + Studio); every other role reproduces today's bar.
const FINANCE_KEY = { fte: 'expenses', contractor: 'invoices' }
const LAYOUT_BASE = {
  owner:      { bar: ['schedule', 'studio'],             allowed: ['schedule', 'studio', 'whatsapp', 'pipeline', 'bookings'] },
  manager:    { bar: ['schedule', 'whatsapp', 'studio'], allowed: ['schedule', 'whatsapp', 'studio', 'pipeline', 'bookings'] },
  head_coach: { bar: ['schedule', 'whatsapp', 'studio'], allowed: ['schedule', 'whatsapp', 'studio', 'bookings', 'pipeline'] },
  staff:      { bar: ['schedule'],                       allowed: ['schedule', 'bookings'] },
  master:     { bar: ['schedule', 'studio'],             allowed: ['schedule', 'studio', 'whatsapp', 'pipeline', 'bookings'] },
}
function withFinance(base, employmentType) {
  return { bar: [...base.bar], allowed: [...base.allowed, FINANCE_KEY[employmentType]] }
}
export const DEFAULT_MOBILE_LAYOUT = Object.freeze(
  Object.fromEntries(
    Object.entries(LAYOUT_BASE).map(([role, base]) => [role, Object.freeze({
      fte: Object.freeze(withFinance(base, 'fte')),
      contractor: Object.freeze(withFinance(base, 'contractor')),
    })])
  )
)
```

- [ ] **Step 2: Write the registry shape test**

```js
// shared/mobile-nav.test.js
import { describe, it, expect } from 'vitest'
import {
  MOBILE_NAV_FEATURES, BAR_ELIGIBLE, DEFAULT_MOBILE_LAYOUT, MOBILE_NAV_ORDER,
} from './mobile-nav.js'

describe('mobile-nav registry', () => {
  it('every feature has key/label/permKeys/barEligible', () => {
    for (const f of MOBILE_NAV_FEATURES) {
      expect(typeof f.key).toBe('string')
      expect(typeof f.label).toBe('string')
      expect(Array.isArray(f.permKeys) && f.permKeys.length > 0).toBe(true)
      expect(typeof f.barEligible).toBe('boolean')
    }
  })

  it('BAR_ELIGIBLE is exactly the bar-eligible keys', () => {
    expect([...BAR_ELIGIBLE].sort()).toEqual(
      ['bookings', 'expenses', 'invoices', 'pipeline', 'schedule', 'studio', 'whatsapp'].sort()
    )
  })

  it('keys are unique and MOBILE_NAV_ORDER matches', () => {
    const keys = MOBILE_NAV_FEATURES.map(f => f.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(MOBILE_NAV_ORDER).toEqual(keys)
  })

  it('every role default references only known + bar-eligible keys', () => {
    const eligible = new Set(BAR_ELIGIBLE)
    for (const role of Object.keys(DEFAULT_MOBILE_LAYOUT)) {
      for (const type of ['fte', 'contractor']) {
        const t = DEFAULT_MOBILE_LAYOUT[role][type]
        for (const k of [...t.bar, ...t.allowed]) expect(eligible.has(k)).toBe(true)
        expect(t.bar.length).toBeLessThanOrEqual(3)
      }
    }
  })
})
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run shared/mobile-nav.test.js`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add shared/mobile-nav.js shared/mobile-nav.test.js
git commit -m "MOBILE-LAYOUT.1 — nav registry + role×employment-type default templates"
```

---

## Task 2: The pure resolver `resolveMobileLayout` (TDD)

**Files:**
- Modify: `shared/mobile-nav.js` (append the function)
- Test: `shared/mobile-nav.test.js` (append cases)

- [ ] **Step 1: Write the failing tests**

Append to `shared/mobile-nav.test.js`:

```js
import { resolveMobileLayout } from './mobile-nav.js'

const ALL = ['schedule', 'whatsapp', 'studio', 'pipeline', 'bookings', 'expenses', 'tasks', 'radar', 'issues', 'contracts', 'policies']

describe('resolveMobileLayout', () => {
  it('manager default reproduces today’s bar', () => {
    const r = resolveMobileLayout({ role: 'manager', employmentType: 'fte', enabledKeys: ALL, override: null })
    expect(r.bar).toEqual(['schedule', 'whatsapp', 'studio'])
    expect(r.more).toContain('pipeline')
    expect(r.more).not.toContain('schedule')
  })

  it('owner default is the lean Schedule + Studio', () => {
    const r = resolveMobileLayout({ role: 'owner', employmentType: 'fte', enabledKeys: ALL, override: null })
    expect(r.bar).toEqual(['schedule', 'studio'])
    expect(r.more).toContain('whatsapp') // WhatsApp dropped to More for owners
  })

  it('an override beats the template and is capped at 3, ordered', () => {
    const r = resolveMobileLayout({
      role: 'manager', employmentType: 'fte', enabledKeys: ALL,
      override: { bar: ['pipeline', 'schedule', 'whatsapp', 'studio'], allowed: ['pipeline', 'schedule', 'whatsapp', 'studio'] },
    })
    expect(r.bar).toEqual(['pipeline', 'schedule', 'whatsapp']) // 4th dropped by cap
  })

  it('drops bar/allowed entries that are not enabled', () => {
    const r = resolveMobileLayout({
      role: 'manager', employmentType: 'fte',
      enabledKeys: ['schedule', 'studio'], // whatsapp toggled off
      override: null,
    })
    expect(r.bar).toEqual(['schedule', 'studio'])
  })

  it('never exposes a non-bar-eligible key in the bar even if an override lists it', () => {
    const r = resolveMobileLayout({
      role: 'staff', employmentType: 'fte', enabledKeys: ALL,
      override: { bar: ['tasks', 'schedule'], allowed: ['tasks', 'schedule'] },
    })
    expect(r.bar).toEqual(['schedule']) // 'tasks' is not bar-eligible
    expect(r.more).toContain('tasks')
  })

  it('contractor vs fte: finance surface differs', () => {
    const fte = resolveMobileLayout({ role: 'staff', employmentType: 'fte', enabledKeys: ['schedule', 'expenses'], override: null })
    const con = resolveMobileLayout({ role: 'staff', employmentType: 'contractor', enabledKeys: ['schedule', 'invoices'], override: null })
    expect(fte.more).toContain('expenses')
    expect(fte.allowed).toContain('expenses')
    expect(con.allowed).toContain('invoices')
    expect(con.allowed).not.toContain('expenses')
  })

  it('bar items are implicitly allowed (override with bar but empty allowed still works)', () => {
    const r = resolveMobileLayout({
      role: 'manager', employmentType: 'fte', enabledKeys: ALL,
      override: { bar: ['schedule', 'pipeline'], allowed: [] },
    })
    expect(r.bar).toEqual(['schedule', 'pipeline'])
  })

  it('more is ordered by MOBILE_NAV_ORDER and excludes bar items', () => {
    const r = resolveMobileLayout({ role: 'manager', employmentType: 'fte', enabledKeys: ALL, override: null })
    const idx = (k) => r.more.indexOf(k)
    expect(idx('pipeline')).toBeGreaterThanOrEqual(0)
    expect(idx('pipeline')).toBeLessThan(idx('tasks')) // registry order preserved
    for (const k of r.bar) expect(r.more).not.toContain(k)
  })

  it('unknown role falls back to staff/fte without throwing', () => {
    const r = resolveMobileLayout({ role: 'nope', employmentType: null, enabledKeys: ['schedule'], override: null })
    expect(r.bar).toEqual(['schedule'])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run shared/mobile-nav.test.js`
Expected: FAIL with `resolveMobileLayout is not a function` (or undefined import).

- [ ] **Step 3: Implement `resolveMobileLayout`** — append to `shared/mobile-nav.js`:

```js
const BAR_ELIGIBLE_SET = new Set(BAR_ELIGIBLE)

/**
 * Resolve the effective mobile layout for a user at a location.
 * Pure — no IO. UI arrangement only.
 *
 * @param {object} args
 * @param {string} args.role            profile.role (active-location role)
 * @param {string|null} args.employmentType  'fte' | 'contractor' | null
 * @param {string[]} args.enabledKeys   nav keys the user passes Layer-1 for
 * @param {{bar?:string[], allowed?:string[]}|null} args.override  permissions.mobile.layout
 * @returns {{ bar: string[], more: string[], allowed: string[] }}
 */
export function resolveMobileLayout({ role, employmentType, enabledKeys, override }) {
  const enabled = new Set(enabledKeys || [])
  const tmpl =
    (DEFAULT_MOBILE_LAYOUT[role] && (DEFAULT_MOBILE_LAYOUT[role][employmentType] || DEFAULT_MOBILE_LAYOUT[role].fte)) ||
    DEFAULT_MOBILE_LAYOUT.staff.fte

  const base = override && Array.isArray(override.bar) ? override : tmpl

  // Bar items are implicitly allowed; intersect with enabled + bar-eligible.
  const allowed = [...new Set([...(base.allowed || []), ...(base.bar || [])])]
    .filter(k => enabled.has(k) && BAR_ELIGIBLE_SET.has(k))
  const allowedSet = new Set(allowed)

  const bar = []
  for (const k of (base.bar || [])) {
    if (allowedSet.has(k) && !bar.includes(k)) bar.push(k)
    if (bar.length === 3) break
  }
  const barSet = new Set(bar)

  // Everything else enabled (incl. non-bar-eligible like tasks/radar),
  // ordered by the canonical registry order.
  const more = MOBILE_NAV_ORDER.filter(k => enabled.has(k) && !barSet.has(k))

  return { bar, more, allowed }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run shared/mobile-nav.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add shared/mobile-nav.js shared/mobile-nav.test.js
git commit -m "MOBILE-LAYOUT.2 — pure resolveMobileLayout (template/override → {bar,more,allowed})"
```

---

## Task 3: Mobile glue (`mobile/lib/mobile-layout.js`)

> Mobile lib is not in the web vitest suite, so this thin glue is verified via the build + on-device, not a unit test. The logic it depends on (`resolveMobileLayout`) is already fully tested in Task 2.

**Files:**
- Create: `mobile/lib/mobile-layout.js`

- [ ] **Step 1: Create the glue**

```js
// Resolve a user's effective mobile layout (bottom bar + More) at their
// active location. Computes the enabled nav-feature set with the SAME
// permission helpers the screens already use (canMobile routes cross-platform
// keys like studio_management through canDashboard), reads the per-assignment
// override from the serialized permissions blob, and runs the shared resolver.
import { MOBILE_NAV_FEATURES, resolveMobileLayout } from '../../shared/mobile-nav'
import { canMobile } from './permissions'

function navFeatureEnabled(profile, feature, activeLocation) {
  if (feature.employmentType && profile?.employment_type !== feature.employmentType) return false
  return feature.permKeys.some(k => canMobile(profile, k, activeLocation))
}

/**
 * @param {object|null} profile         from /api/mobile/me
 * @param {object|null} activeLocation  has .permissions.mobile.layout + .permissions + .features
 * @returns {{ bar: string[], more: string[], allowed: string[] }}
 */
export function resolveLayoutForUser(profile, activeLocation) {
  if (!profile) return { bar: [], more: [], allowed: [] }
  const enabledKeys = MOBILE_NAV_FEATURES
    .filter(f => navFeatureEnabled(profile, f, activeLocation))
    .map(f => f.key)
  const override = activeLocation?.permissions?.mobile?.layout || null
  return resolveMobileLayout({
    role: profile.role,
    employmentType: profile.employment_type,
    enabledKeys,
    override,
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add mobile/lib/mobile-layout.js
git commit -m "MOBILE-LAYOUT.3 — mobile glue: resolveLayoutForUser (enabled set + override → layout)"
```

---

## Task 4: Data-driven bottom bar (`mobile/app/(tabs)/_layout.jsx`)

**Files:**
- Modify: `mobile/app/(tabs)/_layout.jsx`

- [ ] **Step 1: Replace the static `Tabs.Screen` list with a computed, ordered render**

Replace the component body's `return (...)` block and add the layout resolution. Keep the existing imports, the push-registration effect, the loading/session guards, `ImpersonateBanner`, and `PendingContractsBanner`. Add the import and replace the tab rendering.

Add near the other imports:

```js
import { resolveLayoutForUser } from '../../lib/mobile-layout'
```

Inside `TabsLayout()`, after the `if (!session) return <Redirect ... />` guard, replace the hardcoded `showSchedule`/`showInvoices`/… block with:

```js
  const { bar } = resolveLayoutForUser(profile, activeLocation)
  const barSet = new Set(bar)
  const moreEligible = new Set(resolveLayoutForUser(profile, activeLocation).more)

  // Render config for every bar-capable (tabs) route.
  const TAB_META = {
    schedule: { title: 'Schedule', icon: 'calendar-outline' },
    whatsapp: { title: 'WhatsApp', icon: 'chatbubble-outline' },
    studio:   { title: 'Studio',   icon: 'business-outline' },
    pipeline: { title: 'Pipeline', icon: 'trending-up-outline' },
    bookings: { title: 'Bookings', icon: 'calendar-clear-outline' },
    invoices: { title: 'Invoices', icon: 'receipt-outline' },
    expenses: { title: 'Expenses', icon: 'wallet-outline' },
  }
  const FEATURE_KEYS = ['schedule', 'whatsapp', 'studio', 'pipeline', 'bookings', 'invoices', 'expenses']
  // Bar features in their resolved order, then the rest (hidden from the bar,
  // still declared + navigable from More when enabled).
  const hiddenKeys = FEATURE_KEYS.filter(k => !barSet.has(k))

  function featureHref(key) {
    if (barSet.has(key) || moreEligible.has(key)) return `/(tabs)/${key}`
    return null // not enabled → not navigable
  }
```

Then replace the `<Tabs> ... </Tabs>` children with:

```jsx
      <Tabs
        screenOptions={{
          headerShown: true,
          headerTitleStyle: { fontWeight: '600' },
          tabBarActiveTintColor: '#111827',
          tabBarInactiveTintColor: '#94A3B8',
          tabBarStyle: { borderTopColor: '#E2E5E9', backgroundColor: '#FFFFFF' },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color, size }) => (<Ionicons name="home-outline" size={size} color={color} />),
          }}
        />
        {bar.map(key => (
          <Tabs.Screen
            key={key}
            name={key}
            options={{
              title: TAB_META[key].title,
              href: `/(tabs)/${key}`,
              tabBarIcon: ({ color, size }) => (<Ionicons name={TAB_META[key].icon} size={size} color={color} />),
            }}
          />
        ))}
        <Tabs.Screen
          name="more"
          options={{
            title: 'More',
            tabBarIcon: ({ color, size }) => (<Ionicons name="ellipsis-horizontal" size={size} color={color} />),
          }}
        />
        {hiddenKeys.map(key => (
          <Tabs.Screen
            key={key}
            name={key}
            options={{
              title: TAB_META[key].title,
              href: featureHref(key),
              tabBarItemStyle: { display: 'none' },
              tabBarIcon: ({ color, size }) => (<Ionicons name={TAB_META[key].icon} size={size} color={color} />),
            }}
          />
        ))}
      </Tabs>
```

> **Why this shape:** expo-router requires every `(tabs)` route to have a `Tabs.Screen`. Bar features render first (in resolved order, visible); `more` is the trailing anchor; the rest are declared after with `display:none` so they stay routable (reachable from More via `router.push`) but absent from the bar. A feature that's neither in `bar` nor `more` (toggled off) gets `href: null`.

- [ ] **Step 2: Verify it builds + renders**

Mobile isn't in vitest/eslint CI. Verify by launching the app (or `npx expo export --platform ios` to confirm the bundle builds):

Run: `cd mobile && npx expo export --platform ios 2>&1 | tail -5`
Expected: export completes without a bundling error referencing `_layout.jsx`.

- [ ] **Step 3: Commit**

```bash
git add 'mobile/app/(tabs)/_layout.jsx'
git commit -m "MOBILE-LAYOUT.4 — data-driven bottom bar from resolved layout"
```

---

## Task 5: Data-driven More list (`mobile/app/(tabs)/more.jsx`)

**Files:**
- Modify: `mobile/app/(tabs)/more.jsx`

- [ ] **Step 1: Replace the per-row permission gates with `more`-set membership**

Add the import near the top:

```js
import { resolveLayoutForUser } from '../../lib/mobile-layout'
```

Replace the block that computes `showTasks` / `showRadar` / `showBookings` / `showPipeline` / `showInvoices` / `showExpenses` / `showIssues` / `showContracts` / `showPolicies` with:

```js
  const { more } = resolveLayoutForUser(profile, activeLocation)
  const inMore = new Set(more)
  const showTasks     = inMore.has('tasks')
  const showRadar     = inMore.has('radar')
  const showBookings  = inMore.has('bookings')
  const showPipeline  = inMore.has('pipeline')
  const showInvoices  = inMore.has('invoices')
  const showExpenses  = inMore.has('expenses')
  const showIssues    = inMore.has('issues')
  const showContracts = inMore.has('contracts')
  const showPolicies  = inMore.has('policies')
```

Keep `canImpersonate` (it is not a nav feature). The JSX rows already branch on these `show*` flags from the MOBILE-PERMS work, so no JSX changes are needed — a feature promoted into the bar now drops out of `more` and its row disappears automatically (no duplication).

- [ ] **Step 2: Verify build**

Run: `cd mobile && npx expo export --platform ios 2>&1 | tail -5`
Expected: bundles without error.

- [ ] **Step 3: Commit**

```bash
git add 'mobile/app/(tabs)/more.jsx'
git commit -m "MOBILE-LAYOUT.5 — More list driven by resolved layout (no bar/More duplication)"
```

---

## Task 6: StaffForm bottom-bar planner

**Files:**
- Create: `src/components/MobileBarPlanner.jsx`
- Modify: `src/components/StaffForm.jsx`

- [ ] **Step 1: Create `MobileBarPlanner.jsx`**

A dependency-free planner: 3 ordered `<select>` slots + an "allowed" checkbox set. Shows the bar-eligible features for the user's employment type; the runtime resolver drops anything toggled off, so the planner does not need to re-check per-toggle enablement.

```jsx
'use client'
// Bottom-bar planner (MOBILE-LAYOUT.6). Edits permissions.mobile.layout for
// one assignment: which bar-eligible features fill the 3 slots (ordered) and
// which are "allowed" for the staff member to swap in later (Phase 2). No
// drag-drop dependency — 3 slot selects + allowed checkboxes.
import {
  MOBILE_NAV_FEATURES, DEFAULT_MOBILE_LAYOUT,
} from '../../shared/mobile-nav'

const BAR_ELIGIBLE_FEATURES = MOBILE_NAV_FEATURES.filter(f => f.barEligible)

function templateFor(role, employmentType) {
  const r = DEFAULT_MOBILE_LAYOUT[role] || DEFAULT_MOBILE_LAYOUT.staff
  return r[employmentType] || r.fte
}

/**
 * @param {object} props
 * @param {string} props.role            selected assignment's role
 * @param {string} props.employmentType  'fte' | 'contractor'
 * @param {{bar?:string[], allowed?:string[]}|null} props.value  current override (or null)
 * @param {(layout: {bar:string[], allowed:string[]} | null) => void} props.onChange
 */
export default function MobileBarPlanner({ role, employmentType, value, onChange }) {
  // Candidate features for THIS person: bar-eligible, employment-appropriate.
  const candidates = BAR_ELIGIBLE_FEATURES.filter(
    f => !f.employmentType || f.employmentType === employmentType
  )
  const labelByKey = Object.fromEntries(candidates.map(f => [f.key, f.label]))

  const effective = value && Array.isArray(value.bar) ? value : templateFor(role, employmentType)
  const bar = [effective.bar[0] || '', effective.bar[1] || '', effective.bar[2] || '']
  const allowed = new Set(
    (effective.allowed || []).filter(k => candidates.some(c => c.key === k))
  )
  const isOverride = Boolean(value && Array.isArray(value.bar))

  function emit(nextBarArr, nextAllowedSet) {
    const cleanBar = nextBarArr.filter(Boolean).filter((k, i, a) => a.indexOf(k) === i)
    // Bar items are always allowed.
    const cleanAllowed = [...new Set([...nextAllowedSet, ...cleanBar])]
    onChange({ bar: cleanBar, allowed: cleanAllowed })
  }

  function setSlot(i, key) {
    const next = [...bar]
    next[i] = key
    // a key can only occupy one slot
    for (let j = 0; j < next.length; j++) if (j !== i && next[j] === key) next[j] = ''
    emit(next, allowed)
  }

  function toggleAllowed(key) {
    const next = new Set(allowed)
    if (next.has(key)) next.delete(key); else next.add(key)
    emit(bar, next)
  }

  return (
    <div className="mt-4 pt-4 border-t border-un1t-border">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Bottom-bar layout</h4>
        {isOverride && (
          <button type="button" onClick={() => onChange(null)} className="text-xs text-blue-400 hover:text-blue-300">
            Reset to role default
          </button>
        )}
      </div>
      <p className="text-xs text-un1t-subtle mb-3">
        Home and More are fixed. Pick up to 3 features for the bar (in order); only enabled features appear on the phone.
      </p>

      <div className="grid grid-cols-3 gap-2 mb-3">
        {[0, 1, 2].map(i => (
          <label key={i} className="text-xs text-un1t-subtle">
            Slot {i + 1}
            <select
              value={bar[i]}
              onChange={e => setSlot(i, e.target.value)}
              className="mt-1 w-full bg-un1t-surface border border-un1t-border rounded-md px-2 py-1.5 text-sm text-un1t-text"
            >
              <option value="">— empty —</option>
              {candidates.map(f => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <p className="text-xs text-un1t-subtle mb-1.5">Allowed for the bar (staff can swap these in — Phase 2):</p>
      <div className="flex flex-wrap gap-2">
        {candidates.map(f => (
          <label key={f.key} className="flex items-center gap-1.5 text-sm text-un1t-text bg-un1t-surface border border-un1t-border rounded-md px-2 py-1">
            <input type="checkbox" checked={allowed.has(f.key)} onChange={() => toggleAllowed(f.key)} />
            {f.label}
          </label>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Mount it in StaffForm**

In `src/components/StaffForm.jsx`, add the import near the other component imports:

```js
import MobileBarPlanner from './MobileBarPlanner'
```

Then inside the "Mobile App Features" card, immediately AFTER the `</div>` that closes the `allMobilePermissions.map(...)` toggle list (i.e. after the toggles `<div className="space-y-2">…</div>`), insert:

```jsx
        {selectedPermLocationId && (
          <MobileBarPlanner
            role={selectedAssignment?.role || 'staff'}
            employmentType={form.employment_type}
            value={selectedMobilePerms.layout || null}
            onChange={(layout) => patchSelectedMobilePerms({ layout })}
          />
        )}
```

> `patchSelectedMobilePerms({ layout })` merges `layout` into `permissions.mobile`, writing `permissions.mobile.layout`. Passing `null` (Reset) stores `layout: null`, which the resolver treats as "no override → use template".

- [ ] **Step 3: Run the web build to catch import-resolution / JSX errors**

Run: `npm run build 2>&1 | tail -15`
Expected: build succeeds (the new import resolves; StaffForm compiles).

- [ ] **Step 4: Commit**

```bash
git add src/components/MobileBarPlanner.jsx src/components/StaffForm.jsx
git commit -m "MOBILE-LAYOUT.6 — StaffForm bottom-bar planner writes permissions.mobile.layout"
```

---

## Task 7: Full CI mirror + ship

**Files:** none (verification + PR)

- [ ] **Step 1: Run the full CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity
```
Expected: tests pass (incl. the new `shared/mobile-nav.test.js`), lint clean (the pre-existing `ChooserEditorForm.jsx` warning is acceptable), parity clean (no new permission keys — `layout` is a sub-blob, not a `MOBILE_PERMISSIONS` entry).

- [ ] **Step 2: Production build (import-resolution gate)**

```bash
npm run build
```
Expected: succeeds. (Catches any unresolved `shared/mobile-nav` import from `src/`.)

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin mobile-layout-planner
gh pr create --base main --head mobile-layout-planner \
  --title "MOBILE-LAYOUT — per-staff bottom-bar planner (Phase 1)" \
  --body "Role × employment-type default bottom-bar layouts + per-person override in StaffForm, resolved per-location and rendered data-driven on the phone. Pure shared resolver (shared/mobile-nav.js, unit-tested); client-side resolution (no /api/mobile/me change). Defaults reproduce today's bar for every role except owner (lean Schedule+Studio by design). Staff on-phone reorder is Phase 2. Spec: docs/superpowers/specs/2026-06-04-mobile-layout-planner-design.md. Ships OTA on merge."
```

- [ ] **Step 4: Confirm CI green on the PR, then merge (asks for the production OTA go-ahead — mobile + shared change auto-publishes to the production channel).**

---

## Manual verification (post-merge, on device)

1. In web StaffForm, edit a staff member → Mobile App Features → **Bottom-bar layout**. Confirm slots pre-fill from the role template; change Slot 2 to Pipeline; save.
2. On the phone (after OTA), impersonate that user (or sign in) → confirm the bottom bar shows the chosen features in order, and the promoted feature is gone from "More".
3. Toggle a bar feature OFF in the section above → confirm it drops from the bar (resolver intersects with enabled).
4. Switch a multi-location user's active location → confirm the bar re-resolves for that studio.
5. An owner with no override → confirm the lean `Schedule · Studio` default; every other role → today's bar unchanged.

---

## Self-Review

**Spec coverage:**
- §3 three-layer model → Task 1 (registry/defaults) + Task 2 (resolver intersects with enabled). ✓
- §4 registry + bar-eligibility → Task 1 (`MOBILE_NAV_FEATURES`, `BAR_ELIGIBLE`, `barEligible:false` for tasks/radar/issues/contracts/policies). ✓
- §5 role × employment-type templates (owner lean) → Task 1 `DEFAULT_MOBILE_LAYOUT` + Task 2 owner-lean test. ✓
- §6 data model (`permissions.mobile.layout`) → Task 6 (`patchSelectedMobilePerms({ layout })`). ✓
- §7 pure resolver → Task 2. ✓
- §8 API → refined to client-side resolution (override already serialized); documented in header. ✓
- §9 mobile rendering refactor → Tasks 4 + 5. ✓
- §10 StaffForm planner → Task 6. ✓
- §11 edge cases → Task 2 tests (toggled-off, <3, non-eligible, fallback) + multi-location (Task 3 reads activeLocation). ✓
- §12 backward-compat (reproduce today's bar) → Task 2 manager/owner tests + manual step 5. ✓
- §16 testing → Task 2 unit tests + Task 7 parity/build. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output. ✓

**Type/name consistency:** `resolveMobileLayout({ role, employmentType, enabledKeys, override }) → { bar, more, allowed }` used identically in Tasks 2/3/4/5. `DEFAULT_MOBILE_LAYOUT[role][employmentType]`, `BAR_ELIGIBLE`, `MOBILE_NAV_ORDER`, `permissions.mobile.layout`, `patchSelectedMobilePerms` all consistent across tasks. ✓

**Note for the implementer:** mobile (`mobile/`) is not covered by web vitest/eslint — the resolver carries the test weight (Task 2); the RN screens (Tasks 4/5) and the planner (Task 6) are verified by `expo export` / `npm run build` + the on-device checklist.
