// CONTACTEXPORT.1 — who may export contacts to a file (Richard's decision,
// 19 Nov 2026): owners and masters only, at the studio, with Contacts there.
// An export is personal data leaving the CRM, so the bar is higher than the
// bulk tag's (managers may tag; they may not export). Pure; shared by the
// route and the contacts page, so the button shows exactly when the route
// would allow it.
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { hasPermissionForLocation } from '@/lib/permissions'

export function canExportContactsAt(user, locationId) {
  if (!user || !locationId) return false
  if (user.isMaster || user.role === 'master') return true
  const member = (user.locations || []).some((l) => l?.id === locationId)
  if (!member) return false
  return hasRoleAtLocation(user, locationId, ['owner']) && hasPermissionForLocation(user, locationId, 'contacts')
}
