import { describe, it, expect } from 'vitest'
import {
  snoozeStripMode, handledByLine, cleanSnoozeNote, snoozeBody, snoozeOutcome, SNOOZE_FAILED,
} from './inbox-followup'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const H = 3600_000
const at = (ms) => new Date(NOW + ms).toISOString()

describe('snoozeStripMode', () => {
  it('snoozed while the time is ahead, ended once it has passed, none when unset', () => {
    expect(snoozeStripMode({ snoozed_until: at(H) }, NOW)).toBe('snoozed')
    expect(snoozeStripMode({ snoozed_until: at(-H) }, NOW)).toBe('ended')
    expect(snoozeStripMode({ snoozed_until: null }, NOW)).toBe('none')
    expect(snoozeStripMode(null, NOW)).toBe('none')
  })
})

describe('handledByLine', () => {
  it('Mia, a named coach, a coach with no name, paused, waiting for a person', () => {
    expect(handledByLine({}, 'wa')).toBe('Handled by Mia')
    expect(handledByLine({ staff_owned_since: at(-H), handled_by_name: 'Aoife' }, 'wa')).toBe('Handled by Aoife')
    expect(handledByLine({ staff_owned_since: at(-H), handled_by_name: null }, 'wa')).toBe('Handled by a coach')
    expect(handledByLine({ agent_active: false }, 'ig')).toBe('Handled by a coach')
    expect(handledByLine({ agent_paused_at: at(-H) }, 'wa')).toBe('Mia paused')
    expect(handledByLine({ handoff_requested_at: at(-H), staff_owned_since: null }, 'wa')).toBe('Waiting for a person')
  })
  it('"Mia paused" is WhatsApp only, and the channel may be spelled either way', () => {
    expect(handledByLine({ agent_paused_at: at(-H) }, 'instagram')).toBe('Handled by Mia')
    expect(handledByLine({ agent_paused_at: at(-H) }, 'whatsapp')).toBe('Mia paused')
  })
})

describe('snoozeBody', () => {
  it('a snooze carries the instant, the trimmed note and the last message seen', () => {
    expect(snoozeBody({ until: at(H), note: '  ring Friday ', seenLastMessageAt: '2026-11-25T11:00:00Z' }))
      .toEqual({ until: at(H), note: 'ring Friday', seen_last_message_at: '2026-11-25T11:00:00Z' })
  })
  it('omits an empty note and sends null for a thread with no messages', () => {
    expect(snoozeBody({ until: at(H), note: '   ' })).toEqual({ until: at(H), seen_last_message_at: null })
  })
  it('an unsnooze or dismiss is only { until: null }', () => {
    expect(snoozeBody({ until: null, note: 'x', seenLastMessageAt: 'y' })).toEqual({ until: null })
    expect(snoozeBody()).toEqual({ until: null })
  })
  it('holds the note to 140 characters', () => {
    expect(cleanSnoozeNote('a'.repeat(200))).toHaveLength(140)
  })
})

describe('snoozeOutcome', () => {
  it('success', () => expect(snoozeOutcome({ success: true })).toEqual({ ok: true }))
  it("a 409 shows the route's message and refetches", () => {
    expect(snoozeOutcome({ success: false, status: 409, error: 'A new message arrived. Check it before snoozing.' }))
      .toEqual({ ok: false, message: 'A new message arrived. Check it before snoozing.', refetch: true })
  })
  it("another failure shows the route's error without a refetch; no answer shows the fixed line", () => {
    expect(snoozeOutcome({ success: false, status: 400, error: 'Pick a time in the future.' }))
      .toEqual({ ok: false, message: 'Pick a time in the future.', refetch: false })
    expect(snoozeOutcome({ success: false, transport: true })).toEqual({ ok: false, message: SNOOZE_FAILED, refetch: false })
    expect(snoozeOutcome(undefined).ok).toBe(false)
  })
})
