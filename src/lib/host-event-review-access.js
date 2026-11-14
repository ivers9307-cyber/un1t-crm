// APPROVALSQ.4 — the ONE rule for who may review (approve or reject) a host
// event, shared by the approvals provider (who is shown it) and
// POST /api/events/[id]/review (who may decide it), so they cannot drift.
//
// Master, owner or manager by the global role, or by the role held at the
// viewer's ACTIVE studio. The event itself is scoped to the caller's
// organisation by the route (loadHostForOrg).

export const HOST_EVENT_REVIEWER_ROLES = ['master', 'owner', 'manager']

export function canReviewHostEvents(user, activeId = user?.activeLocation?.id || null) {
  return HOST_EVENT_REVIEWER_ROLES.includes(user?.role) ||
    HOST_EVENT_REVIEWER_ROLES.includes(user?.rolesByLocation?.[activeId])
}
