// Inbox queue predicates — the single source of truth for what counts as a
// conversation "needing action". Shared by the UnifiedInbox queue filters and
// the Communications badge count endpoint (/api/whatsapp/unread-count) so the
// red badge and the inbox's own view can never drift apart.
//
// SIDEBAR-BADGES.2 — the badge used to count raw unread_count, which silently
// dropped a thread the moment someone OPENED it (unread reset to 0) without
// replying or resolving, and never counted an agent handoff whose last message
// was Mia's own holding line. Real pending work (Mahishi's handed-off thread,
// Liam's unanswered inbound) showed a 0 badge. The badge now mirrors these
// predicates instead.

/** Customer's turn is the last word and nobody has resolved it → owes a reply. */
export function needsReply(c) {
  return !c?.resolved_at && c?.last_message_direction === 'inbound'
}

// INBOX-HANDOFF.1 — the agent escalated this thread to a human and nobody has
// resolved it yet. agent_handed_off_at is stamped by the customer agent's
// handoff path (auto-reply.js); resolving the thread clears it from this queue.
/** Agent handed this thread to a human and it isn't resolved yet. */
export function isAgentHandoff(c) {
  return !!c?.agent_handed_off_at && !c?.resolved_at
}

/**
 * Does this conversation need a human to do something? = unresolved AND
 * (awaiting a reply OR handed off). `last_message_at` must be set so empty /
 * stale conversation shells (no messages) never inflate the badge. Pure.
 */
export function needsAction(c) {
  if (!c || c.resolved_at || !c.last_message_at) return false
  return needsReply(c) || isAgentHandoff(c)
}
