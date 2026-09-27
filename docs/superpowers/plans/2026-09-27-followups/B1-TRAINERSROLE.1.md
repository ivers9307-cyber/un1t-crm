## PR TRAINERSROLE.1 — the location lookup routes judge the role at the location in the path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /api/locations/[id]/glofox-trainers`, and the three routes with the same gate (`glofox-memberships`, `unifi-users`, `unifi-doors`), decide "may this caller read this?" on the caller's role **at the location in the path**. Today they use the role at the caller's **active** studio. A non-member gets 404, a member without the role gets 403.

**Architecture:** The same fix SCHEDROLES.1 (#1712) and LOCFIX-ROLEGATE.1 applied to their routes. Check membership first with `assertLocationAccessOr404(user, id)`, then the role with `hasRoleAtLocation(user, id, ADMIN_ROLES)`. Masters are let through on `profileRole`. There are four callers of this check, so one shared test table of mixed-role callers sits beside the routes and every route test runs it. A source-scan test stops a route under `src/app/api/locations/[id]/` from checking `user.role` against a role list again. The stale "~850 rows" comment becomes the measured figure.

**Tech Stack:** Next.js 16 App Router route handlers, Vitest (the real `@/lib/auth`, with only `getCurrentUser` mocked, the way the stripe-connect tests do it).

**Ships:** a web deploy only. **No migration.** Nothing under `mobile/` or `shared/` changes, so **no OTA**.

**Worktree:** branch `trainersrole-1` off a fresh `origin/main`, in its own fresh worktree (never a shared one, and no `git stash`). If `node_modules` is missing, run `npm ci` once. Run tests one file at a time with `npx vitest run <file>`. Leave the whole suite and `npm run build` until the gate at the end (8GB machine).

**Written:** 27 Sep 2026, against `origin/main` at `28d02e59` (#1779). Every file:line below was checked against that tree.

---

### What was found

**The bug, exactly as it stands** (`src/app/api/locations/[id]/glofox-trainers/route.js:24-41`):

```js
const ALLOWED_ROLES = new Set(['master', 'owner', 'manager'])
…
  if (!ALLOWED_ROLES.has(user.role)) {                                   // :30 role at the ACTIVE studio
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
  const { id: locationId } = await params
  …
  if (user.role !== 'master') {
    const allowed = (user.locations || []).some((l) => l.id === locationId)   // :39 membership only
    if (!allowed) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
```

`user.role` comes from `resolveActiveLocationRole` (`src/lib/auth.js:109-117`, set on the user at `:658`). It returns the role at the active studio, or the caller's highest role anywhere when they have none there. So the route judges the wrong studio, and gets it wrong in both directions:

- **Too open:** a manager at A who is plain staff at B, working with A active, can read B's list. They pass the role check (manager at A) and the membership check (they belong to B).
- **Too closed:** the same person with B active is refused at A, the studio they manage. A staff member at A who manages B, with A active, is refused at B.
- An outsider gets **403**, not the 404 the house rule asks for (CLAUDE.md, "Detail routes return 404 not 403").

The route is **GET only** and has no write method. Trainer names are edited in the Glofox settings tab, which writes `locations.settings.glofox.trainer_names` through the browser client (`src/components/settings/integrations/GlofoxIntegrationTab.jsx:121-124`). RLS covers that write: `locations_upd` allows only master or owner at that location (`supabase/migrations/320_perf_consolidate_multiple_permissive_policies.sql:190`, `private.auth_is_owner_at(id)`), and it already judges the right studio.

**Who reads and edits trainer names today, and who should:**

| | Today | After this PR |
|---|---|---|
| The page that shows the list, `/settings/locations/[id]` | membership at `params.id` (`page.js:65`, 404) and then **master or owner at `params.id`** (`page.js:78`, `guardMasterOrOwner`, redirect) | unchanged |
| The Glofox tab's edit form | `canEdit = isOwnerOrMaster` from `user.role` (`src/components/settings/LocationIntegrations.jsx:47`, passed at `:214`). Active-studio role, so it wrongly hides the form, but only from an owner-at-target whose active studio is one they don't own (see follow-up F2) | unchanged (follow-up F2) |
| The edit itself (the RLS write) | master or owner at the location | unchanged |
| **The list route** (`GET …/glofox-trainers`) | master/owner/manager **at the active studio** + membership of the target | **master, or owner/manager at the target** (`ADMIN_ROLES`, the same tier as the Glofox credentials write in `src/app/api/locations/[id]/integrations/[provider]/route.js:31, 289-290`) |

In practice only masters and owners-at-target reach the page, so nobody who uses the list today loses it. Managers keep API access at their own studio (see Decision 2).

**The same bug in the other `/api/locations/[id]/**` routes.** All 41 `route.js` files there were read for their gate. Four copy the trainers gate line for line, and they are fixed in this PR (Decision 1):

| Route | Role check | Membership | What it exposes | Called from |
|---|---|---|---|---|
| `glofox-trainers/route.js` | `:30` `ALLOWED_ROLES.has(user.role)` | `:38-41` | Glofox trainer ids, resolved names, class counts | `GlofoxIntegrationTab.jsx:82` |
| `glofox-memberships/route.js` | `:24` | `:32-35` | the studio's Glofox membership + plan catalogue | `GlofoxIntegrationTab.jsx:57`, `src/components/LandingPageSettingsForm.jsx:920` |
| `unifi-users/route.js` | `:37` | `:46-49` | **every UniFi Access user at the controller: names, emails, employee numbers** | `src/components/StaffForm.jsx:1782`, **per assignment location** (`:695-697`, `locationId={a.location_id}`) |
| `unifi-doors/route.js` | `:35` | `:45-48` | the studio's door list | `StaffForm.jsx:1908`, per assignment location (`:740`) |

`StaffForm` calls the UniFi pair once for each studio the staff member is assigned to, whichever studio is active. That is exactly how a non-active location reaches these routes: a manager at A who is staff at B can read B's UniFi user list today.

The other 37 already judge the role at `params.id`, or need no role check:
- **`hasRoleAtLocation`:** `channels`, `channels/[connId]`, `holidays`, `holidays/[holidayId]`, the four `stripe-connect/*` routes (the last four with `assertLocationAccessOr404`).
- **`guardMasterOrOwner` / `guardMailboxAdmin`:** `comms-frequency-cap`, `email-copy`, `email-spam-filter`, `geofence-attendance`, `notification-config`, `send-quiet-hours`, `whatsapp/*`, `email/**`.
- **`rolesByLocation[id]`:** `ac-devices:40-44`, `connections/refresh:37-38`, `integrations/[provider]:289-290`, `role-permissions:46-48`.
- **Master only:** `features`, `bca-config` PUT (`canEditLocationFeatures`).
- **API key, org-scoped:** `integrations`.
- **Membership only, on purpose:** the seven `xero/*` routes (for example `xero/sync-accounts/route.js:6-11`: "anyone with access to the Settings integrations card").
- `user.role === 'master'` (`ac-devices:40`, `channels:31`, `role-permissions:47`, the `xero/*` routes) is **not** this bug. `resolveActiveLocationRole` answers `'master'` only for a `profiles.role` master (`auth.js:110`), and `rolesByLocation` never holds `'master'`, so that comparison doesn't depend on the active studio.

A scan of the 41 files with comments stripped confirms it: exactly the four routes above check `user.role` against a role list (Task 5 pins this).

**The same class outside `/api/locations`:** about 40 more routes check `MANAGER_ROLES`/`ADMIN_ROLES.includes(user.role)` and then act on a location taken from a row, the body or the query. That is too big for an S row, so it is follow-up F1 (listed at the end with file:line).

**The "~850 rows" comment** (`glofox-trainers/route.js:52-55`) is stale. Counted live on 27 Sep 2026 (read-only `select count(*)` on `class_occurrences` for the last 28 days): **191 rows, all at UN1T Stillorgan, every one carrying trainers**. The index counted 184 earlier the same day; the window moves, and it also holds the 48 hours ahead that the sync keeps (`src/lib/class-occurrences.js:223`, `windowHours = 48`). That is about a fifth of the 1000-row cap, so the capped `.limit(1000)` read stays as it is. Only the comment changes.

**Rules that bite in this PR:**
- **Membership comes before role**, and a non-member gets a 404 (`assertLocationAccessOr404`, `src/lib/auth.js:787-797`, body `{ success:false, error:'Not found' }`), so a stranger can't learn that a location id exists. A member without the role gets 403 with each route's existing body, `{ success:false, error:'forbidden' }`.
- **Master:** `hasRoleAtLocation` lets masters through on `profileRole` (`src/lib/role-at-location.js:57`). `assertLocationAccessOr404` passes them because `getCurrentUser` gives masters every **active** location (`auth.js:378-379, 416`).
- **Org admins:** their organisation's locations carry a synthetic `'owner'` in `rolesByLocation` (`expandOrgAdminAccess`, `auth.js:72-89`), so they pass as owners. That needs no special case.
- The 401 stays the route's own `{ success:false, error:'unauthenticated' }`, returned before `params` is read.
- The repo is PUBLIC. Fixtures use `Coach One`, `coach.one@example.com` and made-up UUIDs, never real names.

---

### Decisions (each pinned by a test)

1. **Scope: all four routes, not just the trainers route.** They share the exact gate, the same role set and the same folder, and the fix is the same ten lines. `unifi-users` is the most sensitive of the four (a studio's staff names and emails). Pinned by the shared case table running in all four route tests (Tasks 1-4) and by the guard scan (Task 5), which fails if any of the four keeps its old gate. *If the owner wants the narrow PR: ship Tasks 1, 5 (with the three siblings added to the scan's `KNOWN_UNFIXED` list, see Task 5) and 6, and move Tasks 2-4 to a follow-up unchanged.*
2. **Tier: `ADMIN_ROLES` (master, owner, manager) at the path location.** That is the same membership as today's `ALLOWED_ROLES`, now imported from `src/lib/schemas.js:192` instead of redeclared. It is also the tier the Glofox credentials write already uses (`integrations/[provider]/route.js:289-290`), so managers are not narrowed out. That would be a product change, and the settings page already keeps them out of the UI. Head coaches stay refused. Pinned by: "an owner at B", "a staff member at A who manages B" → 200; "a head coach at B" → 403.
3. **Role at the target, both directions.** "A manager at A who is staff at B, asking for B" → 403 (open today). "A staff member at A who manages B, asking for B, A active" → 200, and "a manager at A with B active, asking for A" → 200 (both refused today).
4. **A non-member gets 404 `{ error:'Not found' }`, not 403.** Pinned by "a manager who does not belong to B" → 404, with nothing downstream called.
5. **A refused caller costs nothing downstream.** No Glofox credentials read, no UniFi call, no class-occurrences read. Pinned in every route test (`expect(<downstream>).not.toHaveBeenCalled()` for every non-200 row).
6. **The trainers payload is unchanged.** Ids are lowercased and deduplicated, `source` is `override` / `glofox` / `null`, the list is sorted by class count, `windowDays: 28`, and the read is scoped to the PATH id. Pinned by a characterisation test that passes before and after.
7. **Masters are judged the house way.** A master reaches any **active** location. An inactive location's id now 404s for a master where it used to answer. That matches the settings page, which already 404s it (`page.js:65`). Pinned by "a master" → 200 (the table's master belongs to A and B, as `getCurrentUser` would build them).

---

### File map

| File | Change |
|---|---|
| `src/app/api/locations/[id]/_role-gate-cases.js` | Create: the mixed-role callers + the case table the four route tests share (test-only; imported only by `*.test.js`) |
| `src/app/api/locations/[id]/glofox-trainers/route.js` | Modify: header lines 12-13; import line 17; delete line 24; gate lines 27-41; comment lines 52-55 |
| `src/app/api/locations/[id]/glofox-trainers/route.test.js` | Create |
| `src/app/api/locations/[id]/glofox-memberships/route.js` | Modify: header lines 8-9; import line 13; delete line 19; gate lines 21-35 |
| `src/app/api/locations/[id]/glofox-memberships/route.test.js` | Create |
| `src/app/api/locations/[id]/unifi-users/route.js` | Modify: header lines 8-11; import line 19; delete lines 29-32; gate lines 34-49 |
| `src/app/api/locations/[id]/unifi-users/route.test.js` | Create |
| `src/app/api/locations/[id]/unifi-doors/route.js` | Modify: header lines 9-11; import line 18; delete lines 28-30; gate lines 32-48 |
| `src/app/api/locations/[id]/unifi-doors/route.test.js` | Create |
| `src/app/api/locations/[id]/role-at-path.test.js` | Create: the source-scan guard |
| `src/lib/openapi.js` | Modify: lines 3769 and 3773-3775 (the trainers entry) |
| `docs/CHANGELOG.md` | Modify: one new row, after `gh pr create` |

---

### Task 1: the shared case table, and `glofox-trainers` judged at the path

**Files:** Create `src/app/api/locations/[id]/_role-gate-cases.js`, `src/app/api/locations/[id]/glofox-trainers/route.test.js`. Modify `src/app/api/locations/[id]/glofox-trainers/route.js`.

- [ ] **Step 1: Write the shared callers and case table**

Create `src/app/api/locations/[id]/_role-gate-cases.js`:

```js
// TRAINERSROLE.1 — mixed-role callers for the /api/locations/[id] lookup
// routes (glofox-trainers, glofox-memberships, unifi-users, unifi-doors).
// TEST-ONLY: imported by the route.test.js files beside those routes, never by
// a route. Not collected as a test itself (vitest collects *.test.js only).
//
// Each caller is shaped the way getCurrentUser() builds it: `role` is the role
// at the ACTIVE studio (resolveActiveLocationRole), `rolesByLocation` holds the
// per-studio roles, `locations` is every studio the caller belongs to, and
// `profileRole` is profiles.role (where mastership lives).

export const LOC_A = 'a0000000-0000-4000-8000-00000000000a'
export const LOC_B = 'b0000000-0000-4000-8000-00000000000b'

function member(rolesByLocation, activeId) {
  return {
    id: 'user-1',
    isMaster: false,
    profileRole: 'staff',
    locations: Object.keys(rolesByLocation).map((id) => ({ id })),
    rolesByLocation,
    activeLocation: { id: activeId },
    role: rolesByLocation[activeId],
  }
}

export const MANAGER_A_STAFF_B = member({ [LOC_A]: 'manager', [LOC_B]: 'staff' }, LOC_A)
export const MANAGER_A_STAFF_B_ACTIVE_B = member({ [LOC_A]: 'manager', [LOC_B]: 'staff' }, LOC_B)
export const STAFF_A_MANAGER_B = member({ [LOC_A]: 'staff', [LOC_B]: 'manager' }, LOC_A)
// Also what an org admin looks like at an org location they hold no explicit
// row at: expandOrgAdminAccess gives it a synthetic 'owner'.
export const STAFF_A_OWNER_B = member({ [LOC_A]: 'staff', [LOC_B]: 'owner' }, LOC_A)
export const STAFF_A_HEAD_COACH_B = member({ [LOC_A]: 'staff', [LOC_B]: 'head_coach' }, LOC_A)
export const OUTSIDER = member({ [LOC_A]: 'manager' }, LOC_A)
export const MASTER = {
  id: 'user-m',
  isMaster: true,
  profileRole: 'master',
  role: 'master',
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

// [label, caller, target location, status, error body or null]
// On origin/main before TRAINERSROLE.1, rows 1-4 and 7 give the wrong answer
// (1 → 200, 2-4 → 403, 7 → 403); rows 5 and 6 already hold.
export const ROLE_GATE_CASES = [
  ['a manager at A who is staff at B, asking for B (A active)', MANAGER_A_STAFF_B, LOC_B, 403, 'forbidden'],
  ['a staff member at A who manages B, asking for B (A active)', STAFF_A_MANAGER_B, LOC_B, 200, null],
  ['a manager at A with B active, asking for A', MANAGER_A_STAFF_B_ACTIVE_B, LOC_A, 200, null],
  ['an owner at B (or an org admin) with A active, asking for B', STAFF_A_OWNER_B, LOC_B, 200, null],
  ['a head coach at B, asking for B', STAFF_A_HEAD_COACH_B, LOC_B, 403, 'forbidden'],
  ['a master', MASTER, LOC_B, 200, null],
  ['a manager who does not belong to B, asking for B', OUTSIDER, LOC_B, 404, 'Not found'],
]
```

- [ ] **Step 2: Write the failing route test**

Create `src/app/api/locations/[id]/glofox-trainers/route.test.js`:

```js
// TRAINERSROLE.1 — GET /api/locations/[id]/glofox-trainers judges the caller's
// role AT THE PATH LOCATION. It used to check `user.role` (the ACTIVE studio's
// role) and then membership only, so a manager at A who is staff at B read B's
// list from an A session, and a manager was refused at their own studio while
// another was active. @/lib/auth is REAL; only getCurrentUser is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
// class-occurrences imports these four from @/lib/glofox at module scope.
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  fetchUpcomingEvents: vi.fn(),
  fetchGlofoxTrainers: vi.fn(),
  fetchMemberResult: vi.fn(),
  glofoxDisplayName: vi.fn(),
}))
vi.mock('@/lib/class-occurrences', async () => {
  const actual = await vi.importActual('@/lib/class-occurrences')
  return { ...actual, resolveTrainerNames: vi.fn() }
})

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { resolveTrainerNames } from '@/lib/class-occurrences'
import { ROLE_GATE_CASES, LOC_B, MASTER } from '../_role-gate-cases.js'

const ID1 = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const ID2 = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const CREDS = {
  branchId: 'branch-1', apiKey: 'key-1', apiToken: 'token-1',
  trainerNames: { [ID1.toUpperCase()]: '  Coach One  ' },
}

function fakeDb(rows) {
  const calls = { from: [], eq: [], gte: [] }
  const chain = {
    select: () => chain,
    eq: (col, val) => { calls.eq.push([col, val]); return chain },
    gte: (col, val) => { calls.gte.push([col, val]); return chain },
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return { calls, client: { from: (t) => { calls.from.push(t); return chain } } }
}

const call = (id) => GET({}, { params: Promise.resolve({ id }) })

describe('GET glofox-trainers — role judged at the path location', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = fakeDb([{ trainers: [ID1] }])
    createServerClient.mockReturnValue(db.client)
    glofoxCredentialsForLocation.mockResolvedValue(CREDS)
    resolveTrainerNames.mockResolvedValue({ [ID1]: 'Coach One' })
  })

  it.each(ROLE_GATE_CASES)('%s → %i', async (_label, caller, target, status, error) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await call(target)
    expect(res.status).toBe(status)
    if (status === 200) {
      expect(glofoxCredentialsForLocation).toHaveBeenCalledWith(db.client, target)
    } else {
      expect(await res.json()).toEqual({ success: false, error })
      expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
      expect(db.calls.from).toEqual([])
    }
  })

  it('401s an anonymous caller before reading anything', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(LOC_B)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'unauthenticated' })
    expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
  })

  // Characterisation: passes before and after. The payload and the location
  // scoping are not part of this change.
  it('returns the distinct trainer ids for the PATH location, override first', async () => {
    db = fakeDb([
      { trainers: [ID1, ID2] },
      { trainers: [{ _id: ID1 }] },
      { trainers: ['An inline name'] },
      { trainers: null },
    ])
    createServerClient.mockReturnValue(db.client)
    resolveTrainerNames.mockResolvedValue({ [ID1]: 'Coach One', [ID2]: 'Coach Two' })
    getCurrentUser.mockResolvedValue(MASTER)

    const res = await call(LOC_B)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: {
        trainers: [
          { id: ID1, name: 'Coach One', source: 'override', classes: 2 },
          { id: ID2, name: 'Coach Two', source: 'glofox', classes: 1 },
        ],
        windowDays: 28,
      },
    })
    expect(db.calls.from).toEqual(['class_occurrences'])
    expect(db.calls.eq).toEqual([['location_id', LOC_B]])
    expect(resolveTrainerNames).toHaveBeenCalledWith(CREDS, [ID1, ID2])
  })
})
```

- [ ] **Step 3: Run it, expect FAIL**

Run: `npx vitest run 'src/app/api/locations/[id]/glofox-trainers/route.test.js'`
Expected: 5 of the 7 table rows fail:
- "a manager at A who is staff at B": expected 403, received 200.
- "a staff member at A who manages B", "a manager at A with B active", "an owner at B": expected 200, received 403.
- "a manager who does not belong to B": expected 404, received 403.

"A head coach at B", "a master", the 401 and the payload test pass.

- [ ] **Step 4: Fix the gate and the comment**

In `src/app/api/locations/[id]/glofox-trainers/route.js`, replace lines 12-13:

```js
// Auth: master / owner / manager only (mirrors /glofox-memberships —
// both touch integration data).
```

with:

```js
// Auth (TRAINERSROLE.1): master, or owner/manager AT THIS LOCATION —
// ADMIN_ROLES, the tier the Glofox credentials write uses
// (integrations/[provider]). Membership first (404, so a stranger cannot
// learn the id exists), then the role judged at the PATH id with
// hasRoleAtLocation. Never `user.role`: that is the caller's ACTIVE studio's
// role, so a manager at Stillorgan who is plain staff at Hatch read Hatch's
// list from a Stillorgan session, and a manager was refused at their own
// studio while another was active (the SCHEDROLES.1 class).
```

Replace line 17:

```js
import { getCurrentUser } from '@/lib/auth'
```

with:

```js
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
```

Delete line 24 (`const ALLOWED_ROLES = new Set(['master', 'owner', 'manager'])`).

Replace the handler's opening, lines 27-41:

```js
export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })
  if (!ALLOWED_ROLES.has(user.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const { id: locationId } = await params
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })
  }
  if (user.role !== 'master') {
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
```

with:

```js
export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })

  const { id: locationId } = await params
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })
  }
  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied
  if (!hasRoleAtLocation(user, locationId, ADMIN_ROLES)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
```

Replace the comment at lines 52-55:

```js
  // 28d of Stillorgan is ~850 rows, under the 1000-row select cap; the
  // list is a distinct-id reference, so a truncated deep tail (order:
  // newest first) would only ever hide a trainer who hasn't taught in
  // weeks anyway.
```

with:

```js
  // 28 days of Stillorgan is about 190 rows (191 counted live on
  // 27 Sep 2026, including the 48 hours ahead the sync keeps), well under
  // the 1000-row select cap. The list is a distinct-id reference, so a
  // truncated deep tail (order: newest first) would only ever hide a
  // trainer who hasn't taught in weeks anyway.
```

Leave the `// eslint-disable-next-line guardrails/no-uncapped-supabase-limit …` line exactly where it is, directly above `const { data: rows, error } = await db`.

- [ ] **Step 5: Run it, expect PASS**

Run: `npx vitest run 'src/app/api/locations/[id]/glofox-trainers/route.test.js'`
Expected: 9 passed.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/api/locations/[id]/_role-gate-cases.js' 'src/app/api/locations/[id]/glofox-trainers/route.js' 'src/app/api/locations/[id]/glofox-trainers/route.test.js'
git commit -m "$(cat <<'EOF'
TRAINERSROLE.1 — glofox-trainers judges the role at the path location

Membership first (404 for a non-member), then owner/manager AT the path id
via hasRoleAtLocation, not user.role (the active studio's role). Fixes the
stale ~850-row comment (about 190).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `glofox-memberships`, the same gate

**Files:** Create `src/app/api/locations/[id]/glofox-memberships/route.test.js`. Modify `src/app/api/locations/[id]/glofox-memberships/route.js`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/locations/[id]/glofox-memberships/route.test.js`:

```js
// TRAINERSROLE.1 — GET /api/locations/[id]/glofox-memberships judges the
// caller's role AT THE PATH LOCATION, not via `user.role` (the ACTIVE studio's
// role). Same gate and same fix as glofox-trainers. @/lib/auth is REAL; only
// getCurrentUser is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  listGlofoxMemberships: vi.fn(),
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { glofoxCredentialsForLocation, listGlofoxMemberships } from '@/lib/glofox'
import { ROLE_GATE_CASES, LOC_B } from '../_role-gate-cases.js'

const MEMBERSHIPS = [{ _id: 'm-1', name: 'Trial', plans: [{ code: 'p-1' }] }]
const call = (id) => GET({}, { params: Promise.resolve({ id }) })

describe('GET glofox-memberships — role judged at the path location', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'branch-1', apiKey: 'key-1', apiToken: 'token-1' })
    listGlofoxMemberships.mockResolvedValue({ ok: true, memberships: MEMBERSHIPS })
  })

  it.each(ROLE_GATE_CASES)('%s → %i', async (_label, caller, target, status, error) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await call(target)
    expect(res.status).toBe(status)
    if (status === 200) {
      expect(await res.json()).toEqual({ success: true, memberships: MEMBERSHIPS, count: 1 })
      expect(glofoxCredentialsForLocation).toHaveBeenCalledWith(expect.anything(), target)
    } else {
      expect(await res.json()).toEqual({ success: false, error })
      expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
      expect(listGlofoxMemberships).not.toHaveBeenCalled()
    }
  })

  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(LOC_B)
    expect(res.status).toBe(401)
    expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run 'src/app/api/locations/[id]/glofox-memberships/route.test.js'`
Expected: the same 5 rows fail as in Task 1, Step 3 (403 where 200 is expected, 200 where 403 is expected, 403 where 404 is expected).

- [ ] **Step 3: Fix the gate**

In `src/app/api/locations/[id]/glofox-memberships/route.js`, replace lines 8-9:

```js
// Auth: master / owner / manager only (mirrors /unifi-users — both
// touch sensitive integration data).
```

with:

```js
// Auth (TRAINERSROLE.1): master, or owner/manager AT THIS LOCATION
// (ADMIN_ROLES). Membership first (404), then the role judged at the PATH id
// with hasRoleAtLocation, never `user.role` (the ACTIVE studio's role). Same
// gate as /glofox-trainers and /unifi-users.
```

Replace line 13:

```js
import { getCurrentUser } from '@/lib/auth'
```

with:

```js
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
```

Delete line 19 (`const ALLOWED_ROLES = new Set(['master', 'owner', 'manager'])`).

Replace lines 21-35:

```js
export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })
  if (!ALLOWED_ROLES.has(user.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const { id: locationId } = await params
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })
  }
  if (user.role !== 'master') {
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
```

with:

```js
export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })

  const { id: locationId } = await params
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })
  }
  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied
  if (!hasRoleAtLocation(user, locationId, ADMIN_ROLES)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run 'src/app/api/locations/[id]/glofox-memberships/route.test.js' src/lib/glofox-trial-options.test.js`
Expected: 8 passed in the route test; `glofox-trial-options.test.js` unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/locations/[id]/glofox-memberships/route.js' 'src/app/api/locations/[id]/glofox-memberships/route.test.js'
git commit -m "$(cat <<'EOF'
TRAINERSROLE.1 — glofox-memberships judges the role at the path location

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `unifi-users`, the same gate (the sensitive one)

**Files:** Create `src/app/api/locations/[id]/unifi-users/route.test.js`. Modify `src/app/api/locations/[id]/unifi-users/route.js`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/locations/[id]/unifi-users/route.test.js`:

```js
// TRAINERSROLE.1 — GET /api/locations/[id]/unifi-users (every UniFi Access
// user at the studio's controller: names, emails, employee numbers) judges the
// caller's role AT THE PATH LOCATION. StaffForm calls it once per studio a
// staff member is assigned to, whichever studio is active, so the old
// `user.role` check let a manager at A who is staff at B read B's list.
// @/lib/auth is REAL; only getCurrentUser is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/unifi-access', () => ({
  getUnifiConfig: vi.fn(),
  listUnifiUsers: vi.fn(),
  UnifiError: class UnifiError extends Error {},
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getUnifiConfig, listUnifiUsers } from '@/lib/unifi-access'
import { ROLE_GATE_CASES, LOC_B } from '../_role-gate-cases.js'

const USERS = [{ id: 'uu-1', full_name: 'Coach One', user_email: 'coach.one@example.com', employee_number: '7', status: 'ACTIVE', nfc_count: 1 }]
const call = (id) => GET({}, { params: Promise.resolve({ id }) })

function fakeDb() {
  const from = vi.fn(() => ({
    select: () => ({
      eq: (_col, id) => ({
        maybeSingle: () => Promise.resolve({ data: { id, name: 'Studio', settings: {} }, error: null }),
      }),
    }),
  }))
  return { from }
}

describe('GET unifi-users — role judged at the path location', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = fakeDb()
    createServerClient.mockReturnValue(db)
    getUnifiConfig.mockResolvedValue({ configured: true })
    listUnifiUsers.mockResolvedValue(USERS)
  })

  it.each(ROLE_GATE_CASES)('%s → %i', async (_label, caller, target, status, error) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await call(target)
    expect(res.status).toBe(status)
    if (status === 200) {
      expect(await res.json()).toEqual({ success: true, users: USERS, count: 1 })
    } else {
      expect(await res.json()).toEqual({ success: false, error })
      expect(db.from).not.toHaveBeenCalled()
      expect(listUnifiUsers).not.toHaveBeenCalled()
    }
  })

  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(LOC_B)
    expect(res.status).toBe(401)
    expect(listUnifiUsers).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run 'src/app/api/locations/[id]/unifi-users/route.test.js'`
Expected: the same 5 rows fail as in Task 1, Step 3.

- [ ] **Step 3: Fix the gate**

In `src/app/api/locations/[id]/unifi-users/route.js`, replace lines 8-11:

```js
// Auth: master / owner / manager only — these are the same gates that
// already protect /studio-management and /api/staff/[id], because
// reading the full user list at a controller is a sensitive operation
// (employee names, emails, employee numbers).
```

with:

```js
// Auth (TRAINERSROLE.1): master, or owner/manager AT THIS LOCATION
// (ADMIN_ROLES), because reading the full user list at a controller is a
// sensitive operation (employee names, emails, employee numbers).
// Membership first (404), then the role judged at the PATH id with
// hasRoleAtLocation. Never `user.role`: StaffForm calls this once per studio
// the staff member is assigned to, whichever studio is active, and the
// active studio's role let a manager at one studio who is staff at another
// read the other's list.
```

Replace line 19:

```js
import { getCurrentUser } from '@/lib/auth'
```

with:

```js
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
```

Delete lines 29-32:

```js
// Roles allowed to read the full UniFi user list. Mirrors the gate
// on the staff edit page so the picker is only available to people
// who can also see / edit the staff record itself.
const ALLOWED_ROLES = new Set(['master', 'owner', 'manager'])
```

Replace lines 34-49:

```js
export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })
  if (!ALLOWED_ROLES.has(user.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const { id: locationId } = await params
  if (!locationId) return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })

  // Master sees every location; owner/manager only the locations they
  // belong to. Mirrors the per-location gate in /api/staff routes.
  if (user.role !== 'master') {
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
```

with:

```js
export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })

  const { id: locationId } = await params
  if (!locationId) return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })

  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied
  if (!hasRoleAtLocation(user, locationId, ADMIN_ROLES)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run 'src/app/api/locations/[id]/unifi-users/route.test.js'`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/locations/[id]/unifi-users/route.js' 'src/app/api/locations/[id]/unifi-users/route.test.js'
git commit -m "$(cat <<'EOF'
TRAINERSROLE.1 — unifi-users judges the role at the path location

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `unifi-doors`, the same gate

**Files:** Create `src/app/api/locations/[id]/unifi-doors/route.test.js`. Modify `src/app/api/locations/[id]/unifi-doors/route.js`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/locations/[id]/unifi-doors/route.test.js`:

```js
// TRAINERSROLE.1 — GET /api/locations/[id]/unifi-doors judges the caller's
// role AT THE PATH LOCATION, symmetric with /unifi-users (StaffForm's door
// picker calls it per assignment location too). @/lib/auth is REAL; only
// getCurrentUser is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/unifi-access', () => ({
  getUnifiConfig: vi.fn(),
  listDoors: vi.fn(),
  UnifiError: class UnifiError extends Error {},
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getUnifiConfig, listDoors } from '@/lib/unifi-access'
import { ROLE_GATE_CASES, LOC_B } from '../_role-gate-cases.js'

const call = (id) => GET({}, { params: Promise.resolve({ id }) })

function fakeDb() {
  const from = vi.fn(() => ({
    select: () => ({
      eq: (_col, id) => ({
        maybeSingle: () => Promise.resolve({ data: { id, name: 'Studio', settings: {} }, error: null }),
      }),
    }),
  }))
  return { from }
}

describe('GET unifi-doors — role judged at the path location', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = fakeDb()
    createServerClient.mockReturnValue(db)
    getUnifiConfig.mockResolvedValue({ configured: true })
    listDoors.mockResolvedValue([{ id: 'door-1', name: 'Front door' }])
  })

  it.each(ROLE_GATE_CASES)('%s → %i', async (_label, caller, target, status, error) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await call(target)
    expect(res.status).toBe(status)
    if (status === 200) {
      expect(await res.json()).toEqual({ success: true, doors: [{ id: 'door-1', name: 'Front door' }], count: 1 })
    } else {
      expect(await res.json()).toEqual({ success: false, error })
      expect(db.from).not.toHaveBeenCalled()
      expect(listDoors).not.toHaveBeenCalled()
    }
  })

  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(LOC_B)
    expect(res.status).toBe(401)
    expect(listDoors).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run 'src/app/api/locations/[id]/unifi-doors/route.test.js'`
Expected: the same 5 rows fail as in Task 1, Step 3.

- [ ] **Step 3: Fix the gate**

In `src/app/api/locations/[id]/unifi-doors/route.js`, replace lines 9-11:

```js
// Auth: master / owner / manager — same gates as /unifi-users at
// this location. Knowing which doors exist at a studio is sensitive
// enough that we don't expose it to staff.
```

with:

```js
// Auth (TRAINERSROLE.1): master, or owner/manager AT THIS LOCATION
// (ADMIN_ROLES), the same gate as /unifi-users. Knowing which doors exist
// at a studio is sensitive enough that we don't expose it to staff.
// Membership first (404), then the role judged at the PATH id with
// hasRoleAtLocation, never `user.role` (the ACTIVE studio's role).
```

Replace line 18:

```js
import { getCurrentUser } from '@/lib/auth'
```

with:

```js
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
```

Delete lines 28-30:

```js
// Mirrors the role gate on /unifi-users so the picker UX is symmetric
// — anyone who can see the user list can also see the door list.
const ALLOWED_ROLES = new Set(['master', 'owner', 'manager'])
```

Replace lines 32-48:

```js
export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })
  if (!ALLOWED_ROLES.has(user.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const { id: locationId } = await params
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })
  }

  // Master sees every location; owner/manager only their own.
  if (user.role !== 'master') {
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
```

with:

```js
export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'unauthenticated' }, { status: 401 })

  const { id: locationId } = await params
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'missing_location_id' }, { status: 400 })
  }

  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied
  if (!hasRoleAtLocation(user, locationId, ADMIN_ROLES)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run 'src/app/api/locations/[id]/unifi-doors/route.test.js'`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/locations/[id]/unifi-doors/route.js' 'src/app/api/locations/[id]/unifi-doors/route.test.js'
git commit -m "$(cat <<'EOF'
TRAINERSROLE.1 — unifi-doors judges the role at the path location

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: a guard so a `/api/locations/[id]` route cannot go back to the active-studio role

**Files:** Create `src/app/api/locations/[id]/role-at-path.test.js`.

- [ ] **Step 1: Write the guard**

Create `src/app/api/locations/[id]/role-at-path.test.js`:

```js
// TRAINERSROLE.1 — a floor, not a proof (the check:select-columns posture).
//
// Every route under src/app/api/locations/[id]/ acts on the location in its
// PATH. `user.role` is the caller's role at their ACTIVE studio
// (resolveActiveLocationRole in src/lib/auth.js), so a role check written on
// it judges the wrong studio: the SCHEDROLES.1 / LOCFIX-ROLEGATE.1 class, last
// seen here in glofox-trainers, glofox-memberships, unifi-users and
// unifi-doors. This fails if a route in this folder checks `user.role` against
// a role list or a non-master role. Judge the role at the path's id instead:
// hasRoleAtLocation(user, id, ROLES), guardMasterOrOwner(user, id), or
// user.rolesByLocation[id].
//
// ALLOWED: `user.role === 'master'` / `!== 'master'`. resolveActiveLocationRole
// answers 'master' only for a profiles.role master and rolesByLocation never
// holds 'master', so that comparison does not depend on the active studio.
// Prefer `user.isMaster` in new code.
//
// BLIND SPOTS, a reviewer's job: the role copied into a variable first
// (`const r = user.role; ROLES.includes(r)`), a role read inside a helper, a
// client component's gate, and every route OUTSIDE this folder (about 40 still
// check `user.role` against a list; see the TRAINERSROLE.1 plan, follow-up F1).

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../../scripts/lib/strip-comments.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function routeFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (entry.name === 'route.js') out.push(full)
  }
  return out
}

const ACTIVE_ROLE_IN_LIST = /\.(?:includes|has)\(\s*user\.role\s*\)/g
const ACTIVE_ROLE_EQUALS = /user\.role\s*[!=]==?\s*['"](?:owner|manager|head_coach|reception|staff)['"]/g

function activeRoleGates(source) {
  const code = stripComments(source)
  return [...code.matchAll(ACTIVE_ROLE_IN_LIST), ...code.matchAll(ACTIVE_ROLE_EQUALS)].map((m) => m[0])
}

describe('/api/locations/[id] routes judge the role at the path location', () => {
  it('catches the shape TRAINERSROLE.1 removed, and not a comment or a master check', () => {
    expect(activeRoleGates('if (!ALLOWED_ROLES.has(user.role)) {')).toEqual(['.has(user.role)'])
    expect(activeRoleGates('if (!MANAGER_ROLES.includes(user.role)) {')).toEqual(['.includes(user.role)'])
    expect(activeRoleGates("if (user.role === 'owner') {")).toEqual(["user.role === 'owner'"])
    expect(activeRoleGates('// the old ALLOWED_ROLES.has(user.role) check')).toEqual([])
    expect(activeRoleGates("const isMaster = user.role === 'master'")).toEqual([])
  })

  it('no route in this folder checks user.role against a role', () => {
    const files = routeFiles(HERE)
    expect(files.length).toBeGreaterThan(30) // 41 on 27 Sep 2026; a wrong HERE finds 0
    const offenders = files.flatMap((file) =>
      activeRoleGates(fs.readFileSync(file, 'utf8')).map((hit) => `${path.relative(HERE, file)}: ${hit}`))
    expect(offenders).toEqual([])
  })
})
```

*(Narrow-PR variant only, Decision 1: add `const KNOWN_UNFIXED = ['glofox-memberships/route.js', 'unifi-users/route.js', 'unifi-doors/route.js']` and filter `files` by it, with a comment naming the follow-up. Not used in the plan as written.)*

- [ ] **Step 2: Run it, expect PASS, then prove it bites**

Run: `npx vitest run 'src/app/api/locations/[id]/role-at-path.test.js'`
Expected: 2 passed.

To prove the second case can fail, run the same scan over `origin/main`'s copy of the folder in the scratchpad (do not touch the worktree's files):

```bash
S="$(mktemp -d)" && git archive origin/main 'src/app/api/locations' scripts/lib/strip-comments.mjs | tar -x -C "$S" && cat > "$S/scan.mjs" <<'EOF'
import fs from 'node:fs'; import path from 'node:path'
import { stripComments } from './scripts/lib/strip-comments.mjs'
const root = 'src/app/api/locations/[id]'
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name === 'route.js' ? [path.join(d, e.name)] : []))
const re = [/\.(?:includes|has)\(\s*user\.role\s*\)/, /user\.role\s*[!=]==?\s*['"](?:owner|manager|head_coach|reception|staff)['"]/]
for (const f of walk(root)) { const s = stripComments(fs.readFileSync(f, 'utf8')); if (re.some((r) => r.test(s))) console.log('HIT', f) }
EOF
(cd "$S" && node scan.mjs); rm -rf "$S"
```

Expected (checked 27 Sep 2026 against `28d02e59`), exactly four lines:

```
HIT src/app/api/locations/[id]/glofox-memberships/route.js
HIT src/app/api/locations/[id]/glofox-trainers/route.js
HIT src/app/api/locations/[id]/unifi-doors/route.js
HIT src/app/api/locations/[id]/unifi-users/route.js
```

- [ ] **Step 3: Commit**

```bash
git add 'src/app/api/locations/[id]/role-at-path.test.js'
git commit -m "$(cat <<'EOF'
TRAINERSROLE.1 — guard: no /api/locations/[id] route gates on the active studio's role

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: OpenAPI

**Files:** Modify `src/lib/openapi.js`. Only the trainers route has an entry (`:3762-3776`); the three siblings have none, and this PR does not add them.

- [ ] **Step 1: Document the gate**

At line 3769, replace the end of the description:

```js
… Powers the Trainer-names reference list in the Glofox settings tab. Master/owner/manager only.',
```

with:

```js
… Powers the Trainer-names reference list in the Glofox settings tab. Master, or owner/manager AT this location (judged at the path id, not the active studio).',
```

Replace lines 3773-3774:

```js
    400: { description: 'Glofox not configured on this location', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } },
```

with:

```js
    400: { description: 'Glofox not configured on this location', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — owner or manager at this location required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not a member of this location (indistinguishable from a missing id)', content: { 'application/json': { schema: ErrorResponse } } },
```

- [ ] **Step 2: Run it, expect PASS**

Run: `npx vitest run src/lib/openapi.test.js`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/openapi.js
git commit -m "$(cat <<'EOF'
TRAINERSROLE.1 — document the glofox-trainers role gate and 404

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### The gate (run once, at the end, in this order)

```bash
git fetch origin main && git rebase origin/main
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
npm run build
```

Expected: all twelve green, then a clean `next build`. This PR adds imports to four route files, and the build is the check that catches a wrong export name: `assertLocationAccessOr404` and `hasRoleAtLocation` come from `@/lib/auth` (`:787`, re-exported at `:1064`), `ADMIN_ROLES` from `@/lib/schemas` (`:192`). `check:location-scoping` stays green because `glofox-trainers` still scopes `class_occurrences` with `.eq('location_id', …)`, and the other three read only `locations` by id after the new `assertLocationAccessOr404`. Confirm there is no OTA with `git diff --stat origin/main -- mobile shared`, which should print nothing.

Then an independent review, then:

```bash
git push -u origin HEAD
gh pr create --base main --title "TRAINERSROLE.1 — the location lookup routes judge the role at the location in the path" --body-file <scratchpad>/trainersrole-pr.md
```

**PR title:** `TRAINERSROLE.1 — the location lookup routes judge the role at the location in the path`

**PR body points:**
- **Why:** `GET /api/locations/[id]/glofox-trainers` checked `ALLOWED_ROLES.has(user.role)`, which is the caller's role at their ACTIVE studio, and then only checked membership of the path's studio. So a manager at A who is staff at B could read B's list from an A session, and a manager was refused at their own studio while another was active (the SCHEDROLES.1 class). `glofox-memberships`, `unifi-users` and `unifi-doors` had the same gate line for line. `unifi-users` returns every UniFi Access user at a studio's controller (names, emails, employee numbers), and `StaffForm` calls it once per studio a staff member is assigned to, whichever studio is active.
- **What:** all four now check membership first with `assertLocationAccessOr404` (a non-member gets 404, not 403), then `hasRoleAtLocation(user, id, ADMIN_ROLES)` (master, or owner/manager AT the path id). It is the same tier as before, and the same one the Glofox credentials write uses. Head coaches are still refused. A refused caller reaches no Glofox, UniFi or database read.
- **Tests:** a shared table of seven mixed-role callers (`_role-gate-cases.js`) runs against every route. Five rows gave the wrong answer on main. A payload characterisation test covers glofox-trainers. A source-scan guard (`role-at-path.test.js`) fails if a `/api/locations/[id]` route checks `user.role` against a role again. It is a floor, not a proof.
- The stale "~850 rows" comment in glofox-trainers now says about 190 (191 counted live on 27 Sep). The capped read is unchanged.
- **Behaviour changes:**
  - a mixed-role caller now gets the answer for the studio in the path;
  - an outsider gets `404 {error:'Not found'}` instead of `403 {error:'forbidden'}`;
  - a master asking for an inactive location now gets 404, which matches the settings page.
- **Checked and unchanged:** the other 37 `/api/locations/[id]` routes already judge at the path id, or need no role check (xero membership-only by design; `user.role === 'master'` isn't this bug).
- **No migration. No OTA.**
- **Found, out of scope:** about 40 routes outside `/api/locations` in the same class, the Integrations tab's client-side `canEdit`, and `unifi-doors`' discarded location-read error. Listed as follow-ups in the plan.
- Last line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

**CHANGELOG row** (add it once the PR number exists, as the first row under the `| # / PR | Item | Notes |` header in `docs/CHANGELOG.md`, and commit it to the branch. Never edit it after it reaches main: the file is `merge=union`):

```
| #<PR> | TRAINERSROLE.1 — the location lookup routes judge the role at the location in the path | 2026-09-<dd>. No migration, **no OTA**. `GET /api/locations/[id]/glofox-trainers`, `glofox-memberships`, `unifi-users` and `unifi-doors` checked `ALLOWED_ROLES.has(user.role)` (the ACTIVE studio's role) and then only membership of the path's studio, so a manager at A who is staff at B read B's trainer list, membership catalogue, UniFi user list (names, emails, employee numbers; `StaffForm` calls it per assignment studio) and door list, and a manager was refused at their own studio while another was active. All four: `assertLocationAccessOr404` (non-member 404, was 403), then `hasRoleAtLocation(user, id, ADMIN_ROLES)` (same tier as before, and the Glofox credentials write's). Shared mixed-role case table `src/app/api/locations/[id]/_role-gate-cases.js` (five of seven rows wrong on main); guard `src/app/api/locations/[id]/role-at-path.test.js` (no `user.role` role check in that folder). glofox-trainers' "~850 rows" comment → about 190 (191 live, 27 Sep). Found, not fixed: ~40 routes outside `/api/locations` in the same class (plan F1). |
```

---

### Review notes / open questions (for the owner)

1. **Scope went from one route to four** (Decision 1). The index row names only glofox-trainers, but the three siblings have the identical gate and `unifi-users` is the more sensitive one. If you want this PR to stay one route, the plan says how to split it without changes to the code.
2. **Managers keep API access at their own studio** (Decision 2). The settings page that shows the trainer list admits only master/owner-at-target (`page.js:78`), and only owners can save names (RLS `locations_upd`). So "who should read the list" could reasonably be owner-only (`guardMasterOrOwner`). The plan keeps today's tier (ADMIN_ROLES) because that is also the Glofox credentials write tier, and narrowing is a product call. Say if you want owner-only.
3. **A master and an inactive location:** a master asking for an inactive location now gets 404 where it used to get an answer (Decision 7). Nothing in the UI reaches an inactive location's settings (the page 404s first).
4. **The error body for an outsider changes** from `{ error:'forbidden' }` (403) to `{ error:'Not found' }` (404). `StaffForm`'s pickers show `json.message || json.error`, so an outsider would now see "Not found" in the picker. The UI can't reach that case, because the staff form only lists the target's assignments at studios the editor can open.

**Found, out of scope (proposed follow-ups):**

- **F1: the same class outside `/api/locations` (M, maybe L).** These routes check `MANAGER_ROLES`/`ADMIN_ROLES`/`CHALLENGE_ADMIN_ROLES.includes(user.role)` and then act on a location taken from a row, the body or the query.
  - **Read and confirmed (the SCHEDROLES shape):**
    - `automations/[key]/route.js:20` (then `body.location_id`, `:33`);
    - `orders/[id]/route.js:42` (then the row's `location_id`, `:58`);
    - `contacts/[id]/export/route.js:29` (row, `:42`);
    - `sequences/[id]/test/route.js:37` (row, `:53`);
    - `races/route.js:60, 101` (query `location_id`, `:68`);
    - `challenges/route.js:38` (query `:46`, body `:62`).
  - **Same token shape, grep-classified but not read.** Each needs a per-route read:
    - automations `[key]/backfill:22,42`, `history:20`, `run-now:36`, `schedule:18`;
    - orders `[id]/cancel:42`, `[id]/refund:124`;
    - sequences `[id]/runs:17`, `stats:35`, `audience/seed:74,171`;
    - races `[id]:77,99,219`, `[id]/teams:44,81`;
    - challenges `[id]:30`;
    - events `[id]:115,175,338` and `events/route.js:161,251`;
    - `whatsapp/templates/[id]/resubmit:33`;
    - contacts `imports/[id]:19`, `imports/[id]/error-csv:27`, `[id]/marketing-preferences:99`, `[id]/route.js:227`, `[id]/push-to-glofox:34`, `[id]/devices:83`, `[id]/devices/[deviceId]:32,63`, `[id]/invite-app:45`, `[id]/impact:23`, `bulk-delete:49`;
    - `campaigns/[id]/send-test:44`;
    - `segments:43`;
    - settings `class-categories:22,45`, `scoring:86`;
    - `admin/password-override:87`;
    - registrations `[id]/cancel:15`, `[id]/payment-sms:52`;
    - `live/sessions/[id]/end:37`;
    - bookings `[id]/cancel:36`, `event-types/[id]/reminders:61,91`;
    - `agent/knowledge/[id]:36,66`;
    - `staff/[id]/send-password-reset:38`.
  - **Probably consistent** (they act on `user.activeLocation`, so the active role is the right role): `orders/route.js`, `communications/events`, `settings/customer-agent`, `agent/knowledge`, `agent/analytics`, `agent/knowledge/import-classes`, `agent/membership-requests`, `contacts/membership-plans`, `contacts/imports`, `promo-codes/*`, `events/[id]/review`, `settings/api-keys/*`, `settings/org-usage`.
  - **Separate, org-scoped:** `hosts/**`.
  - **Suggested approach:** a SCHEDROLES-style sweep, domain by domain, with this plan's case-table pattern. Its guard would be this PR's scan widened to `src/app/api` with a dated baseline allowlist.
- **F2: the Integrations tab's client gate (S).** `src/components/settings/LocationIntegrations.jsx:46-47` computes `isOwnerOrMaster` from `user.role`, the active studio's role. The page already requires master or owner **at the target** (`page.js:78`), so this can only over-block: an owner of Hatch who has Stillorgan active, where they are a manager, sees "Only owners + masters can edit Glofox credentials" and loses the owner-only tabs (Xero, Payments, Twilio, WhatsApp, Ads, AC, BCA) at a studio they own. The fix is `hasRoleAtLocation(user, location.id, ['owner'])` from the client-safe `@/lib/role-at-location` (ROSTERROLE.1's module). It touches every integration tab's visibility, so it deserves its own PR and a browser check.
- **F3: `unifi-doors` discards its location-read error (S).** `const { data: location } = await db…maybeSingle()` (`unifi-doors/route.js:51-55`) turns a failed read into `404 location_not_found`. Destructure `error` and answer 500, the way `unifi-users:52-59` nearly does (it folds the error into the same 404; fix both).
- **F4: the siblings have no OpenAPI entries.** `glofox-memberships`, `unifi-users` and `unifi-doors` aren't in `src/lib/openapi.js`. Add them in a docs sweep if wanted.
- **Size:** six small tasks, each a ten-line gate swap plus a test that reuses the shared table. Still S.
