# WIDGET.1 Phase 1 — Widget Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and ship the server side of the staff iPhone home-screen widgets — a revocable per-device widget token, a narrow opt-in that lets exactly six routes accept it, and the two data endpoints the widgets read — as a normal web PR that merges and deploys on its own.

**Architecture:** A widget token is a fourth auth source, deliberately *not* wired into `getCurrentUser()`. `withAuth` gains an `allowWidgetToken` option; only routes that declare it ever call `getWidgetUser()`, so every other route on the estate rejects a widget token by construction. The widget user object is assembled to the same shape `getCurrentUser()` returns for one location, so `hasPermission()` and `hasPermissionForLocation()` are the *same* functions doing the *same* resolution — including the operator-edited role template, which is extracted into a shared helper rather than copied.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role routes), Zod, vitest.

---

## Scope note — why this is Phase 1 of two

The WIDGET.1 spec covers two subsystems: this backend, and the native
WidgetKit extension (Swift, `@bacons/apple-targets`, App Group, the two-build
release). They are not independent — the native half depends on every endpoint
here — so they are sequenced, not parallel.

They are separate **plans** because Phase 1 is fully specified from code that
exists and is fully testable with `npm test`, while Phase 2's task-level detail
depends on facts nobody here has verified yet: the exact config shape
`@bacons/apple-targets@5.0.0` expects, and how EAS credentials behave when an
App Group is added to two bundle IDs. Writing "complete code with no
placeholders" for those today would mean inventing API surface. **Task 15 is
the spike that produces Phase 2.**

Phase 1 ships nothing user-visible. That is intended: it merges early, deploys
on its own, and de-risks the native release by making every endpoint real and
tested before any Swift is written.

---

## File Structure

**New files**

| File | Responsibility |
| --- | --- |
| `supabase/migrations/607_widget_tokens.sql` | The `widget_tokens` table, deny-all RLS, table-level REVOKE |
| `src/lib/widget-token.js` | Pure: mint, hash, parse a widget bearer. No IO. |
| `src/lib/widget-token.test.js` | Tests for the above |
| `src/lib/widget-auth.js` | `getWidgetUser(db, request)` — token to user object |
| `src/lib/widget-auth.test.js` | Tests for the above |
| `src/lib/role-templates.js` | `loadRoleTemplatesForLocations()`, extracted from `auth.js` so both auth paths share one implementation |
| `src/lib/role-templates.test.js` | Tests for the above |
| `src/app/api/widget/devices/route.js` | `GET` — the controllable devices at a studio, for the config picker |
| `src/app/api/widget/devices/route.test.js` | Tests |
| `src/app/api/widget/tokens/route.js` | `GET` list, `POST` mint |
| `src/app/api/widget/tokens/route.test.js` | Tests |
| `src/app/api/widget/tokens/[id]/route.js` | `DELETE` revoke |
| `src/app/api/widget/tokens/[id]/route.test.js` | Tests |
| `src/app/api/widget-optin.test.js` | Pins the opt-in set |
| `src/components/WidgetTokensCard.jsx` | Staff-detail card listing a person's widgets with a Revoke button |

**Modified files**

| File | Change |
| --- | --- |
| `src/lib/with-auth.js` | New `allowWidgetToken` option; default-deny |
| `src/lib/with-auth.test.js` | Coverage for the option |
| `src/lib/auth.js:553-587` | Call the extracted `loadRoleTemplatesForLocations()` |
| `src/lib/home-queue.js:445-461` | New `getHomeQueueCounts()`; `getHomeQueueCount()` delegates |
| `src/lib/home-queue.test.js` | Coverage for `bySource` |
| `src/app/api/home-queue/count/route.js` | Return `bySource`; opt in |
| `src/app/api/sonos/control/route.js` | Migrate legacy preamble to `withAuth`; opt in |
| `src/app/api/studio-management/unlock/route.js` | Migrate legacy preamble; opt in; audit attribution |
| `src/app/api/shelly/devices/[id]/toggle/route.js:147` | Opt in |
| `src/app/api/studio-management/ac/devices/[id]/turn-on/route.js:16` | Opt in |
| `src/app/api/studio-management/ac/devices/[id]/turn-off/route.js` | Opt in |
| `src/app/settings/staff/[id]/page.js:149` | Mount `WidgetTokensCard` |
| `src/lib/openapi.js` | Register the three new routes |
| `docs/CHANGELOG.md` | One row |

**Two routes are not what you expect.** `sonos/control` and
`studio-management/unlock` still open with the legacy five-line
`getCurrentUser()` preamble — they were never migrated to `withAuth`. The
opt-in cannot be dropped into them; they get a behaviour-preserving migration
first (Tasks 8 and 9). `shelly/.../toggle` and both AC routes are already on
`withAuth` and take a one-line change.

---

## Task 1: The `widget_tokens` table

**Files:**
- Create: `supabase/migrations/607_widget_tokens.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 607 — WIDGET.1. Per-device credential for the iOS home-screen widgets.
--
-- A widget runs in a separate extension process and must NOT share the
-- Supabase session: both clients default to the same SecureStore key, so a
-- refresh from the extension rotates the refresh token out from under the
-- app and signs the staff member out. That failure already happened once
-- during the one-app merge. This table is the alternative — a credential
-- that is minted by the app, scoped to ONE location, revocable on its own,
-- and structurally incapable of touching the Supabase refresh lane.
--
-- Only the raw token's sha256 is stored. The plaintext is returned exactly
-- once, at mint time, and lives thereafter only in the device's App Group.

create table if not exists public.widget_tokens (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id)  on delete cascade,
  location_id  uuid not null references public.locations(id) on delete cascade,
  token_hash   text not null unique,
  device_label text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- The hot path is "hash to live row"; the unique index on token_hash serves
-- it. This one serves the revocation UI ("what does this person hold?").
create index if not exists widget_tokens_profile_live_idx
  on public.widget_tokens (profile_id)
  where revoked_at is null;

alter table public.widget_tokens enable row level security;

-- Deliberately NO policies: RLS with zero permissive policies denies
-- authenticated and anon outright, and service_role bypasses RLS, so every
-- legitimate read goes through an /api route. The REVOKE is the second half
-- of that fence — a table-level GRANT is what makes a column-level revoke a
-- no-op (mig 153/153b), so revoke the table, not columns.
revoke all on public.widget_tokens from anon, authenticated;

comment on table public.widget_tokens is
  'WIDGET.1 — per-device iOS widget credentials. Service-role access only.';
```

- [ ] **Step 2: Apply it via Supabase MCP**

Apply against project `iyvtbjjxdggiadzwwvdj` (un1t-crm — confirm with
`list_projects`; the sentinel project `tpttqakxmyxrwnqjepfm` is a different
database). Use `apply_migration` with name `607_widget_tokens`.

- [ ] **Step 3: Run the security advisors**

Run `get_advisors` with `type: security`.
Expected: no new ERROR or WARN naming `widget_tokens`. If one appears, fix it
before continuing — a new table with an advisor finding is how RLS gaps ship.

- [ ] **Step 4: Verify the grants actually landed**

The migration text is not evidence; `information_schema` is. Run via
`execute_sql`:

```sql
select grantee, privilege_type
from information_schema.table_privileges
where table_name = 'widget_tokens' and grantee in ('anon','authenticated');
```

Expected: **zero rows**.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/607_widget_tokens.sql
git commit -m "WIDGET.1 — mig 607: widget_tokens table, service-role only"
```

---

## Task 2: Pure token helpers

**Files:**
- Create: `src/lib/widget-token.js`
- Test: `src/lib/widget-token.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/widget-token.test.js
// WIDGET.1 — pure token helpers. No IO, no db; these are the only place the
// token's shape is decided.

import { describe, it, expect } from 'vitest'
import {
  WIDGET_TOKEN_PREFIX, generateWidgetToken, hashWidgetToken, parseWidgetBearer,
} from './widget-token'

describe('generateWidgetToken', () => {
  it('mints a prefixed token', () => {
    expect(generateWidgetToken().startsWith(WIDGET_TOKEN_PREFIX)).toBe(true)
  })

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateWidgetToken()))
    expect(seen.size).toBe(200)
  })
})

describe('hashWidgetToken', () => {
  it('is stable for the same token', () => {
    const t = generateWidgetToken()
    expect(hashWidgetToken(t)).toBe(hashWidgetToken(t))
  })

  it('differs between tokens', () => {
    expect(hashWidgetToken(generateWidgetToken()))
      .not.toBe(hashWidgetToken(generateWidgetToken()))
  })

  it('returns a 64-char hex digest', () => {
    expect(hashWidgetToken(generateWidgetToken())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses anything without the prefix', () => {
    // A Supabase JWT must never hash to a lookup key — that is what keeps
    // the two credential families from ever being confused for each other.
    expect(hashWidgetToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y')).toBe(null)
    expect(hashWidgetToken('')).toBe(null)
    expect(hashWidgetToken(null)).toBe(null)
    expect(hashWidgetToken(undefined)).toBe(null)
    expect(hashWidgetToken(12345)).toBe(null)
  })
})

describe('parseWidgetBearer', () => {
  it('extracts a widget token', () => {
    const t = generateWidgetToken()
    expect(parseWidgetBearer(`Bearer ${t}`)).toBe(t)
  })

  it('is case-insensitive on the scheme and tolerates padding', () => {
    const t = generateWidgetToken()
    expect(parseWidgetBearer(`  bearer   ${t}  `)).toBe(t)
  })

  it('ignores a Supabase JWT', () => {
    expect(parseWidgetBearer('Bearer eyJhbGciOiJIUzI1NiJ9.a.b')).toBe(null)
  })

  it('ignores junk', () => {
    expect(parseWidgetBearer('Basic abc')).toBe(null)
    expect(parseWidgetBearer('Bearer')).toBe(null)
    expect(parseWidgetBearer(null)).toBe(null)
    expect(parseWidgetBearer(undefined)).toBe(null)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/lib/widget-token.test.js`
Expected: FAIL — `Failed to resolve import "./widget-token"`.

- [ ] **Step 3: Write the implementation**

```js
// src/lib/widget-token.js
// WIDGET.1 — the widget credential's shape, in one place.
//
// The `rwt_` prefix is load-bearing, not cosmetic. It is what lets
// parseWidgetBearer tell a widget token from a Supabase JWT on the SAME
// Authorization header, so a widget token presented to a route that did not
// opt in falls through to normal JWT verification and 401s, rather than
// being mistaken for a session.

import { createHash, randomBytes } from 'node:crypto'

export const WIDGET_TOKEN_PREFIX = 'rwt_'

const BEARER_RE = /^Bearer\s+(\S+)$/i

/** Mint a new plaintext token. Returned to the device ONCE and never stored. */
export function generateWidgetToken() {
  return WIDGET_TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

/**
 * sha256 of a widget token, or null if it is not one.
 * Plain sha256 with no salt is correct here: the input is 256 bits of CSPRNG
 * output, so there is no dictionary to stretch against — this is a lookup
 * key, not a password hash.
 */
export function hashWidgetToken(token) {
  if (typeof token !== 'string') return null
  if (!token.startsWith(WIDGET_TOKEN_PREFIX)) return null
  if (token.length <= WIDGET_TOKEN_PREFIX.length) return null
  return createHash('sha256').update(token).digest('hex')
}

/** Pull a widget token out of an Authorization header. Null for anything else. */
export function parseWidgetBearer(header) {
  if (typeof header !== 'string') return null
  const m = header.trim().match(BEARER_RE)
  if (!m) return null
  return m[1].startsWith(WIDGET_TOKEN_PREFIX) ? m[1] : null
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/widget-token.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/widget-token.js src/lib/widget-token.test.js
git commit -m "WIDGET.1 — pure widget-token helpers (mint, hash, parse)"
```

---

## Task 3: Extract role-template loading out of `auth.js`

`getWidgetUser` must resolve permissions **identically** to `getCurrentUser`,
and that includes the operator-edited role template (mig 364/367). Copying
that block would create two implementations that drift — and the drift would
be silent and in the permissive direction: a template that *removes* a
permission would keep applying in the app and stop applying in the widget.
Extract it once, call it twice.

**Files:**
- Create: `src/lib/role-templates.js`
- Test: `src/lib/role-templates.test.js`
- Modify: `src/lib/auth.js:553-587`

- [ ] **Step 1: Read the block you are extracting**

Run: `sed -n 540,592p src/lib/auth.js`
You are moving the `roleTemplatesByLocation` / `acDeviceTemplatesByLocation`
loop verbatim. `mergeTemplates` is already defined in `auth.js` — move it too
and re-import it there.

- [ ] **Step 2: Write the failing test**

```js
// src/lib/role-templates.test.js
// WIDGET.1 — extracted from auth.js so getCurrentUser and getWidgetUser
// resolve role templates through ONE implementation.

import { describe, it, expect, vi } from 'vitest'
import { loadRoleTemplatesForLocations } from './role-templates'

const LOC = 'loc-1'

function dbWith(rows, { throws = false } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn(async () => {
          if (throws) throw new Error('boom')
          return { data: rows, error: null }
        }),
      })),
    })),
  }
}

describe('loadRoleTemplatesForLocations', () => {
  it('returns empty maps for a master (templates cannot change what master sees)', async () => {
    const db = dbWith([])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: true, rolesByLocation: { [LOC]: 'owner' }, employmentType: 'fte',
    })
    expect(out).toEqual({ roleTemplatesByLocation: {}, acDeviceTemplatesByLocation: {} })
    expect(db.from).not.toHaveBeenCalled()
  })

  it('returns empty maps when there are no locations', async () => {
    const db = dbWith([])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: {}, employmentType: null,
    })
    expect(out.roleTemplatesByLocation).toEqual({})
    expect(db.from).not.toHaveBeenCalled()
  })

  it('applies the "all" row for the role held at that location', async () => {
    const db = dbWith([
      { location_id: LOC, role: 'staff', employment_type: 'all', permissions: { pipeline: false }, ac_device_ids: null },
      { location_id: LOC, role: 'owner', employment_type: 'all', permissions: { pipeline: true }, ac_device_ids: null },
    ])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: { [LOC]: 'staff' }, employmentType: null,
    })
    expect(out.roleTemplatesByLocation[LOC]).toEqual({ pipeline: false })
  })

  it('layers the employment-type variant on top of "all"', async () => {
    const db = dbWith([
      { location_id: LOC, role: 'staff', employment_type: 'all', permissions: { pipeline: false, tasks: false }, ac_device_ids: null },
      { location_id: LOC, role: 'staff', employment_type: 'fte', permissions: { tasks: true }, ac_device_ids: null },
    ])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: { [LOC]: 'staff' }, employmentType: 'fte',
    })
    expect(out.roleTemplatesByLocation[LOC]).toEqual({ pipeline: false, tasks: true })
  })

  it('takes the variant ac_device_ids when set, else the "all" row', async () => {
    const db = dbWith([
      { location_id: LOC, role: 'staff', employment_type: 'all', permissions: null, ac_device_ids: ['a'] },
      { location_id: LOC, role: 'staff', employment_type: 'fte', permissions: null, ac_device_ids: ['b'] },
    ])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: { [LOC]: 'staff' }, employmentType: 'fte',
    })
    expect(out.acDeviceTemplatesByLocation[LOC]).toEqual(['b'])
  })

  it('DEEP-merges the mobile sub-object rather than clobbering it', async () => {
    // The bug this guards: a flat spread drops whatsapp:false, so a permission
    // the operator explicitly removed silently returns as a code default.
    const db = dbWith([
      { location_id: LOC, role: 'staff', employment_type: 'all', permissions: { pipeline: false, mobile: { whatsapp: false, schedule: true } }, ac_device_ids: null },
      { location_id: LOC, role: 'staff', employment_type: 'fte', permissions: { mobile: { tv_displays: true } }, ac_device_ids: null },
    ])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: { [LOC]: 'staff' }, employmentType: 'fte',
    })
    expect(out.roleTemplatesByLocation[LOC]).toEqual({
      pipeline: false,
      mobile: { whatsapp: false, schedule: true, tv_displays: true },
    })
  })

  it('degrades to empty maps when the fetch throws, rather than failing the request', async () => {
    const db = dbWith(null, { throws: true })
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: { [LOC]: 'staff' }, employmentType: null,
    })
    expect(out).toEqual({ roleTemplatesByLocation: {}, acDeviceTemplatesByLocation: {} })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/role-templates.test.js`
Expected: FAIL — `Failed to resolve import "./role-templates"`.

- [ ] **Step 4: Write the module**

Move `mergeTemplates` out of `auth.js` into this file and export it. The body
below is the `auth.js` loop with `profile.employment_type` becoming the
`employmentType` argument and `isMaster` becoming an argument — no other
behaviour change.

```js
// src/lib/role-templates.js
// WIDGET.1 — extracted from getCurrentUser (auth.js) so that every auth
// source resolves operator-edited role templates through one implementation.
// A second copy would drift silently and in the PERMISSIVE direction: a
// template that removes a permission would keep applying on one path and
// stop applying on the other.
//
// RECEPTION.2 (mig 367): a template can carry employment-type variants — an
// 'all' row applies to every user of the role, and an 'fte'/'contractor'/
// 'casual' row layers on top. Merged here so consumers see ONE blob.

// mergeTemplates is NOT redefined here. It lives in shared/permissions.js and
// is the canonical merge for eight call sites; it strips `mobile`, spreads the
// rest, then DEEP-merges the mobile sub-objects. A flat spread would let a
// variant's mobile blob clobber the base's, so a permission an operator
// explicitly removed would come back as a code default — the exact permissive
// drift this extraction exists to prevent.
import { mergeTemplates } from '@shared/permissions'

/**
 * @param {object} db  service-role supabase client
 * @param {object} args
 * @param {boolean} args.isMaster
 * @param {Record<string,string>} args.rolesByLocation  { [location_id]: role }
 * @param {string|null} args.employmentType             profiles.employment_type
 * @returns {Promise<{roleTemplatesByLocation: object, acDeviceTemplatesByLocation: object}>}
 */
export async function loadRoleTemplatesForLocations(db, { isMaster, rolesByLocation, employmentType }) {
  const roleTemplatesByLocation = {}
  const acDeviceTemplatesByLocation = {}

  // Master skips the fetch entirely — the resolver short-circuits master
  // past tiers 2/2.5/3, so a template can never change what a master sees.
  if (isMaster) return { roleTemplatesByLocation, acDeviceTemplatesByLocation }

  const templateLocationIds = Object.keys(rolesByLocation || {})
  if (templateLocationIds.length === 0) {
    return { roleTemplatesByLocation, acDeviceTemplatesByLocation }
  }

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
        employmentType ? rowFor(locId, employmentType) : null
      )
      if (merged) roleTemplatesByLocation[locId] = merged

      // AC-ROLE.1 — variant wins if non-null, else the 'all' row, else inherit.
      const allRow = findRow(locId, 'all')
      const varRow = employmentType ? findRow(locId, employmentType) : null
      const acList = Array.isArray(varRow?.ac_device_ids)
        ? varRow.ac_device_ids
        : (Array.isArray(allRow?.ac_device_ids) ? allRow.ac_device_ids : null)
      if (acList !== null) acDeviceTemplatesByLocation[locId] = acList
    }
  } catch {
    // Defensive, preserved from auth.js VERBATIM: the original catch is empty
    // and falls through, returning whatever accumulated before the throw.
    // Returning fresh empty maps here would discard partial accumulation —
    // a behaviour change, however unreachable.
  }

  return { roleTemplatesByLocation, acDeviceTemplatesByLocation }
}
```

- [ ] **Step 5: Run the new tests**

Run: `npx vitest run src/lib/role-templates.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Rewire `auth.js` to call it**

Replace lines 553-587 of `src/lib/auth.js` (the `const roleTemplatesByLocation = {}`
declaration through the closing `}` of the `if (!isMaster)` block) with:

```js
  const { roleTemplatesByLocation, acDeviceTemplatesByLocation } =
    await loadRoleTemplatesForLocations(db, {
      isMaster,
      rolesByLocation,
      employmentType: profile.employment_type || null,
    })
```

Add the import at the top of `auth.js`:

```js
import { loadRoleTemplatesForLocations } from './role-templates.js'
```

Remove the now-unused `mergeTemplates` import at `auth.js:6` — line 568 was its
only use, and lint will flag it otherwise. Do NOT delete it from
`shared/permissions.js`: seven other call sites import it from there.

- [ ] **Step 7: Prove nothing changed for the existing auth path**

Run: `npx vitest run src/lib/auth.test.js src/lib/permissions.test.js`
Expected: PASS with the same counts as before the change. If `auth.test.js`
does not exist, run the full suite instead: `npm test` — expected PASS.

- [ ] **Step 8: Verify the build still resolves**

Run: `npm run build`
Expected: exits 0. This is the only check that catches an import-resolution
break; the mocked test suite will not.

- [ ] **Step 9: Commit**

```bash
git add src/lib/role-templates.js src/lib/role-templates.test.js src/lib/auth.js
git commit -m "WIDGET.1 — extract loadRoleTemplatesForLocations from auth.js

Behaviour-preserving. getWidgetUser needs the same template resolution
getCurrentUser does; a second copy would drift in the permissive direction."
```

---

## Task 4: `getWidgetUser`

**Files:**
- Create: `src/lib/widget-auth.js`
- Test: `src/lib/widget-auth.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/widget-auth.test.js
// WIDGET.1 — token to user object. The shape it returns is the contract:
// hasPermission() and hasPermissionForLocation() must work on it unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/role-templates', () => ({
  loadRoleTemplatesForLocations: vi.fn(async () => ({
    roleTemplatesByLocation: {}, acDeviceTemplatesByLocation: {},
  })),
}))

import { getWidgetUser } from './widget-auth'
import { generateWidgetToken, hashWidgetToken } from './widget-token'
import { loadRoleTemplatesForLocations } from '@/lib/role-templates'

const LOC = 'loc-1'
const PROFILE = 'prof-1'

const TOKEN = generateWidgetToken()
const HASH = hashWidgetToken(TOKEN)

const requestWith = (auth) => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } })

/**
 * Minimal table-router db double. Each table returns a terminal thenable so
 * the builder chain resolves the way supabase-js does.
 */
function makeDb(tables) {
  const update = vi.fn(() => ({ eq: vi.fn(() => ({ then: (res) => res({ error: null }) })) }))
  const db = {
    _update: update,
    from: vi.fn((table) => {
      const rows = tables[table]
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        is: vi.fn(() => chain),
        maybeSingle: async () => rows ?? { data: null, error: null },
        update,
      }
      return chain
    }),
  }
  return db
}

const okTables = (over = {}) => ({
  widget_tokens: { data: { id: 'tok-1', profile_id: PROFILE, location_id: LOC, revoked_at: null }, error: null },
  profiles: { data: { id: PROFILE, email: 'a@b.c', full_name: 'A B', role: 'manager', employment_type: 'fte' }, error: null },
  profile_locations: { data: { location_id: LOC, role: 'manager', permissions: { device_control: true } }, error: null },
  locations: { data: { id: LOC, name: 'Stillorgan', features: { sonos: true } }, error: null },
  ...over,
})

beforeEach(() => { vi.clearAllMocks() })

describe('getWidgetUser', () => {
  it('returns null when there is no Authorization header', async () => {
    expect(await getWidgetUser(makeDb(okTables()), requestWith(null))).toBe(null)
  })

  it('returns null for a Supabase JWT (not a widget token)', async () => {
    const db = makeDb(okTables())
    expect(await getWidgetUser(db, requestWith('Bearer eyJhbGciOiJIUzI1NiJ9.a.b'))).toBe(null)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('returns null when the token has no live row', async () => {
    const db = makeDb(okTables({ widget_tokens: { data: null, error: null } }))
    expect(await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))).toBe(null)
  })

  it('returns null when the profile is gone', async () => {
    const db = makeDb(okTables({ profiles: { data: null, error: null } }))
    expect(await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))).toBe(null)
  })

  it('returns null when the person no longer holds an assignment at that location', async () => {
    // The revocation path that needs no revocation: remove someone from a
    // studio and their widget for it stops working on the next tap.
    const db = makeDb(okTables({ profile_locations: { data: null, error: null } }))
    expect(await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))).toBe(null)
  })

  it('builds a user whose activeLocation is the TOKEN location', async () => {
    const u = await getWidgetUser(makeDb(okTables()), requestWith(`Bearer ${TOKEN}`))
    expect(u.activeLocation).toEqual({ id: LOC, name: 'Stillorgan', features: { sonos: true } })
    expect(u.id).toBe(PROFILE)
  })

  it('stamps authSource so withAuth can default-deny', async () => {
    const u = await getWidgetUser(makeDb(okTables()), requestWith(`Bearer ${TOKEN}`))
    expect(u.authSource).toBe('widget')
    expect(u.widgetTokenId).toBe('tok-1')
  })

  it('populates the shape hasPermissionForLocation reads', async () => {
    const u = await getWidgetUser(makeDb(okTables()), requestWith(`Bearer ${TOKEN}`))
    expect(u.assignmentsByLocation[LOC]).toEqual({ location_id: LOC, role: 'manager', permissions: { device_control: true } })
    expect(u.rolesByLocation).toEqual({ [LOC]: 'manager' })
    expect(u.locations).toEqual([{ id: LOC, name: 'Stillorgan', features: { sonos: true } }])
    expect(u.role).toBe('manager')
  })

  it('resolves role templates through the shared loader', async () => {
    loadRoleTemplatesForLocations.mockResolvedValueOnce({
      roleTemplatesByLocation: { [LOC]: { device_control: false } },
      acDeviceTemplatesByLocation: {},
    })
    const u = await getWidgetUser(makeDb(okTables()), requestWith(`Bearer ${TOKEN}`))
    expect(u.roleTemplatesByLocation[LOC]).toEqual({ device_control: false })
    expect(u.activeRoleTemplate).toEqual({ device_control: false })
  })

  it('never reports master, whatever the profile row says', async () => {
    // A widget token is location-scoped by construction. Granting it the
    // master bypass would let a lost phone act estate-wide.
    const db = makeDb(okTables({
      profiles: { data: { id: PROFILE, email: 'm@b.c', full_name: 'M', role: 'master', employment_type: null }, error: null },
    }))
    const u = await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))
    expect(u.isMaster).toBe(false)
    expect(u.role).toBe('manager')      // the assignment's role, not 'master'
    expect(u.profileRole).toBe('master')
  })

  it('touches last_used_at without blocking the result', async () => {
    const db = makeDb(okTables())
    const u = await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))
    expect(u).not.toBe(null)
    expect(db._update).toHaveBeenCalledWith(expect.objectContaining({ last_used_at: expect.any(String) }))
  })

  it('looks the token up by HASH, never by plaintext', async () => {
    const db = makeDb(okTables())
    await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))
    const chain = db.from.mock.results[0].value
    expect(chain.eq).toHaveBeenCalledWith('token_hash', HASH)
    const passed = chain.eq.mock.calls.flat()
    expect(passed).not.toContain(TOKEN)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/widget-auth.test.js`
Expected: FAIL — `Failed to resolve import "./widget-auth"`.

- [ ] **Step 3: Write the implementation**

```js
// src/lib/widget-auth.js
// WIDGET.1 — the fourth auth source, deliberately NOT wired into
// getCurrentUser().
//
// getCurrentUser() is called directly by well over a hundred routes that
// never opted into anything. Adding a widget source there would hand a
// stolen phone the whole estate. Instead this function is called ONLY by
// withAuth when a route declares `allowWidgetToken: true`, so the default
// for every other route is denial by construction rather than by review.
//
// What it returns is a user object shaped like getCurrentUser()'s, narrowed
// to the single location the token is scoped to — so hasPermission() and
// hasPermissionForLocation() run unchanged against it. That sameness is the
// point: there is one permission resolver, not a widget-flavoured copy.

import { parseWidgetBearer, hashWidgetToken } from './widget-token.js'
import { loadRoleTemplatesForLocations } from './role-templates.js'
import { logWarn } from './log.js'

export async function getWidgetUser(db, request) {
  const token = parseWidgetBearer(request?.headers?.get?.('authorization'))
  if (!token) return null
  const tokenHash = hashWidgetToken(token)
  if (!tokenHash) return null

  const { data: row, error: rowErr } = await db
    .from('widget_tokens')
    .select('id, profile_id, location_id, revoked_at')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .maybeSingle()
  if (rowErr || !row) return null

  const { data: profile, error: profileErr } = await db
    .from('profiles')
    .select('id, email, full_name, role, employment_type')
    .eq('id', row.profile_id)
    .maybeSingle()
  if (profileErr || !profile) return null

  // The assignment is the authorisation, and its absence is a revocation
  // nobody had to perform: take someone off a studio and their widget for
  // it stops working on the next tap.
  const { data: assignment, error: assignErr } = await db
    .from('profile_locations')
    .select('location_id, role, permissions')
    .eq('profile_id', row.profile_id)
    .eq('location_id', row.location_id)
    .maybeSingle()
  if (assignErr || !assignment) return null

  // `features` is not optional — resolvePermission reads location.features
  // as its tier-1 gate, so a location object without it silently changes
  // what resolves.
  const { data: location } = await db
    .from('locations')
    .select('id, name, features')
    .eq('id', row.location_id)
    .maybeSingle()
  if (!location) return null

  const rolesByLocation = { [row.location_id]: assignment.role }
  const { roleTemplatesByLocation, acDeviceTemplatesByLocation } =
    await loadRoleTemplatesForLocations(db, {
      isMaster: false,
      rolesByLocation,
      employmentType: profile.employment_type || null,
    })

  // Fire-and-forget: a failed touch must never fail the request, but it must
  // not vanish either — a supabase builder RESOLVES rather than throws, so a
  // bare await would have swallowed it silently.
  db.from('widget_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id)
    .then(({ error }) => {
      if (error) logWarn('widget-auth', 'last_used_at touch failed', { err: error.message })
    }, (e) => logWarn('widget-auth', 'last_used_at threw', { err: e?.message }))

  return {
    ...profile,
    authSource: 'widget',
    widgetTokenId: row.id,
    activeLocation: location,
    locations: [location],
    rolesByLocation,
    assignmentsByLocation: { [row.location_id]: assignment },
    activeAssignment: assignment,
    roleTemplatesByLocation,
    activeRoleTemplate: roleTemplatesByLocation[row.location_id] || null,
    acDeviceTemplatesByLocation,
    activeAcDeviceTemplate: acDeviceTemplatesByLocation[row.location_id] || null,
    // The active-location role, exactly as getCurrentUser reports it.
    role: assignment.role,
    profileRole: profile.role,
    // A widget token is location-scoped by construction; the master bypass
    // is estate-wide. Never grant it here, whatever the profile row says.
    isMaster: false,
    organizationsById: {},
    activeOrganization: null,
    orgAdminOrgIds: [],
  }
}
```

- [ ] **Step 4: Check the log helper's real name before running**

Run: `grep -n "export function logWarn" src/lib/log.js`
If it is not there, run `grep -rn "export function logWarn" src/lib/ | head -2`
and fix the import path in `widget-auth.js` to match. Do not invent a logger.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/widget-auth.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/widget-auth.js src/lib/widget-auth.test.js
git commit -m "WIDGET.1 — getWidgetUser: token to a location-scoped user object"
```

---

## Task 5: `withAuth` gains `allowWidgetToken`, default-deny

**Files:**
- Modify: `src/lib/with-auth.js`
- Test: `src/lib/with-auth.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/with-auth.test.js`. Match the file's existing mock setup —
open it first (`sed -n 1,40p src/lib/with-auth.test.js`) and reuse its
`getCurrentUser` mock rather than adding a second one.

```js
describe('allowWidgetToken', () => {
  // NOTE: this file deliberately uses the REAL hasPermission — permission
  // outcomes are driven by the user object, not by a mock. `schedule` passes
  // because widgetUser() carries it; `studio_management` denies. Do not add a
  // permissions mock here; the existing tests depend on the real resolver.
  function widgetUser(overrides = {}) {
    return {
      id: 'u1',
      role: 'staff',
      authSource: 'widget',
      widgetTokenId: 'tok-1',
      activeLocation: { id: 'loc-1', features: {} },
      activeAssignment: { permissions: { schedule: true } },
      ...overrides,
    }
  }

  it('does not call getWidgetUser when the route did not opt in', async () => {
    getCurrentUser.mockResolvedValue(null)
    const handler = vi.fn()
    const wrapped = withAuth({ permission: 'schedule' }, handler)
    const res = await wrapped(new Request('https://x.test/api/thing'))
    expect(res.status).toBe(401)
    expect(getWidgetUser).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('falls back to a widget token when the route opted in', async () => {
    getCurrentUser.mockResolvedValue(null)
    getWidgetUser.mockResolvedValue(widgetUser())
    const handler = vi.fn(async () => new Response('ok'))
    const wrapped = withAuth({ permission: 'schedule', allowWidgetToken: true }, handler)
    const res = await wrapped(new Request('https://x.test/api/thing'))
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc-1' }))
  })

  it('prefers a real session over a widget token when both are present', async () => {
    getCurrentUser.mockResolvedValue(user({ activeLocation: { id: 'loc-9', features: {} } }))
    getWidgetUser.mockResolvedValue(widgetUser())
    const handler = vi.fn(async () => new Response('ok'))
    const wrapped = withAuth({ permission: 'schedule', allowWidgetToken: true }, handler)
    await wrapped(new Request('https://x.test/api/thing'))
    expect(getWidgetUser).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc-9' }))
  })

  it('still applies the permission gate to a widget user', async () => {
    getCurrentUser.mockResolvedValue(null)
    getWidgetUser.mockResolvedValue(widgetUser())
    const handler = vi.fn()
    const wrapped = withAuth({ permission: 'studio_management', allowWidgetToken: true }, handler)
    const res = await wrapped(new Request('https://x.test/api/thing'))
    expect(res.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects a widget token on a route that requires no location', () => {
    // A widget token IS a location; a location-free route is by definition
    // estate-wide and must never accept one.
    expect(() => withAuth(
      { permission: null, roles: ['master'], location: false, allowWidgetToken: true },
      async () => new Response('ok')
    )).toThrow(/allowWidgetToken requires location/)
  })
})
```

Add to the file's mocks at the top:

```js
vi.mock('@/lib/widget-auth', () => ({ getWidgetUser: vi.fn() }))
```

and to its top-level imports, matching the file's existing `await import` style:

```js
const { getWidgetUser } = await import('@/lib/widget-auth')
```

and add `getWidgetUser.mockReset()` to the file's existing `beforeEach`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/with-auth.test.js`
Expected: FAIL — `getWidgetUser is not a function` / the throw assertion fails.

- [ ] **Step 3: Implement**

In `src/lib/with-auth.js`, add the import:

```js
import { getWidgetUser } from './widget-auth.js'
```

Extend the destructure (currently line ~110):

```js
  const {
    permission,
    location: requireLocation = true,
    roles = null,
    schema = null,
    allowWidgetToken = false,
  } = options
```

Add this validation beside the existing fail-fast checks:

```js
  // A widget token carries exactly one location. A route that does not
  // require a location is estate-wide by definition, so pairing the two
  // would silently widen what a lost phone can reach.
  if (allowWidgetToken && !requireLocation) {
    throw new Error('withAuth: allowWidgetToken requires location: true')
  }
```

Replace the first two lines of `authedHandler`:

```js
  return async function authedHandler(request, ctx) {
    // A real session always wins. The widget path is consulted only when
    // there is no session AND the route explicitly opted in — which is what
    // makes denial the default for every route that did not.
    let user = await getCurrentUser()
    if (!user && allowWidgetToken) {
      user = await getWidgetUser(createServerClient(), request)
    }
    if (!user) return AUTH_ERRORS.unauthorized()
```

Also update the `@param` block above `withAuth` to document the option:

```js
 * @param {boolean} [options.allowWidgetToken]  default false. When true, a
 *   request with no session may authenticate with a widget token (WIDGET.1).
 *   Requires location: true. Every route that omits this rejects widget
 *   tokens, which is why the default is denial.
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/with-auth.test.js`
Expected: PASS, including the five new tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/with-auth.js src/lib/with-auth.test.js
git commit -m "WIDGET.1 — withAuth: allowWidgetToken opt-in, default-deny"
```

---

## Task 6: `getHomeQueueCounts` with a per-source breakdown

**Files:**
- Modify: `src/lib/home-queue.js:445-461`
- Test: `src/lib/home-queue.test.js`

- [ ] **Step 1: Confirm the db-double idiom**

Run: `grep -n "getHomeQueueCount" -B 30 src/lib/home-queue.test.js`
The tests below use that file's own `makeDb({ email_tickets: {...},
whatsapp_conversations: {...} })` helper and its `userAt()` helper. Confirm
both exist before writing; do not introduce a second db-double style.

- [ ] **Step 2: Write the failing test**

Append to `src/lib/home-queue.test.js`, and add `getHomeQueueCounts` to the
existing import from `./home-queue`.

```js
describe('getHomeQueueCounts', () => {
  it('returns a per-source breakdown that sums to count', async () => {
    getPendingApprovalsCount.mockResolvedValue(3)
    hasPermission.mockReturnValue(true)
    hasPermissionForLocation.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ elevated: true, mailboxes: [{ id: 'mb1' }] })
    const db = makeDb({
      email_tickets: { rows: [], count: 2 },
      whatsapp_conversations: { rows: [] },
    })

    const out = await getHomeQueueCounts(db, userAt())

    expect(out.bySource).toEqual({ approvals: 3, mail: 2, inbox: 0 })
    expect(out.count).toBe(5)
    expect(out.degraded).toEqual([])
  })

  it('reports a failed source in degraded and excludes it from the sum', async () => {
    getPendingApprovalsCount.mockRejectedValue(new Error('approvals down'))
    hasPermission.mockReturnValue(true)
    hasPermissionForLocation.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ elevated: true, mailboxes: [{ id: 'mb1' }] })
    const db = makeDb({
      email_tickets: { rows: [], count: 2 },
      whatsapp_conversations: {
        rows: [{
          id: 'w1', resolved_at: null, last_message_at: '2026-08-10T08:00:00Z',
          last_message_direction: 'inbound', agent_handed_off_at: null,
        }],
      },
    })

    const out = await getHomeQueueCounts(db, userAt())

    expect(out.bySource.approvals).toBe(0)
    expect(out.degraded).toContain('approvals')
    expect(out.count).toBe(3)
  })

  it('returns zeroes with no active location, not a throw', async () => {
    const out = await getHomeQueueCounts(makeDb(), { id: 'u1', activeLocation: null })
    expect(out).toEqual({ count: 0, bySource: { approvals: 0, mail: 0, inbox: 0 }, degraded: [] })
  })

  it('still THROWS when mailbox visibility itself is unavailable', async () => {
    // EMAIL-TICKET-CLEANUP.2: "0" here would read as "nothing to do" rather
    // than "we could not check", so this one case must stay a rejection.
    hasPermission.mockReturnValue(true)
    hasPermissionForLocation.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ response: 'mailboxes-unavailable' })
    getPendingApprovalsCount.mockResolvedValue(0)

    await expect(getHomeQueueCounts(makeDb(), userAt())).rejects.toThrow()
  })
})

describe('getHomeQueueCount (unchanged contract)', () => {
  it('still returns a bare number', async () => {
    getPendingApprovalsCount.mockResolvedValue(3)
    hasPermission.mockReturnValue(true)
    hasPermissionForLocation.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ elevated: true, mailboxes: [{ id: 'mb1' }] })
    const db = makeDb({
      email_tickets: { rows: [], count: 2 },
      whatsapp_conversations: { rows: [] },
    })
    expect(await getHomeQueueCount(db, userAt())).toBe(5)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/home-queue.test.js`
Expected: FAIL — `getHomeQueueCounts is not a function`.

- [ ] **Step 4: Implement**

Replace `getHomeQueueCount` (lines 445-461) with:

```js
/**
 * WIDGET.1 — the same three TRUE counts, reported per source.
 *
 * The sum was always computed from three separate numbers; this exposes them
 * instead of discarding them, at no extra query cost. `degraded` names the
 * sources that could not be checked, so a caller can say "3 approvals, mail
 * unavailable" rather than a confident total that quietly excludes a source.
 *
 * @returns {Promise<{count:number, bySource:{approvals:number,mail:number,inbox:number}, degraded:string[]}>}
 */
export async function getHomeQueueCounts(db, user) {
  const empty = { count: 0, bySource: { approvals: 0, mail: 0, inbox: 0 }, degraded: [] }
  const locationId = user?.activeLocation?.id || null
  if (!locationId) return empty

  const settled = await Promise.allSettled([
    getPendingApprovalsCount(db, user),
    countConversationsNeedsReply(db, user, locationId),
    countInboxNeedsAction(db, user, locationId),
  ])

  const [, conversationsSettled] = settled
  if (conversationsSettled.status === 'rejected' && conversationsSettled.reason instanceof ConversationsVisibilityUnavailableError) {
    throw conversationsSettled.reason
  }

  const SOURCES = ['approvals', 'mail', 'inbox']
  const bySource = { approvals: 0, mail: 0, inbox: 0 }
  const degraded = []
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') bySource[SOURCES[i]] = s.value || 0
    else degraded.push(SOURCES[i])
  })

  return {
    count: SOURCES.reduce((sum, k) => sum + bySource[k], 0),
    bySource,
    degraded,
  }
}

/**
 * Unchanged contract: a bare number. Kept because the sidebar poller and
 * /dashboard/today both consume it as one, and this is not their change.
 */
export async function getHomeQueueCount(db, user) {
  const { count } = await getHomeQueueCounts(db, user)
  return count
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/home-queue.test.js`
Expected: PASS — the new blocks plus every pre-existing test in the file.

- [ ] **Step 6: Commit**

```bash
git add src/lib/home-queue.js src/lib/home-queue.test.js
git commit -m "WIDGET.1 — getHomeQueueCounts: expose the per-source breakdown"
```

---

## Task 7: `/api/home-queue/count` reports `bySource` and accepts a widget token

**Files:**
- Modify: `src/app/api/home-queue/count/route.js`
- Test: `src/app/api/home-queue/count/route.test.js` (create if absent)

- [ ] **Step 1: Check the existing web callers before changing the gate**

Run: `grep -rn "home-queue/count" src/ mobile/ | grep -v test`
The route is currently `location: false`, and `allowWidgetToken` requires
`location: true` (Task 5). A session with no active location gets a `0` today
and would get a 400 after this change. Note every caller you find; if any
genuinely runs without an active location, keep `location: false` and resolve
the location inside the handler instead, then say so in the commit message.

- [ ] **Step 2: Write the failing test**

```js
// src/app/api/home-queue/count/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => Object.assign(
    (request, ctx) => handler({ user: globalThis.__user, db: {}, locationId: 'loc-1', request, params: ctx?.params }),
    { _opts: opts }
  ),
}))
vi.mock('@/lib/home-queue', () => ({ getHomeQueueCounts: vi.fn() }))

import { GET } from './route'
import { getHomeQueueCounts } from '@/lib/home-queue'

beforeEach(() => { vi.clearAllMocks(); globalThis.__user = { id: 'u1' } })

describe('GET /api/home-queue/count', () => {
  it('opts into widget tokens', () => {
    expect(GET._opts.allowWidgetToken).toBe(true)
  })

  it('returns count, bySource and degraded', async () => {
    getHomeQueueCounts.mockResolvedValue({
      count: 5, bySource: { approvals: 3, mail: 2, inbox: 0 }, degraded: [],
    })
    const res = await GET(new Request('https://x.test/api/home-queue/count'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      success: true,
      data: { count: 5, bySource: { approvals: 3, mail: 2, inbox: 0 }, degraded: [] },
    })
  })

  it('still answers 500 when mailbox visibility is unavailable', async () => {
    getHomeQueueCounts.mockRejectedValue(new Error('visibility down'))
    const res = await GET(new Request('https://x.test/api/home-queue/count'))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/app/api/home-queue/count/route.test.js`
Expected: FAIL — `_opts.allowWidgetToken` is `undefined`.

- [ ] **Step 4: Implement**

In `src/app/api/home-queue/count/route.js`, change the import from
`getHomeQueueCount` to `getHomeQueueCounts`, and replace the handler:

```js
export const GET = withAuth(
  // WIDGET.1 — the What Needs Me widget reads this. Its token carries the
  // studio, which withAuth installs as the request's active location, so the
  // widget for Hatch cannot read Stillorgan's numbers.
  { permission: null, location: true, allowWidgetToken: true },
  async ({ user, db }) => {
    try {
      const { count, bySource, degraded } = await getHomeQueueCounts(db, user)
      return NextResponse.json({ success: true, data: { count, bySource, degraded } })
    } catch (e) {
      console.error('[home-queue/count] failed:', e.message)
      return NextResponse.json({
        success: false,
        error: 'Could not check the needs-attention count — try again.',
      }, { status: 500 })
    }
  }
)
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/app/api/home-queue/count/route.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/home-queue/count/route.js src/app/api/home-queue/count/route.test.js
git commit -m "WIDGET.1 — home-queue/count: bySource + degraded, widget-token opt-in"
```

---

## Task 8: Migrate `sonos/control` to `withAuth` and opt in

This route still opens with the legacy `getCurrentUser()` preamble. Migrate it
first, behaviour-preserving, then opt in.

**Files:**
- Modify: `src/app/api/sonos/control/route.js`
- Test: `src/app/api/sonos/control/route.test.js` (create if absent)

- [ ] **Step 1: Read the route in full**

Run: `sed -n 1,120p src/app/api/sonos/control/route.js`
Note three things before changing anything: the permission key it checks, how
it resolves the location, and every early return. The migration must preserve
all of them.

- [ ] **Step 2: Write the characterisation test FIRST**

This is the safety net for the refactor — it must pass **before** and after.

```js
// src/app/api/sonos/control/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(), hasPermissionForLocation: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))

import { POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

const body = (b) => new Request('https://x.test/api/sonos/control', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
})

beforeEach(() => { vi.clearAllMocks() })

describe('POST /api/sonos/control — preserved behaviour', () => {
  it('401s with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(body({ action: 'pause' }))).status).toBe(401)
  })

  it('403s without device_control', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', activeLocation: { id: 'loc-1' } })
    hasPermission.mockReturnValue(false)
    expect((await POST(body({ action: 'pause' }))).status).toBe(403)
  })

  it('400s with no active location', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: null })
    hasPermission.mockReturnValue(true)
    expect((await POST(body({ action: 'pause' }))).status).toBe(400)
  })
})
```

Adjust the expected statuses to whatever the route **actually** returns today —
run the test, and if a status differs, change the *test* to match the route.
You are recording current behaviour, not asserting a preference.

- [ ] **Step 3: Run it against the unmodified route**

Run: `npx vitest run src/app/api/sonos/control/route.test.js`
Expected: PASS. If it does not, fix the test until it does. **Do not touch the
route until this is green** — an untested refactor of an auth path is how
silent lockouts ship.

- [ ] **Step 4: Migrate to `withAuth`**

Replace the preamble (the `getCurrentUser()` call, the permission check, the
location resolution and the `createServerClient()` call) with the wrapper,
keeping the handler body byte-identical below that point:

```js
import { withAuth } from '@/lib/with-auth'

export const POST = withAuth(
  // WIDGET.1 — the Studio Controls widget's speaker button lands here. The
  // permission key and location gate are unchanged from the hand-rolled
  // preamble this replaced.
  { permission: 'device_control', location: true, allowWidgetToken: true },
  async ({ user, db, locationId, request }) => {
    // …existing handler body, unchanged…
  }
)
```

Delete the now-unused `getCurrentUser`, `hasPermission` and
`createServerClient` imports if nothing else in the file uses them.

- [ ] **Step 5: Run the characterisation test again**

Run: `npx vitest run src/app/api/sonos/control/route.test.js`
Expected: PASS, unchanged. Update the test's mocks to `@/lib/with-auth` only
where the wrapper genuinely changed the seam — the three status assertions
must still hold.

- [ ] **Step 6: Verify the route-guard check still passes**

Run: `npm run check:route-guards`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/sonos/control/route.js src/app/api/sonos/control/route.test.js
git commit -m "WIDGET.1 — sonos/control: migrate to withAuth, opt into widget tokens

Characterisation tests written and green BEFORE the refactor; the three
auth outcomes (401/403/400) are unchanged."
```

---

## Task 9: Migrate `studio-management/unlock`, opt in, and attribute the audit

The door route. Same legacy preamble as Task 8, plus the audit attribution the
spec requires.

**Files:**
- Modify: `src/app/api/studio-management/unlock/route.js`
- Test: `src/app/api/studio-management/unlock/route.test.js` (create if absent)

- [ ] **Step 1: Read the route and its current audit call**

Run: `sed -n 1,90p src/app/api/studio-management/unlock/route.js`
Run: `grep -n "logAuditEvent" src/app/api/studio-management/unlock/route.js`
Record the exact `category` and `action` strings it already passes. Do not
rename an existing audit action — dashboards read those strings.

- [ ] **Step 2: Write the characterisation test first**

Mirror Task 8's Step 2 exactly, against this route's path and its
`studio_management` permission key:

```js
// src/app/api/studio-management/unlock/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(), hasPermissionForLocation: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))

import { POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

const body = (b) => new Request('https://x.test/api/studio-management/unlock', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
})

beforeEach(() => { vi.clearAllMocks() })

describe('POST /api/studio-management/unlock — preserved behaviour', () => {
  it('401s with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(body({ door_id: 'd1' }))).status).toBe(401)
  })

  it('403s without studio_management', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', activeLocation: { id: 'loc-1' } })
    hasPermission.mockReturnValue(false)
    expect((await POST(body({ door_id: 'd1' }))).status).toBe(403)
  })

  it('400s with no active location', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: null })
    hasPermission.mockReturnValue(true)
    expect((await POST(body({ door_id: 'd1' }))).status).toBe(400)
  })
})
```

Adjust the statuses to what the route actually returns today.

- [ ] **Step 3: Run it green against the unmodified route**

Run: `npx vitest run src/app/api/studio-management/unlock/route.test.js`
Expected: PASS before any edit.

- [ ] **Step 4: Migrate to `withAuth` and opt in**

```js
export const POST = withAuth(
  // WIDGET.1 — the Studio Controls widget's door button lands here. The
  // widget's two-tap arm is a UI affordance only; THIS gate is the
  // authorisation, and it re-checks on every call.
  { permission: 'studio_management', location: true, allowWidgetToken: true },
  async ({ user, db, locationId, request }) => {
    // …existing handler body, unchanged…
  }
)
```

- [ ] **Step 5: Run the characterisation test again**

Run: `npx vitest run src/app/api/studio-management/unlock/route.test.js`
Expected: PASS, unchanged.

- [ ] **Step 6: Write the failing test for audit attribution**

Append to the same file, switching its `with-auth` seam to the wrapper mock
used elsewhere in this plan:

```js
it('records how the door was opened, and which widget did it', async () => {
  globalThis.__user = {
    id: 'u1', role: 'owner', activeLocation: { id: 'loc-1' },
    authSource: 'widget', widgetTokenId: 'tok-1',
    full_name: 'Richard Ivers', email: 'r@x.test',
  }
  await POST(body({ door_id: 'door-1' }))
  expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
    details: expect.objectContaining({ via: 'widget', widget_token_id: 'tok-1' }),
  }))
})

it('marks an app unlock as via: app', async () => {
  globalThis.__user = {
    id: 'u1', role: 'owner', activeLocation: { id: 'loc-1' },
    full_name: 'Richard Ivers', email: 'r@x.test',
  }
  await POST(body({ door_id: 'door-1' }))
  const last = logAuditEvent.mock.calls.at(-1)[0]
  expect(last.details.via).toBe('app')
  expect(last.details.widget_token_id).toBeUndefined()
})
```

Import `logAuditEvent` from `@/lib/audit` at the top of the file.

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/app/api/studio-management/unlock/route.test.js`
Expected: FAIL — `details` has no `via`.

- [ ] **Step 8: Implement the attribution**

At the existing `logAuditEvent` call in the handler, extend `details` — leaving
`category` and `action` exactly as they are:

```js
      details: {
        ...existingDetails,
        // WIDGET.1 — "opened via widget from a phone" has to be legible
        // after the fact, and the token id is what makes it revocable.
        via: user.authSource === 'widget' ? 'widget' : 'app',
        ...(user.widgetTokenId ? { widget_token_id: user.widgetTokenId } : {}),
      },
```

- [ ] **Step 9: Run the tests**

Run: `npx vitest run src/app/api/studio-management/unlock/route.test.js`
Expected: PASS — the characterisation tests and both attribution tests.

- [ ] **Step 10: Commit**

```bash
git add src/app/api/studio-management/unlock/route.js src/app/api/studio-management/unlock/route.test.js
git commit -m "WIDGET.1 — unlock: withAuth, widget-token opt-in, via/token audit attribution"
```

---

## Task 10: Opt in the three routes already on `withAuth`

**Files:**
- Create: `src/app/api/widget-optin.test.js`
- Modify: `src/app/api/shelly/devices/[id]/toggle/route.js:147`
- Modify: `src/app/api/studio-management/ac/devices/[id]/turn-on/route.js:16`
- Modify: `src/app/api/studio-management/ac/devices/[id]/turn-off/route.js`

- [ ] **Step 1: Write the failing test**

```js
// src/app/api/widget-optin.test.js
// WIDGET.1 — the opt-in list, as a test. Adding allowWidgetToken to a route
// widens what a lost phone reaches, so the set is pinned here: a new opt-in
// has to be added deliberately, in this file, by someone who read this.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => Object.assign((req, ctx) => handler({ request: req, params: ctx?.params }), { _opts: opts }),
}))

import { POST as shellyToggle } from './shelly/devices/[id]/toggle/route'
import { POST as acOn } from './studio-management/ac/devices/[id]/turn-on/route'
import { POST as acOff } from './studio-management/ac/devices/[id]/turn-off/route'
import { POST as unlock } from './studio-management/unlock/route'
import { POST as sonos } from './sonos/control/route'
import { GET as queueCount } from './home-queue/count/route'

describe('the widget-token opt-in set', () => {
  it('is exactly these six routes, and every one is location-scoped', () => {
    for (const route of [shellyToggle, acOn, acOff, unlock, sonos, queueCount]) {
      expect(route._opts.allowWidgetToken).toBe(true)
      expect(route._opts.location).not.toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/api/widget-optin.test.js`
Expected: FAIL on the three routes not yet opted in.

- [ ] **Step 3: Add the option to each of the three**

In each file, extend the existing `withAuth` options object with
`allowWidgetToken: true` and a one-line comment naming the widget button it
serves. For example, in the shelly route at line 147:

```js
export const POST = withAuth(
  // WIDGET.1 — the Studio Controls widget's plug button lands here.
  { permission: 'device_control', location: true, allowWidgetToken: true },
```

Do not change the permission keys.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/app/api/widget-optin.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/shelly/devices/[id]/toggle/route.js" \
        "src/app/api/studio-management/ac/devices/[id]/turn-on/route.js" \
        "src/app/api/studio-management/ac/devices/[id]/turn-off/route.js" \
        src/app/api/widget-optin.test.js
git commit -m "WIDGET.1 — opt in shelly toggle + AC on/off; pin the opt-in set in a test"
```

---

## Task 11a: Extract the door allowlist out of the doors route

**Discovered during execution:** only two of the four "device" sources are
database tables. `ac_devices` and `shelly_devices` are; **doors are a live
UniFi Access call** (`listDoors(cfg)` from `src/lib/unifi-access.js`) and
**Sonos groups are a live Sonos Control API call**. The original plan for
Task 11 queried four tables uniformly, which would have returned an empty
picker for doors and speakers.

Worse, it would have skipped the door allowlist. `GET /api/studio-management/doors`
intersects the controller's door list with `profile_locations.unifi_door_ids`
— the per-user, per-location allowlist migration 182 added precisely because
the route "previously returned every door from the UniFi controller
unfiltered, which exposed the door inventory to any staff user with
studio_management permission" (UNIFI-DOORS-SCOPE). A widget picker that
re-derived its own door list would reintroduce that exposure.

So the allowlist intersection gets extracted and shared, for the same reason
role-template loading did in Task 3: a second copy would drift, silently and
permissively.

**Files:**
- Create: `src/lib/studio-doors.js` — `listAllowedDoors(db, { user, location, locationId })`
- Test: `src/lib/studio-doors.test.js`
- Modify: `src/app/api/studio-management/doors/route.js` to call it

- [ ] **Step 1: Read the route you are extracting from**

Run: `sed -n 1,120p src/app/api/studio-management/doors/route.js`

Note the four behaviours that must survive verbatim: the `getUnifiConfig`
dual-read, the door-shape normalisation (UniFi firmwares ship camelCase *or*
snake_case — `id || unique_id || door_id`, `name || display_name || title`),
the NULL-allowlist legacy fallback (`null`/`undefined` = unrestricted,
`[]` = no doors), and the `scope` field the UI uses to choose its empty state.

- [ ] **Step 2: Write the failing test**

Cover: unrestricted (null allowlist) returns everything; `[]` returns nothing;
a populated allowlist returns only the intersection; both door-shape spellings
normalise; a door with no id in any spelling is dropped; a `UnifiError`
propagates its status; unconfigured UniFi is reported as such rather than as
an empty list.

- [ ] **Step 3: Run it, confirm it fails, then implement and confirm it passes**

- [ ] **Step 4: Rewire the doors route to call the helper**

Its observable output — `data`, `scope`, and every status code including the
404, the 412 `unifi_not_configured` and the `UnifiError` passthrough — must not
change. `src/app/api/studio-management/unlock/route.test.js` (Task 9) already
pins the allowlist semantics on the unlock side; run it too.

- [ ] **Step 5: Full suite, lint, build, commit**

---

## Task 11b: `GET /api/widget/devices`

The configuration picker's data source: what can this person actually control
at this studio? It composes **four heterogeneous sources**, two of them live
third-party calls, so `Promise.allSettled` plus a `degraded` list is not
defensive padding — it is the normal case.

**Files:**
- Create: `src/app/api/widget/devices/route.js`
- Test: `src/app/api/widget/devices/route.test.js`

| kind | source | gate |
| --- | --- | --- |
| `door` | `listAllowedDoors()` from Task 11a — UniFi live, allowlist-intersected | `studio_management` |
| `ac` | `ac_devices` table, `.eq('location_id', locationId)` | `studio_management` |
| `plug` | `shelly_devices` table, `.eq('location_id', locationId)` | `device_control` |
| `speaker` | Sonos **players** — `getSonosConfig` → `withFreshToken` → `sonosGetGroups` → `mapGroups().players` | `device_control` |

🔴 **Offer players, never groups.** `src/lib/sonos/groups.js:28` states it plainly:
"Player ids are permanent; group ids are ephemeral." A widget stores its
configured device id permanently, so a button bound to a group id would break
the moment anyone regroups the speakers — silently, and only for whoever had
that widget. The control action resolves group ids from player ids at press
time via `resolveGroupIds()`, which is exactly what the Sonos schedules
already do.

- [ ] **Step 1: Read the two live-source routes** so you reuse their helpers
rather than re-deriving them: `src/app/api/studio-management/doors/route.js`
(post-11a) and `src/app/api/sonos/household/route.js`.

- [ ] **Step 2: Write the failing test.** Cover: all four kinds when both
permissions are held; doors and AC omitted without `studio_management`; plugs
and speakers omitted without `device_control`; an empty list (200, not an
error) when neither is held; one failing source degrades without failing the
list; **Sonos not connected is a normal empty result, not a degraded source**;
and — the security case — **the door list is the allowlist-intersected one,
never the raw controller inventory**.

- [ ] **Step 3: Implement**, shaping every entry as `{ kind, id, label }` and
returning `{ success: true, data: { devices, degraded } }`.

- [ ] **Step 4:** `npm run check:location-scoping`, `check:route-guards`, lint,
full suite, commit.

**Latency note for Phase 2:** this endpoint makes two third-party round trips
(UniFi, Sonos). It is only hit while configuring a widget, never on a timeline
refresh, so that is acceptable — but the config intent must not block its UI on
it without a spinner.

## Task 12: Mint, list and revoke routes

**Files:**
- Create: `src/app/api/widget/tokens/route.js` (GET, POST)
- Test: `src/app/api/widget/tokens/route.test.js`
- Create: `src/app/api/widget/tokens/[id]/route.js` (DELETE)
- Test: `src/app/api/widget/tokens/[id]/route.test.js`

These are **session-only**. They must never carry `allowWidgetToken` — a widget
that can mint widget tokens is a credential that renews itself past revocation.

- [ ] **Step 1: Confirm `staff_management` is a real permission key**

Run: `grep -n "staff_management" shared/permissions.js | head -3`
Expected: a match. `withAuth` fail-fasts on an unknown key at import time, and
`hasPermission` silently denies one — if the key differs, use the real one
throughout this task.

- [ ] **Step 2: Write the failing tests**

```js
// src/app/api/widget/tokens/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => Object.assign(
    (req, ctx) => handler({ user: globalThis.__user, db: globalThis.__db, locationId: 'loc-1', request: req, params: ctx?.params, input: globalThis.__input }),
    { _opts: opts }
  ),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))

import { GET, POST } from './route'
import { hasPermission } from '@/lib/permissions'

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  globalThis.__user = { id: 'u1', role: 'manager' }
  globalThis.__input = { device_label: "Richard's iPhone" }
  globalThis.__db = {
    _inserted: null,
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ is: vi.fn(() => ({ order: vi.fn(async () => ({ data: [{ id: 't1', device_label: 'iPhone', created_at: 'x', last_used_at: null }], error: null })) })) })) })),
      insert: vi.fn((row) => {
        globalThis.__db._inserted = row
        return { select: vi.fn(() => ({ maybeSingle: async () => ({ data: { id: 't-new' }, error: null }) })) }
      }),
    })),
  }
})

describe('the token routes are session-only', () => {
  it('never accept a widget token', () => {
    expect(GET._opts.allowWidgetToken).toBeFalsy()
    expect(POST._opts.allowWidgetToken).toBeFalsy()
  })
})

describe('POST /api/widget/tokens', () => {
  it('returns the plaintext token exactly once', async () => {
    const body = await (await POST(new Request('https://x.test', { method: 'POST' }))).json()
    expect(body.data.token).toMatch(/^rwt_/)
    expect(body.data.id).toBe('t-new')
  })

  it('stores only the hash, never the plaintext', async () => {
    const body = await (await POST(new Request('https://x.test', { method: 'POST' }))).json()
    const row = globalThis.__db._inserted
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(body.data.token)
  })

  it('scopes the row to the caller and the active location', async () => {
    await POST(new Request('https://x.test', { method: 'POST' }))
    expect(globalThis.__db._inserted).toMatchObject({ profile_id: 'u1', location_id: 'loc-1' })
  })
})

describe('GET /api/widget/tokens', () => {
  it('lists live tokens without ever returning a hash', async () => {
    const body = await (await GET(new Request('https://x.test/api/widget/tokens'))).json()
    expect(body.data.tokens[0]).toEqual({ id: 't1', device_label: 'iPhone', created_at: 'x', last_used_at: null })
    expect(JSON.stringify(body)).not.toContain('token_hash')
  })

  it('refuses another profile list without staff_management', async () => {
    hasPermission.mockReturnValue(false)
    const res = await GET(new Request('https://x.test/api/widget/tokens?profile_id=someone-else'))
    expect((await res.json()).data.tokens).toEqual([])
  })
})
```

```js
// src/app/api/widget/tokens/[id]/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => Object.assign(
    (req, ctx) => handler({ user: globalThis.__user, db: globalThis.__db, locationId: 'loc-1', request: req, params: ctx?.params }),
    { _opts: opts }
  ),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))

import { DELETE } from './route'

let updated
beforeEach(() => {
  vi.clearAllMocks()
  updated = null
  globalThis.__user = { id: 'u1', role: 'owner' }
  globalThis.__db = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: async () => ({ data: { id: 't1', profile_id: 'u2' }, error: null }) })) })),
      update: vi.fn((patch) => {
        updated = patch
        return { eq: vi.fn(() => ({ select: vi.fn(async () => ({ data: [{ id: 't1' }], error: null })) })) }
      }),
    })),
  }
})

const del = (id) => DELETE(new Request('https://x.test', { method: 'DELETE' }), { params: Promise.resolve({ id }) })

describe('DELETE /api/widget/tokens/[id]', () => {
  it('never accepts a widget token', () => {
    expect(DELETE._opts.allowWidgetToken).toBeFalsy()
  })

  it('stamps revoked_at rather than deleting the row', async () => {
    // The row is the audit trail for every door that token opened.
    const res = await del('t1')
    expect(res.status).toBe(200)
    expect(updated).toMatchObject({ revoked_at: expect.any(String) })
  })

  it('404s for an unknown id rather than confirming it exists', async () => {
    globalThis.__db.from = vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: async () => ({ data: null, error: null }) })) })),
    }))
    expect((await del('nope')).status).toBe(404)
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/app/api/widget/tokens`
Expected: FAIL — modules do not exist.

- [ ] **Step 4: Implement the list/mint route**

```js
// src/app/api/widget/tokens/route.js
// WIDGET.1 — mint and list widget credentials.
//
// SESSION-ONLY, deliberately: no allowWidgetToken here. A widget that could
// mint widget tokens would be a credential that renews itself straight past
// a revocation, which is the one thing the revocation has to survive.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { hasPermission } from '@/lib/permissions'
import { generateWidgetToken, hashWidgetToken } from '@/lib/widget-token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const mintSchema = z.object({
  device_label: z.string().trim().min(1).max(60).optional(),
})

export const GET = withAuth(
  { permission: null, location: true },
  async ({ user, db, request }) => {
    const requested = new URL(request.url).searchParams.get('profile_id')
    // Reading someone else's widget list is a staff-management act.
    const targetId = requested && requested !== user.id
      ? (hasPermission(user, 'staff_management') ? requested : null)
      : user.id
    if (!targetId) return NextResponse.json({ success: true, data: { tokens: [] } })

    const { data, error } = await db
      .from('widget_tokens')
      .select('id, device_label, created_at, last_used_at')
      .eq('profile_id', targetId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[widget/tokens] list failed:', error.message)
      return NextResponse.json({ success: false, error: 'Could not load widgets.' }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: { tokens: data || [] } })
  }
)

export const POST = withAuth(
  { permission: null, location: true, schema: mintSchema },
  async ({ user, db, locationId, input }) => {
    const token = generateWidgetToken()
    const { data, error } = await db
      .from('widget_tokens')
      .insert({
        profile_id: user.id,
        location_id: locationId,
        token_hash: hashWidgetToken(token),
        device_label: input?.device_label || null,
      })
      .select('id')
      .maybeSingle()

    if (error || !data) {
      console.error('[widget/tokens] mint failed:', error?.message)
      return NextResponse.json({ success: false, error: 'Could not create the widget token.' }, { status: 500 })
    }

    // The ONLY time the plaintext exists outside the device.
    return NextResponse.json({ success: true, data: { id: data.id, token } })
  }
)
```

- [ ] **Step 5: Implement the revoke route**

```js
// src/app/api/widget/tokens/[id]/route.js
// WIDGET.1 — revoke one device's widget without touching that person's
// session. Losing a phone should cost you a widget, not your login.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DELETE = withAuth(
  { permission: null, location: true },
  async ({ user, db, params }) => {
    const id = params?.id
    if (!id) return NextResponse.json({ success: false, error: 'Token id required.' }, { status: 400 })

    const { data: row, error: readErr } = await db
      .from('widget_tokens')
      .select('id, profile_id')
      .eq('id', id)
      .maybeSingle()

    // 404 rather than 403 for someone else's token — a distinct 403 would
    // confirm the id exists, which is the enumeration this repo avoids.
    if (readErr || !row) return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })

    const isOwnToken = row.profile_id === user.id
    if (!isOwnToken && !hasPermission(user, 'staff_management')) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }

    // Stamp, never delete: the row is what attributes every door this token
    // opened, and that history has to outlive the credential.
    const { data: updatedRows, error: updateErr } = await db
      .from('widget_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')

    if (updateErr) {
      console.error('[widget/tokens] revoke failed:', updateErr.message)
      return NextResponse.json({ success: false, error: 'Could not revoke that widget.' }, { status: 500 })
    }
    // A zero-row UPDATE is not an error in PostgREST — judge the rows.
    if (!updatedRows || updatedRows.length === 0) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  }
)
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/app/api/widget/tokens`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/widget/tokens
git commit -m "WIDGET.1 — mint/list/revoke widget tokens (session-only routes)"
```

---

## Task 13: The revocation card on the staff detail page

**Files:**
- Create: `src/components/WidgetTokensCard.jsx`
- Modify: `src/app/settings/staff/[id]/page.js:149`

- [ ] **Step 1: Check the UI primitives before writing the component**

Run: `grep -n "export" src/components/ui/index.js | head -20`
Expected: `Button` and `Card` among the exports. Confirm whether `Button`
takes a `variant` prop and what values it accepts. Adjust the component below
to the real API — do not add a new primitive.

- [ ] **Step 2: Write the component**

```jsx
// src/components/WidgetTokensCard.jsx
// WIDGET.1 — the revocation surface. Lists a person's live home-screen
// widgets and kills one without touching their session.

'use client'

import { useEffect, useState } from 'react'
import { Button, Card } from '@/components/ui'

export default function WidgetTokensCard({ profileId }) {
  const [tokens, setTokens] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [revoking, setRevoking] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/widget/tokens?profile_id=${encodeURIComponent(profileId)}`)
        const json = await res.json()
        if (!json.success) throw new Error(json.error || 'Could not load widgets.')
        if (!cancelled) setTokens(json.data.tokens)
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [profileId])

  async function revoke(id) {
    setRevoking(id)
    setError(null)
    try {
      const res = await fetch(`/api/widget/tokens/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Could not revoke that widget.')
      setTokens((t) => t.filter((x) => x.id !== id))
    } catch (e) {
      setError(e.message)
    } finally {
      setRevoking(null)
    }
  }

  return (
    <Card>
      <h3 className="text-lg font-semibold mb-1">Home-screen widgets</h3>
      <p className="text-sm text-un1t-subtle mb-4">
        Each row is one device showing this person&apos;s Repset widgets. Revoking
        stops that device&apos;s widgets — including its door button — without
        signing them out anywhere.
      </p>

      {loading && <p className="text-sm text-un1t-subtle">Loading…</p>}
      {error && <p className="text-sm text-red-700 mb-3">{error}</p>}

      {!loading && !error && tokens.length === 0 && (
        <p className="text-sm text-un1t-subtle">No widgets set up on any device.</p>
      )}

      <ul className="divide-y divide-un1t-border">
        {tokens.map((t) => (
          <li key={t.id} className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium">{t.device_label || 'Unnamed device'}</p>
              <p className="text-xs text-un1t-subtle">
                Added {new Date(t.created_at).toLocaleDateString('en-IE')}
                {t.last_used_at
                  ? ` · last used ${new Date(t.last_used_at).toLocaleDateString('en-IE')}`
                  : ' · never used'}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={revoking === t.id}
              onClick={() => revoke(t.id)}
            >
              {revoking === t.id ? 'Revoking…' : 'Revoke'}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
```

- [ ] **Step 3: Mount the card**

In `src/app/settings/staff/[id]/page.js`, add the import beside the existing
`StaffForm` import on line 4:

```js
import WidgetTokensCard from '@/components/WidgetTokensCard'
```

Then render it after the `<StaffForm …/>` element:

```jsx
      <div className="mt-8">
        <WidgetTokensCard profileId={profile.id} />
      </div>
```

Read the surrounding JSX first to confirm the variable holding the profile is
called `profile` — if the page names it something else, use that name.

- [ ] **Step 4: Run the affected tests and the build**

Run: `npx vitest run src/app/api/widget/tokens "src/app/settings/staff/[id]/page.test.js"`
Expected: PASS.

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/WidgetTokensCard.jsx "src/app/settings/staff/[id]/page.js"
git commit -m "WIDGET.1 — widget revocation card on the staff detail page"
```

---

## Task 14: Register in openapi, changelog, and run the full CI mirror

**Files:**
- Modify: `src/lib/openapi.js`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Register the three new routes**

Read the file's existing shape first (`grep -n "paths\[" src/lib/openapi.js | head -5`)
and follow it exactly for `/api/widget/devices` (GET), `/api/widget/tokens`
(GET, POST) and `/api/widget/tokens/{id}` (DELETE).

- [ ] **Step 2: Add ONE changelog row**

Add a single row under the table header in `docs/CHANGELOG.md`, keyed by the
PR number once you have it. **Never edit a row that is already pushed** —
`merge=union` cannot tell a revision from a new row and will keep both copies.

- [ ] **Step 3: Run the full CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: all eleven exit 0.

- [ ] **Step 4: Run the real build**

Run: `npm run build`
Expected: exits 0. Tests run on mocked imports and will not catch a Turbopack
or import-resolution failure.

- [ ] **Step 5: Commit and open the PR**

```bash
git add src/lib/openapi.js docs/CHANGELOG.md
git commit -m "WIDGET.1 — register widget routes in openapi; changelog row"
git push -u origin HEAD
gh pr create --base main --fill
```

Report the PR URL. Pushing is not shipping.

---

## Task 15: Spike — produce the Phase 2 plan

Phase 2 is the native half: the widget extension, the two Swift widget kinds,
the App Group, the config intents, the push-triggered reload, and the two-build
release. It cannot be planned to this level of detail until three things are
verified rather than assumed.

- [ ] **Step 1: Verify the config-plugin API**

```bash
npm view @bacons/apple-targets version
npm view @bacons/apple-targets repository.url
```

Fetch its README and record: the exact `expo-target.config.js` shape, how an
App Group is declared, how the widget's deployment target is set, and whether
it supports two bundle identifiers driven by an env var (the `LEGACY_APP=1`
switch this repo already uses in `mobile/app.config.js`).

- [ ] **Step 2: Answer the credentials question**

Determine — from Expo/EAS documentation, not from memory — what
`eas credentials` does when an App Group entitlement is added to a bundle ID,
and whether the capability-sync that twice un-ticked HealthKit behaves the same
way for App Groups. This decides whether the two builds can be run from one
worktree.

- [ ] **Step 3: Measure the door round trip**

With Phase 1 deployed, time `POST /api/studio-management/unlock` end to end
from a phone on cellular. An AppIntent runs under a short system budget; if the
p95 is anywhere near it, the intent must return on acceptance rather than on
completion, and that changes the route's contract.

- [ ] **Step 4: Register `mobile/targets/` as non-bundle**

This is Phase 2's Task 1 and it must land before any Swift file does.
`scripts/check-ota-trigger-paths.mjs` classifies every top-level entry under
`mobile/`; an unclassified one fails `check:ota-paths` **and** the inline gate
that aborts OTA publishes. Add to the `NON_BUNDLE` map at line 85:

```js
  targets: 'WIDGET.1 — Swift sources for the iOS widget extension, generated into the Xcode project at prebuild. Never enters the Metro bundle; a widget-only change must publish no OTA.',
```

and add the fires/does-not-fire case to `tests/ota-trigger-paths.test.js`.

- [ ] **Step 5: Write the Phase 2 plan**

Save to `docs/superpowers/plans/2026-09-10-widget-native-extension.md`, using
the same structure as this document, and covering: the config plugin, the App
Group bridging module, minting the token from the app, the two `AppIntent`
configurations, the two widget kinds and their sizes, the two-tap door arm,
`WidgetCenter` reload from the push handler, the `runtimeVersion` bump to
2.4.0, and the two-build submission.

---

## Self-review

**Spec coverage.** §1 widget kinds → Phase 2 (Task 15). §2 native target →
Phase 2. §3 auth → Tasks 1-5. §4 endpoints → Tasks 6-12. §5 refresh → Phase 2.
§6 door unlock: server re-check → Task 9 (the `withAuth` permission gate),
audit attribution → Task 9, revocation → Tasks 12-13, two-tap confirm →
Phase 2, latency → Task 15 Step 3. §7 extension-never-decides → structural:
every decision lives in Tasks 6-12, behind the API. §8 release traps:
`check:ota-paths` → Task 15 Step 4, the rest → Phase 2. §9 testing → each
task's own tests; the device-check list is Phase 2's exit gate. §10 out of
scope → unchanged.

**Type consistency.** `getWidgetUser(db, request)` returns `authSource` and
`widgetTokenId`, consumed under those names in Tasks 5 and 9.
`getHomeQueueCounts` returns `{count, bySource, degraded}`, consumed under
those names in Task 7. `allowWidgetToken` is spelled identically in Tasks 5,
7-12. The device shape `{kind, id, label}` in Task 11 is what Phase 2's config
intent reads.

**Known soft spots, flagged rather than papered over.** Task 11's table names
are placeholders *by instruction* — Step 1 makes you read the real ones,
because guessing a table name there produces a route that returns an empty
picker and looks like a permission bug. Tasks 8 and 9's characterisation tests
record whatever statuses those routes return today rather than asserting a
preference: they were never covered, and their current behaviour is exactly
what the refactor has to preserve.
