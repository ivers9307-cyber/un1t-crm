// INBOXFOLLOW.1 — the inbox list shows the latest 50 threads, but the queues
// (Needs reply, Mia needs help, Waiting) must hold EVERY thread that needs
// someone, however old its last message. The list routes therefore also read
// the unresolved threads that are owed a reply, asked for a person, waited on
// the customer, or are snoozed, and merge them by id.
export const ACTIVE_SET_LIMIT = 300
export const ACTIVE_SET_OR = [
  'last_message_direction.eq.inbound',
  'handoff_requested_at.not.is.null',
  'staff_waiting_since.not.is.null',
  'snoozed_until.not.is.null',
].join(',')

// Latest-50 rows first, then any active-set rows they do not already hold;
// newest message first, so the list reads the same as before.
export function mergeActiveSet(latest, active) {
  const seen = new Set((latest || []).map(c => c.id))
  const extra = (active || []).filter(c => !seen.has(c.id))
  if (extra.length === 0) return latest || []
  const ts = c => (c.last_message_at ? new Date(c.last_message_at).getTime() : 0)
  return [...(latest || []), ...extra].sort((a, b) => ts(b) - ts(a))
}
