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
import { EXECUTING_KINDS, retryOffered } from '@/lib/agent/request-recovery'
import { failureExplanation, accountSummaryLine, whyFlagged } from '@/lib/approvals/agent-request-why'

// AGENT-FUNNEL-CREDITS.1 — the membership/credit fields the Glofox sync
// denormalises onto contacts, surfaced on every approval card so staff see
// what the account can book with before deciding.
const CONTACT_EMBED = 'contact:contacts!contact_id ( id, name, email, phone, glofox_membership_plan, glofox_membership_status, glofox_membership_state, trial_credits_remaining )'

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

// Shared item shape for both queues (pending + failed-retryable).
function toItem(r) {
  return {
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
    // Pre-computed (like failedWhy) so mobile renders them without a lib.
    accountLine: accountSummaryLine(r.contact),
    why: whyFlagged(r),
  }
}

// AGENT-RETRY.2 — failed executions ride the badge. A failed Glofox
// execution is a customer who was told nothing and is still waiting; until
// now it counted nowhere and was only visible if someone happened to open
// the card or the requests page. The lookback bounds the table scan; the
// real gate is retryOffered (class still in the future, or failed within
// its recency window) — same rule as the settings page's section.
const RETRY_LOOKBACK_DAYS = 30

async function fetchRetryableFailed(db, activeId, { withContact = true } = {}) {
  const cutoff = new Date(Date.now() - RETRY_LOOKBACK_DAYS * 86_400_000).toISOString()
  const contactEmbed = withContact ? `, ${CONTACT_EMBED}` : ''
  const { data, error } = await db
    .from('agent_membership_requests')
    .select(`id, kind, status, details, customer_note, created_at, decided_at, location_id, channel, conversation_id, retention_flagged${contactEmbed}`)
    .eq('location_id', activeId)
    .eq('status', 'failed')
    .in('kind', [...EXECUTING_KINDS])
    .gte('decided_at', cutoff)
    .order('decided_at', { ascending: false })
    .limit(50)
  if (error) throw new Error(`agent_requests failed: ${error.message}`)
  return (data || []).filter((r) => retryOffered(r, Date.now()))
}

export const agentRequestsProvider = {
  key: 'agent_requests',
  permissionKey: 'approvals_agent_requests',
  label: 'Agent requests',
  reviewBase: '/settings/customer-agent/requests',

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [], failedItems: [] }

    const { data, error } = await db
      .from('agent_membership_requests')
      .select(`
        id, kind, details, customer_note, created_at, location_id,
        channel, conversation_id, retention_flagged,
        ${CONTACT_EMBED}
      `)
      .eq('location_id', activeId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw new Error(`agent_requests: ${error.message}`)

    const items = (data || []).map(toItem)
    // AGENT-RETRY.2 — failed-retryable rows travel in their OWN array, not
    // in items: the mobile Customers tab renders items verbatim and has no
    // retry affordance yet, so mixing them in would show mobile a card
    // whose Decline can only 409. They DO count — that is the point.
    const failedItems = (await fetchRetryableFailed(db, activeId)).map((r) => ({
      ...toItem(r),
      failed: true,
      failedAt: r.decided_at || null,
      // Pre-computed what-went-wrong copy so mobile renders it without
      // needing the (web-side) explainer lib.
      failedWhy: failureExplanation(r),
    }))
    return { count: items.length + failedItems.length, items, failedItems }
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
    // AGENT-RETRY.2 — the badge must agree with the tab: pending + offered
    // retries. The failed side can't be a head-count (retryOffered reads
    // details/decided_at per row), so it fetches the bounded window without
    // the contact embed and counts in JS.
    const failed = await fetchRetryableFailed(db, activeId, { withContact: false })
    return (count || 0) + failed.length
  },
}
