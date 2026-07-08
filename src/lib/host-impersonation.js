// Admin "view as host" (HOST-PORTAL.4). The host analog of impersonation.js:
// a un1t_host_impersonate cookie names the host_id an ADMIN is viewing, with an
// audited open/close lifecycle in host_impersonation_log. getCurrentHost honors
// the cookie ONLY after re-checking ADMIN_ROLES + org membership per request.
import { cookies } from 'next/headers'
import { createServerClient } from './supabase'
import { ADMIN_ROLES } from './schemas'

export const HOST_IMPERSONATE_COOKIE = 'un1t_host_impersonate'
const MAX_AGE_SECONDS = 60 * 60 * 8 // 8h; the per-request re-check is the real guard

/** Pure: may this resolved staff user view-as a host? (the org check is done by the caller) */
export function canImpersonateHost(user) {
  return !!user && ADMIN_ROLES.includes(user.role)
}

/** Pure: admin AND has a resolvable active org (both are prerequisites to run the host lookup). */
export function impersonationHostQueryAllowed(user) {
  const orgId = user?.activeOrganization?.id || user?.activeLocation?.organization_id || null
  return canImpersonateHost(user) && !!orgId
}

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

export async function stopHostImpersonation({ adminUserId }) {
  const db = createServerClient()
  await db.from('host_impersonation_log')
    .update({ ended_at: new Date().toISOString() })
    .eq('admin_user_id', adminUserId).is('ended_at', null)
  const cookieStore = await cookies()
  cookieStore.set(HOST_IMPERSONATE_COOKIE, '', { maxAge: 0, path: '/' })
}
