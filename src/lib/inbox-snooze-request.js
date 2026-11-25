// INBOXFOLLOW.2 — the part of POST …/conversations/[id]/snooze that both
// channels share: judge a validated body against a thread and the server
// clock, and say what to write. The routes own sign-in, studio and permission.

import { snoozePatch, unsnoozePatch } from '@/lib/inbox-state'
import { snoozeUntilProblem } from '@shared/inbox-snooze'

export const NEW_MESSAGE_ERROR = 'A new message arrived. Check it before snoozing.'

/**
 * @param {{ until: string|null, note: string|null, seen_last_message_at?: string|null }} body  validated by SnoozeSchema
 * @param {{ resolved_at?: string|null, last_message_at?: string|null, last_message_direction?: string|null }} conversation
 * @returns {{ patch: object, lastMessageGuard: { value: string|null } | null } | { status: number, error: string }}
 *   `lastMessageGuard` is set when the caller said what they had seen: the
 *   route makes the write conditional on last_message_at still being `value`,
 *   so a message landing between the read and the write is caught too.
 */
export function snoozeUpdateFor(body, conversation, { userId, nowMs = Date.now() }) {
  // Clearing a snooze is always allowed, and a thread that is not snoozed stays as it is.
  if (body.until === null) return { patch: unsnoozePatch() }
  if (conversation.resolved_at) return { status: 400, error: 'Conversation is completed' }
  const untilMs = Date.parse(body.until)
  const problem = snoozeUntilProblem(untilMs, nowMs)
  if (problem) return { status: 400, error: problem }
  const seen = body.seen_last_message_at
  let lastMessageGuard = null
  if (seen !== undefined && seen !== null) {
    const seenMs = Date.parse(seen)
    const lastMs = conversation.last_message_at ? Date.parse(conversation.last_message_at) : null
    if (conversation.last_message_direction === 'inbound' && lastMs !== null && lastMs > seenMs) {
      return { status: 409, error: NEW_MESSAGE_ERROR }
    }
    lastMessageGuard = { value: conversation.last_message_at ?? null }
  }
  return { lastMessageGuard, patch: snoozePatch({ untilIso: new Date(untilMs).toISOString(), userId, note: body.note }) }
}
