import { describe, it, expect } from 'vitest'
import { rowsForQueue, rowDecor, defaultQueue } from './inbox-list'

const H = 3600_000
const NOW = Date.parse('2026-11-25T12:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const CFG = { quietHours: 48, nudgeEnabled: false }

const inbound = (id, waitedH, extra = {}) => ({
  id, channel: 'whatsapp', last_message_direction: 'inbound',
  last_message_at: ago(waitedH * H), customer_waiting_since: ago(waitedH * H), ...extra,
})

describe('rowsForQueue', () => {
  it('Needs reply: the longest wait first, whatever the newest message', () => {
    const list = [inbound('new', 1), inbound('oldest', 30), inbound('mid', 5)]
    expect(rowsForQueue(list, 'needs_reply', NOW, CFG).map(c => c.id)).toEqual(['oldest', 'mid', 'new'])
  })
  it('the other queues: newest message first', () => {
    const waiting = (id, h) => ({ id, channel: 'whatsapp', last_message_direction: 'outbound', last_message_at: ago(h * H), staff_waiting_since: ago(h * H) })
    const list = [waiting('old', 20), waiting('new', 2), waiting('mid', 10)]
    expect(rowsForQueue(list, 'waiting', NOW, CFG).map(c => c.id)).toEqual(['new', 'mid', 'old'])
    expect(rowsForQueue([inbound('a', 9), inbound('b', 2)], 'all', NOW, CFG).map(c => c.id)).toEqual(['b', 'a'])
  })
  it('an Instagram row (channel: instagram) sorts and filters with the shared rules', () => {
    const ig = { ...inbound('ig1', 40), channel: 'instagram' }
    expect(rowsForQueue([inbound('wa1', 3), ig], 'needs_reply', NOW, CFG).map(c => c.id)).toEqual(['ig1', 'wa1'])
  })
})

describe('rowDecor', () => {
  it('wait chip, window chip and state line for a WhatsApp row', () => {
    const conv = inbound('a', 2, { window_expires_at: new Date(NOW + 3 * H).toISOString(), snoozed_until: null })
    const d = rowDecor(conv, NOW, CFG, 'Europe/Dublin')
    expect(d.wait).toEqual({ text: 'waiting 2h', tone: 'amber' })
    expect(d.window).toEqual({ text: 'closes in 3h', tone: 'amber' })
    expect(d.stateLine).toBeNull()
  })
  it('Instagram shows no window chip; a snoozed row shows its state line', () => {
    const conv = { ...inbound('b', 1), channel: 'instagram', window_expires_at: ago(H), snoozed_until: new Date(NOW + 24 * H).toISOString(), snooze_note: 'quote' }
    const d = rowDecor(conv, NOW, CFG, 'Europe/Dublin')
    expect(d.window).toBeNull()
    expect(d.stateLine).toBe('Snoozed until Thu 12:00 · quote')
  })
})

describe('defaultQueue', () => {
  it('opens on Needs reply, like the web', () => expect(defaultQueue).toBe('needs_reply'))
})
