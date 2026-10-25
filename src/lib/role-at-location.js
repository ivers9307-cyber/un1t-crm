// ROSTERROLE.1 — per-location role checks, split out of `src/lib/auth.js` so a
// CLIENT component can ask the same question the routes ask.
//
// WHY THE SPLIT: `@/lib/auth` reaches `next/headers` and the service-role
// Supabase client, so it can never enter a client bundle. The publish modal
// needed "is this person an owner AT THE ROSTER'S STUDIO" and, having no way
// to call this, read `user.role` instead — the role at the ACTIVE studio. For
// anyone whose active studio is not the one they are publishing, the button
// then offered the wrong action: an owner at Hatch publishing Stillorgan (or
// a master, whose `user.role` is per-location and usually not 'owner') was
// shown "Request owner approval" for a publish the server would have accepted
// outright. Copying the rule into the component was the other option, and a
// copied permission rule is a permission rule that drifts.
//
// Nothing here touches the network, `next/headers`, or the database. Keep it
// that way: this module is imported by both halves of the app.

/**
 * Does the caller hold one of `allowedRoles` AT `locationId`?
 *
 * SCHEDROLES.1 — the per-location authority check. A plain
 * `MANAGER_ROLES.includes(user.role)` check on a route that writes to a
 * PATH-PARAM location judges the wrong studio — a manager at Stillorgan who
 * is plain staff at Hatch passed it while acting on Hatch. Pass the target
 * id, never `user.activeLocation?.id`.
 *
 * Master bypass reads `profileRole` (the estate-level role on `profiles`),
 * NOT `user.role` — the same bypass `guardMasterOrOwner` uses. `user.role`
 * can read 'master' by fallback resolution, and a per-location row is not
 * where mastership lives; masters have no `rolesByLocation` entries at all.
 *
 * Fails CLOSED: a null user, a missing/blank locationId, or no per-location
 * role at the target all answer false. Note this differs from
 * assertLocationAccess, where a null locationId means "no specific location"
 * and passes — here a missing target means the caller's role cannot be
 * judged, which must never read as permission.
 *
 * MEMBERSHIP IS A SEPARATE QUESTION. Run assertLocationAccess (or
 * assertLocationAccessOr404 on a detail route) FIRST, so a caller who is not
 * at the location at all is told that, rather than getting a role complaint
 * that confirms the location exists.
 *
 * Usage:
 *   const guard = assertLocationAccess(user, locationId)
 *   if (guard) return guard
 *   if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
 *     return NextResponse.json({ success: false, error: '…' }, { status: 403 })
 *   }
 *
 * @param {{ profileRole?: string, rolesByLocation?: Record<string,string> } | null} user
 * @param {string | null | undefined} locationId  the TARGET location
 * @param {readonly string[]} allowedRoles
 * @returns {boolean}
 */
export function hasRoleAtLocation(user, locationId, allowedRoles) {
  if (!user || !locationId) return false
  if (user.profileRole === 'master') return true
  const role = user.rolesByLocation?.[locationId]
  if (!role) return false
  return (allowedRoles || []).includes(role)
}

/**
 * Does the caller hold one of `allowedRoles` at ANY location?
 *
 * SCHEDROLES.1 — a COARSE pre-check only, never the authority decision. A
 * route whose target location is not known until it has parsed the body or
 * fetched a row keeps its cheap "a plain coach has nothing to say here"
 * refusal with this, then judges the real target with hasRoleAtLocation.
 * It replaces `MANAGER_ROLES.includes(user.role)` as that pre-check: the old
 * one read the ACTIVE studio's role, so it both over-blocked (a manager whose
 * active studio is one where they are staff) and, followed only by a
 * membership check, under-blocked (a head coach at A acting on B where they
 * are staff).
 *
 * Master bypass on profileRole, as hasRoleAtLocation.
 *
 * @param {{ profileRole?: string, rolesByLocation?: Record<string,string> } | null} user
 * @param {readonly string[]} allowedRoles
 * @returns {boolean}
 */
export function hasRoleAtAnyLocation(user, allowedRoles) {
  if (!user) return false
  if (user.profileRole === 'master') return true
  return Object.values(user.rolesByLocation || {}).some((r) => (allowedRoles || []).includes(r))
}
