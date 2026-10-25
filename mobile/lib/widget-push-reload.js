// mobile/lib/widget-push-reload.js
// WIDGET.1 Task 13 — "should this push reload the What Needs Me widget?"
// Pure decision, extracted from the push-received handler so it's testable
// (no RN component test runner exists in this repo — see CLAUDE.md).
//
// The widget renders GET /api/home-queue/count's three buckets
// (approvals / mail / inbox — src/lib/home-queue.js getHomeQueueCounts()).
// WidgetKit throttles reloads against a small daily budget, so this is
// deliberately a NARROW allowlist of push types that can move one of those
// three numbers — not "any push", which the Task 13 plan draft proposed and
// which would spend the budget on pushes the widget can't show anything
// different for (a schedule change, a WhatsApp health alert, a decision
// notice to the person who ALREADY knows because they made the decision in
// the app).
//
// Each entry below is cross-checked against the server send site that
// mints data.type (grepped across src/app/api/** + src/lib/**) and the
// provider/query it feeds:
//
//   approvals (src/lib/approvals/registry.js providers) — a NEW pending
//   item lands:
//     swap_open, swap_awaiting   — shift-swaps provider (status IN
//                                  pending/awaiting_approval); sent from
//                                  src/app/api/schedule/swaps/[id]/route.js
//                                  and .../swaps/route.js.
//     time_off_inbound           — time-off provider; schedule/time-off/route.js.
//     agent_request              — agent-requests provider; agent/approval-notify.js.
//     host_event_review          — host-events provider; host-notifications.js.
//     expense_submitted          — fte-expenses provider; expenses/[id]/submit/route.js.
//     issue_submitted            — issues provider (open+in_progress); issues/route.js.
//
//   mail (src/lib/home-queue.js countConversationsNeedsReply — email_tickets
//   needing a reply):
//     email_inbound — fired exactly when the PRE-increment unread_count is
//                     0, i.e. this message is what makes the ticket newly
//                     need a reply (email-inbound-push.js).
//
//   inbox (countInboxNeedsAction — needsReply OR isAgentHandoff on an
//   unresolved WhatsApp/Instagram conversation, src/lib/inbox-queues.js):
//     whatsapp_inbound, instagram_inbound         — new inbound message.
//     whatsapp_agent_handoff, instagram_agent_handoff — agent handed the
//                     thread to a human, which is the OTHER predicate
//                     needsAction() checks.
//
// Deliberately EXCLUDED, and why (all confirmed against the same grep):
//   - swap_inbound/claimed/accepted/withdrawn/declined/decision,
//     time_off_decision — personal notices to the requester/taker, not a
//     change to the manager's approvals queue.
//   - swap_open_pool — broadcast to the eligible claim-pool, not an
//     approval-queue item.
//   - invoice_approved/declined, expense_approved/declined, issue_resolved
//     — DECISION notices sent to the person who submitted the item, i.e.
//     it is LEAVING the queue on an action the approver already took
//     inside the app; nothing here for the approvals count that the
//     approver's own client doesn't already know.
//   - agent_request_expired, agent_request_stale (agent/approvals-sla.js)
//     — about an item that is ALREADY counted; the queue size doesn't
//     change.
//   - agent_activity — "customer is chatting with Mia"; the agent is still
//     handling it, so isAgentHandoff/needsReply haven't flipped yet.
//   - contract_issued, checklist_overdue, checklist_compliance, lead_new,
//     task_reminder, booking_reminder, schedule_published/updated,
//     shift_adjusted, wa_quality, number_health, flow_health,
//     template_status, admin_test_push — none of these feed any of the
//     three home-queue buckets at all.

const RELOAD_TYPES = new Set([
  // approvals
  'swap_open',
  'swap_awaiting',
  'time_off_inbound',
  'agent_request',
  'host_event_review',
  'expense_submitted',
  'issue_submitted',
  // mail
  'email_inbound',
  // inbox
  'whatsapp_inbound',
  'instagram_inbound',
  'whatsapp_agent_handoff',
  'instagram_agent_handoff',
])

/**
 * @param {{type?: string}|null|undefined} data — a push's `data` payload
 *   (response.notification.request.content.data / notification's own
 *   .request.content.data — same shape either way).
 * @returns {boolean} true iff this push type can change one of the three
 *   What Needs Me counts (approvals / mail / inbox) and is therefore worth
 *   spending a WidgetKit reload on.
 */
export function shouldReloadWidgetsForPush(data) {
  return typeof data?.type === 'string' && RELOAD_TYPES.has(data.type)
}
