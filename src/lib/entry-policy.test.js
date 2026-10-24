// ENTRYPOLICY.1 — the two pure rules and the settings. Pure, Node env.
// Zone maths is exercised in Europe/Dublin AND America/New_York across a DST
// change (CLAUDE.md): the cutoff counts back from the entrant's wave start on
// the studio's wall clock, never from a Date parsed as UTC.

import { describe, it, expect } from 'vitest'
import {
  ENTRY_POLICY_DEFAULTS,
  EntryPolicySettingsSchema,
  resolveEntryPolicy,
  renderEntryPolicyMessage,
  entryStartMs,
  selfServiceBlock,
  holdsPlace,
  pendingLapsed,
  holdingPlaces,
  unpaidHoldEndsMs,
  lapsedMessage,
} from './entry-policy.js'

const T = (iso) => Date.parse(iso)
const HOUR = 3_600_000

describe('ENTRY_POLICY_DEFAULTS', () => {
  it('both switches on, 48 h cutoff, 48 h unpaid hold, operator copy with placeholders', () => {
    expect(ENTRY_POLICY_DEFAULTS.self_cancel_enabled).toBe(true)
    expect(ENTRY_POLICY_DEFAULTS.self_reschedule_enabled).toBe(true)
    expect(ENTRY_POLICY_DEFAULTS.cutoff_hours).toBe(48)
    expect(ENTRY_POLICY_DEFAULTS.unpaid_hold_hours).toBe(48)
    for (const k of ['cutoff_message', 'disabled_message', 'lapsed_message']) {
      expect(ENTRY_POLICY_DEFAULTS[k]).toContain('{{event_name}}')
      expect(ENTRY_POLICY_DEFAULTS[k]).not.toMatch(/—|–/)
    }
    expect(ENTRY_POLICY_DEFAULTS.cutoff_message).toContain('{{hours}}')
    expect(ENTRY_POLICY_DEFAULTS.lapsed_message).toContain('{{hours}}')
    expect(Object.isFrozen(ENTRY_POLICY_DEFAULTS)).toBe(true)
  })
})

describe('EntryPolicySettingsSchema', () => {
  it('accepts every key optional and the hour ranges', () => {
    expect(EntryPolicySettingsSchema.safeParse({}).success).toBe(true)
    expect(EntryPolicySettingsSchema.safeParse({ self_cancel_enabled: false, cutoff_hours: 0, unpaid_hold_hours: 1, cutoff_message: ' x ' }).success).toBe(true)
    expect(EntryPolicySettingsSchema.safeParse({ cutoff_hours: 720, unpaid_hold_hours: 720 }).success).toBe(true)
  })
  it('refuses out-of-range hours, non-integers and a zero hold', () => {
    expect(EntryPolicySettingsSchema.safeParse({ cutoff_hours: -1 }).success).toBe(false)
    expect(EntryPolicySettingsSchema.safeParse({ cutoff_hours: 721 }).success).toBe(false)
    expect(EntryPolicySettingsSchema.safeParse({ cutoff_hours: 1.5 }).success).toBe(false)
    expect(EntryPolicySettingsSchema.safeParse({ unpaid_hold_hours: 0 }).success).toBe(false)
    expect(EntryPolicySettingsSchema.safeParse({ unpaid_hold_hours: '48' }).success).toBe(false)
  })
})

describe('resolveEntryPolicy', () => {
  it('returns the defaults for a race with no entry_policy (an existing event keeps today\'s behaviour)', () => {
    expect(resolveEntryPolicy({ entry_policy: null })).toEqual(ENTRY_POLICY_DEFAULTS)
    expect(resolveEntryPolicy(null)).toEqual(ENTRY_POLICY_DEFAULTS)
    expect(resolveEntryPolicy({})).toEqual(ENTRY_POLICY_DEFAULTS)
  })
  it('overlays saved values, drops nulls, accepts the saved object or the race row', () => {
    const saved = { self_cancel_enabled: false, cutoff_hours: 24, cutoff_message: null, lapsed_message: 'Gone.' }
    const fromRow = resolveEntryPolicy({ entry_policy: saved })
    expect(fromRow.self_cancel_enabled).toBe(false)
    expect(fromRow.self_reschedule_enabled).toBe(true)
    expect(fromRow.cutoff_hours).toBe(24)
    expect(fromRow.cutoff_message).toBe(ENTRY_POLICY_DEFAULTS.cutoff_message)
    expect(fromRow.lapsed_message).toBe('Gone.')
    expect(resolveEntryPolicy(saved)).toEqual(fromRow)
  })
  it('a hand-written row cannot produce an unusable policy', () => {
    const p = resolveEntryPolicy({ entry_policy: { self_cancel_enabled: 'no', cutoff_hours: 9999, unpaid_hold_hours: 0, disabled_message: 7, extra: 1 } })
    expect(p.self_cancel_enabled).toBe(true)
    expect(p.cutoff_hours).toBe(48)
    expect(p.unpaid_hold_hours).toBe(48)
    expect(p.disabled_message).toBe(ENTRY_POLICY_DEFAULTS.disabled_message)
    expect('extra' in p).toBe(false)
  })
  it('keeps an empty string cleared on purpose, and ignores a non-object', () => {
    expect(resolveEntryPolicy({ entry_policy: { cutoff_message: '' } }).cutoff_message).toBe('')
    expect(resolveEntryPolicy({ entry_policy: ['x'] })).toEqual(ENTRY_POLICY_DEFAULTS)
  })
})

describe('renderEntryPolicyMessage', () => {
  it('fills hours and event_name, leaves unknown placeholders', () => {
    expect(renderEntryPolicyMessage('{{hours}} h before {{event_name}} {{other}}', { hours: 24, event_name: 'Hyrox Sim' }))
      .toBe('24 h before Hyrox Sim {{other}}')
    expect(renderEntryPolicyMessage('For {{event_name}}.', {})).toBe('For this event.')
  })
})

// ── the cutoff: wall clock in the studio zone, across DST ────────────────
const DUB = 'Europe/Dublin'
const NY = 'America/New_York'

describe('entryStartMs', () => {
  it('Dublin: the morning after clocks go forward (29 Mar 2026) is IST, one hour off a UTC parse', () => {
    expect(entryStartMs({ race_date: '2026-03-29' }, { start_time: '09:00:00' }, DUB)).toBe(T('2026-03-29T08:00:00Z'))
    // The day before the change is still GMT.
    expect(entryStartMs({ race_date: '2026-03-28' }, { start_time: '09:00:00' }, DUB)).toBe(T('2026-03-28T09:00:00Z'))
  })
  it('New York: the day after clocks go back (1 Nov 2026) is EST', () => {
    expect(entryStartMs({ race_date: '2026-11-02' }, { start_time: '09:00' }, NY)).toBe(T('2026-11-02T14:00:00Z'))
    expect(entryStartMs({ race_date: '2026-10-31' }, { start_time: '09:00' }, NY)).toBe(T('2026-10-31T13:00:00Z'))
  })
  it('no wave: the start of race day in the studio zone', () => {
    expect(entryStartMs({ race_date: '2026-03-29' }, null, DUB)).toBe(T('2026-03-29T00:00:00Z'))
    expect(entryStartMs({ race_date: '2026-11-01' }, null, NY)).toBe(T('2026-11-01T04:00:00Z'))
  })
  it('null without a date; a bad time falls back to the day start', () => {
    expect(entryStartMs({ race_date: null }, { start_time: '09:00' }, DUB)).toBeNull()
    expect(entryStartMs({ race_date: '2026-11-02' }, { start_time: 'noon' }, NY)).toBe(T('2026-11-02T05:00:00Z'))
  })
})

describe('selfServiceBlock', () => {
  const dubEvent = { name: 'Hyrox Sim', race_date: '2026-03-29', entry_policy: null }
  const wave = { start_time: '09:00:00' }
  // Start 2026-03-29T08:00Z (09:00 IST); 48 h back = 2026-03-27T08:00Z.
  it('null before the cutoff, cutoff from the moment 48 h before the wave start (Dublin, across the spring change)', () => {
    expect(selfServiceBlock({ event: dubEvent, wave, nowMs: T('2026-03-27T07:59:59Z'), zone: DUB, action: 'cancel' })).toBeNull()
    const b = selfServiceBlock({ event: dubEvent, wave, nowMs: T('2026-03-27T08:00:00Z'), zone: DUB, action: 'cancel' })
    expect(b.code).toBe('cutoff')
    expect(b.message).toBe('Changes to entries for Hyrox Sim close 48 hours before the start time. The team can still help: get in touch with the studio.')
    // A UTC parse of "09:00" would open a one-hour window that does not exist.
    expect(selfServiceBlock({ event: dubEvent, wave, nowMs: T('2026-03-27T08:30:00Z'), zone: DUB, action: 'reschedule' })?.code).toBe('cutoff')
  })
  it('New York, across the autumn change: the wave start is EST on 2 Nov', () => {
    const ev = { name: 'NY Sim', race_date: '2026-11-02', entry_policy: { cutoff_hours: 24 } }
    // Start 2026-11-02T14:00Z; 24 h back = 2026-11-01T14:00Z.
    expect(selfServiceBlock({ event: ev, wave, nowMs: T('2026-11-01T13:59:00Z'), zone: NY, action: 'reschedule' })).toBeNull()
    expect(selfServiceBlock({ event: ev, wave, nowMs: T('2026-11-01T14:00:00Z'), zone: NY, action: 'reschedule' })?.code).toBe('cutoff')
  })
  it('no waves: counts back from the start of race day', () => {
    const ev = { name: 'Open Day', race_date: '2026-11-01', entry_policy: null }
    // Day start 2026-11-01T04:00Z (EDT); 48 h back = 2026-10-30T04:00Z.
    expect(selfServiceBlock({ event: ev, wave: null, nowMs: T('2026-10-30T03:59:00Z'), zone: NY, action: 'cancel' })).toBeNull()
    expect(selfServiceBlock({ event: ev, wave: null, nowMs: T('2026-10-30T04:00:00Z'), zone: NY, action: 'cancel' })?.code).toBe('cutoff')
  })
  it('cutoff_hours 0 means no cutoff at all, even on race morning', () => {
    const ev = { ...dubEvent, entry_policy: { cutoff_hours: 0 } }
    expect(selfServiceBlock({ event: ev, wave, nowMs: T('2026-03-29T07:00:00Z'), zone: DUB, action: 'cancel' })).toBeNull()
  })
  it('the switches: cancel and reschedule are gated separately, with the disabled copy', () => {
    const ev = { ...dubEvent, entry_policy: { self_cancel_enabled: false } }
    const early = T('2026-03-01T10:00:00Z')
    const b = selfServiceBlock({ event: ev, wave, nowMs: early, zone: DUB, action: 'cancel' })
    expect(b).toEqual({ code: 'disabled', message: 'Changes to entries for Hyrox Sim are handled by the team. Get in touch with the studio and they will sort it out.' })
    expect(selfServiceBlock({ event: ev, wave, nowMs: early, zone: DUB, action: 'reschedule' })).toBeNull()
    const ev2 = { ...dubEvent, entry_policy: { self_reschedule_enabled: false } }
    expect(selfServiceBlock({ event: ev2, wave, nowMs: early, zone: DUB, action: 'reschedule' })?.code).toBe('disabled')
    expect(selfServiceBlock({ event: ev2, wave, nowMs: early, zone: DUB, action: 'cancel' })).toBeNull()
  })
  it('disabled wins over cutoff; operator copy is rendered with the placeholders', () => {
    const ev = { ...dubEvent, entry_policy: { self_cancel_enabled: false, cutoff_hours: 2, disabled_message: 'Ask us about {{event_name}}.', cutoff_message: '{{hours}}h rule' } }
    expect(selfServiceBlock({ event: ev, wave, nowMs: T('2026-03-29T07:30:00Z'), zone: DUB, action: 'cancel' })).toEqual({ code: 'disabled', message: 'Ask us about Hyrox Sim.' })
    expect(selfServiceBlock({ event: ev, wave, nowMs: T('2026-03-29T07:30:00Z'), zone: DUB, action: 'reschedule' })).toEqual({ code: 'cutoff', message: '2h rule' })
  })
  it('an event with no date cannot be judged on a cutoff: allowed (the callers\' past-day gate decides)', () => {
    expect(selfServiceBlock({ event: { name: 'x', race_date: null }, wave, nowMs: 0, zone: DUB, action: 'cancel' })).toBeNull()
  })
  it('refuses an unknown action loudly', () => {
    expect(() => selfServiceBlock({ event: dubEvent, wave, nowMs: 0, zone: DUB, action: 'move' })).toThrow(TypeError)
  })
})

// ── the unpaid hold ───────────────────────────────────────────────────────
describe('holdsPlace', () => {
  const pending = (registered_at) => ({ status: 'pending_payment', registered_at })
  it('confirmed always holds; cancelled, no_show, placed never do', () => {
    expect(holdsPlace({ status: 'confirmed', registered_at: '2020-01-01T00:00:00Z' }, T('2026-10-24T00:00:00Z'))).toBe(true)
    for (const status of ['cancelled', 'no_show', 'placed', undefined]) {
      expect(holdsPlace({ status, registered_at: '2026-10-24T00:00:00Z' }, T('2026-10-24T00:00:00Z'))).toBe(false)
    }
  })
  it('pending holds for exactly unpaid_hold_hours from registered_at (default 48 h), judged in absolute hours across a DST change', () => {
    // Registered before the Dublin spring change, judged after it: 48 h is 48 h.
    const reg = pending('2026-03-27T08:00:00Z')
    expect(holdsPlace(reg, T('2026-03-29T07:59:59Z'))).toBe(true)
    expect(holdsPlace(reg, T('2026-03-29T08:00:00Z'))).toBe(false)
    expect(unpaidHoldEndsMs(reg, null)).toBe(T('2026-03-29T08:00:00Z'))
    // And across the New York autumn change, with an operator hold of 24 h.
    const ny = pending('2026-10-31T20:00:00Z')
    expect(holdsPlace(ny, T('2026-11-01T19:59:00Z'), { unpaid_hold_hours: 24 })).toBe(true)
    expect(holdsPlace(ny, T('2026-11-01T20:00:00Z'), { unpaid_hold_hours: 24 })).toBe(false)
  })
  it('takes the policy as a race row too, and a null column means 48 h', () => {
    const reg = pending('2026-10-20T10:00:00Z')
    expect(holdsPlace(reg, T('2026-10-22T09:00:00Z'), { entry_policy: null })).toBe(true)
    expect(holdsPlace(reg, T('2026-10-22T11:00:00Z'), { entry_policy: null })).toBe(false)
    expect(holdsPlace(reg, T('2026-10-22T11:00:00Z'), { entry_policy: { unpaid_hold_hours: 72 } })).toBe(true)
  })
  it('an unreadable registered_at keeps holding (never oversell a row we cannot date)', () => {
    expect(holdsPlace(pending(null), T('2026-10-24T00:00:00Z'))).toBe(true)
    expect(holdsPlace(pending('yesterday'), T('2026-10-24T00:00:00Z'))).toBe(true)
    expect(unpaidHoldEndsMs(pending(null), null)).toBeNull()
  })
  it('pendingLapsed is the complement for pending rows only; holdingPlaces filters by the rule', () => {
    const now = T('2026-10-24T12:00:00Z')
    const fresh = pending('2026-10-24T00:00:00Z')
    const old = pending('2026-10-20T00:00:00Z')
    expect(pendingLapsed(old, now)).toBe(true)
    expect(pendingLapsed(fresh, now)).toBe(false)
    expect(pendingLapsed({ status: 'cancelled' }, now)).toBe(false)
    const confirmed = { status: 'confirmed' }
    expect(holdingPlaces([fresh, old, confirmed, { status: 'placed' }], now)).toEqual([fresh, confirmed])
    expect(holdingPlaces(null, now)).toEqual([])
  })
})

describe('lapsedMessage', () => {
  it('renders the operator copy with the hold and the event name', () => {
    expect(lapsedMessage({ name: 'Hyrox Sim', entry_policy: null }))
      .toBe('Your unpaid entry for Hyrox Sim was held for 48 hours and has now lapsed. You can register again if places remain.')
    expect(lapsedMessage({ name: 'Hyrox Sim', entry_policy: { unpaid_hold_hours: 12, lapsed_message: '{{hours}}h gone for {{event_name}}' } })).toBe('12h gone for Hyrox Sim')
  })
})
