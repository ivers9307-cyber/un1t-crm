# Admin View-As-Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner/manager open any host's portal from the CRM and act as that host (full manage), via a transient re-validated cookie override — no host login, no persistent dual account, audited.

**Architecture:** Extend the single `getCurrentHost()` gate to honor a `un1t_host_impersonate` cookie ONLY for an `ADMIN_ROLES` caller whose org owns the host (re-checked every request). Mirror the CRM's `impersonation.js` (cookie + `impersonation_log`). All `/host` pages + `/api/host/*` routes inherit it unchanged, so "full manage" falls out for free.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role), `next/headers` cookies, Vitest. Spec: `docs/superpowers/specs/2026-07-09-admin-view-as-host-design.md`.

---

## File Structure

**Create:**
- `supabase/migrations/389_host_impersonation_log.sql` — audit table.
- `src/lib/host-impersonation.js` — `HOST_IMPERSONATE_COOKIE`, `canImpersonateHost`, `startHostImpersonation`, `stopHostImpersonation`.
- `src/lib/host-impersonation.test.js` — `canImpersonateHost` predicate tests.
- `src/app/api/hosts/[id]/impersonate/route.js` — start (ADMIN + org).
- `src/app/api/hosts/impersonate/exit/route.js` — stop.
- `src/components/host/HostImpersonationBanner.jsx` — banner + Exit button (client).

**Modify:**
- `src/lib/host-auth.js` — extend `getCurrentHost()` with the impersonation fallback; update the header comment.
- `src/components/settings/HostDetail.jsx` — "Open host portal" button.
- `src/app/host/(portal)/layout.js` — render the banner + swap Sign-out for Exit when impersonating.

---

## Task 1: Migration — host_impersonation_log

**Files:** Create `supabase/migrations/389_host_impersonation_log.sql`

- [ ] **Step 1: Write the migration**

```sql
-- HOST-PORTAL.4 — audit log for admin "view as host" sessions.
-- Mirrors impersonation_log (mig 035): one open row per admin at a time;
-- started on view-as, ended_at stamped on exit. Service-role only.
create table if not exists host_impersonation_log (
  id              uuid primary key default gen_random_uuid(),
  admin_user_id   uuid not null,
  host_id         uuid not null references event_hosts(id) on delete cascade,
  organization_id uuid,
  ip              text,
  user_agent      text,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  auto_closed     boolean not null default false
);
alter table host_impersonation_log enable row level security;
create index if not exists idx_host_impersonation_open
  on host_impersonation_log (admin_user_id) where ended_at is null;

comment on table host_impersonation_log is
  'Audit of admin view-as-host sessions (HOST-PORTAL.4). Service-role only; access is authorized in app code (ADMIN_ROLES + org).';
```

- [ ] **Step 2: Apply via Supabase MCP** — `apply_migration` name `host_impersonation_log`, project `iyvtbjjxdggiadzwwvdj` (confirm via `list_projects`; NOT sentinel).
- [ ] **Step 3: Advisors** — `get_advisors` type=security. Expected: only the pre-existing INFO `rls_enabled_no_policy` (now incl. `host_impersonation_log` — intended, service-role only). No new ERROR.
- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/389_host_impersonation_log.sql
git commit -m "HOST-PORTAL.4 — mig 389: host_impersonation_log audit table"
```

---

## Task 2: host-impersonation lib

**Files:** Create `src/lib/host-impersonation.js` + `src/lib/host-impersonation.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/host-impersonation.test.js
import { describe, it, expect } from 'vitest'
import { canImpersonateHost, HOST_IMPERSONATE_COOKIE } from './host-impersonation'

describe('canImpersonateHost', () => {
  it('allows owner/manager/master', () => {
    for (const role of ['owner', 'manager', 'master']) {
      expect(canImpersonateHost({ id: 'u1', role })).toBe(true)
    }
  })
  it('denies staff/head_coach and null', () => {
    expect(canImpersonateHost({ id: 'u1', role: 'staff' })).toBe(false)
    expect(canImpersonateHost({ id: 'u1', role: 'head_coach' })).toBe(false)
    expect(canImpersonateHost(null)).toBe(false)
    expect(canImpersonateHost(undefined)).toBe(false)
  })
})

describe('HOST_IMPERSONATE_COOKIE', () => {
  it('is the host view-as cookie name', () => {
    expect(HOST_IMPERSONATE_COOKIE).toBe('un1t_host_impersonate')
  })
})
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/lib/host-impersonation.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/host-impersonation.js`**

```js
// Admin "view as host" (HOST-PORTAL.4). The host analog of impersonation.js:
// a un1t_host_impersonate cookie names the host_id an ADMIN is viewing, with an
// audited open/close lifecycle in host_impersonation_log. getCurrentHost honors
// the cookie ONLY after re-checking ADMIN_ROLES + org membership per request.
import { cookies } from 'next/headers'
import { createServerClient } from './supabase'
import { ADMIN_ROLES } from './schemas'

export const HOST_IMPERSONATE_COOKIE = 'un1t_host_impersonate'
const MAX_AGE_SECONDS = 60 * 60 * 8 // 8h; the per-request re-check is the real guard

/** Pure: may this resolved staff user view-as a host? (org check is done by the caller) */
export function canImpersonateHost(user) {
  return !!user && ADMIN_ROLES.includes(user.role)
}

/**
 * Open a view-as session: close any open row for this admin, insert a new one,
 * set the cookie. Caller has already verified ADMIN_ROLES + that hostId is in
 * organizationId.
 */
export async function startHostImpersonation({ adminUserId, hostId, organizationId, ip, userAgent }) {
  const db = createServerClient()
  await db.from('host_impersonation_log')
    .update({ ended_at: new Date().toISOString() })
    .eq('admin_user_id', adminUserId).is('ended_at', null)
  const { error } = await db.from('host_impersonation_log').insert({
    admin_user_id: adminUserId,
    host_id: hostId,
    organization_id: organizationId || null,
    ip: ip || null,
    user_agent: userAgent || null,
  })
  if (error) throw new Error(`Failed to start host impersonation log: ${error.message}`)
  const cookieStore = await cookies()
  cookieStore.set(HOST_IMPERSONATE_COOKIE, hostId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_SECONDS,
    path: '/',
  })
}

/** Close the open row + clear the cookie. */
export async function stopHostImpersonation({ adminUserId }) {
  const db = createServerClient()
  await db.from('host_impersonation_log')
    .update({ ended_at: new Date().toISOString() })
    .eq('admin_user_id', adminUserId).is('ended_at', null)
  const cookieStore = await cookies()
  cookieStore.set(HOST_IMPERSONATE_COOKIE, '', { maxAge: 0, path: '/' })
}
```

Note: exactly ONE `cookieStore.set(...)` per function (avoids the ASI gotcha documented in impersonation.js where two back-to-back `(await cookies()).set(...)` lines misparse).

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/host-impersonation.test.js` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/host-impersonation.js src/lib/host-impersonation.test.js
git commit -m "HOST-PORTAL.4 — host-impersonation lib: cookie + audited start/stop + canImpersonateHost"
```

---

## Task 3: Extend getCurrentHost with the impersonation fallback

**Files:** Modify `src/lib/host-auth.js`

- [ ] **Step 1: Rewrite `getCurrentHost()` + add the resolver**

Replace the body of `getCurrentHost()` and add a private helper. Keep `HOST_PORTAL_COLS` as-is. New code:

```js
import { cookies } from 'next/headers'
import { createAuthClient, getCurrentUser } from './auth'
import { createServerClient } from './supabase'
import { HOST_IMPERSONATE_COOKIE, canImpersonateHost } from './host-impersonation'

// ...HOST_PORTAL_COLS unchanged...

export async function getCurrentHost() {
  const db = createServerClient()

  // 1. A REAL host (host_users row) always resolves to themselves.
  let authUser = null
  try {
    const sb = await createAuthClient()
    const { data } = await sb.auth.getUser()
    authUser = data?.user || null
  } catch { authUser = null }

  if (authUser) {
    const { data: link } = await db
      .from('host_users')
      .select(`host_id, event_hosts:host_id ( ${HOST_PORTAL_COLS} )`)
      .eq('auth_user_id', authUser.id)
      .maybeSingle()
    const host = link?.event_hosts || null
    if (host) return { host, authUserId: authUser.id, email: authUser.email || null }
  }

  // 2. ADMIN view-as via the un1t_host_impersonate cookie (HOST-PORTAL.4).
  return resolveHostImpersonation(db)
}

// Admin "view as host": honor the cookie ONLY for an ADMIN whose org owns the
// host. Re-validated every call, so a stale/tampered cookie grants nothing.
async function resolveHostImpersonation(db) {
  const cookieStore = await cookies()
  const hostId = cookieStore.get(HOST_IMPERSONATE_COOKIE)?.value
  if (!hostId) return null

  const user = await getCurrentUser()
  if (!canImpersonateHost(user)) return null
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return null

  // Org-scoped load (the .eq organization_id IS the IDOR guard) in the portal shape.
  const { data: host } = await db
    .from('event_hosts')
    .select(HOST_PORTAL_COLS)
    .eq('id', hostId)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!host) return null

  return { host, authUserId: user.id, email: user.email || null, impersonatedBy: { id: user.id } }
}
```

Also update the file header comment: note that view-as (HOST-PORTAL.4) is a transient ADMIN override honored here — it does NOT create a `host_users` row, so the STAFF-XOR invariant still holds (no persistent dual account).

- [ ] **Step 2: Write the failing test** — Create `src/lib/host-auth.test.js`. Because `getCurrentHost` wires `cookies()`/`createAuthClient`/`getCurrentUser`, test the SECURITY-CRITICAL decision via the pure predicate + document the branch. Minimum test (predicate already covered in Task 2); add an integration-style test only if a clean mock seam exists. If not practical, note it and rely on the adversarial review + build. (Do NOT fake-pass.)

Concretely, add to `src/lib/host-impersonation.test.js` a table asserting the resolver's decision rule as pure logic by extracting it: refactor the org+admin decision into a tiny pure helper `impersonationHostQueryAllowed(user)` === `canImpersonateHost(user) && !!(user.activeOrganization?.id || user.activeLocation?.organization_id)` and test it:

```js
import { impersonationHostQueryAllowed } from './host-impersonation'
describe('impersonationHostQueryAllowed', () => {
  it('needs an admin AND a resolvable org', () => {
    expect(impersonationHostQueryAllowed({ role: 'owner', activeOrganization: { id: 'o1' } })).toBe(true)
    expect(impersonationHostQueryAllowed({ role: 'owner', activeLocation: { organization_id: 'o1' } })).toBe(true)
    expect(impersonationHostQueryAllowed({ role: 'owner' })).toBe(false) // no org
    expect(impersonationHostQueryAllowed({ role: 'staff', activeOrganization: { id: 'o1' } })).toBe(false)
    expect(impersonationHostQueryAllowed(null)).toBe(false)
  })
})
```

Add `impersonationHostQueryAllowed` to `host-impersonation.js`:
```js
export function impersonationHostQueryAllowed(user) {
  const orgId = user?.activeOrganization?.id || user?.activeLocation?.organization_id || null
  return canImpersonateHost(user) && !!orgId
}
```
and use it in `resolveHostImpersonation` (replace the two-line admin+org check with `if (!impersonationHostQueryAllowed(user)) return null`).

- [ ] **Step 3: Run** — `npx vitest run src/lib/host-impersonation.test.js` → PASS.
- [ ] **Step 4: Build** — `npm run build` (host-auth is imported widely; must resolve). Confirm no import cycle error (host-auth ↔ host-impersonation ↔ auth): host-impersonation imports only `supabase`+`schemas`+`next/headers` (NOT host-auth), so no cycle.
- [ ] **Step 5: Commit**

```bash
git add src/lib/host-auth.js src/lib/host-impersonation.js src/lib/host-impersonation.test.js
git commit -m "HOST-PORTAL.4 — getCurrentHost: admin view-as fallback (org-scoped, re-validated)"
```

---

## Task 4: Impersonate + exit routes

**Files:** Create `src/app/api/hosts/[id]/impersonate/route.js` + `src/app/api/hosts/impersonate/exit/route.js`

- [ ] **Step 1: Implement the start route**

```js
// POST /api/hosts/[id]/impersonate — start an admin view-as-host session.
// ADMIN_ROLES; the host must be in the caller's org. (HOST-PORTAL.4)
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { startHostImpersonation } from '@/lib/host-impersonation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.includes(user.role)) return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  await startHostImpersonation({
    adminUserId: user.id,
    hostId: host.id,
    organizationId: orgId,
    ip: request.headers.get('x-forwarded-for') || null,
    userAgent: request.headers.get('user-agent') || null,
  })
  return NextResponse.json({ success: true, data: { hostId: host.id } })
}
```

- [ ] **Step 2: Implement the exit route**

```js
// POST /api/hosts/impersonate/exit — end the caller's view-as-host session.
// The admin's staff session is untouched (the host cookie is additive), so
// getCurrentUser still resolves them. (HOST-PORTAL.4)
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { stopHostImpersonation } from '@/lib/host-impersonation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  await stopHostImpersonation({ adminUserId: user.id })
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 3: Verify** — `npm run check:route-guards` (both getCurrentUser-guarded). `npm run build` — confirm `/api/hosts/[id]/impersonate` AND `/api/hosts/impersonate/exit` BOTH appear (Next resolves the literal `impersonate/exit` folder distinctly from `[id]`; a host id is a uuid, never the literal "impersonate").
- [ ] **Step 4: Commit**

```bash
git add "src/app/api/hosts/[id]/impersonate/route.js" "src/app/api/hosts/impersonate/exit/route.js"
git commit -m "HOST-PORTAL.4 — impersonate start + exit routes (ADMIN, org-scoped)"
```

---

## Task 5: UI — "Open host portal" button + impersonation banner

**Files:** Create `src/components/host/HostImpersonationBanner.jsx`; Modify `src/components/settings/HostDetail.jsx`, `src/app/host/(portal)/layout.js`

- [ ] **Step 1: "Open host portal" button in `HostDetail.jsx`**

Add a button (the settings/hosts page is already ADMIN-gated). On click, `POST /api/hosts/${hostId}/impersonate`; on `{success:true}`, do a **full navigation** so the new cookie is sent: `window.location.href = '/host'`. Match the file's existing button styling (`@/components/ui` `Button`, light theme) + its fetch/error pattern (read a neighbouring action like the portal invite in the same file). Label: "Open host portal". Place it in the "Host portal" card near the "Invite to portal" button. Set `type="button"`.

- [ ] **Step 2: `HostImpersonationBanner.jsx`** (client)

```jsx
'use client'
import { useState } from 'react'

export default function HostImpersonationBanner({ hostName }) {
  const [exiting, setExiting] = useState(false)
  async function exit() {
    setExiting(true)
    try {
      await fetch('/api/hosts/impersonate/exit', { method: 'POST' })
    } finally {
      window.location.href = '/settings/hosts'
    }
  }
  return (
    <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-200 text-sm">
      <div className="max-w-4xl mx-auto px-4 h-10 flex items-center justify-between gap-3">
        <span>Viewing <strong>{hostName}</strong>&apos;s portal as admin.</span>
        <button type="button" onClick={exit} disabled={exiting} className="shrink-0 rounded-lg bg-white text-black text-xs font-semibold px-3 py-1.5 hover:bg-white/90 disabled:opacity-60">
          {exiting ? 'Exiting…' : 'Exit to CRM'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Wire the banner + swap Sign-out in `layout.js`**

In `src/app/host/(portal)/layout.js`: after `const session = await getCurrentHost()`, when `session.impersonatedBy` is set, render `<HostImpersonationBanner hostName={session.host.name} />` ABOVE the `<header>`, and render **"Exit to CRM"** (or nothing) instead of `<HostSignOut />` in the header — because `HostSignOut` calls `supabase.auth.signOut()`, which would kill the ADMIN's staff session. Concretely: `{session.impersonatedBy ? null : <HostSignOut />}` in the header (the banner already provides Exit). Import `HostImpersonationBanner`.

- [ ] **Step 4: Verify** — `npm run lint` (0 errors; watch chip-contrast — the banner is on the bg-black host surface, already exempted in `eslint.guardrails.config.mjs`), `npm run build` (all host pages compile).
- [ ] **Step 5: Commit**

```bash
git add src/components/host/HostImpersonationBanner.jsx src/components/settings/HostDetail.jsx "src/app/host/(portal)/layout.js"
git commit -m "HOST-PORTAL.4 — Open host portal button + view-as banner (Exit not Sign-out)"
```

---

## Task 6: Final CI + adversarial review + PR

- [ ] **Step 1: Full CI mirror + build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
npm run build
```
All green; build lists `/api/hosts/[id]/impersonate` + `/api/hosts/impersonate/exit`.

- [ ] **Step 2: Adversarial review** (single strong agent or 2-lens workflow) on:
  1. **Resolver security** — can a non-admin (staff/head_coach) or a cross-org admin resolve an impersonated host? Confirm `resolveHostImpersonation` re-checks `canImpersonateHost` + `.eq('organization_id', orgId)` EVERY call; a stale/tampered cookie grants nothing; a real host (host_users) still wins first + can't be hijacked.
  2. **Session integrity** — does the host cookie ever damage the admin's staff session? Does "Exit" fully clear the cookie + close the log row? Does the portal show Exit (not Sign-out) so the admin can't nuke their staff session? Can a real host reach the impersonate routes (they have no getCurrentUser → 401)?
- [ ] **Step 3:** Fix any confirmed findings; re-run CI + build.
- [ ] **Step 4: Push + PR**

```bash
git push -u origin admin-view-as-host
gh pr create --base main --title "HOST-PORTAL.4 — admin view-as-host" --fill
```

---

## Self-Review (completed at write time)

- **Spec coverage:** mechanism/getCurrentHost (Task 3), audit table (Task 1), lib/cookie/start-stop (Task 2), routes (Task 4), button + banner + Exit-not-Sign-out (Task 5), security re-validation (Task 3 resolver + Task 6 review), full-manage (inherited — no route changes). ✓
- **Placeholder scan:** Task 3 Step 2 gives a concrete pure helper (`impersonationHostQueryAllowed`) + real tests rather than "add tests" — no placeholder. ✓
- **Type consistency:** `HOST_IMPERSONATE_COOKIE`, `canImpersonateHost`, `impersonationHostQueryAllowed`, `startHostImpersonation({adminUserId,hostId,organizationId,ip,userAgent})`, `stopHostImpersonation({adminUserId})`, session shape `{host,authUserId,email,impersonatedBy:{id}}` consistent across Tasks 2–5. ✓
- **Firewall:** no `host_users` write anywhere — STAFF-XOR preserved. ✓
