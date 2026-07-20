// SUPPORT-ACCESS (Repset Phase 3) — node-side support-session helpers.
//
// A master opens a support session against a tenant ORGANIZATION in one
// of two modes (read_only | act_on_behalf). This module owns the
// server-side lifecycle: pick a tenant-eye identity, REUSE the existing
// impersonation mechanism (impersonation.js) for the identity/scope-swap,
// set the signed `un1t_support` mode cookie, and write/close the
// support_sessions audit row (mig 431).
//
// The read-only ENFORCEMENT is NOT here — it lives at the central
// chokepoint (src/proxy.js) via decideSupportWriteBlock. This module only
// establishes the state the proxy reads.
//
// Reused verbatim from impersonation.js:
//   • startImpersonation  — sets un1t_impersonate cookie + opens an
//     impersonation_log row so getCurrentUser() swaps identity/scope to
//     the tenant's owner (all existing IDOR/location guards then keep the
//     master inside that tenant — that IS the act_on_behalf scoping).
//   • stopImpersonation   — clears the cookie + stamps ended_at.
//
// The signing lives in support-session-edge.js (Web Crypto) so the proxy
// (Edge) and this file (Node) share ONE implementation.

import { cookies } from 'next/headers'
import { createServerClient } from './supabase'
import { startImpersonation, stopImpersonation } from './impersonation'
import {
  SUPPORT_COOKIE,
  SUPPORT_MODES,
  SUPPORT_SESSION_MAX_AGE_SECONDS,
  isSupportMode,
  signSupportPayload,
  verifySupportCookie,
} from './support-session-edge'

export {
  SUPPORT_COOKIE,
  SUPPORT_MODES,
  SUPPORT_SESSION_MAX_AGE_SECONDS,
  isSupportMode,
  verifySupportCookie,
}

const ACTIVE_LOCATION_COOKIE = 'un1t_active_location'

/**
 * Pick the tenant-eye identity + a location to scope the portfolio to.
 *
 * Prefers an org_admin (mig 417 — acts as owner across the whole org),
 * else an owner-at-a-location within the org. Returns the owner's own
 * location where possible so getCurrentUser accepts the active-location
 * cookie (it validates the cookie against the impersonated user's
 * assignments). When the org has no owner/admin profile at all we return
 * ownerId=null → scope-only (the master stays themselves, portfolio still
 * scoped to the org's first active location).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string} orgId
 * @returns {Promise<{ownerId: string|null, locationId: string|null}>}
 */
export async function findOrgSupportTarget(db, orgId) {
  const { data: orgLocs } = await db
    .from('locations')
    .select('id, active, name')
    .eq('organization_id', orgId)
    .order('name')
  const locs = orgLocs || []
  const activeLocs = locs.filter((l) => l.active)
  const firstActiveLoc = activeLocs[0]?.id || locs[0]?.id || null

  // 1) org_admin (whole-org owner).
  const { data: admins } = await db
    .from('profile_organizations')
    .select('profile_id')
    .eq('organization_id', orgId)
    .eq('role', 'org_admin')
    .limit(1)
  if (admins?.[0]?.profile_id) {
    return { ownerId: admins[0].profile_id, locationId: firstActiveLoc }
  }

  // 2) owner at a location in the org — prefer an active + default one so
  //    the impersonated owner lands cleanly on the tenant's portfolio.
  const locIds = locs.map((l) => l.id)
  if (locIds.length) {
    const { data: owners } = await db
      .from('profile_locations')
      .select('profile_id, location_id, is_default')
      .in('location_id', locIds)
      .eq('role', 'owner')
    if (owners?.length) {
      const isActive = (id) => activeLocs.some((l) => l.id === id)
      const pick =
        owners.find((o) => isActive(o.location_id) && o.is_default) ||
        owners.find((o) => isActive(o.location_id)) ||
        owners[0]
      return { ownerId: pick.profile_id, locationId: pick.location_id }
    }
  }

  // 3) scope-only.
  return { ownerId: null, locationId: firstActiveLoc }
}

function activeLocationCookieOptions() {
  return {
    // NON-httpOnly to match the web LocationSwitcher's document.cookie
    // write (src/lib/active-location.js) so the switcher can still
    // overwrite it. getCurrentUser reads it server-side either way.
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SUPPORT_SESSION_MAX_AGE_SECONDS,
    path: '/',
  }
}

function supportCookieOptions() {
  return {
    httpOnly: true, // server-only; the proxy reads it, the client never needs to.
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SUPPORT_SESSION_MAX_AGE_SECONDS,
    path: '/',
  }
}

/**
 * Start (or re-open) a support session. Master-only — the caller MUST
 * have already confirmed the underlying session is a master.
 *
 * Steps:
 *   1. Verify the org exists.
 *   2. Close any prior OPEN support_sessions row for this master.
 *   3. Reuse impersonation for the tenant-eye view (or scope-only).
 *   4. Scope the active-location cookie to a location in the org so
 *      /portfolio resolves to this tenant deterministically.
 *   5. Insert the audit row + mint the signed un1t_support cookie.
 *
 * @param {object} args
 * @param {{id: string, role: string}} args.masterProfile  confirmed master
 * @param {string} args.organizationId
 * @param {'read_only'|'act_on_behalf'} args.mode
 * @param {string|null} [args.reason]
 * @param {string|null} [args.ip]
 * @param {string|null} [args.userAgent]
 * @returns {Promise<{sessionId:string, organizationId:string, organizationName:string, mode:string, impersonatedUserId:string|null, landing:string}>}
 */
export async function startSupportSession({ masterProfile, organizationId, mode, reason, ip, userAgent }) {
  if (!masterProfile || masterProfile.role !== 'master') {
    throw new Error('Only master accounts can start a support session.')
  }
  if (!organizationId) throw new Error('organizationId is required.')
  if (!isSupportMode(mode)) throw new Error('Invalid support mode.')

  const db = createServerClient()
  const { data: org, error: oErr } = await db
    .from('organizations')
    .select('id, name')
    .eq('id', organizationId)
    .single()
  if (oErr || !org) throw new Error('Target organization not found.')

  const { ownerId, locationId } = await findOrgSupportTarget(db, organizationId)

  // Close any prior OPEN support session for this master (one at a time).
  await db
    .from('support_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('master_user_id', masterProfile.id)
    .is('ended_at', null)

  // Identity/scope-swap. When an owner exists we impersonate them so the
  // master sees the tenant exactly as they would; that impersonation IS
  // the act_on_behalf scoping (existing guards keep writes inside the
  // org). When none exists, ensure we're NOT carrying a stale
  // impersonation and stay scope-only.
  if (ownerId) {
    await startImpersonation({
      masterProfile,
      targetUserId: ownerId,
      reason: reason || `Support session · ${org.name}`,
      ip,
      userAgent,
    })
  } else {
    await stopImpersonation({ masterUserId: masterProfile.id })
  }

  // Insert the audit row (service-role → RLS bypassed).
  const { data: inserted, error: insErr } = await db
    .from('support_sessions')
    .insert({
      master_user_id: masterProfile.id,
      target_organization_id: organizationId,
      impersonated_user_id: ownerId || null,
      mode,
      reason: reason || null,
      ip: ip || null,
      user_agent: userAgent || null,
    })
    .select('id')
    .single()
  if (insErr || !inserted) throw new Error(`Failed to open support session: ${insErr?.message || 'insert failed'}`)

  const cookieStore = await cookies()
  // Scope the active-location cookie AFTER startImpersonation (which
  // clears it) so /portfolio deterministically resolves to this tenant.
  if (locationId) {
    cookieStore.set(ACTIVE_LOCATION_COOKIE, locationId, activeLocationCookieOptions())
  }

  const now = Date.now()
  const cookieValue = await signSupportPayload({
    sid: inserted.id,
    org: organizationId,
    mode,
    master: masterProfile.id,
    imp: ownerId || null,
    iat: now,
    exp: now + SUPPORT_SESSION_MAX_AGE_SECONDS * 1000,
  })
  cookieStore.set(SUPPORT_COOKIE, cookieValue, supportCookieOptions())

  return {
    sessionId: inserted.id,
    organizationId,
    organizationName: org.name,
    mode,
    impersonatedUserId: ownerId || null,
    landing: '/portfolio',
  }
}

/**
 * Switch the mode of the master's currently-open support session. Closes
 * the current audited span and opens a fresh one with the new mode (so
 * the audit timeline shows each mode as its own bounded span), re-minting
 * the cookie. Keeps the SAME impersonation (identity/scope unchanged).
 *
 * @param {object} args
 * @param {string} args.masterUserId  the REAL master id
 * @param {'read_only'|'act_on_behalf'} args.mode  the mode to switch TO
 * @returns {Promise<{ok:boolean, mode?:string, organizationId?:string, error?:string}>}
 */
export async function switchSupportMode({ masterUserId, mode }) {
  if (!isSupportMode(mode)) return { ok: false, error: 'invalid_mode' }
  const db = createServerClient()
  const { data: openRow } = await db
    .from('support_sessions')
    .select('id, target_organization_id, impersonated_user_id, reason')
    .eq('master_user_id', masterUserId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!openRow) return { ok: false, error: 'no_active_support_session' }

  const nowIso = new Date().toISOString()
  await db.from('support_sessions').update({ ended_at: nowIso }).eq('id', openRow.id).is('ended_at', null)

  const { data: inserted, error: insErr } = await db
    .from('support_sessions')
    .insert({
      master_user_id: masterUserId,
      target_organization_id: openRow.target_organization_id,
      impersonated_user_id: openRow.impersonated_user_id || null,
      mode,
      reason: openRow.reason || null,
    })
    .select('id')
    .single()
  if (insErr || !inserted) return { ok: false, error: insErr?.message || 'insert_failed' }

  const cookieStore = await cookies()
  const now = Date.now()
  const cookieValue = await signSupportPayload({
    sid: inserted.id,
    org: openRow.target_organization_id,
    mode,
    master: masterUserId,
    imp: openRow.impersonated_user_id || null,
    iat: now,
    exp: now + SUPPORT_SESSION_MAX_AGE_SECONDS * 1000,
  })
  cookieStore.set(SUPPORT_COOKIE, cookieValue, supportCookieOptions())

  return { ok: true, mode, organizationId: openRow.target_organization_id }
}

/**
 * Exit the master's support session: stop any impersonation, clear both
 * cookies, and stamp ended_at on the open audit row.
 *
 * @param {object} args
 * @param {string} args.masterUserId  the REAL master id
 * @returns {Promise<{closed:boolean, organizationId:string|null}>}
 */
export async function stopSupportSession({ masterUserId }) {
  const db = createServerClient()
  const { data: openRow } = await db
    .from('support_sessions')
    .select('id, target_organization_id')
    .eq('master_user_id', masterUserId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Stamp ended_at on the open support row(s).
  await db
    .from('support_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('master_user_id', masterUserId)
    .is('ended_at', null)

  // Reuse impersonation stop (clears un1t_impersonate + un1t_active_location
  // + stamps the impersonation_log row).
  await stopImpersonation({ masterUserId })

  // Clear the support cookie.
  const cookieStore = await cookies()
  cookieStore.set(SUPPORT_COOKIE, '', { maxAge: 0, path: '/' })

  return { closed: !!openRow, organizationId: openRow?.target_organization_id || null }
}

/**
 * Recent support sessions for the master console audit panel. Master-only
 * data — the caller must gate on profileRole === 'master'. Joins the org
 * name + master name for display.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {number} [limit]
 * @returns {Promise<Array<object>>}
 */
export async function getRecentSupportSessions(db, limit = 25) {
  const { data, error } = await db
    .from('support_sessions')
    .select('id, master_user_id, target_organization_id, impersonated_user_id, mode, reason, started_at, ended_at, auto_closed, organizations(name), master:profiles!support_sessions_master_user_id_fkey(full_name, email)')
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) return []
  return (data || []).map((r) => ({
    id: r.id,
    masterUserId: r.master_user_id,
    masterName: r.master?.full_name || r.master?.email || null,
    organizationId: r.target_organization_id,
    organizationName: r.organizations?.name || null,
    impersonatedUserId: r.impersonated_user_id,
    mode: r.mode,
    reason: r.reason,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    autoClosed: r.auto_closed,
    active: !r.ended_at,
  }))
}

/**
 * Pure planner — given the currently-open support rows + a reference
 * time, decide which are past the session max-age and the truthful
 * upper-bound ended_at to stamp. Mirrors planStaleImpersonationCloses.
 *
 * @param {Array<{id:string, started_at:string}>} openRows
 * @param {number} now  epoch ms
 * @param {number} [maxAgeSeconds]
 * @returns {Array<{id:string, ended_at:string}>}
 */
export function planStaleSupportCloses(openRows, now, maxAgeSeconds = SUPPORT_SESSION_MAX_AGE_SECONDS) {
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
 * Reaper IO — close every support_sessions row open past the session
 * max-age, stamping a truthful upper-bound ended_at + auto_closed=true.
 * Called by the hourly /api/cron/close-stale-impersonations cron
 * alongside closeStaleImpersonations().
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {number} [now]  epoch ms
 * @param {number} [maxAgeSeconds]
 * @returns {Promise<{ok:boolean, closed:number, stale:number, error?:string}>}
 */
export async function closeStaleSupportSessions(db, now = Date.now(), maxAgeSeconds = SUPPORT_SESSION_MAX_AGE_SECONDS) {
  const cutoffIso = new Date(now - maxAgeSeconds * 1000).toISOString()
  const { data: openRows, error } = await db
    .from('support_sessions')
    .select('id, started_at')
    .is('ended_at', null)
    .lt('started_at', cutoffIso)
  if (error) return { ok: false, closed: 0, stale: 0, error: error.message }

  const plan = planStaleSupportCloses(openRows, now, maxAgeSeconds)
  let closed = 0
  for (const p of plan) {
    const { error: uErr } = await db
      .from('support_sessions')
      .update({ ended_at: p.ended_at, auto_closed: true })
      .eq('id', p.id)
      .is('ended_at', null)
    if (!uErr) closed++
  }
  return { ok: true, closed, stale: plan.length }
}
