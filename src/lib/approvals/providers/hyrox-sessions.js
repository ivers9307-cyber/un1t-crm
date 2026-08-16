// HYROX-TC.2 — approvals provider for AI-generated Hyrox Training Club
// sessions. Surfaces `draft` hyrox_sessions rows so a coach reviews/edits
// and approves each session before it can publish to the studio TV.
//
// TENANT.8 (item 4) — APPROVALS-LOCATION-SCOPE: every row is
// eq('location_id', activeId)-filtered to the viewer's own active
// location, so the registry's bundlesDenyCategory(user.activeLocation.features,
// key) check already covers every row here. No per-row location-features
// query needed — unlike host_events (org-scoped).

import { viewerActiveLocationId } from '../registry'

export const hyroxSessionsProvider = {
  key: 'hyrox_sessions',
  permissionKey: 'approvals_hyrox_sessions',
  label: 'Hyrox sessions',
  reviewBase: '/hyrox',

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    const { data, error } = await db
      .from('hyrox_sessions')
      .select('id, week_no, slot, phase, focus, created_at, location_id')
      .eq('status', 'draft')
      .eq('location_id', activeId)
      .order('week_no', { ascending: true })
      .limit(50)
    if (error) throw new Error(`hyrox_sessions: ${error.message}`)
    const items = (data || []).map((r) => ({
      id: r.id,
      title: `Week ${r.week_no} · session ${r.slot}${r.focus ? ` — ${r.focus}` : ''}`,
      subtitle: `${r.phase} phase · awaiting coach approval`,
      meta: 'Hyrox Training Club',
      submittedAt: r.created_at,
      amount: null,
      currency: null,
      reviewUrl: `/hyrox?focus=${r.id}`,
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    const { count, error } = await db
      .from('hyrox_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'draft')
      .eq('location_id', activeId)
    if (error) throw new Error(`hyrox_sessions count: ${error.message}`)
    return count || 0
  },
}
