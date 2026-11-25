// INBOXFOLLOW.4 — what the phone's Messages list shows, as pure functions: which
// rows a queue holds and in what order, and each row's wait chip, window chip and
// state line. The rules are shared/inbox-queues.js and the words are
// shared/inbox-row-text.js, the same ones the web inbox reads. The screen
// (app/(staff)/(tabs)/whatsapp.jsx) only draws what this returns.

import { filterByQueue, sortNeedsReply } from 'shared/inbox-queues'
import { waitChipInfo, windowChipInfo, stateLineText } from 'shared/inbox-row-text'

// The web opens on Needs reply; so does the phone.
export const defaultQueue = 'needs_reply'

const newestFirst = (list) =>
  [...list].sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0))

/** The rows of one queue: Needs reply longest wait first, the others newest first. */
export function rowsForQueue(list, queue, nowMs, cfg) {
  const rows = filterByQueue(list, queue, nowMs, cfg)
  return queue === 'needs_reply' ? sortNeedsReply(rows, nowMs, cfg) : newestFirst(rows)
}

/** One row's chips and state line. `zone` is the studio's zone, for clock times. */
export function rowDecor(conv, nowMs, cfg, zone) {
  return {
    wait: waitChipInfo(conv, nowMs, cfg),
    window: windowChipInfo(conv, nowMs),
    stateLine: stateLineText({ conv, nowMs, cfg, zone }),
  }
}
