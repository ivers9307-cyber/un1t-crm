// HUBDOOR.1 — ONE definition of "who handles staff-reported issues".
//
// The problem this replaces: `issues_inbox` is a registered, grantable
// WEB_PERMISSIONS key (shared/permissions.js — default off for staff /
// manager / head_coach, on for owner, and operator-editable per user and
// per role template), and the ⌘K palette gates its Issues command on it
// (src/lib/command-palette.js). But every issues SURFACE — the /issues
// page and all six handler API routes — gated on a hand-rolled
// `isHandler()` that admitted master/owner ROLES and never consulted the
// key at all. Seven near-identical copies of the same four lines.
//
// The result was a permission that did nothing in one direction and lied
// in the other: granting `issues_inbox` to a manager gave them a ⌘K
// command that redirected them to '/', while the permission UI's own hint
// implied the grant worked. Prod had exactly one live instance of it (a
// head_coach holding the key via the Stillorgan head_coach role template,
// mig 364's tier 2.5) — small, but it is the same shape as the two hub
// doors this branch fixes, so it gets the same treatment.
//
// The fix is ADDITIVE by design: role handlers keep working exactly as
// before and the key is honoured ALONGSIDE them. Two consequences worth
// stating rather than discovering:
//
//   - Revoking `issues_inbox` from an owner still changes nothing, because
//     the owner ROLE admits them. Making the key authoritative would mean
//     removing the role bypass, which is a tightening (and a lockout risk
//     for any owner whose key resolves false), not this branch's job.
//   - `hasPermission` honours the per-location feature gate (mig 032), so
//     the KEY path respects a studio that has switched `issues_inbox` off,
//     while the ROLE path still does not. Same reason: closing that would
//     be a tightening. Prod has one such location (SourceIt).
//
// Deliberately NOT routed through here: the submit route's push fan-out
// (`sendPushToRolesAtLocation(locationId, ['owner','master'], …)` in
// src/app/api/issues/route.js). That is notification TARGETING, not access
// control — a granted handler who is not owner/master simply doesn't get
// pushed; nobody is locked out of anything. Making it permission-aware
// needs a permission-aware push helper (and a decision about the mobile
// `issue_triage` mirror), which is a separate change.

import { hasPermission } from '@/lib/permissions'

/**
 * Is this user a handler for issues at their ACTIVE location?
 *
 * Master and owner by role (the REPORT-ISSUE.1 "all owners at the studio"
 * routing decision), OR anyone holding the grantable `issues_inbox` key
 * there.
 *
 * `profileRole` is checked alongside `role` because `user.role` is the
 * ACTIVE-LOCATION role (src/lib/auth.js resolveActiveLocationRole) — a
 * master whose active assignment says 'staff' must still resolve master.
 *
 * @param {object|null|undefined} user  getCurrentUser() / withAuth user
 * @returns {boolean}
 */
export function isIssueHandler(user) {
  if (!user) return false
  if (user.role === 'master' || user.profileRole === 'master' || user.isMaster) return true
  if (user.role === 'owner') return true
  return hasPermission(user, 'issues_inbox')
}
