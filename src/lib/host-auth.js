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
// PROVISIONING DISCIPLINE: never give one auth user BOTH a profiles row and a
// host_users row — that would resolve as staff AND host. The future "invite
// host" flow must create a dedicated auth user per host (never link a staff
// login). There's no DB XOR constraint (mirrors the member `contacts.user_id`
// model); it's an invariant the provisioning path must uphold.

import { createAuthClient } from './auth'
import { createServerClient } from './supabase'

// Non-sensitive host fields the portal reads. Never the access_token.
const HOST_PORTAL_COLS =
  'id, name, email, organization_id, payment_provider, ' +
  'charges_enabled, payouts_enabled, details_submitted, ' +
  'stripe_connected_account_id, onboarding_completed_at, platform_fee_cents'

/**
 * The current host, or null. `null` means "not a host session" — the caller
 * (a /host page layout or an /api/host route) redirects to /host/login or 401s.
 * @returns {Promise<{ host: object, authUserId: string, email: string|null }|null>}
 */
export async function getCurrentHost() {
  let authUser = null
  try {
    const sb = await createAuthClient()
    const { data } = await sb.auth.getUser()
    authUser = data?.user || null
  } catch {
    return null
  }
  if (!authUser) return null

  // Service-role: the link table + host row are read past RLS, then scoped in
  // code to THIS auth user. A host can only ever resolve to their own host_id.
  const db = createServerClient()
  const { data: link } = await db
    .from('host_users')
    .select(`host_id, event_hosts:host_id ( ${HOST_PORTAL_COLS} )`)
    .eq('auth_user_id', authUser.id)
    .maybeSingle()

  const host = link?.event_hosts || null
  if (!host) return null
  return { host, authUserId: authUser.id, email: authUser.email || null }
}
