// USAGE.1 — who the App usage report covers, and the reads behind it.
//
// The report lives in the platform console (master only, cross-tenant).
// Every active, non-deleted staff member below master is in scope; the
// tenant filter narrows to people linked to that organisation (through a
// studio membership or an organisation grant), and the studio filter, applied
// by the route, to people assigned there plus anyone with usage there.
// Masters are never recorded, so they are never listed.
//
// SECURITY: service-role reads. The route's master gate is the only thing
// between these rows and a browser; this module adds no gate of its own.

import { excludeTombstones } from '@/lib/staff-tombstone'

const PAGE = 1000

async function readAll(build, what) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw new Error(`app usage scope: ${what} read failed: ${error.code || error.message}`)
    out.push(...(data || []))
    if (!data || data.length < PAGE) return out
  }
}

export class UsageScopeError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

/**
 * @param {object} db service-role client
 * @param {{ organizationId?: string|null, locationId?: string|null }} filters
 * @returns {Promise<{ organizations: {id,name}[], locations: {id,name,organization_id}[],
 *   staff: { id, name, tenant, orgIds: Set<string>, locationIds: Set<string> }[] }>}
 * @throws {UsageScopeError} an unknown organisation, or a studio outside it
 */
export async function loadUsageScope(db, { organizationId = null, locationId = null } = {}) {
  const [organizations, locations, profiles, links, grants] = await Promise.all([
    readAll(() => db.from('organizations').select('id, name').order('name').order('id'), 'organizations'),
    readAll(() => db.from('locations').select('id, name, organization_id').eq('is_host_anchor', false).order('name').order('id'), 'locations'),
    readAll(() => excludeTombstones(db.from('profiles').select('id, full_name, role'))
      .eq('active', true)
      .neq('role', 'master')
      .order('id'), 'profiles'),
    readAll(() => db.from('profile_locations').select('profile_id, location_id').order('id'), 'profile_locations'),
    readAll(() => db.from('profile_organizations').select('profile_id, organization_id').order('id'), 'profile_organizations'),
  ])

  if (organizationId && !organizations.some((o) => o.id === organizationId)) {
    throw new UsageScopeError('Unknown organisation')
  }
  if (locationId) {
    const loc = locations.find((l) => l.id === locationId)
    if (!loc) throw new UsageScopeError('Unknown studio')
    if (organizationId && loc.organization_id !== organizationId) {
      throw new UsageScopeError('That studio is not in the chosen organisation')
    }
  }

  const orgOfLocation = new Map(locations.map((l) => [l.id, l.organization_id]))
  const orgName = new Map(organizations.map((o) => [o.id, o.name]))
  const byProfile = new Map(profiles.map((p) => [p.id, { orgIds: new Set(), locationIds: new Set() }]))
  for (const l of links) {
    const entry = byProfile.get(l.profile_id)
    if (!entry) continue
    entry.locationIds.add(l.location_id)
    const org = orgOfLocation.get(l.location_id)
    if (org) entry.orgIds.add(org)
  }
  for (const g of grants) byProfile.get(g.profile_id)?.orgIds.add(g.organization_id)

  const staff = profiles
    .map((p) => {
      const { orgIds, locationIds } = byProfile.get(p.id)
      return {
        id: p.id,
        name: p.full_name || 'Unnamed',
        tenant: [...orgIds].map((id) => orgName.get(id)).filter(Boolean).sort().join(', ') || null,
        orgIds,
        locationIds,
      }
    })
    .filter((p) => !organizationId || p.orgIds.has(organizationId))

  return { organizations, locations, staff }
}
