// Inbox queue predicates + message-type labels (MOBILE-MSG.M1).
//
// Pure JS, no React-Native imports — runs under vitest's node
// environment (see vitest.config include for mobile/lib). These mirror
// the web UnifiedInbox semantics EXACTLY so a conversation sits in the
// same queue on phone and desktop:
//
//   needs reply   = unresolved + last message inbound
//   agent handoff = Mia escalated (agent_handed_off_at) + unresolved
//
// Resolving a thread clears both — and server-side the conversation
// PATCH re-arms the agent for the next inbound (AGENT-REARM.1), so the
// mobile ✓ is a full "hand it back to Mia", not just list hygiene.

export function needsReply(c) {
  return !!c && !c.resolved_at && c.last_message_direction === 'inbound'
}

export function isAgentHandoff(c) {
  return !!c && !!c.agent_handed_off_at && !c.resolved_at
}

export const QUEUES = [
  { key: 'all', label: 'All' },
  { key: 'needs_reply', label: 'Needs reply' },
  { key: 'handoff', label: 'Agent handoff' },
]

const QUEUE_PREDICATES = {
  all: () => true,
  needs_reply: needsReply,
  handoff: isAgentHandoff,
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
}

export function mediaLabel(messageType) {
  if (!messageType || messageType === 'text') return null
  return MEDIA_LABELS[messageType] || { icon: 'attach-outline', label: messageType }
}
