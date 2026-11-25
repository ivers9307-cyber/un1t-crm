// INBOXFOLLOW.4 — the pure side of the phone's follow-up UI: which snooze strip a
// thread shows, who "Handled by" says has it, the snooze request body, and how a
// snooze answer reads. No React, no network: the screens stay thin and this is
// what the tests cover. The rules themselves are shared/inbox-queues.js; the
// words of the list row are shared/inbox-row-text.js (via ./inbox).

import { isSnoozed, snoozeEnded, handledBy } from 'shared/inbox-queues'
import { SNOOZE_NOTE_MAX } from 'shared/inbox-snooze'

export const SNOOZE_FAILED = 'Could not change the snooze. Try again.'

/**
 * @returns {'snoozed'|'ended'|'none'} 'snoozed': the thread is snoozed now
 *   (show "Snoozed until … · Unsnooze"); 'ended': the time has passed but the
 *   snooze is still set (show "Snooze ended · Dismiss"); 'none': neither.
 */
export function snoozeStripMode(conv, nowMs = Date.now()) {
  if (!conv) return 'none'
  if (isSnoozed(conv, nowMs)) return 'snoozed'
  if (snoozeEnded(conv, nowMs)) return 'ended'
  return 'none'
}

/**
 * The "Handled by" status line, from the shared handledBy() states.
 * `handled_by_name` is the route's first name (null when no one is known).
 * @param {'wa'|'ig'|'whatsapp'|'instagram'} channel
 */
export function handledByLine(conv, channel = 'wa') {
  const ch = channel === 'ig' || channel === 'instagram' ? 'ig' : 'wa'
  const state = handledBy(conv, ch)
  if (state === 'paused') return 'Mia paused'
  if (state === 'unclaimed') return 'Waiting for a person'
  if (state === 'person') return `Handled by ${conv?.handled_by_name || 'a coach'}`
  return 'Handled by Mia'
}

/** The note as typed, trimmed and held to the route's limit. */
export function cleanSnoozeNote(note) {
  return String(note ?? '').trim().slice(0, SNOOZE_NOTE_MAX)
}

/**
 * The POST body. A snooze carries the last message the person has seen so the
 * route refuses (409) when a customer message has landed since; an unsnooze or
 * dismiss is only `{ until: null }`.
 */
export function snoozeBody({ until = null, note = '', seenLastMessageAt = null } = {}) {
  if (until === null) return { until: null }
  const body = { until, seen_last_message_at: seenLastMessageAt ?? null }
  const clean = cleanSnoozeNote(note)
  if (clean) body.note = clean
  return body
}

/**
 * How a snooze answer reads. A 409 means a newer message arrived: show the
 * route's message and refetch the thread so the next try carries the fresh
 * last_message_at. Any other failure shows the route's `error`, or a fixed line
 * when there is none (a dropped connection).
 * @returns {{ ok: true } | { ok: false, message: string, refetch: boolean }}
 */
export function snoozeOutcome(res) {
  if (res?.success === true) return { ok: true }
  return { ok: false, message: res?.error || SNOOZE_FAILED, refetch: res?.status === 409 }
}
