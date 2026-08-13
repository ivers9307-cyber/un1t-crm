// Inbox queue predicates + message-type labels (MOBILE-MSG.M1).
//
// Pure JS, no React-Native imports — runs under vitest's node
// environment (see vitest.config include for mobile/lib). These mirror
// the web src/lib/inbox-queues.js semantics EXACTLY so a conversation
// sits in the same queue on phone and desktop:
//
//   needs reply      = unresolved + last message inbound
//   agent handoff    = Mia escalated (agent_handed_off_at) + unresolved
//   needs action     = unresolved AND (needs reply OR handoff), with a
//                      last_message_at guard so empty conversation
//                      shells never inflate a badge (SIDEBAR-BADGES.2)
//   pending approval = the agent captured a request awaiting a human
//                      decision (pending_approval is annotated by the
//                      conversations routes / a pending-requests fetch;
//                      it is not a table column) — INBOX-APPROVALS
//
// Resolving a thread clears needs-reply + handoff — and server-side the
// conversation PATCH re-arms the agent for the next inbound
// (AGENT-REARM.1), so the mobile ✓ is a full "hand it back to Mia",
// not just list hygiene. Email conversations never carry
// agent_handed_off_at or pending_approval (no customer agent on email);
// the predicates read those as absent, which is correct.

export function needsReply(c) {
  return !!c && !c.resolved_at && c.last_message_direction === 'inbound'
}

export function isAgentHandoff(c) {
  return !!c && !!c.agent_handed_off_at && !c.resolved_at
}

/**
 * Does this conversation need a human to do something? = unresolved AND
 * (awaiting a reply OR handed off). `last_message_at` must be set so
 * empty / stale conversation shells (no messages) never inflate the
 * badge. Mirrors src/lib/inbox-queues.js needsAction exactly. Pure.
 */
export function needsAction(c) {
  if (!c || c.resolved_at || !c.last_message_at) return false
  return needsReply(c) || isAgentHandoff(c)
}

/**
 * The agent captured a request on this thread that's still awaiting a
 * human decision. Mirrors the web UnifiedInbox row pill's predicate
 * (truthiness of the route-annotated `pending_approval` flag).
 */
export function hasPendingApproval(c) {
  return !!c?.pending_approval
}

export const QUEUES = [
  { key: 'all', label: 'All' },
  { key: 'needs_reply', label: 'Needs reply' },
  { key: 'handoff', label: 'Agent handoff' },
  { key: 'pending_approval', label: 'Approval' },
]

const QUEUE_PREDICATES = {
  all: () => true,
  needs_reply: needsReply,
  handoff: isAgentHandoff,
  pending_approval: hasPendingApproval,
}

export function filterByQueue(conversations, queue) {
  const pred = QUEUE_PREDICATES[queue] || QUEUE_PREDICATES.all
  return (conversations || []).filter(pred)
}

export function queueCounts(conversations) {
  const list = conversations || []
  return {
    all: list.length,
    needs_reply: list.filter(needsReply).length,
    handoff: list.filter(isAgentHandoff).length,
    pending_approval: list.filter(hasPendingApproval).length,
  }
}

// Chip metadata for non-text messages. Returns null for text (no chip)
// or { icon, label } where icon is an Ionicons name. Voice notes matter
// most here: Mia soft-hands them to the team (no transcription by
// design), so the thread must show WHAT arrived, not "[audio]".
const MEDIA_LABELS = {
  audio: { icon: 'mic-outline', label: 'Voice note' },
  voice: { icon: 'mic-outline', label: 'Voice note' },
  image: { icon: 'image-outline', label: 'Photo' },
  video: { icon: 'videocam-outline', label: 'Video' },
  document: { icon: 'document-outline', label: 'Document' },
  sticker: { icon: 'happy-outline', label: 'Sticker' },
  location: { icon: 'location-outline', label: 'Location' },
  contacts: { icon: 'person-outline', label: 'Contact card' },
  // Instagram kinds. Without these the chip fell back to the raw webhook
  // string and a bubble read "story_mention" — internal vocabulary in front
  // of an operator (IG-MEDIA.4).
  story_mention: { icon: 'aperture-outline', label: 'Story mention' },
  share: { icon: 'link-outline', label: 'Shared post' },
  reel: { icon: 'film-outline', label: 'Reel' },
}

export function mediaLabel(messageType) {
  if (!messageType || messageType === 'text') return null
  return MEDIA_LABELS[messageType] || { icon: 'attach-outline', label: messageType }
}
