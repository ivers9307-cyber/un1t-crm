// src/lib/widget-auth.js
// WIDGET.1 — the fourth auth source, deliberately NOT wired into
// getCurrentUser().
//
// getCurrentUser() is called directly by well over a hundred routes that
// never opted into anything. Adding a widget source there would hand a
// stolen phone the whole estate. Instead this function is called ONLY by
// withAuth when a route declares `allowWidgetToken: true`, so the default
// for every other route is denial by construction rather than by review.
//
// What it returns is a user object shaped like getCurrentUser()'s, narrowed
// to the single location the token is scoped to — so hasPermission() and
// hasPermissionForLocation() run unchanged against it. That sameness is the
// point: there is one permission resolver, not a widget-flavoured copy.

import { parseWidgetBearer, hashWidgetToken } from './widget-token.js'
import { loadRoleTemplatesForLocations } from './role-templates.js'
import { logWarn } from './log.js'

export async function getWidgetUser(db, request) {
  const token = parseWidgetBearer(request?.headers?.get?.('authorization'))
  if (!token) return null
  const tokenHash = hashWidgetToken(token)
  if (!tokenHash) return null

  const { data: row, error: rowErr } = await db
    .from('widget_tokens')
    .select('id, profile_id, location_id, revoked_at')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .maybeSingle()
  if (rowErr || !row) return null

  const { data: profile, error: profileErr } = await db
    .from('profiles')
    .select('id, email, full_name, role, employment_type')
    .eq('id', row.profile_id)
    .maybeSingle()
  if (profileErr || !profile) return null

  // The assignment is the authorisation, and its absence is a revocation
  // nobody had to perform: take someone off a studio and their widget for
  // it stops working on the next tap.
  const { data: assignment, error: assignErr } = await db
    .from('profile_locations')
    .select('location_id, role, permissions')
    .eq('profile_id', row.profile_id)
    .eq('location_id', row.location_id)
    .maybeSingle()
  if (assignErr || !assignment) return null

  // `features` is not optional — resolvePermission reads location.features
  // as its tier-1 gate, so a location object without it silently changes
  // what resolves.
  const { data: location } = await db
    .from('locations')
    .select('id, name, features')
    .eq('id', row.location_id)
    .maybeSingle()
  if (!location) return null

  const rolesByLocation = { [row.location_id]: assignment.role }
  const { roleTemplatesByLocation, acDeviceTemplatesByLocation } =
    await loadRoleTemplatesForLocations(db, {
      isMaster: false,
      rolesByLocation,
      employmentType: profile.employment_type || null,
    })

  // Fire-and-forget: a failed touch must never fail the request, but it must
  // not vanish either — a supabase builder RESOLVES rather than throws, so a
  // bare await would have swallowed it silently.
  db.from('widget_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id)
    .then(({ error }) => {
      if (error) logWarn('widget-auth', 'last_used_at touch failed', { err: error.message })
    }, (e) => logWarn('widget-auth', 'last_used_at threw', { err: e?.message }))

  return {
    ...profile,
    authSource: 'widget',
    widgetTokenId: row.id,
    activeLocation: location,
    locations: [location],
    rolesByLocation,
    assignmentsByLocation: { [row.location_id]: assignment },
    activeAssignment: assignment,
    roleTemplatesByLocation,
    activeRoleTemplate: roleTemplatesByLocation[row.location_id] || null,
    acDeviceTemplatesByLocation,
    activeAcDeviceTemplate: acDeviceTemplatesByLocation[row.location_id] || null,
    // The active-location role, exactly as getCurrentUser reports it.
    role: assignment.role,
    profileRole: profile.role,
    // A widget token is location-scoped by construction; the master bypass
    // is estate-wide. Never grant it here, whatever the profile row says.
    isMaster: false,
    organizationsById: {},
    activeOrganization: null,
    orgAdminOrgIds: [],
  }
}
