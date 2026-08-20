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
// HOW BIG THE GAP ACTUALLY IS (corrected — SEC-LIVE-API.2)
// -------------------------------------------------------
// An earlier revision of this comment claimed 6 Stillorgan accounts were
// refused the page and served by the API, reasoning from the CODE DEFAULTS
// (`studio_management` is false for staff, reception and head_coach in
// shared/permissions.js). That skipped tier 2.5. `resolvePermission` consults
// the operator-edited `location_role_permissions` template BEFORE the role
// default, and `getCurrentUser` loads `roleTemplatesByLocation` for every
// location the user holds — so the template is what those accounts actually
// resolve on. Stillorgan carries three template rows that grant
// `studio_management: true` (head_coach/all, staff/fte, staff/contractor).
//
// Recomputed through the real tier order, all 13 Stillorgan
// `profile_locations` rows: 12 resolve TRUE (owner ×2 incl. a master, a
// head_coach with an explicit true, 2 head_coaches via the template, 4 staff
// with an explicit true, 3 staff via the template) and exactly ONE resolves
// FALSE — the manager with an explicit `permissions.studio_management: false`.
//
// So the leak population is ONE account, not six. The fix is still the right
// one: an operator deliberately took the permission off that manager, the
// page honoured it, and the API served her the board anyway. But the honest
// size matters, because the six-account figure was reached by reading the
// defaults instead of the resolver, and it went into a permanent record.
//
// TWO DOORS THIS GATE DOES NOT CLOSE
// ----------------------------------
// 1. RLS is still the OLD gate. `heart_rate_sessions_read`, `hr_samples`,
//    `hr_detections_location_read`, `class_bookings_location_read` and
//    `contacts_select` are all `private.auth_is_in_location(location_id)` —
//    master OR a `profile_locations` row, with NO permission check — and
//    `authenticated` holds SELECT on every one of them. The browser carries a
//    real `authenticated` JWT (src/lib/supabase.js `createBrowserClient`), and
//    the app already does browser-direct PostgREST reads elsewhere, so anyone
//    with a membership row can still read those tables directly with MORE
//    fields than this API ever returned. (No realtime publication covers them,
//    so the subscription variant is shut.) CLAUDE.md's "service-role bypasses
//    RLS, so the route IS the enforcement point" is true of the route and only
//    of the route — the table still enforces membership-only. Closing that
//    needs a migration (a `private.auth_has_permission_at(loc, key)` helper
//    replayed through the same tier order, applied per-command — never a
//    single RESTRICTIVE FOR ALL, which silently folds SELECT away). Out of
//    scope here; the audit item stays OPEN until it lands.
// 2. The public board. `/api/public/live/[locationId]` takes no auth at all —
//    only an IP+location rate limit — and returns a live HR board with
//    `First L.` names, current BPM and zone. Its own header records this as
//    the unfinished half of P0-3. Any location member can also read
//    `tv_displays.token` (its policy is membership-scoped too) and use the
//    token-gated twin. So "live HR + member identity" is masked after this
//    change, not confidential. Deliberate for the lobby TV; not a regression;
//    closed only by migrating every TV onto /tv/live/[token] and retiring the
//    location-keyed entrypoint.
//
// WHY IT CANNOT BLANK A STUDIO DISPLAY
// ------------------------------------
// The in-studio TV / kiosk surfaces do NOT call this family. `/tv/[locationId]`
// polls `/api/public/live/[locationId]` and `/tv/live/[token]` polls
// `/api/public/tv-live/[token]` — both unauthenticated by design (the token is
// the auth), both untouched here. The only callers of /api/live/** in the
// estate are LiveClassClient.jsx and DetectedTab.jsx, which render *inside*
// the already-gated /live page, plus a master. Mobile calls no /api/live route
// at all — its staff surfaces reach /api/studio-management/* and /api/timer/*
// only (mobile/lib/studio-mgmt-api.js, mobile/lib/timer-api.js) — and
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
//
// This holds for the SESSION route too, but only since SEC-LIVE-API.2. The
// first cut left `POST /api/live/sessions/[id]/end` deciding its role on
// `user.role` alone — the active-location role, caller-chosen through the
// `x-active-location` header or the `un1t_active_location` cookie — because
// `guardLiveSession` took no `roles` option. It does now, and the route
// passes it, so the role resolves at `session.location_id` like everywhere
// else in the family. Nothing in prod could reach that gap (every account
// holding `studio_management` at Stillorgan on a non-coach role is
// single-location), so it was latent, not live — but the header used to
// claim a property the code did not have.
//
// The /live PAGE is aligned to the same rule (SEC-LIVE-API.2). It gated on
// `hasPermission`, i.e. the ACTIVE location, while the routes it polls gated
// on the target — leaving the page the softer half and, for one real prod
// account, a board that rendered and then 403'd on every poll.

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
 * AFTER the lookup therefore collapses to one 404 — missing, foreign,
 * permission-less, or wrong-role — all indistinguishable.
 *
 * `roles` is the same option guardLiveLocation takes, and the route DOES pass
 * it (SEC-LIVE-API.2). The route's own pre-lookup role check can only test
 * `user.role`, which is the ACTIVE-location role — the session's location is
 * unknown until the lookup. That left the exact active-location decoupling
 * this file's header warns about: head_coach at L2 + staff at L1 could send
 * `x-active-location: L2`, clear the pre-lookup check, and end a session at L1
 * on a coach capability they hold only at L2. Re-checking the role HERE, at
 * `session.location_id`, closes it; the pre-lookup 403 stays as a cheap first
 * pass that reveals nothing about the id.
 *
 * @param {object|null} user
 * @param {{ location_id: string }|null|undefined} session
 * @param {{ roles?: readonly string[] }} [opts]
 * @returns {import('next/server').NextResponse|null}
 */
export function guardLiveSession(user, session, { roles = null } = {}) {
  const notFound = NextResponse.json({ ok: false, error: 'Session not found' }, { status: 404 })
  if (!session) return notFound
  const isMaster = user?.isMaster || user?.role === 'master'
  if (!isMaster && !getUserLocationIds(user).includes(session.location_id)) return notFound
  if (roles && !isMaster && !roles.includes(roleAtLocation(user, session.location_id))) return notFound
  if (!hasPermissionForLocation(user, session.location_id, LIVE_PERMISSION)) return notFound
  return null
}
