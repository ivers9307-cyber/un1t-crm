// APPROVALS-STUDIO.1 — one push (+ registry email fallback) per customer
// approval request, sent when a LASTING pending agent_membership_requests
// row is created: Mia draft-mode bookings/cancellations, the MIA-BOOK.1
// rejection fallback, pause/cancel/membership requests, event drafts, and
// the /start funnel's routeToReview. Auto-mode intent rows (pending for
// milliseconds while the Glofox call runs) must NOT notify — only call
// this where the row waits for a human.
//
// Deduped per (request, recipient) via notifyUsersAtRolesOnce, so calling
// it twice for the same request id (e.g. routeToReview reusing an existing
// pending row) is safe. Fire-and-forget: a notify hiccup never blocks the
// customer-facing outcome.
import { notifyUsersAtRolesOnce } from '@/lib/push-dedup'
import { APPROVAL_KIND_LABELS } from '@shared/approval-cards'

export async function notifyAgentApprovalRequest(db, { requestId, locationId, kind, customerName, summary }) {
  if (!requestId || !locationId) return
  try {
    const label = APPROVAL_KIND_LABELS[kind] || 'Customer request'
    const who = customerName || 'A customer'
    await notifyUsersAtRolesOnce(db, `agent_request:${requestId}`, locationId, ['owner', 'manager'], {
      title: `Approval needed · ${label}`,
      body: summary ? `${who}: ${summary}` : `${who} is waiting on a decision.`,
      category: 'agent_requests',
      emailSubject: 'Customer approval needed',
      data: { type: 'agent_request', request_id: requestId },
    })
  } catch (e) {
    console.warn(`[agent][approval-notify] ${kind || 'request'} ${requestId}: ${e?.message || e}`)
  }
}
