// Inbox queue rules come from the shared module (one copy for web and
// phone); this file also holds the message-type chip labels (MOBILE-MSG.M1).
//
// Pure JS, no React-Native imports, so it runs under vitest's node environment.

export {
  DEFAULT_FOLLOWUP_CFG, NUDGE_GRACE_HOURS, QUEUES,
  isSnoozed, snoozeEnded, returnAtMs, returnReason, needsReply, needsMiaHelp,
  isWaiting, needsAction, hasPendingApproval, waitSinceMs, sortNeedsReply,
  windowState, handledBy, filterByQueue, queueCounts,
} from 'shared/inbox-queues'

// The row's words (wait chip, window chip, state line) and the snooze presets are
// the shared ones the web uses, so both surfaces read the same.
export { waitChipInfo, windowChipInfo, stateLineText, durationLabel } from 'shared/inbox-row-text'
export { snoozePresets, SNOOZE_NOTE_MAX } from 'shared/inbox-snooze'

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
