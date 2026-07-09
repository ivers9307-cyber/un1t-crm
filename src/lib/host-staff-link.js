// Link an existing UN1T staff login to a host (HOST-PORTAL.5). Pure decision:
// given the resolved staff profile, whether they share the admin's org, and any
// existing host_users link, decide the outcome. Order matters: not_staff first —
// a non-staff email must never be linked here (that would side-door a brand-new
// dual account; the invite flow is for 3rd-party hosts on a separate email).

/**
 * @param {{ staffProfile: object|null, sameOrg: boolean, existingLink: {host_id:string}|null, hostId: string }} args
 * @returns {'ok'|'not_staff'|'cross_org'|'already'|'other_host'}
 */
export function linkStaffDecision({ staffProfile, sameOrg, existingLink, hostId }) {
  if (!staffProfile) return 'not_staff'
  if (!sameOrg) return 'cross_org'
  if (existingLink) return existingLink.host_id === hostId ? 'already' : 'other_host'
  return 'ok'
}
