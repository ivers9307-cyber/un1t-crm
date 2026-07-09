// Host-portal authentication (HOST-PORTAL.1).
//
// Resolves the logged-in HOST (event_hosts) from the Supabase session cookie —
// the host analog of getCurrentUser (staff) / resolveCustomerContact (members).
// A host auth user has a host_users row → event_hosts but NO profiles row, so:
//   - getCurrentHost() returns null for staff users (no host_users row)
//   - getCurrentUser() returns null for host users (no profiles row)
// i.e. the staff CRM and the host portal are cleanly firewalled over the shared
// auth.users table. Server-only.
//
// PROVISIONING DISCIPLINE: by default, never give one auth user BOTH a profiles
// row and a host_users row — that would resolve as staff AND host. The "invite
// host" flow creates a dedicated auth user per host and refuses a staff email;
// with mig 387 (host-portal invites make no profiles row) a pure 3rd-party host
// never gets CRM access. There's no DB XOR constraint (mirrors the member
// `contacts.user_id` model); it's an invariant the invite path upholds.
//
// DELIBERATE EXCEPTION (HOST-PORTAL.5): a user MAY hold BOTH rows when an admin
// links an EXISTING staff member to a host in their org via the admin action
// POST /api/hosts/[id]/link-staff — that one login is intentionally staff (CRM)
// AND host (portal): getCurrentHost resolves them as the host, getCurrentUser
// still resolves them as staff. This applies ONLY to that admin link action;
// the invite path + mig 387 still forbid it for 3rd-party hosts.
//
// ADMIN VIEW-AS (HOST-PORTAL.4): getCurrentHost also falls through to a
// transient admin override (resolveHostImpersonation) — an ADMIN whose org owns
// the host may act as that host via the un1t_host_impersonate cookie. It's
// re-validated (ADMIN_ROLES + org ownership) every request and creates NO
// host_users row, so the STAFF-XOR invariant above still holds (the admin stays
// a staff user; nothing persistent makes them a host).

import { cookies } from 'next/headers'
import { createAuthClient, getCurrentUser } from './auth'
import { createServerClient } from './supabase'
import { HOST_IMPERSONATE_COOKIE, impersonationHostQueryAllowed } from './host-impersonation'

// Non-sensitive host fields the portal reads. Never the access_token.
const HOST_PORTAL_COLS =
  'id, name, email, organization_id, payment_provider, ' +
  'charges_enabled, payouts_enabled, details_submitted, ' +
  'stripe_connected_account_id, onboarding_completed_at, platform_fee_cents'

/**
 * The current host, or null. `null` means "not a host session" — the caller
 * (a /host page layout or an /api/host route) redirects to /host/login or 401s.
 * @returns {Promise<{ host: object, authUserId: string, email: string|null, impersonatedBy?: { id: string } }|null>}
 */
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
    // Service-role: the link table + host row are read past RLS, then scoped in
    // code to THIS auth user. A host can only ever resolve to their own host_id.
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
// host. Re-validated every call — a stale/tampered cookie grants nothing.
async function resolveHostImpersonation(db) {
  const cookieStore = await cookies()
  const hostId = cookieStore.get(HOST_IMPERSONATE_COOKIE)?.value
  if (!hostId) return null

  const user = await getCurrentUser()
  if (!impersonationHostQueryAllowed(user)) return null
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null

  // The .eq('organization_id', orgId) IS the IDOR guard; load the portal shape.
  const { data: host } = await db
    .from('event_hosts')
    .select(HOST_PORTAL_COLS)
    .eq('id', hostId)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!host) return null

  // Audit-authoritative: only an OPEN host_impersonation_log row counts as a
  // live view-as session. This makes exit fully effective (a lingering cookie
  // without an open row grants nothing) and mirrors the staff impersonation
  // gate in auth.js. Re-checked every request alongside the admin+org guard.
  // Query on hostId (what the cookie asserts) to stay symmetric with the cookie.
  // Known limitation: abandoned sessions rely on cookie expiry (8h); a
  // stale-open-row reaper is a follow-up.
  const { data: openRow } = await db
    .from('host_impersonation_log')
    .select('id')
    .eq('admin_user_id', user.id)
    .eq('host_id', hostId)
    .is('ended_at', null)
    .maybeSingle()
  if (!openRow) return null

  return { host, authUserId: user.id, email: user.email || null, impersonatedBy: { id: user.id } }
}
