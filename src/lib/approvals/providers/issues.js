// REPORT-ISSUE.2 — approvals provider for staff-reported issues.
//
// Surfaces open + in_progress issues at the user's active location
// as another category inside /approvals so handlers don't need to
// flip between two inboxes. The dedicated /issues page is still the
// richer surface (claim + resolve + close); the /approvals tab is
// the aggregator view.
//
// Scope: owner + master at the location (per the "All owners at the
// studio" routing decision). Non-handlers see a 0-count empty tab
// (the inbox UI hides 0-count tabs by default).

import {
  canApproveAtActiveLocation,
  viewerActiveLocationId,
} from '../registry'

const HANDLER_ROLES = ['owner']
const OPEN_STATUSES = ['open', 'in_progress']

export const issuesProvider = {
  key: 'issues',
  label: 'Issues',
  reviewBase: '/issues',

  // Hide the tab entirely for non-handlers — head_coach / manager /
  // staff don't act on issues, so an empty tab would just be noise.
  // Master always sees it (handled inside canApproveAtActiveLocation).
  isVisible(user) {
    return canApproveAtActiveLocation(user, HANDLER_ROLES)
  },

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    if (!canApproveAtActiveLocation(user, HANDLER_ROLES)) {
      return { count: 0, items: [] }
    }

    const { data, error } = await db
      .from('issues')
      .select(`
        id, description, status, created_at, location_id,
        submitter:submitter_id ( id, full_name ),
        location:location_id ( id, name )
      `)
      .eq('location_id', activeId)
      .in('status', OPEN_STATUSES)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw new Error(`issues: ${error.message}`)

    const items = (data || []).map((r) => ({
      id: r.id,
      title: r.submitter?.full_name || 'Staff',
      // Single-line preview so the inbox card stays scannable.
      subtitle: (r.description || '').slice(0, 160),
      meta: r.location?.name || null,
      submittedAt: r.created_at,
      amount: null,
      currency: null,
      // Land on /issues with the row focused. The inbox drawer
      // doesn't currently read ?focus= but adding it keeps the
      // contract consistent across providers and is a no-op
      // until the inbox grows that affordance.
      reviewUrl: `/issues?focus=${r.id}`,
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    if (!canApproveAtActiveLocation(user, HANDLER_ROLES)) return 0
    const { count, error } = await db
      .from('issues')
      .select('*', { count: 'exact', head: true })
      .eq('location_id', activeId)
      .in('status', OPEN_STATUSES)
    if (error) throw new Error(`issues count: ${error.message}`)
    return count || 0
  },
}
