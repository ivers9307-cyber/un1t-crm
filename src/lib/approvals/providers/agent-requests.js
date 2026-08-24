// AGENT-HANDS.1 — approvals provider for customer-agent requests.
//
// Surfaces PENDING agent_membership_requests (pause / cancellation /
// class_booking drafts) inside /approvals so they stop living only on
// the easily-missed /settings/customer-agent/requests page. Bookings
// are time-sensitive — a class can start within hours — so they need
// the badge + Today-feed pickup the registry provides for free.
// Auto-mode bookings and consultations finalise to actioned/failed
// (audit trail) and normally never appear here — MIA-REVIEW.3 writes
// their intent row as 'pending' for the duration of the Glofox call, so
// the only auto-mode rows that linger in this queue are ones whose
// execution crashed mid-flight. Approving such a row re-runs the action
// (Glofox arbitrates double-booking), which is the intended recovery.
//
// Visibility here is INTENTIONALLY narrower than who can act: the PATCH
// /api/agent/membership-requests/[id] route accepts any staff at the
// request's location (comms-surface rights — INBOX-APPROVALS, Richard
// 2026-07-03), but the /approvals badge/count/Today-feed stays manager+
// so the review queue remains a manager surface. Non-manager staff
// decide from the inline card in /communications/inbox instead
// (GET ?conversation_id= form).
//
// TENANT.8 (item 4) — APPROVALS-LOCATION-SCOPE: every row is
// eq('location_id', activeId)-filtered to the viewer's own active
// location, so the registry's bundlesDenyCategory(user.activeLocation.features,
// key) check already covers every row here. No per-row location-features
// query needed — unlike host_events (org-scoped).

import { viewerActiveLocationId } from '../registry'
import { formatMoneyMinor } from '@/lib/money-format'

const KIND_LABELS = {
  pause: 'Pause membership',
  cancellation: 'Cancel membership',
  class_booking: 'Book class',
  consultation: 'Book consultation',
}

// One-line summary of the request payload per kind. Exported for tests.
export function agentRequestSubtitle(row) {
  const d = row?.details || {}
  if (row?.kind === 'class_booking') {
    const parts = [d.class_name, d.class_time].filter(Boolean)
    if (d.paid) parts.push(`💳 Paid ${formatMoneyMinor(d.amount_cents, d.currency)}`)
    return parts.join(' · ') || 'Class booking request'
  }
  if (row?.kind === 'consultation') {
    return [d.date, d.start_time].filter(Boolean).join(' · ') || 'Consultation request'
  }
  if (row?.kind === 'pause') {
    const span = [d.start_date, d.end_date].filter(Boolean).join(' → ')
    return [span || null, d.reason].filter(Boolean).join(' · ') || 'Pause request'
  }
  return d.reason || row?.customer_note || 'Cancellation request'
}

export const agentRequestsProvider = {
  key: 'agent_requests',
  permissionKey: 'approvals_agent_requests',
  label: 'Agent requests',
  reviewBase: '/settings/customer-agent/requests',

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }

    const { data, error } = await db
      .from('agent_membership_requests')
      .select(`
        id, kind, details, customer_note, created_at, location_id,
        channel, conversation_id, retention_flagged,
        contact:contacts!contact_id ( id, name, email, phone )
      `)
      .eq('location_id', activeId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw new Error(`agent_requests: ${error.message}`)

    const items = (data || []).map((r) => ({
      id: r.id,
      title: `${KIND_LABELS[r.kind] || r.kind} — ${r.contact?.name || 'Customer'}`,
      subtitle: agentRequestSubtitle(r).slice(0, 160),
      meta: 'via the customer agent',
      submittedAt: r.created_at,
      amount: r.details?.paid ? (r.details.amount_cents ?? null) : null,
      currency: r.details?.paid ? (r.details.currency || 'EUR') : null,
      reviewUrl: `/settings/customer-agent/requests?focus=${r.id}`,
      // APPROVALS-STUDIO.1 — the mobile Customers tab renders + actions
      // these directly, so it needs the raw request fields. AGENT-REQ-UX.1
      // — the web tab now renders + actions them inline too.
      kind: r.kind,
      details: r.details || {},
      customerNote: r.customer_note || null,
      contactId: r.contact?.id || null,
      contactName: r.contact?.name || null,
      // For the operator's Glofox lookup — shown on the decide card.
      contactEmail: r.contact?.email || null,
      contactPhone: r.contact?.phone || null,
      retentionFlagged: !!r.retention_flagged,
      channel: r.channel || null,
      conversationId: r.conversation_id || null,
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    const { count, error } = await db
      .from('agent_membership_requests')
      .select('*', { count: 'exact', head: true })
      .eq('location_id', activeId)
      .eq('status', 'pending')
    if (error) throw new Error(`agent_requests count: ${error.message}`)
    return count || 0
  },
}
