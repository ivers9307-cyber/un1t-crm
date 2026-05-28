// withAuth — handler wrapper that runs the auth + permission +
// location-scope gate exactly once, in one place.
//
// Why this exists
//   Every gated API route opens with the same five lines:
//     const user = await getCurrentUser()
//     if (!user) return … 401
//     if (!hasPermission(user, '<key>')) return … 403
//     const locationId = user.activeLocation?.id
//     if (!locationId) return … 400
//     const db = createServerClient()
//   Across ~144 routes that's 700+ LOC of duplicated boilerplate.
//   Worse, the 403 message text drifts subtly across routes — three
//   distinct phrasings of "not enabled at this location" exist
//   today and a typo in any one would silently lock real users
//   out without a clear signal in the logs.
//
//   The audit (architectural-debt-audit.md item 1.2) called this
//   out as the highest LOC-impact medium-effort fix. This wrapper
//   is the deliverable.
//
// Shape
//   export const POST = withAuth(
//     { permission: 'studio_management', location: true },
//     async ({ user, db, locationId, request, params }) => {
//       // body of the route — auth already happened
//     }
//   )
//
// Options
//   permission         a key from WEB_PERMISSION_KEYS. Required.
//                      Accepting an array would be useful later
//                      for OR semantics; keep single for now.
//   location           true → require user.activeLocation, return 400
//                      otherwise. Most routes need this; set false
//                      for global / cross-org admin routes.
//   roles              optional whitelist that must include
//                      user.role (e.g. ['master','owner']). Master
//                      shortcut is also gated by hasPermission, so
//                      this is rarely needed — used for routes
//                      where role-based gating is stricter than
//                      what the permissions matrix expresses.
//
// Migration strategy
//   Both the legacy 5-line preamble and the wrapper produce the
//   same response shape. Routes can be migrated one-at-a-time
//   without coordinating a big-bang switch, and a route halfway
//   through the migration will pass the same tests as before.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { WEB_PERMISSION_KEYS } from '@shared/permissions'

const VALID_PERMISSION_KEYS = new Set(WEB_PERMISSION_KEYS)

/** Standard error shapes — exported so route tests can assert on them. */
export const AUTH_ERRORS = Object.freeze({
  unauthorized: () =>
    NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
  forbidden: (key) =>
    NextResponse.json(
      { success: false, error: `${humanise(key)} is not enabled for your role at this location.` },
      { status: 403 }
    ),
  forbiddenRole: (allowedRoles) =>
    NextResponse.json(
      { success: false, error: `Allowed roles: ${allowedRoles.join(', ')}.` },
      { status: 403 }
    ),
  noActiveLocation: () =>
    NextResponse.json({ success: false, error: 'No active location.' }, { status: 400 }),
})

function humanise(key) {
  // 'studio_management' → 'Studio management'.
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/^./, c => c.toUpperCase())
}

/**
 * @param {object} options
 * @param {string} options.permission   one of WEB_PERMISSION_KEYS
 * @param {boolean} [options.location]  default true; require active location
 * @param {string[]} [options.roles]    optional role whitelist
 * @param {(ctx: object) => Promise<Response>} handler
 *   handler receives { user, db, locationId, request, params } where
 *   `params` is the second arg passed to a Next.js dynamic-route handler.
 * @returns {(request: Request, ctx?: { params?: object }) => Promise<Response>}
 */
export function withAuth(options, handler) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('withAuth(options, handler): options must be an object')
  }
  if (typeof handler !== 'function') {
    throw new TypeError('withAuth(options, handler): handler must be a function')
  }
  const { permission, location: requireLocation = true, roles = null } = options
  // Fail-fast at module load: a typo in the permission key here
  // means nobody could ever pass the gate. Better to error loudly
  // at import time than to silently 403 every request. Accepts
  // null for routes that only want role-gating (no permission key
  // applies).
  if (permission != null && !VALID_PERMISSION_KEYS.has(permission)) {
    throw new Error(
      `withAuth: unknown permission key '${permission}'. ` +
      `Valid keys: ${[...VALID_PERMISSION_KEYS].join(', ')}.`
    )
  }
  if (roles != null && (!Array.isArray(roles) || roles.length === 0)) {
    throw new TypeError('withAuth: roles must be a non-empty array if provided')
  }

  return async function authedHandler(request, ctx) {
    const user = await getCurrentUser()
    if (!user) return AUTH_ERRORS.unauthorized()

    if (permission != null && !hasPermission(user, permission)) {
      return AUTH_ERRORS.forbidden(permission)
    }
    if (roles && !roles.includes(user.role)) {
      return AUTH_ERRORS.forbiddenRole(roles)
    }

    let locationId = null
    if (requireLocation) {
      locationId = user.activeLocation?.id || null
      if (!locationId) return AUTH_ERRORS.noActiveLocation()
    }

    const db = createServerClient()
    // Next.js 15+ delivers `params` to route handlers as a Promise
    // that must be awaited before the values inside are readable.
    // Resolve once here so every withAuth-wrapped handler sees a
    // plain object (e.g. `{ id: '...' }`) — discovered after the
    // STUDIO-AC-DEVICES.3 routes were the first withAuth handlers
    // to actually use params, and the picker on StaffForm got a
    // 'Location id required' from the route below.
    const params = ctx?.params ? await ctx.params : undefined
    return handler({
      user,
      db,
      locationId,
      request,
      params,
    })
  }
}
