// Master impersonation helpers.
//
// A master can sign in as another user to replicate their experience
// for debugging. Implementation is cookie-based — the master's real
// auth session stays intact, we just override which profile
// `getCurrentUser()` returns when an impersonation cookie is present
// AND the underlying session is a master.
//
// Cookie name:    un1t_impersonate
// Cookie value:   the target user's UUID
// Cookie scope:   httpOnly, sameSite lax, ~24h max-age
// Resolved by:    src/lib/auth.js#getCurrentUser
// Audited via:    impersonation_log table (mig 035)
//
// Stopping impersonation clears the cookie and sets ended_at on the
// matching log row. Starting a new session on top of an existing one
// implicitly closes the old one first (no double-active rows).

import { cookies, headers } from 'next/headers'
import { createServerClient } from './supabase'

export const IMPERSONATE_COOKIE = 'un1t_impersonate'
export const IMPERSONATE_HEADER = 'x-impersonate-target'
const ONE_DAY_SECONDS = 24 * 60 * 60

/**
 * Read the impersonation cookie. Returns the target user's UUID
 * (still validated downstream — never trusted on its own — getCurrentUser
 * also re-checks that the underlying session belongs to a master).
 */
export function readImpersonationCookie() {
  try {
    const v = cookies().get(IMPERSONATE_COOKIE)?.value
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null
  } catch {
    // Not in a request context.
    return null
  }
}

/**
 * Read the impersonation HEADER. Mobile clients can't set cookies, so
 * they signal impersonation via x-impersonate-target on each request.
 * Like the cookie path, the value is still master-gated downstream
 * inside getCurrentUser() — a non-master JWT sending this header has
 * the value silently ignored. Returns the target user's UUID.
 */
export function readImpersonationHeader() {
  try {
    const v = headers().get(IMPERSONATE_HEADER) || ''
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Combined cookie+header read. Header wins if both are set (mobile
 * client should be authoritative when both are present, e.g. a
 * developer running the iOS sim against a logged-in dev cookie).
 */
export function readImpersonationTarget() {
  return readImpersonationHeader() || readImpersonationCookie()
}

/**
 * Set the cookie + write the audit row. Service-role DB so RLS doesn't
 * trip the SELECT before the underlying session is master-confirmed
 * by the caller.
 *
 * @param {object} masterProfile  Already-confirmed master profile from getCurrentUser
 * @param {string} targetUserId   UUID of the user to impersonate
 * @param {string|null} reason    Optional free-text
 * @param {{ ip?: string, userAgent?: string }} req
 */
export async function startImpersonation({ masterProfile, targetUserId, reason, ip, userAgent }) {
  if (!masterProfile || masterProfile.role !== 'master') {
    throw new Error('Only master accounts can start an impersonation session.')
  }
  if (!targetUserId || targetUserId === masterProfile.id) {
    throw new Error('Cannot impersonate yourself.')
  }

  const db = createServerClient()
  // Verify target exists.
  const { data: target, error: tErr } = await db
    .from('profiles')
    .select('id, full_name, role, active')
    .eq('id', targetUserId)
    .single()
  if (tErr || !target) throw new Error('Target user not found.')

  // Close any currently-active impersonation row for this master so
  // there's never more than one open at a time.
  await db
    .from('impersonation_log')
    .update({ ended_at: new Date().toISOString() })
    .eq('master_user_id', masterProfile.id)
    .is('ended_at', null)

  // Insert the new row.
  const { error: insErr } = await db.from('impersonation_log').insert({
    master_user_id: masterProfile.id,
    target_user_id: targetUserId,
    ip: ip || null,
    user_agent: userAgent || null,
    reason: reason || null,
  })
  if (insErr) throw new Error(`Failed to start impersonation log: ${insErr.message}`)

  // Set the impersonation cookie.
  cookies().set(IMPERSONATE_COOKIE, targetUserId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ONE_DAY_SECONDS,
    path: '/',
  })

  // Clear the master's active-location cookie so the impersonated
  // user lands at THEIR default location rather than wherever the
  // master was last viewing. Without this, a target user who happens
  // to be assigned to the same location as the master sees that
  // location's feature gate (often quite different from their own
  // default's), which is misleading for "view as user" debugging.
  cookies().set('un1t_active_location', '', { maxAge: 0, path: '/' })

  return { targetUserId, targetName: target.full_name, targetRole: target.role }
}

/**
 * Clear the cookie and stamp ended_at on the active log row.
 *
 * @param {string} masterUserId  UUID of the master whose session to close
 */
export async function stopImpersonation({ masterUserId }) {
  const db = createServerClient()
  await db
    .from('impersonation_log')
    .update({ ended_at: new Date().toISOString() })
    .eq('master_user_id', masterUserId)
    .is('ended_at', null)

  cookies().set(IMPERSONATE_COOKIE, '', { maxAge: 0, path: '/' })
  // Also clear any stale active-location cookie that was leftover
  // from the impersonated user's preferred location — masters
  // returning to their own session should land on their own default
  // rather than wherever the target was. (Master sees every location
  // anyway via auth_is_master, so the worst case is "wrong default
  // pre-selected".)
  cookies().set('un1t_active_location', '', { maxAge: 0, path: '/' })
}
