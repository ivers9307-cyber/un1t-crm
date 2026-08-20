// SEC-LIVE-API.1 — the single gate for the /api/live/** family.
//
// WHY THIS EXISTS
// ---------------
// SEC-LIVE-GATE.1 put `hasPermission(user, 'studio_management')` on the
// /live/[locationId] PAGE, but the routes that page polls every ~2s kept
// their original guard: logged in + a member of the location. Every /api
// route runs on the service-role client (RLS bypassed — see CLAUDE.md), so
// the route IS the enforcement point: a staffer refused the page could still
// GET the same payload directly — live heart-rate sessions, member names and
// the class roster.
//
// `studio_management` defaults FALSE for staff, reception and head_coach
// (shared/permissions.js), so that gap is populated by real people, not a
// hypothetical: at Stillorgan today it is 6 accounts (2 head_coaches on the
// default, 3 staff on the default, 1 manager with an explicit `false`).
//
// WHY IT CANNOT BLANK A STUDIO DISPLAY
// ------------------------------------
// The in-studio TV / kiosk surfaces do NOT call this family. `/tv/[locationId]`
// polls `/api/public/live/[locationId]` and `/tv/live/[token]` polls
// `/api/public/tv-live/[token]` — both unauthenticated by design (the token is
// the auth), both untouched here. The only callers of /api/live/** in the
// estate are LiveClassClient.jsx and DetectedTab.jsx, which render *inside*
// the already-gated /live page, plus a master. There is no mobile caller and
// champ-bridge only POSTs to /api/bridge/*. A studio-PIN device is not a
// separate identity either: pin-login mints a session for a real staff
// profile, so it inherits that staffer's permissions and needs no bypass.
//
// PER-LOCATION, NOT ACTIVE-LOCATION
// ---------------------------------
// These routes name their location in the path, so both halves of the
// decision resolve AT THAT LOCATION: `hasPermissionForLocation` for the
// permission and the target-location assignment for the role. Pairing an
// active-location capability with a membership test on a different location
// is the decoupling `hasPermissionInOrganization` warns about — an owner at
// Hatch who is only staff at Stillorgan would otherwise carry the owner
// capability onto Stillorgan's floor. Prod has such an account today
// (head_coach at Stillorgan, owner at Hatch).

import { NextResponse } from 'next/server'
import { getUserLocationIds } from './auth'
import { hasPermissionForLocation } from './permissions'

/** The permission the /live page requires; the whole family now matches it. */
export const LIVE_PERMISSION = 'studio_management'

/**
 * Roles allowed to MUTATE live state (pair a strap, end a session, register a
 * device). Unchanged from the per-route ALLOWED_ROLES lists this replaces,
 * minus the dead `'coach'` entry — `roleSchema` has never had a `coach` role
 * (master/owner/manager/head_coach/staff/reception), so it never matched.
 */
// This is one list, not several: /test-mode already spelled exactly these
// three, and /pair, /end-all and /register-device spelled the same three plus
// the dead 'coach'. The effective sets were identical before this file.
export const LIVE_MUTATION_ROLES = Object.freeze(['owner', 'manager', 'head_coach'])

/**
 * The caller's role AT `locationId` (not at their active location).
 * Mirrors how hasPermissionForLocation resolves `roleHere`. Falls back to
 * `user.role` when no per-location assignment exists — that is the master /
 * org-admin synthetic case, and falling back keeps them working.
 *
 * @param {object} user
 * @param {string} locationId
 * @returns {string|null}
 */
export function roleAtLocation(user, locationId) {
  if (!user) return null
  if (user.isMaster || user.role === 'master') return 'master'
  const assignment = user.assignmentsByLocation?.[locationId] || null
  const location = (user.locations || []).find((l) => l?.id === locationId) || null
  return assignment?.role || location?.role || user.role || null
}

/**
 * Guard for every /api/live/[locationId]/** route.
 *
 * Order is deliberate: 401 → location scope → role → permission. The first
 * three fire before any database lookup, so none of them confirms whether the
 * location or any row exists — the caller supplied the location id itself.
 *
 * @param {object|null} user            getCurrentUser() result
 * @param {string} locationId           the route's [locationId]
 * @param {{ roles?: readonly string[] }} [opts]
 *   `roles` — when present, the caller must ALSO hold one of these roles at
 *   the location (the mutation routes). Omit for read routes.
 * @returns {import('next/server').NextResponse|null} a response to return, or
 *   null when the caller is allowed through.
 */
export function guardLiveLocation(user, locationId, { roles = null } = {}) {
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  const isMaster = user.isMaster || user.role === 'master'
  if (!isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }
  if (roles && !isMaster && !roles.includes(roleAtLocation(user, locationId))) {
    return NextResponse.json({ ok: false, error: 'Coach only' }, { status: 403 })
  }
  if (!hasPermissionForLocation(user, locationId, LIVE_PERMISSION)) {
    return NextResponse.json(
      { ok: false, error: 'Studio management permission required' },
      { status: 403 },
    )
  }
  return null
}

/**
 * Guard for POST /api/live/sessions/[id]/end, which is keyed by a session id
 * rather than a location.
 *
 * The house rule is 404-not-403 on detail routes so ids can't be enumerated,
 * and this route broke it: a missing id 404'd while a real id at a location
 * you cannot reach 403'd, which confirms the id is real. Everything decided
 * AFTER the lookup therefore collapses to one 404 — missing, foreign, or
 * permission-less are indistinguishable. The role check stays a 403 because
 * it fires BEFORE the lookup and reveals nothing about the id.
 *
 * @param {object|null} user
 * @param {{ location_id: string }|null|undefined} session
 * @returns {import('next/server').NextResponse|null}
 */
export function guardLiveSession(user, session) {
  const notFound = NextResponse.json({ ok: false, error: 'Session not found' }, { status: 404 })
  if (!session) return notFound
  const isMaster = user?.isMaster || user?.role === 'master'
  if (!isMaster && !getUserLocationIds(user).includes(session.location_id)) return notFound
  if (!hasPermissionForLocation(user, session.location_id, LIVE_PERMISSION)) return notFound
  return null
}
