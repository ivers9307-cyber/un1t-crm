// INBOXFOLLOW.2 — the part of POST …/conversations/[id]/snooze that both
// channels share: judge a validated body against a thread and the server
// clock, and say what to write. The routes own sign-in, studio and permission.

import { snoozePatch, unsnoozePatch } from '@/lib/inbox-state'
import { snoozeUntilProblem } from '@shared/inbox-snooze'

/**
 * @param {{ until: string|null, note: string|null }} body  validated by SnoozeSchema
 * @param {{ resolved_at?: string|null }} conversation
 * @returns {{ patch: object } | { status: number, error: string }}
 */
export function snoozeUpdateFor(body, conversation, { userId, nowMs = Date.now() }) {
  // Clearing a snooze is always allowed, and a thread that is not snoozed stays as it is.
  if (body.until === null) return { patch: unsnoozePatch() }
  if (conversation.resolved_at) return { status: 400, error: 'Conversation is completed' }
  const untilMs = Date.parse(body.until)
  const problem = snoozeUntilProblem(untilMs, nowMs)
  if (problem) return { status: 400, error: problem }
  return { patch: snoozePatch({ untilIso: new Date(untilMs).toISOString(), userId, note: body.note }) }
}
