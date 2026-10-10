// EVENT-MOVE.6 — what a CUSTOMER is shown about moving their own entry: the
// options (eligible times only, never a number about room), why an entry
// cannot move, and the copy for every refusal.
import { describe, it, expect } from 'vitest'
import {
  publicMoveOptions, priceNote, entryMoveBlock, customerMoveMessage, CUSTOMER_MOVE_STATUS,
} from './registration-move-public.js'

const CAPACITY_WORDS = /spot|capacity|count|left/i

const target = (over = {}) => ({
  id: 'e2', name: 'Hatch Oct 25', race_date: '2026-10-25', kind: 'hyrox_sim', location_id: 'L1', location_name: 'Hatch St',
  crosses_studio: false, capacity_mode: 'teams', price_gap_cents: 0, currency: 'EUR',
  waves: [
    { id: 'w1', start_time: '09:00:00', label: 'Heat A', capacity: 10, spots_left: 4 },
    { id: 'w2', start_time: '11:00:00', label: null, capacity: 10, spots_left: 0 },
    { id: 'w3', start_time: '13:00:00', label: null, capacity: null, spots_left: null },
  ],
  ...over,
})

function everyKeyAndText(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => everyKeyAndText(v, out))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); everyKeyAndText(v, out) }
  else if (typeof value === 'string') out.push(value)
  return out
}

describe('publicMoveOptions', () => {
  it('lists only times with room, and never a key or a word about room', () => {
    const opts = publicMoveOptions([target()], 2)
    expect(opts).toHaveLength(1)
    expect(opts[0].times.map((t) => t.wave_id)).toEqual(['w1', 'w3'])
    for (const word of everyKeyAndText(opts)) expect(word).not.toMatch(CAPACITY_WORDS)
    expect(JSON.stringify(opts)).not.toMatch(/"(capacity|spots_left)"/)
  })

  it('in people mode a time must fit the whole entry', () => {
    const t = target({ capacity_mode: 'people', waves: [
      { id: 'w1', start_time: '09:00:00', label: null, capacity: 10, spots_left: 1 },
      { id: 'w2', start_time: '11:00:00', label: null, capacity: 10, spots_left: 2 },
    ] })
    expect(publicMoveOptions([t], 2)[0].times.map((x) => x.wave_id)).toEqual(['w2'])
  })

  it('drops an event whose every time is full, keeps one with no times at all', () => {
    const full = target({ id: 'e3', waves: [{ id: 'w9', start_time: '09:00:00', label: null, capacity: 2, spots_left: 0 }] })
    const noWaves = target({ id: 'e4', waves: [] })
    expect(publicMoveOptions([full, noWaves], 1).map((o) => o.event_id)).toEqual(['e4'])
    expect(publicMoveOptions([noWaves], 1)[0].times).toEqual([])
  })

  it('carries the price difference and a plain sentence for it', () => {
    const [same, dearer, cheaper] = publicMoveOptions([
      target({ id: 'a', race_date: '2026-10-20' }),
      target({ id: 'b', race_date: '2026-10-21', price_gap_cents: 1000 }),
      target({ id: 'c', race_date: '2026-10-22', price_gap_cents: -500 }),
    ], 1)
    expect(same).toMatchObject({ event_id: 'a', price_difference_cents: 0, price_note: 'Same price' })
    expect(dearer).toMatchObject({ event_id: 'b', price_difference_cents: 1000, price_note: '€10.00 more, paid before the move' })
    expect(cheaper).toMatchObject({ event_id: 'c', price_difference_cents: -500, price_note: '€5.00 less, not refunded' })
  })

  it('names the event, its date, its studio and the times, sorted by date', () => {
    const opts = publicMoveOptions([target({ id: 'late', race_date: '2026-11-02' }), target({ id: 'early', race_date: '2026-10-20' })], 1)
    expect(opts.map((o) => o.event_id)).toEqual(['early', 'late'])
    expect(opts[0]).toMatchObject({ name: 'Hatch Oct 25', race_date: '2026-10-20', location_name: 'Hatch St', currency: 'EUR' })
    expect(opts[0].times[0]).toEqual({ wave_id: 'w1', start_time: '09:00', label: 'Heat A' })
  })

  it('is empty for no targets', () => {
    expect(publicMoveOptions(null, 1)).toEqual([])
  })
})

describe('priceNote', () => {
  it('handles other currencies', () => {
    expect(priceNote(250, 'GBP')).toBe('£2.50 more, paid before the move')
    expect(priceNote(-250, 'USD')).toBe('2.50 USD less, not refunded')
  })
})

describe('entryMoveBlock', () => {
  const reg = { status: 'confirmed', race: { race_date: '2026-10-18' }, race_started_at: null, race_finished_at: null }
  const today = '2026-10-09'
  it('null for a confirmed, upcoming, unchecked entry', () => {
    expect(entryMoveBlock({ registration: reg, checkinCount: 0, today })).toBeNull()
  })
  it.each([
    ['unpaid', { ...reg, status: 'pending_payment' }, 0, 'pending_payment'],
    ['cancelled', { ...reg, status: 'cancelled' }, 0, 'not_active'],
    ['no-show', { ...reg, status: 'no_show' }, 0, 'not_active'],
    ['checked in', reg, 1, 'checked_in'],
    ['raced', { ...reg, race_started_at: '2026-10-18T09:00:00Z' }, 0, 'checked_in'],
    ['past', { ...reg, race: { race_date: '2026-10-08' } }, 0, 'event_past'],
  ])('blocks a %s entry with a plain sentence', (_w, registration, checkinCount, code) => {
    const b = entryMoveBlock({ registration, checkinCount, today })
    expect(b.code).toBe(code)
    expect(b.message).toMatch(/\.$/)
    expect(b.message).not.toMatch(/—|–/)
  })
})

describe('customer copy', () => {
  it('has a message for every refusal a customer can meet, with no dashes and no staff words', () => {
    for (const code of ['not_found', 'not_active', 'pending_payment', 'checked_in', 'event_past', 'same_event', 'target_unavailable',
      'different_payee', 'already_entered', 'headcount_not_allowed', 'wave_required', 'wrong_event', 'wave_full', 'load_failed',
      'write_failed', 'conflict', 'no_email', 'host_not_ready', 'provider_failed', 'already_settled']) {
      const m = customerMoveMessage(code)
      expect(m, code).toBeTruthy()
      expect(m).not.toMatch(/—|–|\bstaff\b|\bcollect\b|\bforce\b|\bpayee\b/i)
      expect(m).not.toMatch(CAPACITY_WORDS)
    }
    expect(customerMoveMessage('made_up')).toMatch(/try again/i)
  })
  it('never answers 401 or 403; a full time is 409', () => {
    expect(Object.values(CUSTOMER_MOVE_STATUS)).not.toContain(401)
    expect(Object.values(CUSTOMER_MOVE_STATUS)).not.toContain(403)
    expect(CUSTOMER_MOVE_STATUS.wave_full).toBe(409)
    expect(CUSTOMER_MOVE_STATUS.not_found).toBe(404)
  })
})
