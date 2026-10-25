// FINALTIDY.1 — who may SEE one FTE expense claim.
//
// Detail routes answer 404, not 403, to a caller who cannot see the row, so a
// claim id can't be probed for existence (CLAUDE.md invariant). Every
// /api/expenses/[id]/* handler asks canSeeExpenseClaim() first and answers a
// caller who fails it exactly as it answers a missing claim. A caller who CAN
// see the claim but may not perform the action (the claimant pressing
// Approve, an approver pressing Submit) keeps the route's existing honest
// 403: the claim's existence is no secret to them.
//
// The visible set is the union of the surfaces that already show the claim:
//   - the claimant (their own list)
//   - master (every list)
//   - an owner at the claim's studio (GET /api/expenses location scope)
//   - anyone holding approvals_fte_expenses AT the claim's studio (the
//     approvals inbox provider lists submitted claims to them, and the
//     approve/decline routes already let them act)
// Nothing here widens who may act; it only decides 404 vs the route's own
// answer.

import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'

export function isExpenseMaster(user) {
  return user?.profileRole === 'master' || user?.role === 'master'
}

export function ownsExpenseLocation(user, locationId) {
  if (!locationId) return false
  return Object.entries(user?.rolesByLocation || {})
    .some(([loc, r]) => r === 'owner' && loc === locationId)
}

export function canApproveExpenseClaim(user, claim) {
  return hasPermissionForLocation(user, claim?.location_id, APPROVAL_CATEGORY_PERMISSION.fte_expenses)
}

export function canSeeExpenseClaim(user, claim) {
  if (!user || !claim) return false
  if (claim.profile_id === user.id) return true
  if (isExpenseMaster(user)) return true
  if (ownsExpenseLocation(user, claim.location_id)) return true
  return canApproveExpenseClaim(user, claim)
}
