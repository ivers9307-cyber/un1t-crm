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

// Max wall-clock lifetime of an impersonation session, shared across
// every surface so they can't drift: the web cookie max-age, the mobile
// SecureStore expiry (mobile/lib/impersonate.js MAX_AGE_MS), and the
// close-stale-impersonations reaper cutoff. Impersonation is a debugging
// tool ("view as user"), not a working session — a tight window bounds
// both the exposure of an abandoned session and the audit imprecision of
// a reaped row. Renewing is one click/tap. Change here = change
// everywhere (keep mobile MAX_AGE_MS in sync — there's no shared import
// across the web/native boundary).
export const IMPERSONATE_SESSION_MAX_AGE_SECONDS = 2 * 60 * 60

/**
 * Read the impersonation cookie. Returns the target user's UUID
 * (still validated downstream — never trusted on its own — getCurrentUser
 * also re-checks that the underlying session belongs to a master).
 *
 * Next 15+: cookies() returns a Promise so this is async.
 */
export async function readImpersonationCookie() {
  try {
    const v = (await cookies()).get(IMPERSONATE_COOKIE)?.value
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
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
 *
 * Next 15+: headers() returns a Promise so this is async.
 */
export async function readImpersonationHeader() {
  try {
    const v = (await headers()).get(IMPERSONATE_HEADER) || ''
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
  } catch {
    return null
  }
}

/**
 * Combined cookie+header read. Header wins if both are set (mobile
 * client should be authoritative when both are present, e.g. a
 * developer running the iOS sim against a logged-in dev cookie).
 *
 * Next 15+: async to match the underlying header/cookie readers.
 */
export async function readImpersonationTarget() {
  return (await readImpersonationHeader()) || (await readImpersonationCookie())
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

  // Set the impersonation cookie. Resolve the cookies store ONCE
  // up-front — two reasons: avoids a duplicate `await cookies()`,
  // and dodges JS's automatic-semicolon-insertion gotcha where two
  // back-to-back `(await cookies()).set(...)` statements get
  // parsed as `set(...)(await cookies())` — calling the cookie
  // store as a function (TypeError). The Next-14 sync version
  // didn't trip this because `cookies().set(...)` doesn't start
  // with `(`. Migrating to async made the leading-paren explicit
  // and silently broke the feature. See SESSION_STATE for the
  // bug write-up.
  const cookieStore = await cookies()
  cookieStore.set(IMPERSONATE_COOKIE, targetUserId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: IMPERSONATE_SESSION_MAX_AGE_SECONDS,
    path: '/',
  })

  // Clear the master's active-location cookie so the impersonated
  // user lands at THEIR default location rather than wherever the
  // master was last viewing. Without this, a target user who happens
  // to be assigned to the same location as the master sees that
  // location's feature gate (often quite different from their own
  // default's), which is misleading for "view as user" debugging.
  cookieStore.set('un1t_active_location', '', { maxAge: 0, path: '/' })

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

  // Same ASI-safety pattern as startImpersonation — resolve the
  // cookie store once and reuse, otherwise two leading-paren
  // `(await cookies()).set(...)` lines get parsed as a function
  // call on the first .set's return value.
  const cookieStore = await cookies()
  cookieStore.set(IMPERSONATE_COOKIE, '', { maxAge: 0, path: '/' })
  // Also clear any stale active-location cookie that was leftover
  // from the impersonated user's preferred location — masters
  // returning to their own session should land on their own default
  // rather than wherever the target was. (Master sees every location
  // anyway via auth_is_master, so the worst case is "wrong default
  // pre-selected".)
  cookieStore.set('un1t_active_location', '', { maxAge: 0, path: '/' })
}

/**
 * Pure planner — given the currently-open impersonation rows and a
 * reference time, decide which are past the session max-age and what
 * truthful ended_at to stamp on each.
 *
 * A session cannot outlive its max-age (the cookie/SecureStore both
 * expire then), so any row older than that is provably dead. We stamp
 * ended_at = started_at + max-age (the upper bound of when it could
 * still have been active), NOT `now`, so a reaper that runs hours later
 * doesn't inflate the recorded session duration.
 *
 * Pure: input → output, no IO. Tested in impersonation.test.js.
 *
 * @param {Array<{id:string, started_at:string}>} openRows
 * @param {number} now  epoch ms
 * @param {number} [maxAgeSeconds]
 * @returns {Array<{id:string, ended_at:string}>}
 */
export function planStaleImpersonationCloses(
  openRows,
  now,
  maxAgeSeconds = IMPERSONATE_SESSION_MAX_AGE_SECONDS,
) {
  const maxAgeMs = maxAgeSeconds * 1000
  const out = []
  for (const r of openRows || []) {
    const startMs = r?.started_at ? new Date(r.started_at).getTime() : NaN
    if (!Number.isFinite(startMs)) continue
    if (now - startMs >= maxAgeMs) {
      out.push({ id: r.id, ended_at: new Date(startMs + maxAgeMs).toISOString() })
    }
  }
  return out
}

/**
 * Reaper IO — close every impersonation_log row open past the session
 * max-age, stamping a truthful upper-bound ended_at + auto_closed=true.
 * Catches every session that ended without an explicit Stop (tab close,
 * logout, cookie/SecureStore expiry). Called by the hourly
 * /api/cron/close-stale-impersonations cron.
 *
 * @param {SupabaseClient} db   service-role client
 * @param {number} [now]        epoch ms (injectable for tests)
 * @param {number} [maxAgeSeconds]
 * @returns {Promise<{ok:boolean, closed:number, stale:number, error?:string}>}
 */
export async function closeStaleImpersonations(
  db,
  now = Date.now(),
  maxAgeSeconds = IMPERSONATE_SESSION_MAX_AGE_SECONDS,
) {
  const cutoffIso = new Date(now - maxAgeSeconds * 1000).toISOString()
  const { data: openRows, error } = await db
    .from('impersonation_log')
    .select('id, started_at')
    .is('ended_at', null)
    .lt('started_at', cutoffIso)
  if (error) return { ok: false, closed: 0, stale: 0, error: error.message }

  const plan = planStaleImpersonationCloses(openRows, now, maxAgeSeconds)
  let closed = 0
  for (const p of plan) {
    // Re-assert ended_at IS NULL so a concurrent explicit Stop wins the
    // race and we don't overwrite a precise end with the upper bound.
    const { error: uErr } = await db
      .from('impersonation_log')
      .update({ ended_at: p.ended_at, auto_closed: true })
      .eq('id', p.id)
      .is('ended_at', null)
    if (!uErr) closed++
  }
  return { ok: true, closed, stale: plan.length }
}
