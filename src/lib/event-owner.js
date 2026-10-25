// EVENT-OWNER.1 — which studio owns an event, and who may change it.
//
// An event's `location_id` decides its studio inbox, its contacts' home
// studio, its email templates and (with sending_location_id) its comms
// identity. It used to be set silently from the creator's active studio
// with no way to change it, which is how "Sean Noble - Hyrox Workshop in
// Hatch Street" was created owned by Stillorgan (12 Oct 2026).
//
// Moving an event is an admin act at BOTH ends, inside one organisation,
// never onto a host anchor, and never for a host event (its owner is the
// host's anchor location, which the payee routing depends on).
// Member pricing does not depend on the owner within an org
// (EVENT-MEMBER-ORG.1), and race payments share one Revolut account.

import { assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { ADMIN_ROLES } from '@/lib/schemas'

/**
 * The studios a user may pick as an event's owner: active, not a host
 * anchor, in `organizationId`, where they hold the races permission (and,
 * when `requireAdmin`, an admin role). Reads only the user object.
 *
 * @param {object} user  getCurrentUser() result
 * @param {{ organizationId: string|null, requireAdmin?: boolean }} opts
 * @returns {Array<{ id: string, name: string }>}
 */
export function eventOwnerOptions(user, { organizationId, requireAdmin = false }) {
  return (user?.locations || [])
    .filter((l) => l?.id && l.active !== false && !l.is_host_anchor)
    .filter((l) => !organizationId || l.organization_id === organizationId)
    .filter((l) => hasPermissionForLocation(user, l.id, 'races'))
    .filter((l) => !requireAdmin || hasRoleAtLocation(user, l.id, ADMIN_ROLES))
    .map((l) => ({ id: l.id, name: l.name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

/**
 * Judge a request to move `existing` (race_events row: id, location_id,
 * host_id) to `targetLocationId`. `nextHostId` is the body's host_id: a
 * move that also assigns a payee is refused like a host event's move.
 *
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
export async function judgeEventOwnerChange({ db, user, existing, targetLocationId, nextHostId = undefined }) {
  if (!targetLocationId || targetLocationId === existing.location_id) return { ok: true }
  if (existing.host_id || nextHostId) {
    return { ok: false, status: 400, error: "A host's event stays with the host. Remove the payment host first." }
  }
  if (assertLocationAccessOr404(user, targetLocationId)) {
    return { ok: false, status: 404, error: 'Studio not found' }
  }
  if (!hasRoleAtLocation(user, existing.location_id, ADMIN_ROLES)
      || !hasRoleAtLocation(user, targetLocationId, ADMIN_ROLES)) {
    return { ok: false, status: 403, error: 'Moving an event to another studio needs manager access at both studios.' }
  }
  if (!hasPermissionForLocation(user, targetLocationId, 'races')) {
    return { ok: false, status: 403, error: 'Events are turned off at that studio.' }
  }

  const { data: locs, error } = await db
    .from('locations')
    .select('id, organization_id, is_host_anchor, active')
    .in('id', [existing.location_id, targetLocationId])
  if (error) return { ok: false, status: 500, error: 'Could not read the studios. Nothing was changed.' }
  const from = (locs || []).find((l) => l.id === existing.location_id)
  const to = (locs || []).find((l) => l.id === targetLocationId)
  if (!from || !to || to.is_host_anchor || to.active === false
      || !from.organization_id || from.organization_id !== to.organization_id) {
    return { ok: false, status: 400, error: 'invalid_location' }
  }
  return { ok: true }
}
