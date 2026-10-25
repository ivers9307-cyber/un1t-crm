// TENANTSCOPE.1 — whose devices a settings-holder may see and push to.
//
// The staff fleet (the /settings/notifications/health page, GET
// /api/staff-devices, the update nudge and the test push) is an
// ORGANISATION's staff. Those surfaces gate on the caller's role or
// `settings` permission at the ACTIVE studio, so the fleet is that
// studio's organisation: everyone with a membership at any of its
// locations, plus its org admins (SAAS-4, mig 417). Inside the
// organisation nothing changes — a Hatch manager still sees Stillorgan.
// A master keeps the estate-wide fleet, the platform view these surfaces
// were built as.
//
// A failed read THROWS. An empty fleet on a DB blip would read as "nobody
// here has the app" and hide exactly the people the page exists to chase;
// every caller turns the throw into a 500 (or the error page) and sends
// nothing.
//
// Callers keep reading the WHOLE active fleet's devices for the target
// version (one app binary for the estate — only a version string leaves);
// they list, count, nudge and test only the ids this scope admits.

const PAGE_MAX = 1000 // PostgREST's select cap; every read here is staff-sized

/**
 * @param {object} db service-role client
 * @param {{ isMaster?: boolean, activeOrganization?: { id: string } | null } | null} user
 * @returns {Promise<{ all: true, organizationId: null, locationIds: null, profileIds: null }
 *   | { all: false, organizationId: string|null, locationIds: string[], profileIds: Set<string> }>}
 */
export async function loadFleetScope(db, user) {
  if (user?.isMaster) {
    return { all: true, organizationId: null, locationIds: null, profileIds: null }
  }
  const organizationId = user?.activeOrganization?.id || null
  if (!organizationId) {
    return { all: false, organizationId: null, locationIds: [], profileIds: new Set() }
  }

  const { data: locs, error: locErr } = await db
    .from('locations')
    .select('id')
    .eq('organization_id', organizationId)
    .order('id', { ascending: true })
    .range(0, PAGE_MAX - 1)
  if (locErr) throw new Error(`fleet scope: locations read failed: ${locErr.message}`)
  const locationIds = (locs || []).map((l) => l.id)

  const [linksRes, adminsRes] = await Promise.all([
    locationIds.length
      ? db
          .from('profile_locations')
          .select('profile_id')
          .in('location_id', locationIds)
          .order('profile_id', { ascending: true })
          .range(0, PAGE_MAX - 1)
      : Promise.resolve({ data: [], error: null }),
    db
      .from('profile_organizations')
      .select('profile_id')
      .eq('organization_id', organizationId)
      .order('profile_id', { ascending: true })
      .range(0, PAGE_MAX - 1),
  ])
  if (linksRes.error) throw new Error(`fleet scope: profile_locations read failed: ${linksRes.error.message}`)
  if (adminsRes.error) throw new Error(`fleet scope: profile_organizations read failed: ${adminsRes.error.message}`)

  const links = linksRes.data || []
  if (links.length >= PAGE_MAX) {
    // Loud, not silent: a truncated membership list would drop staff.
    console.error(`[staff-fleet-scope] profile_locations hit the ${PAGE_MAX}-row cap for organisation ${organizationId} — add pagination`)
  }
  const profileIds = new Set([...links, ...(adminsRes.data || [])].map((r) => r.profile_id))
  return { all: false, organizationId, locationIds, profileIds }
}

/** Does this scope admit the profile? A missing scope admits nobody. */
export function inFleetScope(scope, profileId) {
  if (!scope) return false
  return scope.all === true || scope.profileIds.has(profileId)
}
