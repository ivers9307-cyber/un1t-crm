// src/lib/role-templates.js
// WIDGET.1 — extracted from getCurrentUser (auth.js) so that every auth
// source resolves operator-edited role templates through one implementation.
// A second copy would drift silently and in the PERMISSIVE direction: a
// template that removes a permission would keep applying on one path and
// stop applying on the other.
//
// RECEPTION.2 (mig 367): a template can carry employment-type variants — an
// 'all' row applies to every user of the role, and an 'fte'/'contractor'/
// 'casual' row layers on top. Merged here so consumers see ONE blob.

// mergeTemplates is NOT redefined here. It lives in shared/permissions.js and
// is the canonical merge for eight call sites; it strips `mobile`, spreads the
// rest, then DEEP-merges the mobile sub-objects. A flat spread would let a
// variant's mobile blob clobber the base's, so a permission an operator
// explicitly removed would come back as a code default — the exact permissive
// drift this extraction exists to prevent.
import { mergeTemplates } from '@shared/permissions'

/**
 * @param {object} db  service-role supabase client
 * @param {object} args
 * @param {boolean} args.isMaster
 * @param {Record<string,string>} args.rolesByLocation  { [location_id]: role }
 * @param {string|null} args.employmentType             profiles.employment_type
 * @returns {Promise<{roleTemplatesByLocation: object, acDeviceTemplatesByLocation: object}>}
 */
export async function loadRoleTemplatesForLocations(db, { isMaster, rolesByLocation, employmentType }) {
  const roleTemplatesByLocation = {}
  const acDeviceTemplatesByLocation = {}

  // Master skips the fetch entirely — the resolver short-circuits master
  // past tiers 2/2.5/3, so a template can never change what a master sees.
  if (isMaster) return { roleTemplatesByLocation, acDeviceTemplatesByLocation }

  const templateLocationIds = Object.keys(rolesByLocation || {})
  if (templateLocationIds.length === 0) {
    return { roleTemplatesByLocation, acDeviceTemplatesByLocation }
  }

  try {
    const { data: templateRows } = await db
      .from('location_role_permissions')
      .select('location_id, role, employment_type, permissions, ac_device_ids')
      .in('location_id', templateLocationIds)

    const findRow = (locId, emp) => (templateRows || []).find(r =>
      r.location_id === locId && r.role === rolesByLocation[locId] && r.employment_type === emp
    ) || null
    const rowFor = (locId, emp) => findRow(locId, emp)?.permissions || null

    for (const locId of templateLocationIds) {
      const merged = mergeTemplates(
        rowFor(locId, 'all'),
        employmentType ? rowFor(locId, employmentType) : null
      )
      if (merged) roleTemplatesByLocation[locId] = merged

      // AC-ROLE.1 — variant wins if non-null, else the 'all' row, else inherit.
      const allRow = findRow(locId, 'all')
      const varRow = employmentType ? findRow(locId, employmentType) : null
      const acList = Array.isArray(varRow?.ac_device_ids)
        ? varRow.ac_device_ids
        : (Array.isArray(allRow?.ac_device_ids) ? allRow.ac_device_ids : null)
      if (acList !== null) acDeviceTemplatesByLocation[locId] = acList
    }
  } catch {
    // Defensive, preserved from auth.js VERBATIM: the original catch is empty
    // and falls through, returning whatever accumulated before the throw.
    // Returning fresh empty maps here would discard partial accumulation —
    // a behaviour change, however unreachable.
  }

  return { roleTemplatesByLocation, acDeviceTemplatesByLocation }
}
