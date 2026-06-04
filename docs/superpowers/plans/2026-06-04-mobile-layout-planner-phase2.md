# Mobile Layout Planner — Phase 2 Implementation Plan (on-phone staff reorder, server-synced)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Let a staff member arrange *their own* mobile bottom bar — which of the admin-defined **allowed** features fill the 3 slots, and in what order — from their phone, synced across devices.

**Architecture:** A new `mobile_bar_prefs (profile_id, location_id, bar[])` table (migration 246, already applied) holds each staff member's per-location arrangement. `PUT /api/mobile/layout` writes it (clamped to the user's admin-allowed set). `/api/mobile/me` serializes `staffBar` per location. The Phase-1 pure resolver gains a `staffBar` input that becomes the bar *source* (still clamped to `allowed ∩ enabled`), so the admin's bounds always hold. A mobile "Customise bottom bar" screen (reached from More) edits it.

**Tech Stack:** Plain JS/ESM, Vitest, Next.js route handlers (Zod + `validateBody`), Expo Router. `shared/mobile-nav.js` shared by web + mobile (`@shared/` alias on web, relative on mobile).

**Branch:** `mobile-layout-phase2` (migration `supabase/migrations/246_mobile_bar_prefs.sql` already committed; DB migration already applied).

**Builds on Phase 1** (merged): `shared/mobile-nav.js` (`resolveMobileLayout`, `MOBILE_NAV_FEATURES`, `BAR_ELIGIBLE`, `DEFAULT_MOBILE_LAYOUT`), `mobile/lib/mobile-layout.js` (`resolveLayoutForUser`).

---

## Task 1: Resolver gains a `staffBar` input (TDD)

**Files:** Modify `shared/mobile-nav.js`; Test `shared/mobile-nav.test.js`; Modify `mobile/lib/mobile-layout.js`.

- [ ] **Step 1: Append failing tests to `shared/mobile-nav.test.js`** (inside the existing `describe('resolveMobileLayout', ...)` or a new describe):

```js
describe('resolveMobileLayout staffBar', () => {
  const ALLOWED_MGR = ['schedule', 'whatsapp', 'studio', 'pipeline', 'bookings']
  const base = { role: 'manager', employmentType: 'fte', enabledKeys: ALLOWED_MGR }

  it('staffBar overrides the bar arrangement (within allowed)', () => {
    const r = resolveMobileLayout({ ...base, override: null, staffBar: ['pipeline', 'schedule'] })
    expect(r.bar).toEqual(['pipeline', 'schedule'])
  })

  it('staffBar is clamped to allowed (a non-allowed key is dropped)', () => {
    // manager allowed has no 'bookings' in the default template? It does — use a key truly outside.
    const r = resolveMobileLayout({
      role: 'staff', employmentType: 'fte', enabledKeys: ['schedule', 'bookings', 'expenses'],
      override: null, staffBar: ['pipeline', 'schedule'], // staff template allows schedule+bookings(+expenses), NOT pipeline
    })
    expect(r.bar).toEqual(['schedule']) // pipeline dropped (not in staff allowed)
  })

  it('staffBar is clamped to enabled', () => {
    const r = resolveMobileLayout({ ...base, enabledKeys: ['schedule', 'studio'], override: null, staffBar: ['whatsapp', 'schedule'] })
    expect(r.bar).toEqual(['schedule']) // whatsapp not enabled
  })

  it('empty/missing staffBar falls back to the admin/template bar', () => {
    const r1 = resolveMobileLayout({ ...base, override: null, staffBar: [] })
    const r2 = resolveMobileLayout({ ...base, override: null, staffBar: null })
    expect(r1.bar).toEqual(['schedule', 'whatsapp', 'studio'])
    expect(r2.bar).toEqual(['schedule', 'whatsapp', 'studio'])
  })

  it('staffBar is capped at 3', () => {
    const r = resolveMobileLayout({ ...base, override: null, staffBar: ['pipeline', 'bookings', 'schedule', 'whatsapp'] })
    expect(r.bar).toEqual(['pipeline', 'bookings', 'schedule'])
  })

  it('allowed still comes from the admin layer, not staffBar', () => {
    const r = resolveMobileLayout({ ...base, override: null, staffBar: ['pipeline'] })
    expect(r.allowed).toEqual(expect.arrayContaining(['schedule', 'whatsapp', 'studio', 'pipeline', 'bookings']))
  })
})
```

- [ ] **Step 2: Run to confirm fail** — `npx vitest run shared/mobile-nav.test.js` → the new staffBar cases fail (bar ignores staffBar today).

- [ ] **Step 3: Modify `resolveMobileLayout` in `shared/mobile-nav.js`** — add `staffBar` to the destructure and use it as the bar source. Replace the existing function body's bar-building section. The full updated function:

```js
export function resolveMobileLayout({ role, employmentType, enabledKeys, override, staffBar }) {
  const enabled = new Set(enabledKeys || [])
  const tmpl =
    (DEFAULT_MOBILE_LAYOUT[role] && (DEFAULT_MOBILE_LAYOUT[role][employmentType] || DEFAULT_MOBILE_LAYOUT[role].fte)) ||
    DEFAULT_MOBILE_LAYOUT.staff.fte

  const base = override && Array.isArray(override.bar) ? override : tmpl

  // `allowed` always comes from the ADMIN layer (override/template) — never from
  // the staff arrangement. Bar items are implicitly allowed.
  const allowed = [...new Set([...(base.allowed || []), ...(base.bar || [])])]
    .filter(k => enabled.has(k) && BAR_ELIGIBLE_SET.has(k))
  const allowedSet = new Set(allowed)

  // Bar SOURCE: the staff member's own arrangement when set, else the admin
  // default. Either way it's clamped to allowed ∩ enabled and capped at 3.
  const barSource = (Array.isArray(staffBar) && staffBar.length) ? staffBar : (base.bar || [])
  const bar = []
  for (const k of barSource) {
    if (allowedSet.has(k) && !bar.includes(k)) bar.push(k)
    if (bar.length === 3) break
  }
  const barSet = new Set(bar)

  const more = MOBILE_NAV_ORDER.filter(k => enabled.has(k) && !barSet.has(k))

  return { bar, more, allowed }
}
```

- [ ] **Step 4: Pass `staffBar` through `mobile/lib/mobile-layout.js`** — in `resolveLayoutForUser`, add `staffBar: activeLocation?.staffBar || null` to the `resolveMobileLayout(...)` call. The updated call:

```js
  return resolveMobileLayout({
    role: profile.role,
    employmentType: profile.employment_type,
    enabledKeys,
    override,
    staffBar: activeLocation?.staffBar || null,
  })
```

- [ ] **Step 5: Run all tests** — `npx vitest run shared/mobile-nav.test.js` → all pass (21 total). Confirm the Phase-1 cases still pass (no `staffBar` → unchanged).

- [ ] **Step 6: Commit**
```bash
git add shared/mobile-nav.js shared/mobile-nav.test.js mobile/lib/mobile-layout.js
git commit -m "MOBILE-LAYOUT-P2.1 — resolver staffBar input (staff arrangement clamped to allowed)"
```

---

## Task 2: `/api/mobile/me` serializes `staffBar` per location

**Files:** Modify `src/app/api/mobile/me/route.js`.

- [ ] **Step 1: Add a `mobile_bar_prefs` lookup + attach `staffBar` to each serialized location**

In `src/app/api/mobile/me/route.js`, after `getCurrentUser()` returns `user` and before the `return NextResponse.json(...)`, add a query for this user's bar prefs and build a map. The route already imports what it needs to read the DB? Check — if `createServerClient` isn't imported, add `import { createServerClient } from '@/lib/supabase'`. Then:

```js
  // Phase 2: the staff member's own bottom-bar arrangement per location.
  const db = createServerClient()
  const { data: barPrefRows } = await db
    .from('mobile_bar_prefs')
    .select('location_id, bar')
    .eq('profile_id', user.id)
  const staffBarByLocation = {}
  for (const row of (barPrefRows || [])) staffBarByLocation[row.location_id] = row.bar || []
```

Then add `staffBar: staffBarByLocation[l.id] || null` to the per-location object inside `locations.map(...)`, and `staffBar: staffBarByLocation[user.activeLocation.id] || null` to the `activeLocation` object. (Place it alongside the existing `features` / `permissions` keys.)

- [ ] **Step 2: Verify the route still builds** — `npm run build 2>&1 | tail -5` → green.

- [ ] **Step 3: Commit**
```bash
git add src/app/api/mobile/me/route.js
git commit -m "MOBILE-LAYOUT-P2.2 — /api/mobile/me serializes staffBar per location"
```

---

## Task 3: `PUT /api/mobile/layout` endpoint (writes the staff arrangement)

**Files:** Create `src/app/api/mobile/layout/route.js`; Test `src/app/api/mobile/layout/route.test.js`.

- [ ] **Step 1: Create the route** `src/app/api/mobile/layout/route.js`:

```js
// MOBILE-LAYOUT Phase 2 — a staff member saves their own bottom-bar arrangement
// for a location. The bar is clamped server-side to the user's admin-defined
// allowed∩bar-eligible set at that location (a forged/stale client can't place
// a feature outside the admin's bounds). Per-toggle enablement is re-checked at
// render time by the resolver, so we only enforce the allowed pool here.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { resolveMobileLayout, BAR_ELIGIBLE } from '@shared/mobile-nav'

export const runtime = 'nodejs'

const Schema = z.object({
  location_id: uuidLike,
  bar: z.array(z.string()).max(8), // clamped to ≤3 after the allowed filter
})

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { location_id, bar } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  // The admin-allowed pool at THIS location. Call the resolver with
  // enabledKeys = all bar-eligible keys so `allowed` = admin allowed ∩ bar-eligible
  // (render-time re-clamps to actually-enabled).
  const assignment = user.assignmentsByLocation?.[location_id]
  const override = assignment?.permissions?.mobile?.layout || null
  const role = user.rolesByLocation?.[location_id] || user.role
  const { allowed } = resolveMobileLayout({
    role,
    employmentType: user.employment_type,
    enabledKeys: BAR_ELIGIBLE,
    override,
  })
  const allowedSet = new Set(allowed)

  const cleanBar = [...new Set(bar)].filter(k => allowedSet.has(k)).slice(0, 3)

  const db = createServerClient()
  const { error } = await db
    .from('mobile_bar_prefs')
    .upsert(
      { profile_id: user.id, location_id, bar: cleanBar, updated_at: new Date().toISOString() },
      { onConflict: 'profile_id,location_id' }
    )
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, bar: cleanBar })
}
```

- [ ] **Step 2: Write the test** `src/app/api/mobile/layout/route.test.js` — verify the bar is clamped to the allowed set. Mock `getCurrentUser` + `createServerClient`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
}))
const upsert = vi.fn(() => ({ error: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ from: () => ({ upsert }) }) }))

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'

function req(body) {
  return new Request('http://x/api/mobile/layout', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('PUT /api/mobile/layout', () => {
  beforeEach(() => { upsert.mockClear() })

  it('clamps the bar to the admin allowed set + caps at 3', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'u1', role: 'manager', employment_type: 'fte',
      locations: [{ id: 'loc1' }],
      rolesByLocation: { loc1: 'manager' },
      assignmentsByLocation: { loc1: { permissions: { mobile: {} } } }, // → manager template allowed
    })
    const res = await PUT(req({ location_id: 'loc1', bar: ['pipeline', 'tasks', 'schedule', 'whatsapp'] }))
    const json = await res.json()
    expect(json.success).toBe(true)
    // 'tasks' dropped (not bar-eligible/allowed); capped at 3
    expect(json.bar).toEqual(['pipeline', 'schedule', 'whatsapp'])
    expect(upsert).toHaveBeenCalledOnce()
    expect(upsert.mock.calls[0][0]).toMatchObject({ profile_id: 'u1', location_id: 'loc1', bar: ['pipeline', 'schedule', 'whatsapp'] })
  })

  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await PUT(req({ location_id: 'loc1', bar: [] }))
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 3: Run** — `npx vitest run src/app/api/mobile/layout/route.test.js` → pass. (If `assertLocationAccess` import shape differs, align the mock to the real export.)

- [ ] **Step 4: Register the route in OpenAPI if the repo requires it** — check `src/lib/openapi.js`; if other mobile routes are registered there, add this one following the same pattern. If mobile routes aren't registered, skip.

- [ ] **Step 5: Build + commit**
```bash
npm run build 2>&1 | tail -5   # must be green (new route + @shared import)
git add src/app/api/mobile/layout/route.js src/app/api/mobile/layout/route.test.js
git commit -m "MOBILE-LAYOUT-P2.3 — PUT /api/mobile/layout (clamped staff bar save)"
```

---

## Task 4: Mobile "Customise bottom bar" screen + entry point

**Files:** Create `mobile/lib/layout-api.js`; Create `mobile/app/customise-bar.jsx`; Modify `mobile/app/(tabs)/more.jsx`.

- [ ] **Step 1: Create `mobile/lib/layout-api.js`**

```js
// Save the signed-in user's bottom-bar arrangement for a location.
import { api } from './api'

export function saveBarLayout(locationId, bar) {
  return api('/api/mobile/layout', { method: 'PUT', locationId, body: { location_id: locationId, bar } })
}
```

- [ ] **Step 2: Create `mobile/app/customise-bar.jsx`** — a screen that lets the user pick which of their *allowed* features fill the 3 slots (in order), then saves. Uses `resolveLayoutForUser` for the current bar + allowed set, and `MOBILE_NAV_FEATURES` for labels.

```jsx
import { useState } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, Alert } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../lib/auth-context'
import { resolveLayoutForUser } from '../lib/mobile-layout'
import { saveBarLayout } from '../lib/layout-api'
import { MOBILE_NAV_FEATURES } from '../../shared/mobile-nav'

const LABEL = Object.fromEntries(MOBILE_NAV_FEATURES.map(f => [f.key, f.label]))

export default function CustomiseBar() {
  const { profile, activeLocation, refresh } = useAuth()
  const router = useRouter()
  const { bar, allowed } = resolveLayoutForUser(profile, activeLocation)
  const [slots, setSlots] = useState([bar[0] || '', bar[1] || '', bar[2] || ''])
  const [saving, setSaving] = useState(false)

  function setSlot(i, key) {
    setSlots(prev => {
      const next = [...prev]
      next[i] = key
      for (let j = 0; j < next.length; j++) if (j !== i && next[j] === key) next[j] = ''
      return next
    })
  }

  async function save() {
    setSaving(true)
    const cleanBar = slots.filter(Boolean).filter((k, i, a) => a.indexOf(k) === i)
    const r = await saveBarLayout(activeLocation?.id, cleanBar)
    setSaving(false)
    if (r.success) { await refresh(); router.back() }
    else Alert.alert('Couldn’t save', r.error || 'Unknown error')
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Customise bar' }} />
      <ScrollView contentContainerClassName="p-4">
        <Text className="text-sm text-un1t-subtle mb-4">
          Choose up to 3 features for your bottom bar, in order. Home and More always stay.
          {allowed.length === 0 ? '\n\nNothing to arrange here yet.' : ''}
        </Text>
        {[0, 1, 2].map(i => (
          <View key={i} className="mb-4">
            <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-1.5">Slot {i + 1}</Text>
            <View className="flex-row flex-wrap gap-2">
              <SlotChip label="— empty —" active={!slots[i]} onPress={() => setSlot(i, '')} />
              {allowed.map(key => (
                <SlotChip key={key} label={LABEL[key] || key} active={slots[i] === key} onPress={() => setSlot(i, key)} />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
      <View className="p-4 border-t border-un1t-border">
        <Pressable onPress={save} disabled={saving || allowed.length === 0}
          className="bg-un1t-text rounded-xl py-3.5 items-center active:opacity-80 disabled:opacity-50">
          {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text className="text-un1t-bg font-semibold">Save layout</Text>}
        </Pressable>
      </View>
    </View>
  )
}

function SlotChip({ label, active, onPress }) {
  return (
    <Pressable onPress={onPress}
      className={`px-3 py-2 rounded-full border ${active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-surface border-un1t-border'}`}>
      <Text className={`text-sm ${active ? 'text-un1t-bg font-semibold' : 'text-un1t-text'}`}>{label}</Text>
    </Pressable>
  )
}
```

- [ ] **Step 3: Add a "Customise bottom bar" row in `mobile/app/(tabs)/more.jsx`** — gate it on the user having an allowed set (≥1 feature to arrange). Near the other resolved-layout reads, compute `allowed` from the same `resolveLayoutForUser` call (extend the existing destructure to `const { more, allowed } = resolveLayoutForUser(profile, activeLocation)`), then add a `showCustomise = allowed.length > 0`, and a row in a sensible section (e.g. its own small section just above "Master tools" / sign-out):

```jsx
      {allowed.length > 0 && (
        <Section title="Personalise">
          <Row icon="grid-outline" label="Customise bottom bar" onPress={() => router.push('/customise-bar')} isLast />
        </Section>
      )}
```

(Read the current `more.jsx` to extend the existing `resolveLayoutForUser` destructure to also capture `allowed`, and to place the Section consistently.)

- [ ] **Step 4: Verify the bundle builds** — `cd mobile && npx expo export --platform ios 2>&1 | tail -5; cd ..` → bundles without error.

- [ ] **Step 5: Commit**
```bash
git add mobile/lib/layout-api.js mobile/app/customise-bar.jsx 'mobile/app/(tabs)/more.jsx'
git commit -m "MOBILE-LAYOUT-P2.4 — on-phone Customise bottom bar screen + More entry"
```

---

## Task 5: CI mirror + ship

- [ ] **Step 1:** `npm test && npm run lint && npm run check:mobile-parity` → all green (incl. new resolver + route tests).
- [ ] **Step 2:** `npm run build` → green.
- [ ] **Step 3:** `cd mobile && npx expo export --platform ios | tail -3; cd ..` → bundles.
- [ ] **Step 4:** push + open PR (base main). Body: server-synced on-phone staff reorder; migration 246 already applied; clamped to admin allowed; ships OTA on merge.
- [ ] **Step 5:** Confirm CI green; ask for the merge/OTA go-ahead.

---

## Self-Review

**Spec coverage** (Phase-1 spec §14 Phase 2): user-writable store (migration 246 ✓), endpoint (Task 3 ✓), `/me` serialization (Task 2 ✓), resolver clamps staff arrangement to `allowed ∩ enabled` (Task 1 ✓), on-phone screen (Task 4 ✓).

**Placeholder scan:** none — complete code in every step.

**Type/name consistency:** `staffBar` param + `activeLocation.staffBar` serialization + `mobile_bar_prefs.bar` column + `saveBarLayout(locationId, bar)` consistent across tasks. `resolveMobileLayout` signature extended (additive — Phase-1 callers without `staffBar` unchanged).

**Security note:** the endpoint clamps to the admin allowed set server-side (a forged client can't escape the bounds); RLS self-read policy is defense-in-depth; writes are service-role via the endpoint scoped to `user.id`. Layout is UI-only.

**Note:** mobile screens (Task 4) aren't in web CI — verified by `expo export` + on-device. The resolver + endpoint carry the test weight (Tasks 1, 3).
