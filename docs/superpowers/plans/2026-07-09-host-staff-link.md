# Link a Staff Login to a Host — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin attach an existing UN1T staff member (by email) to a host, so that one login works as staff in the CRM *and* as that host in the portal — with a "Host portal" sidebar link for the linked user, and an unlink to revoke.

**Architecture:** A deliberate, admin+org-gated exception to the STAFF-XOR firewall: a new route creates a `host_users` row for an *existing staff* auth user (the resolvers already support a user being both). No migration (`host_users` from mig 386 suffices). The sidebar shows a "Host portal" link when the logged-in user has a `host_users` row.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role), Zod, Vitest. Spec: `docs/superpowers/specs/2026-07-09-host-staff-link-design.md`.

---

## File Structure

**Create:**
- `src/lib/host-staff-link.js` — pure `linkStaffDecision(...)` (the eligibility branch logic).
- `src/lib/host-staff-link.test.js` — unit tests for it.
- `src/app/api/hosts/[id]/link-staff/route.js` — GET (list links) + POST (link) + DELETE (unlink).

**Modify:**
- `src/components/settings/HostDetail.jsx` — a "Staff logins" subsection in the Host portal card.
- `src/components/AppShellServer.jsx` — resolve `isLinkedHost` for the current user.
- `src/components/AppShell.jsx` — forward `isLinkedHost` to `Sidebar`.
- `src/components/Sidebar.jsx` — render a "Host portal" → `/host` link when `isLinkedHost`.
- `src/lib/host-auth.js` + `src/app/api/hosts/[id]/invite/route.js` — one-line comment updates noting the deliberate link exception.

---

## Task 1: Pure eligibility helper

**Files:** Create `src/lib/host-staff-link.js` + `src/lib/host-staff-link.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/host-staff-link.test.js
import { describe, it, expect } from 'vitest'
import { linkStaffDecision } from './host-staff-link'

describe('linkStaffDecision', () => {
  const staff = { id: 'u1', full_name: 'Sam', email: 's@x.ie' }
  it('ok: staff, same org, no existing link', () => {
    expect(linkStaffDecision({ staffProfile: staff, sameOrg: true, existingLink: null, hostId: 'h1' })).toBe('ok')
  })
  it('not_staff: no profiles row', () => {
    expect(linkStaffDecision({ staffProfile: null, sameOrg: true, existingLink: null, hostId: 'h1' })).toBe('not_staff')
  })
  it('cross_org: staff not in the admin org', () => {
    expect(linkStaffDecision({ staffProfile: staff, sameOrg: false, existingLink: null, hostId: 'h1' })).toBe('cross_org')
  })
  it('already: already linked to THIS host', () => {
    expect(linkStaffDecision({ staffProfile: staff, sameOrg: true, existingLink: { host_id: 'h1' }, hostId: 'h1' })).toBe('already')
  })
  it('other_host: linked to a different host', () => {
    expect(linkStaffDecision({ staffProfile: staff, sameOrg: true, existingLink: { host_id: 'h2' }, hostId: 'h1' })).toBe('other_host')
  })
  it('not_staff takes precedence over org/link', () => {
    expect(linkStaffDecision({ staffProfile: null, sameOrg: false, existingLink: { host_id: 'h2' }, hostId: 'h1' })).toBe('not_staff')
  })
})
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/lib/host-staff-link.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/host-staff-link.js`**

```js
// Link an existing UN1T staff login to a host (HOST-PORTAL.5). Pure decision:
// given the resolved staff profile, whether they share the admin's org, and any
// existing host_users link, decide the outcome. The route maps each to a message.
// Order matters: not_staff first (a non-staff email must never be linked here —
// that would side-door a brand-new dual account; use the invite flow instead).

/**
 * @param {{ staffProfile: object|null, sameOrg: boolean, existingLink: {host_id:string}|null, hostId: string }} args
 * @returns {'ok'|'not_staff'|'cross_org'|'already'|'other_host'}
 */
export function linkStaffDecision({ staffProfile, sameOrg, existingLink, hostId }) {
  if (!staffProfile) return 'not_staff'
  if (!sameOrg) return 'cross_org'
  if (existingLink) return existingLink.host_id === hostId ? 'already' : 'other_host'
  return 'ok'
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/host-staff-link.test.js` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/host-staff-link.js src/lib/host-staff-link.test.js
git commit -m "HOST-PORTAL.5 — linkStaffDecision eligibility helper"
```

---

## Task 2: Link/unlink/list API

**Files:** Create `src/app/api/hosts/[id]/link-staff/route.js`

- [ ] **Step 1: Implement GET + POST + DELETE**

```js
// GET/POST/DELETE /api/hosts/[id]/link-staff — link an existing UN1T staff login
// to a host (dual staff+host account). ADMIN_ROLES; host + staff user must be in
// the caller's org. Deliberate STAFF-XOR exception (see host-auth.js). (HOST-PORTAL.5)
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { linkStaffDecision } from '@/lib/host-staff-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LinkSchema = z.object({ email: z.string().email().max(320) })
const UnlinkSchema = z.object({ auth_user_id: z.string().min(1) })

async function gate(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return { err: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!ADMIN_ROLES.includes(user.role)) return { err: NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 }) }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return { err: NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 }) }
  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, orgId)
  if (!host) return { err: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  return { db, orgId, hostId: host.id, user }
}

// True when the staff profile shares the admin's org (via profile_locations → locations).
async function staffSharesOrg(db, staffId, orgId) {
  const { data: pls } = await db.from('profile_locations').select('location_id').eq('profile_id', staffId)
  const locIds = (pls || []).map((r) => r.location_id)
  if (locIds.length === 0) return false
  const { data: locs } = await db.from('locations').select('id').in('id', locIds).eq('organization_id', orgId)
  return (locs || []).length > 0
}

export async function GET(_request, props) {
  const g = await gate(props); if (g.err) return g.err
  const { db, hostId } = g
  const { data: links } = await db
    .from('host_users')
    .select('auth_user_id, email, profiles:auth_user_id ( full_name )')
    .eq('host_id', hostId)
  const rows = (links || []).map((l) => ({ auth_user_id: l.auth_user_id, email: l.email, full_name: l.profiles?.full_name || null }))
  return NextResponse.json({ success: true, data: rows })
}

export async function POST(request, props) {
  const g = await gate(props); if (g.err) return g.err
  const { db, orgId, hostId } = g

  let body; try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = LinkSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Enter a valid email.' }, { status: 400 })
  const email = parsed.data.email.trim()

  // Resolve the staff user (profiles.id === auth.users.id). Case-insensitive.
  const { data: staffProfile } = await db.from('profiles').select('id, full_name, email').ilike('email', email).maybeSingle()
  const sameOrg = staffProfile ? await staffSharesOrg(db, staffProfile.id, orgId) : false
  const existingLink = staffProfile
    ? (await db.from('host_users').select('host_id').eq('auth_user_id', staffProfile.id).maybeSingle()).data
    : null

  const decision = linkStaffDecision({ staffProfile, sameOrg, existingLink, hostId })
  const errors = {
    not_staff: "That email isn’t a UN1T staff account — use “Invite to portal” for a 3rd-party host on a separate email.",
    cross_org: 'That staff member is not in this organisation.',
    other_host: 'That staff member is already linked to another host.',
  }
  if (decision === 'already') return NextResponse.json({ success: true, data: { already: true, full_name: staffProfile.full_name, email: staffProfile.email } })
  if (decision !== 'ok') return NextResponse.json({ success: false, error: errors[decision] }, { status: 400 })

  const { error: insErr } = await db.from('host_users').insert({ host_id: hostId, auth_user_id: staffProfile.id, email: staffProfile.email || email })
  if (insErr) return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })
  return NextResponse.json({ success: true, data: { linked: { full_name: staffProfile.full_name, email: staffProfile.email || email } } })
}

export async function DELETE(request, props) {
  const g = await gate(props); if (g.err) return g.err
  const { db, hostId } = g
  let body; try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = UnlinkSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid request.' }, { status: 400 })
  const { error } = await db.from('host_users').delete().eq('host_id', hostId).eq('auth_user_id', parsed.data.auth_user_id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
```

Note: the `host_users → profiles:auth_user_id ( full_name )` embed relies on the FK `host_users.auth_user_id → auth.users` and `profiles.id → auth.users` — if PostgREST can't infer that embed, fall back to a second query (`profiles.select('id, full_name').in('id', authUserIds)`) and map by id. Verify which works during implementation.

- [ ] **Step 2: Guard + build** — `npm run check:route-guards` (getCurrentUser recognised), `npm run build` (route compiles; `/api/hosts/[id]/link-staff` present).
- [ ] **Step 3: Commit**

```bash
git add "src/app/api/hosts/[id]/link-staff/route.js"
git commit -m "HOST-PORTAL.5 — link-staff route (GET/POST/DELETE, ADMIN + org-gated)"
```

---

## Task 3: HostDetail — "Staff logins" subsection

**Files:** Modify `src/components/settings/HostDetail.jsx`

- [ ] **Step 1: Add the subsection**

READ the file first — reuse its existing fetch/error/loading state pattern (see `inviteToPortal`/`openPortal`). In the `<Card title="Host portal">`, below the existing buttons, add a "Staff logins" block:
- State: `links` (array), `linkEmail` (string), `linkError`, `linkBusy`.
- On mount (and after mutations), `GET /api/hosts/${hostId}/link-staff` → `setLinks(data)`.
- An email `<input>` + **"Link staff login"** `Button` (`type="button"`): `POST /api/hosts/${hostId}/link-staff` `{ email: linkEmail }`; on `{success:true}` clear the input, re-fetch the list, surface any `error`.
- Render each link: `full_name || email` + email + an **Unlink** `Button` (`type="button"`) → `DELETE /api/hosts/${hostId}/link-staff` `{ auth_user_id }` → re-fetch.
- Helper text: "Give an existing UN1T staff member access to this host's portal with their normal login."
- Use `@/components/ui` primitives + light `un1t-*` tokens to match the card. Every `<button>` gets an explicit `type`.

- [ ] **Step 2: Verify** — `npm run lint` (0 errors), `npm run build`.
- [ ] **Step 3: Commit**

```bash
git add src/components/settings/HostDetail.jsx
git commit -m "HOST-PORTAL.5 — HostDetail: link/unlink staff logins UI"
```

---

## Task 4: Sidebar "Host portal" link for linked hosts

**Files:** Modify `src/components/AppShellServer.jsx`, `src/components/AppShell.jsx`, `src/components/Sidebar.jsx`

- [ ] **Step 1: Resolve `isLinkedHost` in `AppShellServer.jsx`**

```jsx
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import AppShell from './AppShell'

export default async function AppShellServer({ children }) {
  const user = await getCurrentUser()
  let isLinkedHost = false
  if (user?.id) {
    const db = createServerClient()
    const { data } = await db.from('host_users').select('auth_user_id').eq('auth_user_id', user.id).maybeSingle()
    isLinkedHost = !!data
  }
  return <AppShell user={user} isLinkedHost={isLinkedHost}>{children}</AppShell>
}
```

- [ ] **Step 2: Forward it in `AppShell.jsx`**

READ the file. The component signature is `AppShell({ user, children, ... })` (client component). Add `isLinkedHost` to the props and pass it to `<Sidebar user={user} isLinkedHost={isLinkedHost} ... />` (line ~88).

- [ ] **Step 3: Render the link in `Sidebar.jsx`**

READ the file. The signature is `Sidebar({ user, mobileOpen, onMobileClose })` — add `isLinkedHost = false`. Render a "Host portal" `<Link href="/host">` (with a fitting lucide icon, e.g. `Store` or `ExternalLink`) that is shown **only when `isLinkedHost`**, styled like the other nav leaves (reuse `leafClassName`/the existing Link classes). Place it as a distinct item — e.g. just above the `/account` link near the bottom (line ~356), outside the `ALL_NAV` permission-filtered list (this link is gated on being a linked host, not on a permission). It navigates to the host portal on the same domain (`/host`), so a normal `<Link>` is fine.

- [ ] **Step 4: Verify** — `npm run lint`, `npm run build` (the shell + sidebar compile; `/host` link renders).
- [ ] **Step 5: Commit**

```bash
git add src/components/AppShellServer.jsx src/components/AppShell.jsx src/components/Sidebar.jsx
git commit -m "HOST-PORTAL.5 — sidebar Host portal link for linked staff-hosts"
```

---

## Task 5: Document the firewall exception

**Files:** Modify `src/lib/host-auth.js`, `src/app/api/hosts/[id]/invite/route.js`

- [ ] **Step 1: Update the comments**

In `src/lib/host-auth.js`'s header comment (the STAFF-XOR / provisioning-discipline note), add: a user MAY hold both a `profiles` and a `host_users` row **only** via the deliberate admin action `POST /api/hosts/[id]/link-staff` (HOST-PORTAL.5) — an existing staff member given host access to a host in their org. The *invite* path + mig 387 still forbid it for 3rd-party hosts (no CRM access for a pure host).

In `src/app/api/hosts/[id]/invite/route.js`'s STAFF-XOR comment, add a one-liner: the invite refuses a staff email on purpose; to give a staff member host access, use `link-staff` instead.

- [ ] **Step 2: Commit** — `git commit -am "HOST-PORTAL.5 — document the deliberate staff↔host link exception"`

---

## Task 6: Final CI + adversarial review + PR

- [ ] **Step 1: Full CI mirror + build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
npm run build
```
All green; build lists `/api/hosts/[id]/link-staff`.

- [ ] **Step 2: Adversarial review** (single strong agent or 2-lens workflow) on:
  1. **Authorization:** can a non-admin or cross-org user link/unlink? Is `orgId` session-derived? Does `loadHostForOrg` 404 a cross-org host? Does `staffSharesOrg` correctly reject a staff user outside the org? Can the staff-target check be bypassed to link a non-staff (pure host / arbitrary) auth user?
  2. **Escalation / blast radius:** the change only ADDS host access to an existing staff user — confirm it can NEVER grant CRM/staff access to a pure host (invite + mig 387 unchanged; no `profiles` write anywhere). Confirm unlink is scoped to `(host_id, auth_user_id)` so an admin can't remove another org's link. Confirm `UNIQUE(auth_user_id)` still bounds one host per login. Confirm a linked staff-host's `getCurrentHost` resolves to their own host only.
- [ ] **Step 3:** Fix confirmed findings; re-run CI + build.
- [ ] **Step 4: Push + PR**

```bash
git push -u origin host-staff-link
gh pr create --base main --title "HOST-PORTAL.5 — link a staff login to a host" --fill
```

---

## Self-Review (completed at write time)

- **Spec coverage:** link/unlink/list API (Task 2), eligibility branches (Task 1), HostDetail UI (Task 3), sidebar entry point (Task 4), firewall doc (Task 5), security review (Task 6). No migration (host_users exists) ✓. View-as precedence + subdomain limits are documented in the spec (no code needed). ✓
- **Placeholder scan:** the two "verify which embed works / fall back to a second query" notes are explicit implementation checks against live schema, not deferred logic. ✓
- **Type consistency:** `linkStaffDecision({ staffProfile, sameOrg, existingLink, hostId })` return set `'ok'|'not_staff'|'cross_org'|'already'|'other_host'` consistent between Task 1 (helper+test) and Task 2 (route mapping); `isLinkedHost` prop name consistent across Tasks 4. ✓
