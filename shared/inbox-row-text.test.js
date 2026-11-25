import { describe, it, expect } from 'vitest'
import { durationLabel, waitChipInfo, windowChipInfo, stateLineText, dayTime, snoozeUntilLabel } from './inbox-row-text'

const H = 3600_000
const NOW = Date.parse('2026-11-25T12:00:00Z') // a Wednesday
const ago = (ms) => new Date(NOW - ms).toISOString()
const ahead = (ms) => new Date(NOW + ms).toISOString()
const CFG = { quietHours: 48, nudgeEnabled: false }
const wa = { _ch: 'wa', last_message_at: ago(H) }
const phoneIg = { channel: 'instagram', last_message_at: ago(H) }

describe('durationLabel', () => {
  it.each([
    [30_000, '<1m'], [45 * 60_000, '45m'], [2 * H + 10 * 60_000, '2h 10m'], [3 * H, '3h'],
    [24 * H, '1 day'], [50 * H, '2 days'],
  ])('%i ms reads %s', (ms, label) => expect(durationLabel(ms)).toBe(label))
})

describe('waitChipInfo', () => {
  it('"waiting 2h 10m" when the customer waits on us', () => {
    const conv = { ...wa, last_message_direction: 'inbound', customer_waiting_since: ago(2 * H + 10 * 60_000) }
    expect(waitChipInfo(conv, NOW, CFG)).toEqual({ text: 'waiting 2h 10m', tone: 'amber' })
  })
  it('"quiet 2 days" when we wait on the customer', () => {
    const conv = { ...wa, last_message_direction: 'outbound', staff_owned_since: ago(60 * H), staff_waiting_since: ago(2 * 24 * H + H) }
    expect(waitChipInfo(conv, NOW, { quietHours: 96, nudgeEnabled: false })).toEqual({ text: 'quiet 2 days', tone: 'slate' })
  })
  it('nothing for a resolved thread or one with no wait', () => {
    expect(waitChipInfo({ ...wa, resolved_at: ago(H) }, NOW, CFG)).toBeNull()
    expect(waitChipInfo({ ...wa, last_message_direction: 'outbound' }, NOW, CFG)).toBeNull()
    expect(waitChipInfo(null, NOW, CFG)).toBeNull()
  })
})

describe('windowChipInfo', () => {
  it('closes in hours, calm', () => {
    expect(windowChipInfo({ ...wa, window_expires_at: ahead(6 * H) }, NOW)).toEqual({ text: 'closes in 6h', tone: 'emerald' })
  })
  it('amber under 4 hours, in minutes under an hour', () => {
    expect(windowChipInfo({ ...wa, window_expires_at: ahead(3 * H) }, NOW)).toEqual({ text: 'closes in 3h', tone: 'amber' })
    expect(windowChipInfo({ ...wa, window_expires_at: ahead(20 * 60_000) }, NOW)).toEqual({ text: 'closes in 20m', tone: 'amber' })
  })
  it('template only once closed; nothing for Instagram on either shape', () => {
    expect(windowChipInfo({ ...wa, window_expires_at: ago(H) }, NOW)).toEqual({ text: 'template only', tone: 'gray' })
    expect(windowChipInfo({ _ch: 'ig', window_expires_at: ago(H) }, NOW)).toBeNull()
    expect(windowChipInfo({ ...phoneIg, window_expires_at: ago(H) }, NOW)).toBeNull()
  })
})

describe('stateLineText', () => {
  it('snoozed, with and without a note, in the studio zone', () => {
    const snoozed = { ...wa, snoozed_until: '2026-11-27T09:00:00Z' } // Friday
    expect(stateLineText({ conv: snoozed, nowMs: NOW, cfg: CFG, zone: 'Europe/Dublin' })).toBe('Snoozed until Fri 09:00')
    expect(stateLineText({ conv: { ...snoozed, snooze_note: ' ring back ' }, nowMs: NOW, cfg: CFG, zone: 'Europe/Dublin' })).toBe('Snoozed until Fri 09:00 · ring back')
    expect(stateLineText({ conv: snoozed, nowMs: NOW, cfg: CFG, zone: 'America/New_York' })).toBe('Snoozed until Fri 04:00')
  })
  it('gone quiet, and no reply after a nudge', () => {
    const quiet = { ...wa, last_message_direction: 'outbound', staff_waiting_since: ago(50 * H) }
    expect(stateLineText({ conv: quiet, nowMs: NOW, cfg: CFG, zone: 'Europe/Dublin' })).toBe('Gone quiet')
    const nudged = { ...quiet, staff_nudged_at: ago(50 * H), staff_nudge_outcome: 'sent' }
    expect(stateLineText({ conv: nudged, nowMs: NOW, cfg: CFG, zone: 'Europe/Dublin' })).toBe('No reply after nudge')
  })
  it('a fired snooze reminder', () => {
    const ended = { ...wa, last_message_direction: 'outbound', snoozed_until: ago(H), snooze_note: 'quote' }
    expect(stateLineText({ conv: ended, nowMs: NOW, cfg: CFG, zone: 'Europe/Dublin' })).toBe('Snooze ended · quote')
    expect(stateLineText({ conv: { ...ended, snooze_note: null }, nowMs: NOW, cfg: CFG, zone: 'Europe/Dublin' })).toBe('Snooze ended')
  })
  it('Mia nudged, while we wait on the customer', () => {
    const conv = { ...wa, last_message_direction: 'outbound', staff_waiting_since: ago(5 * H), staff_nudged_at: '2026-11-24T10:02:00Z', staff_nudge_outcome: 'sent' }
    expect(stateLineText({ conv, nowMs: NOW, cfg: CFG, zone: 'Europe/Dublin' })).toBe('Mia nudged Tue 10:02')
  })
  it('the preview stays when nothing applies, and for a resolved thread', () => {
    expect(stateLineText({ conv: { ...wa, last_message_direction: 'inbound' }, nowMs: NOW, cfg: CFG, zone: 'Europe/Dublin' })).toBeNull()
    expect(stateLineText({ conv: { ...wa, resolved_at: ago(H), snoozed_until: ahead(H) }, nowMs: NOW, cfg: CFG, zone: 'Europe/Dublin' })).toBeNull()
  })
  it('dayTime falls back to Dublin for a bad zone', () => {
    expect(dayTime(Date.parse('2026-11-27T09:00:00Z'), 'nope')).toBe('Fri 09:00')
  })
})

describe('snoozeUntilLabel', () => {
  it('weekday, day, month and time in the studio zone', () => {
    expect(snoozeUntilLabel('2026-11-27T09:00:00Z', 'Europe/Dublin')).toBe('Fri 27 Nov, 09:00')
    expect(snoozeUntilLabel('2026-11-27T09:00:00Z', 'America/New_York')).toBe('Fri 27 Nov, 04:00')
  })
})
