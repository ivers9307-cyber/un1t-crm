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
//
// TENANT.8 (item 4) — host_events is the ONE provider in APPROVALS_PROVIDERS
// whose rows can span MULTIPLE locations within the org (every other
// provider is already eq('location_id', activeId)-scoped — see each
// provider file's own APPROVALS-LOCATION-SCOPE comment), so the registry's
// isProviderVisible only checking the VIEWER'S active location's bundle
// state is NOT enough here: a row can legitimately belong to a different,
// bundle-OFF location. filterRowsByLocationBundle fetches every involved
// location's features in one query and filters row-by-row.

import { viewerActiveLocationId, filterRowsByLocationBundle } from '../registry'

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
        id, name, kind, race_date, status, submitted_at, created_at, location_id,
        host:event_hosts!host_id ( id, name, organization_id )
      `)
      .eq('status', 'pending_review')
      .not('host_id', 'is', null)
      .order('submitted_at', { ascending: true })
      .limit(50)

    if (error) throw new Error(`host_events: ${error.message}`)

    const orgRows = (data || []).filter((r) => r.host?.organization_id === orgId)
    // TENANT.8 (item 4) — per-row bundle filter (see header comment).
    const rows = await filterRowsByLocationBundle(db, orgRows, 'host_events')
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
      .select('id, location_id, host:event_hosts!host_id ( organization_id )')
      .eq('status', 'pending_review')
      .not('host_id', 'is', null)
      .limit(50)
    if (error) throw new Error(`host_events count: ${error.message}`)
    const orgRows = (data || []).filter((r) => r.host?.organization_id === orgId)
    // TENANT.8 (item 4) — count must match fetchPending's filtered set.
    const rows = await filterRowsByLocationBundle(db, orgRows, 'host_events')
    return rows.length
  },
}
