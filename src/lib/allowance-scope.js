// ROSTER-FIX.2 / SCHEDROLES.1 — who may read or manage another person's
// allowance, shared by /api/schedule/allowances and /api/schedule/allowances/lieu.
//
// A profile is in scope when it shares a studio with the caller (master =
// everywhere). Sharing a studio is not enough to MANAGE it: the caller must be
// a manager at a studio the profile belongs to (hasRoleAtLocation), not merely
// hold a manager role at their ACTIVE studio. Answers:
//   'managed'   — manager at one of the profile's studios (or master)
//   'member'    — shares a studio, manages none of the shared ones → 403
//   'foreign'   — no shared studio, or the lookup failed          → 404
// A detail-style 404 on a miss keeps a cross-tenant id indistinguishable from
// a missing one.

import { getUserLocationIds, hasRoleAtLocation } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'

export async function profileScope(db, user, profileId) {
  if (user.profileRole === 'master') return 'managed'
  const { data, error } = await db.from('profile_locations').select('location_id').eq('profile_id', profileId)
  if (error) return 'foreign'
  const mine = new Set(getUserLocationIds(user))
  const shared = (data || []).map((l) => l.location_id).filter((id) => mine.has(id))
  if (shared.length === 0) return 'foreign'
  return shared.some((id) => hasRoleAtLocation(user, id, MANAGER_ROLES)) ? 'managed' : 'member'
}
