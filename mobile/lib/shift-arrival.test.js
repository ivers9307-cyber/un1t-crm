// mobile/lib/shift-arrival.test.js
//
// ARRIVALSHOW.1 — the one line a coach sees under their own shift. Pure: the
// server sends facts (src/lib/shift-arrivals.js), this decides with "now".
// Runs under TZ=Europe/Dublin and TZ=America/Los_Angeles in the gate: nothing
// here may depend on the phone's zone.

import { describe, it, expect } from 'vitest'
import { arrivalLine, arrivalHelpFor, ARRIVAL_WORDS } from './shift-arrival'

const START = '2026-09-24T06:00:00.000Z' // 07:00 Dublin
const END = '2026-09-24T07:00:00.000Z'   // 08:00 Dublin
const at = (iso) => Date.parse(iso)

const shift = (arrival, over = {}) => ({ id: 'a1', shift_date: '2026-09-24', published: true, arrival, ...over })
const none = (over = {}) => ({
  at: null, at_local: null, at_local_date: null, source: null, carried: false, tracked: true,
  starts_at: START, ends_at: END, ...over,
})
const stamped = (over = {}) => none({ at: '2026-09-24T05:52:00.000Z', at_local: '06:52', at_local_date: '2026-09-24', source: 'geofence', ...over })

describe('arrivalLine — a stamp', () => {
  it('reads "Arrived 06:52", before, during and after the shift', () => {
    for (const now of [at('2026-09-24T05:55:00Z'), at('2026-09-24T06:30:00Z'), at('2026-09-24T09:00:00Z')]) {
      expect(arrivalLine(shift(stamped()), now)).toEqual({ kind: 'arrived', text: 'Arrived 06:52' })
    }
  })

  it('an arrival the evening before a just-after-midnight shift says so', () => {
    const s = shift(stamped({ at_local: '23:50', at_local_date: '2026-09-24' }), { shift_date: '2026-09-25' })
    expect(arrivalLine(s, at('2026-09-25T01:00:00Z')).text).toBe('Arrived 23:50 the day before')
  })

  it('carried (back-to-back, or the double-stamp shape) reads as on site', () => {
    expect(arrivalLine(shift(stamped({ carried: true, source: null })), at('2026-09-24T09:00:00Z')))
      .toEqual({ kind: 'on_site', text: 'On site from your earlier shift (arrived 06:52)' })
  })

  it('a stamp shows even where arrivals are not tracked, and on a draft', () => {
    expect(arrivalLine(shift(stamped({ tracked: false })), 0).kind).toBe('arrived')
    expect(arrivalLine(shift(stamped({ tracked: null })), 0).kind).toBe('arrived')
    expect(arrivalLine(shift(stamped(), { published: false }), 0).kind).toBe('arrived')
  })
})

describe('arrivalLine — no stamp', () => {
  it.each([
    ['before the shift starts', '2026-09-24T05:59:59Z', null],
    ['exactly at the start', '2026-09-24T06:00:00Z', 'not_yet'],
    ['during the shift', '2026-09-24T06:30:00Z', 'not_yet'],
    ['exactly at the end', '2026-09-24T07:00:00Z', 'not_recorded'],
    ['after the shift', '2026-09-25T12:00:00Z', 'not_recorded'],
  ])('%s', (_name, nowIso, kind) => {
    const line = arrivalLine(shift(none()), at(nowIso))
    expect(line?.kind ?? null).toBe(kind)
  })

  it('the words', () => {
    expect(arrivalLine(shift(none()), at('2026-09-24T06:30:00Z')).text).toBe('No arrival recorded yet')
    expect(arrivalLine(shift(none()), at('2026-09-24T08:00:00Z')).text).toBe('No arrival recorded')
  })

  it('not tracked (studio off, exempt) shows nothing', () => {
    expect(arrivalLine(shift(none({ tracked: false })), at('2026-09-24T08:00:00Z'))).toBeNull()
  })

  it('tracking unknown (a failed read) shows nothing: unknown is never absence', () => {
    expect(arrivalLine(shift(none({ tracked: null })), at('2026-09-24T08:00:00Z'))).toBeNull()
  })

  it('a draft shows no absence line', () => {
    expect(arrivalLine(shift(none(), { published: false }), at('2026-09-24T08:00:00Z'))).toBeNull()
  })

  it('no window, or a broken one, shows nothing', () => {
    expect(arrivalLine(shift(none({ starts_at: null })), at('2026-09-24T08:00:00Z'))).toBeNull()
    expect(arrivalLine(shift(none({ ends_at: 'soon' })), at('2026-09-24T08:00:00Z'))).toBeNull()
  })

  it('a stamp with a malformed local time shows nothing: never "Arrived undefined", never an absence', () => {
    expect(arrivalLine(shift(stamped({ at_local: '6:52' })), at('2026-09-24T08:00:00Z'))).toBeNull()
    expect(arrivalLine(shift(stamped({ at_local: null })), at('2026-09-24T06:30:00Z'))).toBeNull()
  })

  it('a missing "now" shows no absence line', () => {
    expect(arrivalLine(shift(none()), undefined)).toBeNull()
    expect(arrivalLine(shift(none()), NaN)).toBeNull()
  })
})

describe('arrivalLine — nothing to say', () => {
  it.each([
    ['an old server (no field)', { id: 'a1', shift_date: '2026-09-24' }],
    ["a colleague's row, or a failed read (null)", shift(null)],
    ['a garbage value', shift('arrived')],
    ['no shift', null],
  ])('%s', (_name, s) => {
    expect(arrivalLine(s, at('2026-09-24T08:00:00Z'))).toBeNull()
  })
})

describe('the words (D7)', () => {
  it('no word says late, missed, no-show or absent', () => {
    const all = [
      ARRIVAL_WORDS.arrived('06:52'), ARRIVAL_WORDS.arrivedDayBefore('23:50'), ARRIVAL_WORDS.onSite('06:52'),
      ARRIVAL_WORDS.notYet, ARRIVAL_WORDS.notRecorded, ARRIVAL_WORDS.help,
    ].join(' ').toLowerCase()
    for (const w of ['late', 'missed', 'no-show', 'no show', 'absent']) expect(all).not.toContain(w)
  })
})

describe('arrivalHelpFor', () => {
  it('shows only when a line shows', () => {
    const now = at('2026-09-24T08:00:00Z')
    expect(arrivalHelpFor([], now)).toBeNull()
    expect(arrivalHelpFor(null, now)).toBeNull()
    expect(arrivalHelpFor([shift(none({ tracked: false })), shift(null)], now)).toBeNull()
    expect(arrivalHelpFor([shift(null), shift(none())], now)).toBe(ARRIVAL_WORDS.help)
    expect(arrivalHelpFor([shift(stamped())], now)).toBe(ARRIVAL_WORDS.help)
  })
})
