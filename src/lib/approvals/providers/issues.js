// REPORT-ISSUE.2 — approvals provider for staff-reported issues.
//
// Surfaces open + in_progress issues at the user's active location as
// another category inside /approvals so handlers don't need to flip
// between two inboxes. The dedicated /issues page is still the richer
// surface (claim + resolve + close); the /approvals tab is the
// aggregator view.
//
// HOME.3 — unified with countInboxIssues's open+in_progress definition
// (src/lib/issues.js — the same query the retired /api/issues/count
// sidebar-badge route used to run). Previously this provider counted
// 'open' only, on the APPROVALS-STUDIO.2 theory that a claimed
// (in_progress) issue is "decided, just pending actioning" — but that
// left this tab and the sidebar issues badge counting two different
// populations of the same table, which is precisely the drift the home
// queue exists to remove: an operator working off one badge and a handler
// working off the other would disagree about how many issues are open.
// One definition, shared.
//
// Scope: issue handlers at the location — owner + master by role (the
// "All owners at the studio" routing decision), OR anyone holding the
// grantable `issues_inbox` key. HUBDOOR.1 folded the key in so this tab,
// the /issues page, the six handler API routes and the command palette
// all resolve the same population; before it, a manager granted
// `issues_inbox` got a palette command and no tab and no page. The OR
// lives in canHandleIssues below rather than in canApproveAtActiveLocation
// (whose `allowedRoles` contract is role-only, shared by six other
// providers). Non-handlers see a 0-count empty tab (the inbox UI hides
// 0-count tabs by default).
//
// TENANT.8 (item 4) — APPROVALS-LOCATION-SCOPE: every row is
// eq('location_id', activeId)-filtered to the viewer's own active
// location (defence in depth even though `issues` has no
// CATEGORY_BUNDLES mapping at all — it mirrors the core `issues_inbox`
// key, see shared/permission-bundles.js, so bundlesDenyCategory never
// denies it here regardless).

import {
  canApproveAtActiveLocation,
  viewerActiveLocationId,
} from '../registry'
import { hasPermission } from '@/lib/permissions'

const HANDLER_ROLES = ['owner']

// Master is handled inside canApproveAtActiveLocation; hasPermission is
// resolved against the caller's ACTIVE location, the same scope this
// provider filters its rows to, so the two halves agree on "where".
function canHandleIssues(user) {
  return canApproveAtActiveLocation(user, HANDLER_ROLES) || hasPermission(user, 'issues_inbox')
}
const OPEN_STATUSES = ['open', 'in_progress']

export const issuesProvider = {
  key: 'issues',
  label: 'Issues',
  reviewBase: '/issues',

  // Hide the tab entirely for non-handlers — head_coach / manager /
  // staff don't act on issues, so an empty tab would just be noise.
  // Master always sees it (handled inside canApproveAtActiveLocation).
  isVisible(user) {
    return canHandleIssues(user)
  },

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    if (!canHandleIssues(user)) {
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
    if (!canHandleIssues(user)) return 0
    const { count, error } = await db
      .from('issues')
      .select('*', { count: 'exact', head: true })
      .eq('location_id', activeId)
      .in('status', OPEN_STATUSES)
    if (error) throw new Error(`issues count: ${error.message}`)
    return count || 0
  },
}
