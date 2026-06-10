# Staff & Access Management — C1: Read Vertical (Cycle 1, Plan C, slice 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the staff **read** vertical end-to-end on the shared core — a `src/lib/staff.js` service backing the staff GET routes, a `staff` SDK domain, and a responsive **mobile staff directory** (list + detail) that consumes it — proving the rails (Plan A) + primitives (Plan B) on a real admin surface, without touching the 632-LOC PUT monolith.

**Architecture:** `src/lib/staff.js` owns the read logic (scope by caller's locations, role-based field gating, reusing `getUserLocationIds` + `ADMIN_ROLES`). The existing `GET /api/staff` is refactored onto it and a **new `GET /api/staff/[id]`** is added (none exists today — the web edit page reads the DB directly). `shared/sdk/staff.js` adds `list()`/`get(id)`; web and mobile both call the same `sdk.staff.*`. The mobile screens compose the Plan-B `DataTable` primitive. Auth is unchanged from today's routes (`getCurrentUser` + location scope; admins see HR fields, others see the slim roster).

**Tech Stack:** JS (no TS), Next.js route handlers, Zod, Vitest, Expo Router + the new `mobile/components/ui` primitives + `mobile/lib/sdk`.

**Decomposition note:** Plan C is 3 slices. **C1 (this) = read vertical** (safe, additive, ships a usable directory). **C2 = write path** — the careful extraction of the create/update logic (the 632-LOC PUT with its assignment-diff + UniFi/Protect/AC side-effects + comp dual-write) into a `staff` service, pointing web `StaffForm` and a mobile editor at the SDK. **C3 = permissions matrix + role wizard + device pickers + the `settings`→mobile parity-permission work** (add a mobile `staff` permission, remove `settings` from `WEB_ONLY_OK`). C2 and C3 get their own plans.

**Branch:** `mobile-parity-staff` (already created off `main`, with the rails + primitives branches merged in). Each task commits; PR after the gate.

**Reference before starting:** read `src/app/api/staff/route.js` (the GET handler + `STAFF_PUBLIC_FIELDS` + `ADMIN_ROLES` usage), `src/lib/auth.js` (`getUserLocationIds` is pure over `user.locations`), `shared/sdk/index.js` + `shared/sdk/me.js` (the domain pattern), `mobile/app/radar/index.jsx` (the read-screen pattern: `useAuth`, load/loading/error, `Stack.Screen` + `BackHeaderLeft`, pull-to-refresh), `mobile/components/ui/index.js` (DataTable/Card), and `mobile/app/(tabs)/more.jsx` (the launcher-row pattern).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/lib/staff.js` | Read service: `listStaffForUser`, `getStaffForUser`, `STAFF_PUBLIC_FIELDS` | Create |
| `src/lib/staff.test.js` | Service unit tests (mock db) | Create |
| `src/app/api/staff/route.js` | GET refactored onto `listStaffForUser` (POST untouched) | Modify |
| `src/app/api/staff/[id]/route.js` | New GET handler via `getStaffForUser` (PUT/DELETE untouched) | Modify |
| `src/app/api/staff/[id]/route.test.js` | Test the new GET (auth + cross-tenant 404 + admin gating) | Create |
| `shared/sdk/staff.js` | `staffDomain(request)` → `list`, `get` | Create |
| `shared/sdk/index.js` | Register `staff` in DOMAINS | Modify |
| `shared/sdk/staff.test.js` | SDK domain test (mock fetch) | Create |
| `mobile/app/staff/index.jsx` | Staff list screen (DataTable, admin-gated, → detail) | Create |
| `mobile/app/staff/[id].jsx` | Staff detail screen (read-only profile + assignments) | Create |
| `mobile/app/(tabs)/more.jsx` | Add a "Staff" launcher row (admin-gated) | Modify |

---

## Task 1: Staff read service

**Files:** Create `src/lib/staff.js`, `src/lib/staff.test.js`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/staff.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { listStaffForUser, getStaffForUser, STAFF_PUBLIC_FIELDS } from './staff.js'

// Minimal db mock: records the last select() clause per table so we can
// assert admins get '*' and non-admins get the slim field list.
function mockDb({ links = [], profiles = [], detailLinks = null } = {}) {
  const calls = { profilesSelect: null }
  return {
    calls,
    from(table) {
      if (table === 'profile_locations') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: links, error: null }),
            // getStaffForUser uses .eq(...).in(...).limit(1)
            eq: () => ({ in: () => ({ limit: () => Promise.resolve({ data: detailLinks ?? links, error: null }) }) }),
          }),
        }
      }
      if (table === 'profiles') {
        return {
          select: (clause) => {
            calls.profilesSelect = clause
            return {
              in: () => ({ order: () => Promise.resolve({ data: profiles, error: null }) }),
              eq: () => ({ single: () => Promise.resolve({ data: profiles[0] ?? null, error: profiles[0] ? null : { message: 'no rows' } }) }),
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const adminUser = { role: 'owner', locations: [{ id: 'loc-1' }] }
const staffUser = { role: 'staff', locations: [{ id: 'loc-1' }] }

describe('listStaffForUser', () => {
  it('returns [] when the caller has no locations', async () => {
    const res = await listStaffForUser({ db: mockDb(), user: { role: 'staff', locations: [] } })
    expect(res).toEqual({ ok: true, data: [] })
  })
  it('returns [] when no profiles share a location', async () => {
    const res = await listStaffForUser({ db: mockDb({ links: [] }), user: adminUser })
    expect(res).toEqual({ ok: true, data: [] })
  })
  it('admins get the full select (HR fields)', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
    const res = await listStaffForUser({ db, user: adminUser })
    expect(res.ok).toBe(true)
    expect(db.calls.profilesSelect).toContain('*')
    expect(db.calls.profilesSelect).not.toContain(STAFF_PUBLIC_FIELDS)
  })
  it('non-admins get the slim public field list (no salary)', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
    const res = await listStaffForUser({ db, user: staffUser })
    expect(res.ok).toBe(true)
    expect(db.calls.profilesSelect).toContain(STAFF_PUBLIC_FIELDS)
    expect(db.calls.profilesSelect).not.toContain('hourly_rate')
  })
})

describe('getStaffForUser', () => {
  it('404 when the caller has no locations', async () => {
    const res = await getStaffForUser({ db: mockDb(), user: { role: 'owner', locations: [] }, id: 'p1' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })
  it('404 when the target shares no location with the caller (cross-tenant)', async () => {
    const db = mockDb({ detailLinks: [] })
    const res = await getStaffForUser({ db, user: adminUser, id: 'p-other' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })
  it('returns the profile when the target shares a location', async () => {
    const db = mockDb({ detailLinks: [{ profile_id: 'p1' }], profiles: [{ id: 'p1', full_name: 'Ada' }] })
    const res = await getStaffForUser({ db, user: adminUser, id: 'p1' })
    expect(res.ok).toBe(true)
    expect(res.data.full_name).toBe('Ada')
  })
  it('non-admin gets the slim select for the detail too', async () => {
    const db = mockDb({ detailLinks: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
    await getStaffForUser({ db, user: staffUser, id: 'p1' })
    expect(db.calls.profilesSelect).toContain(STAFF_PUBLIC_FIELDS)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/staff.test.js`
Expected: FAIL — Cannot find module './staff.js'.

- [ ] **Step 3: Implement the service**

Create `src/lib/staff.js`:

```js
// Staff read service (Plan C1). The single source of read logic for the
// staff directory — backs GET /api/staff, GET /api/staff/[id], and the
// web staff list, consumed on mobile via the SDK. Scopes to profiles
// sharing a location with the caller; admins (master/owner/manager) see
// the full profile incl. HR fields, others see the slim public roster.
// The create/update logic (the PUT monolith) is NOT here — that's C2.
import { getUserLocationIds } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'

// Slim fields visible to non-admin staff. Excludes salary / hourly_rate
// / overtime_rate (HR-sensitive). Mirrors the original inline constant
// from the GET route.
export const STAFF_PUBLIC_FIELDS =
  'id, full_name, email, role, avatar_url, active, employment_type, contracted_hours_per_week'

function selectClause(isAdmin) {
  return isAdmin
    ? '*, profile_locations(*, locations(*))'
    : `${STAFF_PUBLIC_FIELDS}, profile_locations(location_id, role, locations(id, name, slug))`
}

/**
 * List staff sharing ≥1 location with the caller.
 * @returns {Promise<{ ok: true, data: object[] } | { ok: false, error: string }>}
 */
export async function listStaffForUser({ db, user }) {
  const userLocationIds = getUserLocationIds(user)
  if (userLocationIds.length === 0) return { ok: true, data: [] }

  const { data: links, error: linksError } = await db
    .from('profile_locations')
    .select('profile_id')
    .in('location_id', userLocationIds)
  if (linksError) return { ok: false, error: linksError.message }

  const profileIds = [...new Set((links || []).map(l => l.profile_id))]
  if (profileIds.length === 0) return { ok: true, data: [] }

  const isAdmin = ADMIN_ROLES.includes(user.role)
  const { data, error } = await db
    .from('profiles')
    .select(selectClause(isAdmin))
    .in('id', profileIds)
    .order('full_name', { ascending: true })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data }
}

/**
 * Fetch one staff member by id, but only if they share a location with
 * the caller (cross-tenant guard → 404 to avoid confirming existence).
 * @returns {Promise<{ ok: true, data: object } | { ok: false, status: number, error: string }>}
 */
export async function getStaffForUser({ db, user, id }) {
  const userLocationIds = getUserLocationIds(user)
  if (userLocationIds.length === 0) return { ok: false, status: 404, error: 'Not found' }

  const { data: links } = await db
    .from('profile_locations')
    .select('profile_id')
    .eq('profile_id', id)
    .in('location_id', userLocationIds)
    .limit(1)
  if (!links || links.length === 0) return { ok: false, status: 404, error: 'Not found' }

  const isAdmin = ADMIN_ROLES.includes(user.role)
  const { data, error } = await db
    .from('profiles')
    .select(selectClause(isAdmin))
    .eq('id', id)
    .single()
  if (error) return { ok: false, status: 404, error: error.message }
  return { ok: true, data }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/staff.test.js`
Expected: PASS (9 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/staff.js src/lib/staff.test.js
git commit -m "STAFF-C1.1 — staff read service (listStaffForUser, getStaffForUser)"
```

---

## Task 2: Refactor GET /api/staff onto the service

**Files:** Modify `src/app/api/staff/route.js`.

- [ ] **Step 1: Check for an existing route test**

Run: `ls src/app/api/staff/route.test.js 2>/dev/null && echo EXISTS || echo NONE`. If it EXISTS, read it — the refactor must keep it green. If NONE, the service tests (Task 1) cover the logic.

- [ ] **Step 2: Refactor the GET handler**

In `src/app/api/staff/route.js`, replace the entire `GET` function body (currently it inlines the profile_locations lookup + admin/slim select) with a delegation to the service. Add the import near the top (after the existing `@/lib/schemas` import):

```js
import { listStaffForUser } from '@/lib/staff'
```

Replace the whole `export async function GET() { ... }` (the handler that ends at the `return NextResponse.json({ success: true, data })` before the POST comment) with:

```js
// GET /api/staff — List staff in the caller's locations.
//   - master/owner/manager: full profile + HR fields
//   - head_coach/staff: slim public roster (no salary, etc.)
// Read logic lives in src/lib/staff.js (shared with GET /api/staff/[id]
// and consumed on mobile via the SDK).
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const result = await listStaffForUser({ db, user })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}
```

Leave the `STAFF_PUBLIC_FIELDS` constant in the route file IF the POST handler references it; otherwise remove the now-unused constant (grep `STAFF_PUBLIC_FIELDS` in the file — if GET was its only user, delete the line to avoid an unused-var lint error). The `getUserLocationIds` import may also become unused — grep; remove from the import only if nothing else in the file uses it.

- [ ] **Step 3: Verify behavior unchanged**

Run: `npx vitest run src/lib/staff.test.js` (service still green). If a `route.test.js` existed, run it too and keep it green.
Run: `npm run lint 2>&1 | grep -A2 "staff/route" || echo "no lint errors in staff/route"`
Expected: no unused-var errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/staff/route.js
git commit -m "STAFF-C1.2 — GET /api/staff delegates to the staff read service"
```

---

## Task 3: New GET /api/staff/[id]

**Files:** Modify `src/app/api/staff/[id]/route.js`; Create `src/app/api/staff/[id]/route.test.js`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/staff/[id]/route.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: (u) => (u?.locations || []).map(l => l.id),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/staff', () => ({ getStaffForUser: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { getStaffForUser } from '@/lib/staff'

const req = () => new Request('http://localhost/api/staff/p1')
const props = { params: { id: 'p1' } }

beforeEach(() => vi.clearAllMocks())

describe('GET /api/staff/[id]', () => {
  it('401 when not authenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req(), props)
    expect(res.status).toBe(401)
    expect(getStaffForUser).not.toHaveBeenCalled()
  })
  it('404 when the service reports cross-tenant / missing', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', locations: [{ id: 'loc-1' }] })
    getStaffForUser.mockResolvedValue({ ok: false, status: 404, error: 'Not found' })
    const res = await GET(req(), props)
    expect(res.status).toBe(404)
  })
  it('200 with the profile when the service returns it', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', locations: [{ id: 'loc-1' }] })
    getStaffForUser.mockResolvedValue({ ok: true, data: { id: 'p1', full_name: 'Ada' } })
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.full_name).toBe('Ada')
    expect(getStaffForUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/staff/[id]/route.test.js`
Expected: FAIL — `GET` is not exported from `./route.js` (only PUT/DELETE exist).

- [ ] **Step 3: Add the GET handler**

In `src/app/api/staff/[id]/route.js`, add the import (alongside the existing `getCurrentUser` import) and a GET export. First confirm the existing imports; add:

```js
import { getStaffForUser } from '@/lib/staff'
```

Add this handler (place it ABOVE the existing `PUT` export):

```js
// GET /api/staff/[id] — fetch one staff member (scoped to the caller's
// locations; admins see HR fields). New in C1: the web edit page reads
// the DB directly, so this route exists for the mobile staff directory
// + any SDK consumer. Read logic lives in src/lib/staff.js.
export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const result = await getStaffForUser({ db, user, id: params.id })
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status || 400 })
  }
  return NextResponse.json({ success: true, data: result.data })
}
```

Ensure `NextResponse` and `createServerClient` are already imported in the file (they are — PUT/DELETE use them).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/staff/[id]/route.test.js`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/staff/[id]/route.js" "src/app/api/staff/[id]/route.test.js"
git commit -m "STAFF-C1.3 — new GET /api/staff/[id] via the staff read service"
```

---

## Task 4: SDK staff domain

**Files:** Create `shared/sdk/staff.js`, `shared/sdk/staff.test.js`; Modify `shared/sdk/index.js`.

- [ ] **Step 1: Write the failing test**

Create `shared/sdk/staff.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { createSdk } from './index.js'

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

describe('sdk.staff', () => {
  it('list() calls GET /api/staff', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: true, data: [{ id: 'p1' }] }))
    const sdk = createSdk({ baseUrl: 'https://api.test', getAuthHeaders: () => ({}), fetchImpl })
    const out = await sdk.staff.list()
    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/api/staff', expect.objectContaining({ method: 'GET' }))
    expect(out.data[0].id).toBe('p1')
  })
  it('get(id) calls GET /api/staff/:id', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: true, data: { id: 'p1' } }))
    const sdk = createSdk({ baseUrl: '', getAuthHeaders: () => ({}), fetchImpl })
    await sdk.staff.get('p1')
    expect(fetchImpl).toHaveBeenCalledWith('/api/staff/p1', expect.objectContaining({ method: 'GET' }))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run shared/sdk/staff.test.js`
Expected: FAIL — `sdk.staff` is undefined.

- [ ] **Step 3: Create the domain + register it**

Create `shared/sdk/staff.js`:

```js
// `staff` domain — the staff directory (read). list() + get(id) hit the
// neutral /api/staff routes (resolved by getCurrentUser → cookie on web,
// Bearer on mobile), backed by src/lib/staff.js. Create/update land in
// C2; this is the read slice.
export function staffDomain(request) {
  return {
    list: () => request('/api/staff', { method: 'GET' }),
    get: (id) => request(`/api/staff/${id}`, { method: 'GET' }),
  }
}
```

In `shared/sdk/index.js`, add the import and register the domain:

```js
import { staffDomain } from './staff.js'
```

and extend the `DOMAINS` map (currently `{ me: meDomain }`) to:

```js
const DOMAINS = {
  me: meDomain,
  staff: staffDomain,
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run shared/sdk/staff.test.js`
Expected: PASS (2 cases).

- [ ] **Step 5: Commit**

```bash
git add shared/sdk/staff.js shared/sdk/staff.test.js shared/sdk/index.js
git commit -m "STAFF-C1.4 — sdk.staff domain (list, get)"
```

---

## Task 5: Mobile staff list screen

**Files:** Create `mobile/app/staff/index.jsx`.

Read `mobile/app/radar/index.jsx` (the read-screen pattern) and `mobile/components/ui/index.js` (DataTable) before writing.

- [ ] **Step 1: Create the list screen**

Create `mobile/app/staff/index.jsx`:

```js
// STAFF-C1 — mobile staff directory (read). Admin-gated (master/owner/
// manager). Lists staff sharing a location with the caller via the SDK,
// rendered through the responsive DataTable primitive; a row opens the
// read-only detail. Management (edit/permissions/door access) stays on
// web until C2/C3.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { sdk } from '../../lib/sdk'
import { DataTable } from '../../components/ui'
import BackHeaderLeft from '../../components/BackHeaderLeft'

const ADMIN_ROLES = ['master', 'owner', 'manager']

function locationsLabel(staff) {
  const names = (staff.profile_locations || [])
    .map(pl => pl.locations?.name)
    .filter(Boolean)
  return names.length ? names.join(', ') : '—'
}

export default function StaffDirectory() {
  const { profile } = useAuth()
  const router = useRouter()
  const isAdmin = !!profile && ADMIN_ROLES.includes(profile.role)

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    const res = await sdk.staff.list()
    if (!res.success) { setError(res.error || 'Failed to load staff'); setRows([]); return }
    setRows(res.data || [])
  }, [])

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [isAdmin, load])

  const columns = [
    { key: 'full_name', label: 'Name', flex: 2 },
    { key: 'role', label: 'Role', flex: 1 },
    { key: 'locations', label: 'Studios', flex: 2, render: (r) => <Text className="text-sm text-un1t-text">{locationsLabel(r)}</Text> },
  ]

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Staff', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />

      {!isAdmin ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Staff management is owner/manager only.</Text>
        </View>
      ) : loading ? (
        <View className="py-16 items-center"><ActivityIndicator /></View>
      ) : (
        <ScrollView
          contentContainerClassName="px-4 pt-4 pb-10"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} tintColor="#111827" />}
        >
          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          )}
          <DataTable
            columns={columns}
            data={rows}
            keyExtractor={(r) => r.id}
            onRowPress={(r) => router.push(`/staff/${r.id}`)}
            empty={<Text className="text-center text-un1t-subtle py-8">No staff at your studios yet.</Text>}
          />
          <Text className="text-xs text-un1t-muted text-center mt-4 px-4">
            Read-only directory. Edit staff, roles, permissions and door access on the web for now.
          </Text>
        </ScrollView>
      )}
    </View>
  )
}
```

- [ ] **Step 2: Verify imports resolve**

Run: `npm run check:mobile-imports`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add mobile/app/staff/index.jsx
git commit -m "STAFF-C1.5 — mobile staff directory list screen (DataTable + SDK)"
```

---

## Task 6: Mobile staff detail screen

**Files:** Create `mobile/app/staff/[id].jsx`.

- [ ] **Step 1: Create the detail screen**

Create `mobile/app/staff/[id].jsx`:

```js
// STAFF-C1 — mobile staff detail (read-only). Loads one staff member
// via the SDK and shows their profile + per-studio assignments. No edit
// controls (C2). Admin-gated like the list.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { sdk } from '../../lib/sdk'
import { Card } from '../../components/ui'
import BackHeaderLeft from '../../components/BackHeaderLeft'

const ADMIN_ROLES = ['master', 'owner', 'manager']

function Row({ label, value }) {
  return (
    <View className="flex-row justify-between px-4 py-3 border-b border-un1t-border">
      <Text className="text-sm text-un1t-subtle">{label}</Text>
      <Text className="text-sm text-un1t-text">{value ?? '—'}</Text>
    </View>
  )
}

export default function StaffDetail() {
  const { id } = useLocalSearchParams()
  const { profile } = useAuth()
  const isAdmin = !!profile && ADMIN_ROLES.includes(profile.role)

  const [staff, setStaff] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    const res = await sdk.staff.get(id)
    if (!res.success) { setError(res.error || 'Failed to load'); setStaff(null); return }
    setStaff(res.data)
  }, [id])

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [isAdmin, load])

  const assignments = staff?.profile_locations || []

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: staff?.full_name || 'Staff', headerLeft: () => <BackHeaderLeft label="Staff" fallbackHref="/staff" /> }} />

      {!isAdmin ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
        </View>
      ) : loading ? (
        <View className="py-16 items-center"><ActivityIndicator /></View>
      ) : (
        <ScrollView
          contentContainerClassName="px-4 pt-4 pb-10"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} tintColor="#111827" />}
        >
          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          )}
          {staff && (
            <>
              <Card padding="none" className="overflow-hidden mb-4">
                <Row label="Name" value={staff.full_name} />
                <Row label="Email" value={staff.email} />
                <Row label="Role" value={staff.role} />
                <Row label="Status" value={staff.active ? 'Active' : 'Inactive'} />
                <Row label="Employment" value={staff.employment_type} />
              </Card>

              <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">Studio assignments</Text>
              <Card padding="none" className="overflow-hidden">
                {assignments.length === 0
                  ? <Text className="text-center text-un1t-subtle py-6">No studio assignments.</Text>
                  : assignments.map((pl, i) => (
                      <View key={pl.location_id || i} className={`px-4 py-3 ${i < assignments.length - 1 ? 'border-b border-un1t-border' : ''}`}>
                        <Text className="text-sm text-un1t-text">{pl.locations?.name || pl.location_id}</Text>
                        <Text className="text-xs text-un1t-subtle mt-0.5">{pl.role}{pl.is_default ? ' · default' : ''}</Text>
                      </View>
                    ))}
              </Card>

              <Text className="text-xs text-un1t-muted text-center mt-4 px-4">
                Read-only. Edit this staff member on the web.
              </Text>
            </>
          )}
        </ScrollView>
      )}
    </View>
  )
}
```

> Note: the detail uses `staff.email`/`employment_type`, which are present for admins (the only role that reaches this screen). If `Card` doesn't accept `padding="none"`, check `mobile/components/ui/Card.jsx` and use the supported prop (the styles support `none|sm|md|lg`).

- [ ] **Step 2: Verify imports resolve**

Run: `npm run check:mobile-imports`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "mobile/app/staff/[id].jsx"
git commit -m "STAFF-C1.6 — mobile staff detail screen (read-only)"
```

---

## Task 7: More-launcher row + gate + PR

**Files:** Modify `mobile/app/(tabs)/more.jsx`.

- [ ] **Step 1: Add the launcher row**

Read `mobile/app/(tabs)/more.jsx` and find the list of launcher tiles/rows (the ones that `router.push` to More-only screens like `/radar`, `/approvals`, `/issues`). Add a **Staff** row following the exact same pattern, routing to `/staff`, shown only for admin roles. Use the same gating idiom the file already uses; if it gates by `canMobile(profile, key, ...)`, gate Staff with an inline role check instead since there's no mobile staff permission yet:

```js
// inside the admin-visible section; mirror the existing row markup
{['master', 'owner', 'manager'].includes(profile?.role) && (
  <LauncherRow icon="people-outline" label="Staff" onPress={() => router.push('/staff')} />
)}
```

Match the actual component/markup the file uses (it may be a `<Pressable>` tile rather than a `LauncherRow` component — mirror whatever is there). Keep the icon consistent with the file's icon set (Ionicons `people-outline` is a safe staff icon if that set is in use).

- [ ] **Step 2: Verify imports + full mobile gate**

Run: `npm run check:mobile-imports` (clean) and `npm run check:mobile-parity` (clean — no permission keys changed, so parity is unaffected).

- [ ] **Step 3: Commit**

```bash
git add "mobile/app/(tabs)/more.jsx"
git commit -m "STAFF-C1.7 — Staff row in the mobile More launcher (admin-gated)"
```

- [ ] **Step 4: Full CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports
```
Expected: all green (existing + the new staff service / route / sdk tests). 1 pre-existing lint warning OK.

- [ ] **Step 5: Production build (new web imports + route)**

Run: `npm run build`
Expected: `✓ Compiled successfully`. (Catches `@/lib/staff` resolution + the new `[id]` GET route.)

- [ ] **Step 6: Push + open PR**

```bash
git push -u origin mobile-parity-staff
```
Open the PR against `main`, title `STAFF-C1 — staff read vertical (service + SDK domain + mobile directory)`. Body: the read service backing both GET routes; the new `GET /api/staff/[id]`; the `sdk.staff` domain; the admin-gated mobile staff directory (list + detail) on the new primitives; that the PR **also contains the rails (#415) + primitives (#416)** since it's stacked (note this so the reviewer expects that diff, or rebase once those merge); and that **write/permissions/device-access stay on web (C2/C3)**.

---

## Self-review

- **Spec coverage:** Implements the read slice of the foundation spec's §6 (Staff & Access as first consumer) end-to-end on the rails (§2/§3) + primitives (§4): service → routes → SDK → mobile screens. The write path (§6 create/edit/matrix/toggles) is explicitly C2/C3.
- **Placeholder scan:** none — every step has complete code + exact commands. The two "read the existing file" notes (more.jsx markup, Card padding prop) are verification instructions, not placeholders — the surrounding code is complete.
- **Type/name consistency:** `listStaffForUser`/`getStaffForUser`/`STAFF_PUBLIC_FIELDS` defined in Task 1, imported by Tasks 2–3; `staffDomain`/`sdk.staff.list`/`sdk.staff.get` defined in Task 4, consumed by Tasks 5–6; the `{ ok, data } | { ok:false, status?, error }` service envelope is consistent. Mobile screens use `sdk` from `mobile/lib/sdk` (Plan A) and `DataTable`/`Card` from `mobile/components/ui` (Plan B).
- **Safety:** the GET refactor preserves exact behavior (same scope, same field gating); POST/PUT/DELETE on the staff routes are untouched (the risky monolith is not modified); the new GET is additive; the mobile screens are new and admin-gated. No permission-registry or parity-linter change (deferred to C3), so `check:mobile-parity` is unaffected.
