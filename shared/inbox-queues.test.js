import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FOLLOWUP_CFG, NUDGE_GRACE_HOURS, QUEUES,
  isSnoozed, returnAtMs, returnReason, needsReply, needsMiaHelp,
  isWaiting, needsAction, hasPendingApproval, waitSinceMs, sortNeedsReply,
  windowState, handledBy, filterByQueue, queueCounts,
} from './inbox-queues'

const H = 3600_000
const NOW = Date.parse('2026-11-25T12:00:00Z')
const ago = h => new Date(NOW - h * H).toISOString()
const ahead = h => new Date(NOW + h * H).toISOString()
const Q48 = { quietHours: 48, nudgeEnabled: false }
const Q48N = { quietHours: 48, nudgeEnabled: true }

// A thread staff replied to `h` hours ago.
const staffReplied = (h, extra = {}) => ({
  id: 'x', last_message_at: ago(h), last_message_direction: 'outbound',
  staff_waiting_since: ago(h), resolved_at: null, ...extra,
})
const inbound = (extra = {}) => ({
  id: 'i', last_message_at: ago(1), last_message_direction: 'inbound',
  customer_waiting_since: ago(1), resolved_at: null, ...extra,
})

describe('constants', () => {
  it('defaults and queue list', () => {
    expect(DEFAULT_FOLLOWUP_CFG).toEqual({ quietHours: 48, nudgeEnabled: false })
    expect(NUDGE_GRACE_HOURS).toBe(24)
    expect(QUEUES.map(q => q.key)).toEqual(['needs_reply', 'mia_help', 'waiting', 'pending_approval', 'all'])
    expect(QUEUES.map(q => q.label)).toEqual(['Needs reply', 'Mia needs help', 'Waiting', 'Approvals', 'All'])
  })
})

describe('isSnoozed', () => {
  it('true only while snoozed_until is in the future', () => {
    expect(isSnoozed({ snoozed_until: ahead(1) }, NOW)).toBe(true)
    expect(isSnoozed({ snoozed_until: ago(1) }, NOW)).toBe(false)
    expect(isSnoozed({}, NOW)).toBe(false)
    expect(isSnoozed(null, NOW)).toBe(false)
  })
})

describe('returnAtMs', () => {
  it('null when we are not waiting', () => {
    expect(returnAtMs(inbound(), Q48, 'wa')).toBe(null)
  })
  it('waiting_since + Q by default', () => {
    expect(returnAtMs(staffReplied(10), Q48, 'wa')).toBe(NOW - 10 * H + 48 * H)
  })
  it('nudges on adds the 24h grace on wa only', () => {
    expect(returnAtMs(staffReplied(10), Q48N, 'wa')).toBe(NOW - 10 * H + 72 * H)
    expect(returnAtMs(staffReplied(10), Q48N, 'ig')).toBe(NOW - 10 * H + 48 * H)
  })
  it('outcome sent and sending: nudged_at + Q', () => {
    const base = staffReplied(60, { staff_nudged_at: ago(10) })
    expect(returnAtMs({ ...base, staff_nudge_outcome: 'sent' }, Q48N, 'wa')).toBe(NOW - 10 * H + 48 * H)
    expect(returnAtMs({ ...base, staff_nudge_outcome: 'sending' }, Q48N, 'wa')).toBe(NOW - 10 * H + 48 * H)
  })
  it('outcome skipped*: nudged_at itself', () => {
    const c = staffReplied(60, { staff_nudged_at: ago(5), staff_nudge_outcome: 'skipped:no_consent' })
    expect(returnAtMs(c, Q48N, 'wa')).toBe(NOW - 5 * H)
  })
  it('a snooze ending after returnAt wins', () => {
    const c = staffReplied(10, { snoozed_until: ahead(100) })
    expect(returnAtMs(c, Q48, 'wa')).toBe(NOW + 100 * H)
  })
  it('a snooze ending before returnAt does not move it', () => {
    const c = staffReplied(10, { snoozed_until: ahead(2) })
    expect(returnAtMs(c, Q48, 'wa')).toBe(NOW - 10 * H + 48 * H)
  })
})

describe('returnReason', () => {
  it('waiting inside the quiet window gives null; 49h with nudges off is gone_quiet', () => {
    expect(returnReason(staffReplied(47), NOW, Q48, 'wa')).toBe(null)
    expect(returnReason(staffReplied(49), NOW, Q48, 'wa')).toBe('gone_quiet')
  })
  it('nudges on, wa: 49h still waiting, 73h gone_quiet', () => {
    expect(returnReason(staffReplied(49), NOW, Q48N, 'wa')).toBe(null)
    expect(returnReason(staffReplied(73), NOW, Q48N, 'wa')).toBe('gone_quiet')
  })
  it('nudges on, ig: 49h is gone_quiet', () => {
    expect(returnReason(staffReplied(49), NOW, Q48N, 'ig')).toBe('gone_quiet')
  })
  it('outcome sent: 47h after nudge null, 49h no_reply_after_nudge', () => {
    const sent = (h, o = 'sent') => staffReplied(100, { staff_nudged_at: ago(h), staff_nudge_outcome: o })
    expect(returnReason(sent(47), NOW, Q48N, 'wa')).toBe(null)
    expect(returnReason(sent(49), NOW, Q48N, 'wa')).toBe('no_reply_after_nudge')
    expect(returnReason(sent(49, 'sending'), NOW, Q48N, 'wa')).toBe('no_reply_after_nudge')
  })
  it('null for a resolved thread', () => {
    expect(returnReason(staffReplied(49, { resolved_at: ago(1) }), NOW, Q48, 'wa')).toBe(null)
  })
})

describe('needsReply / isWaiting / needsAction', () => {
  it('inbound thread needs a reply', () => {
    expect(needsReply(inbound(), NOW, Q48, 'wa')).toBe(true)
    expect(isWaiting(inbound(), NOW, Q48, 'wa')).toBe(false)
    expect(needsAction(inbound(), NOW, Q48, 'wa')).toBe(true)
  })
  it('staff replied 47h ago is waiting, not needs-reply', () => {
    const c = staffReplied(47)
    expect(isWaiting(c, NOW, Q48, 'wa')).toBe(true)
    expect(needsReply(c, NOW, Q48, 'wa')).toBe(false)
    expect(needsAction(c, NOW, Q48, 'wa')).toBe(false)
  })
  it('staff replied 49h ago with nudges off is needs-reply', () => {
    const c = staffReplied(49)
    expect(isWaiting(c, NOW, Q48, 'wa')).toBe(false)
    expect(needsReply(c, NOW, Q48, 'wa')).toBe(true)
    expect(needsAction(c, NOW, Q48, 'wa')).toBe(true)
  })
  it('outcome skipped:no_consent is needs-reply at once', () => {
    const c = staffReplied(1, { staff_nudged_at: ago(0.5), staff_nudge_outcome: 'skipped:no_consent' })
    expect(needsReply(c, NOW, Q48N, 'wa')).toBe(true)
  })
  it('snoozed inbound thread is waiting and not needs-action', () => {
    const c = inbound({ snoozed_until: ahead(5) })
    expect(isWaiting(c, NOW, Q48, 'wa')).toBe(true)
    expect(needsReply(c, NOW, Q48, 'wa')).toBe(false)
    expect(needsAction(c, NOW, Q48, 'wa')).toBe(false)
  })
  it('an unanswered customer message is Needs reply and not Waiting, even with a stale staff_waiting_since', () => {
    const c = inbound({ staff_waiting_since: ago(2) })
    expect(needsReply(c, NOW, Q48, 'wa')).toBe(true)
    expect(isWaiting(c, NOW, Q48, 'wa')).toBe(false)
  })
  it('the same thread snoozed is Waiting and not Needs reply', () => {
    const c = inbound({ staff_waiting_since: ago(2), snoozed_until: ahead(5) })
    expect(isWaiting(c, NOW, Q48, 'wa')).toBe(true)
    expect(needsReply(c, NOW, Q48, 'wa')).toBe(false)
  })
  it('resolved thread is in no queue', () => {
    const c = inbound({ resolved_at: ago(1), handoff_requested_at: ago(2), pending_approval: true, snoozed_until: ahead(5) })
    expect(needsReply(c, NOW, Q48, 'wa')).toBe(false)
    expect(needsMiaHelp(c)).toBe(false)
    expect(isWaiting(c, NOW, Q48, 'wa')).toBe(false)
    expect(needsAction(c, NOW, Q48, 'wa')).toBe(false)
    expect(filterByQueue([c], 'needs_reply', NOW, Q48)).toEqual([])
    expect(filterByQueue([c], 'mia_help', NOW, Q48)).toEqual([])
    expect(filterByQueue([c], 'waiting', NOW, Q48)).toEqual([])
  })
  it('changing quietHours from 48 to 4 moves a 5h-old waiting thread to needs-reply', () => {
    const c = staffReplied(5)
    expect(isWaiting(c, NOW, { quietHours: 48, nudgeEnabled: false }, 'wa')).toBe(true)
    expect(needsReply(c, NOW, { quietHours: 4, nudgeEnabled: false }, 'wa')).toBe(true)
    expect(isWaiting(c, NOW, { quietHours: 4, nudgeEnabled: false }, 'wa')).toBe(false)
  })
  it('one-argument callers still work with the defaults', () => {
    expect(needsReply({ last_message_direction: 'inbound' })).toBe(true)
    expect(needsAction({ last_message_direction: 'inbound' })).toBe(false) // no last_message_at
    expect(needsAction(inbound({ last_message_at: new Date().toISOString() }))).toBe(true)
  })
  it('null input is safe', () => {
    expect(needsReply(null)).toBe(false)
    expect(isWaiting(null)).toBe(false)
    expect(needsAction(null)).toBe(false)
    expect(needsMiaHelp(null)).toBe(false)
  })
})

describe('needsMiaHelp', () => {
  it('reads handoff_requested_at on unresolved threads', () => {
    expect(needsMiaHelp({ handoff_requested_at: ago(1) })).toBe(true)
    expect(needsMiaHelp({ handoff_requested_at: ago(1), resolved_at: ago(0.5) })).toBe(false)
    expect(needsMiaHelp({ agent_handed_off_at: ago(1) })).toBe(false)
  })
  it('a handed-off thread needs action even when we replied last', () => {
    const c = staffReplied(1, { handoff_requested_at: ago(2) })
    expect(needsAction(c, NOW, Q48, 'wa')).toBe(true)
  })
})

describe('hasPendingApproval', () => {
  it('reads the route-annotated flag', () => {
    expect(hasPendingApproval({ pending_approval: true })).toBe(true)
    expect(hasPendingApproval({})).toBe(false)
    expect(hasPendingApproval(null)).toBe(false)
  })
})

describe('waitSinceMs', () => {
  it('customer_waiting_since when the last message is inbound', () => {
    expect(waitSinceMs(inbound({ customer_waiting_since: ago(7) }), NOW, Q48, 'wa')).toBe(NOW - 7 * H)
  })
  it('returnAt when a staff-replied thread has returned; null while waiting', () => {
    expect(waitSinceMs(staffReplied(49), NOW, Q48, 'wa')).toBe(NOW - 49 * H + 48 * H)
    expect(waitSinceMs(staffReplied(10), NOW, Q48, 'wa')).toBe(null)
  })
})

describe('sortNeedsReply', () => {
  it('oldest wait first, no-wait rows last by last_message_at', () => {
    const a = inbound({ id: 'a', customer_waiting_since: ago(2) })
    const b = inbound({ id: 'b', customer_waiting_since: ago(9) })
    const c = inbound({ id: 'c', customer_waiting_since: null, last_message_at: ago(30) })
    const d = inbound({ id: 'd', customer_waiting_since: null, last_message_at: ago(20) })
    expect(sortNeedsReply([d, a, c, b], NOW, Q48).map(r => r.id)).toEqual(['b', 'a', 'c', 'd'])
  })
  it('uses each row _ch for its return time', () => {
    const wa = staffReplied(60, { id: 'wa', _ch: 'wa' }) // nudges on: returns at 72h, not returned
    const ig = staffReplied(50, { id: 'ig', _ch: 'ig' }) // returned at 48h
    const out = sortNeedsReply([wa, ig], NOW, Q48N)
    expect(out.map(r => r.id)).toEqual(['ig', 'wa'])
  })
})

describe('windowState', () => {
  it('3h59m left is open and soon', () => {
    const c = { window_expires_at: new Date(NOW + 3 * H + 59 * 60_000).toISOString() }
    expect(windowState(c, NOW, 'wa')).toEqual({ kind: 'open', msLeft: 3 * H + 59 * 60_000, soon: true })
  })
  it('5h left is open, not soon', () => {
    expect(windowState({ window_expires_at: ahead(5) }, NOW, 'wa')).toEqual({ kind: 'open', msLeft: 5 * H, soon: false })
  })
  it('expired or missing is closed; ig is null', () => {
    expect(windowState({ window_expires_at: ago(1) }, NOW, 'wa')).toEqual({ kind: 'closed' })
    expect(windowState({}, NOW, 'wa')).toEqual({ kind: 'closed' })
    expect(windowState({ window_expires_at: ahead(5) }, NOW, 'ig')).toBe(null)
  })
})

describe('handledBy', () => {
  it('paused beats everything on wa', () => {
    expect(handledBy({ agent_paused_at: ago(1), staff_owned_since: ago(1) }, 'wa')).toBe('paused')
    expect(handledBy({ agent_paused_at: ago(1) }, 'ig')).toBe('mia')
  })
  it('unclaimed: handoff requested and no staff owner', () => {
    expect(handledBy({ handoff_requested_at: ago(1) }, 'wa')).toBe('unclaimed')
  })
  it('person: staff owner, or agent_active false with no pause', () => {
    expect(handledBy({ handoff_requested_at: ago(2), staff_owned_since: ago(1) }, 'wa')).toBe('person')
    expect(handledBy({ agent_active: false }, 'wa')).toBe('person')
  })
  it('mia otherwise', () => {
    expect(handledBy({ agent_active: true }, 'wa')).toBe('mia')
    expect(handledBy({}, 'wa')).toBe('mia')
  })
})

describe('filterByQueue / queueCounts', () => {
  const list = [
    inbound({ id: 'in' }),
    staffReplied(10, { id: 'wait' }),
    staffReplied(60, { id: 'back' }),
    inbound({ id: 'mia', handoff_requested_at: ago(1) }),
    inbound({ id: 'ap', pending_approval: true, last_message_direction: 'outbound' }),
    inbound({ id: 'done', resolved_at: ago(1) }),
  ]
  it('filters each queue', () => {
    const ids = q => filterByQueue(list, q, NOW, Q48).map(c => c.id)
    expect(ids('needs_reply')).toEqual(['in', 'back', 'mia'])
    expect(ids('mia_help')).toEqual(['mia'])
    expect(ids('waiting')).toEqual(['wait'])
    expect(ids('pending_approval')).toEqual(['ap'])
    expect(ids('all')).toHaveLength(6)
    expect(ids('nope')).toHaveLength(6)
  })
  it('counts and empty input', () => {
    expect(queueCounts(list, NOW, Q48)).toEqual({ needs_reply: 3, mia_help: 1, waiting: 1, pending_approval: 1, all: 6 })
    expect(queueCounts(null, NOW, Q48)).toEqual({ needs_reply: 0, mia_help: 0, waiting: 0, pending_approval: 0, all: 0 })
  })
  it('reads the channel from _ch, or channel: instagram on phone rows', () => {
    const wa = staffReplied(60, { id: 'wa', _ch: 'wa' })
    const ig = staffReplied(60, { id: 'ig', _ch: 'ig' })
    const phoneIg = staffReplied(60, { id: 'pig', channel: 'instagram' })
    expect(filterByQueue([wa, ig, phoneIg], 'needs_reply', NOW, Q48N).map(c => c.id)).toEqual(['ig', 'pig'])
  })
})
