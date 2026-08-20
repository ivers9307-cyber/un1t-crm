// HUBDOOR.2 — ONE definition of "who may open the challenges admin".
//
// Same problem shape as issues-access.js, found by review of HUBDOOR.1:
// /api/challenges and /api/challenges/[id] have always gated on BOTH a
// role floor and a permission key —
//
//     MANAGER_ROLES.includes(user.role) && hasPermission(user, 'challenges')
//
// — but nothing on the way IN honoured the role half. `src/app/(members)/
// challenges/page.js` is `'use client'` with no server gate at all: its
// only access control was the load fetch's 403 handler doing
// `router.replace('/')`. So a staff or reception holder of `challenges`
// (grantable: `challenges` is a registered WEB_PERMISSIONS key, and the
// Stillorgan head_coach role template already sets it, so operators do use
// it) got the page shell, a flash of chrome, a failed fetch, and a bounce.
// The (members) tab strip and the Members hub redirect chain both offered
// them the door on the key alone, so the bounce was reachable by two more
// routes than typing the URL.
//
// The fix is a TIGHTENING of the surfaces to match the data route, never a
// widening of the data route to match the surfaces: /api/challenges keeps
// exactly the gate it had. Nobody who could load challenge data before can
// not load it now, and nobody who could not, now can. What changes is that
// the refusal happens server-side, before render, at every entrance.
//
// The role floor is MANAGER_ROLES (master, owner, manager, head_coach) —
// `user.role` is the ACTIVE-LOCATION role, so a master whose active
// assignment is 'staff' is refused, exactly as the API refuses them.
// Widening that to admit master-by-profile would be a real widening and is
// deliberately not done here; if it is wanted it belongs in the API first.

import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'

// Exported as its own name so the Members hub redirect chain
// (src/lib/hub-index-chains.js) can record this step's role floor as data
// and stay bound to this module rather than re-deriving it. Pinned in
// challenges-access.test.js.
export const CHALLENGE_ADMIN_ROLES = MANAGER_ROLES

/**
 * May this user open the challenges admin at their ACTIVE location?
 *
 * @param {object|null|undefined} user  getCurrentUser() / withAuth user
 * @returns {boolean}
 */
export function canAdminChallenges(user) {
  if (!user) return false
  if (!CHALLENGE_ADMIN_ROLES.includes(user.role)) return false
  return hasPermission(user, 'challenges')
}
