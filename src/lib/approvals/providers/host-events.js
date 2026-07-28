// HOST-APPROVALS.1 — approvals provider for host events pending review.
//
// A host submitting an event for review previously surfaced ONLY at
// /settings/hosts (+ a Settings badge and an email) — invisible in the
// approvals queue and unpushed, so a pending event could sit unseen
// (live miss: Pride Training Club's 20 Sept masterclass, 2026-07-28).
// Scope is the caller's ACTIVE ORGANIZATION (hosts are org-owned, not
// location-owned — same scoping as every /api/hosts route).
//
// Approve/decline executes via POST /api/events/[id]/review (CAS on
// pending_review; decline requires a reason), which also emails the host.

import { viewerActiveLocationId } from '../registry'

const REVIEWER_ROLES = ['master', 'owner', 'manager']

function viewerOrgId(user) {
  return user?.activeOrganization?.id || user?.activeLocation?.organization_id || null
}

export const hostEventsProvider = {
  key: 'host_events',
  label: 'Host events',
  reviewBase: '/settings/hosts',

  // Reviewer roles only — mirrors the review route's ADMIN_ROLES gate
  // (+ master). Others see no tab rather than an inert one.
  isVisible(user) {
    return REVIEWER_ROLES.includes(user?.role) ||
      REVIEWER_ROLES.includes(user?.rolesByLocation?.[viewerActiveLocationId(user)])
  },

  async fetchPending(db, user) {
    const orgId = viewerOrgId(user)
    if (!orgId) return { count: 0, items: [] }

    const { data, error } = await db
      .from('race_events')
      .select(`
        id, name, kind, race_date, status, submitted_at, created_at,
        host:event_hosts!host_id ( id, name, organization_id )
      `)
      .eq('status', 'pending_review')
      .not('host_id', 'is', null)
      .order('submitted_at', { ascending: true })
      .limit(50)

    if (error) throw new Error(`host_events: ${error.message}`)

    const rows = (data || []).filter((r) => r.host?.organization_id === orgId)
    const items = rows.map((r) => ({
      id: r.id,
      title: `${r.name} — ${r.host?.name || 'Host'}`,
      subtitle: [r.race_date, r.kind].filter(Boolean).join(' · '),
      meta: 'host event awaiting review',
      submittedAt: r.submitted_at || r.created_at,
      amount: null,
      currency: null,
      reviewUrl: `/settings/hosts`,
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const orgId = viewerOrgId(user)
    if (!orgId) return 0
    const { data, error } = await db
      .from('race_events')
      .select('id, host:event_hosts!host_id ( organization_id )')
      .eq('status', 'pending_review')
      .not('host_id', 'is', null)
      .limit(50)
    if (error) throw new Error(`host_events count: ${error.message}`)
    return (data || []).filter((r) => r.host?.organization_id === orgId).length
  },
}
