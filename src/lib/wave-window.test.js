// WAVEWIN.1 — sequential wave fill for the public signup widget.
//
// Events with waves across many hours were filling sparsely: customers
// spread across the whole day, leaving big gaps between part-filled
// waves. The picker now only offers the immediately-available window —
// the earliest wave with space, plus every wave starting within
// WAVE_WINDOW_MINUTES after it. Earlier sold-out waves stay visible
// (greyed) so the fill progress is legible; later waves are hidden and
// "release" as the window slides forward when earlier waves fill.

import { describe, it, expect } from 'vitest'
import {
  windowedWaves, WAVE_WINDOW_MINUTES, WAVE_WINDOW_ALL_MINUTES, WAVE_WINDOW_MIN_MINUTES,
  WAVE_WINDOW_CHOICES, resolveWaveWindowMinutes, waveWindowLabel,
} from './wave-window'

const w = (id, start_time, is_full = false) => ({ id, start_time, is_full })

describe('windowedWaves', () => {
  it('shows only waves within 90 minutes of the first available wave', () => {
    const waves = [
      w('a', '10:00:00'),
      w('b', '10:30:00'),
      w('c', '11:30:00'),
      w('d', '12:00:00'),
      w('e', '14:00:00'),
    ]
    const out = windowedWaves(waves)
    // Anchor 10:00 → window closes 11:30 inclusive.
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps earlier sold-out waves visible (greyed by is_full) ahead of the window', () => {
    const waves = [
      w('a', '09:00:00', true),
      w('b', '09:30:00', true),
      w('c', '10:00:00'),
      w('d', '11:00:00'),
      w('e', '13:00:00'),
    ]
    const out = windowedWaves(waves)
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('slides the window forward as earlier waves fill — the anti-gap mechanic', () => {
    const waves = [
      w('a', '09:00:00', true),
      w('b', '10:00:00', true),
      w('c', '12:00:00'),
      w('d', '13:00:00'),
      w('e', '13:30:00'),
      w('f', '15:00:00'),
    ]
    const out = windowedWaves(waves)
    // Anchor moves to 12:00 → 13:30 in, 15:00 still hidden.
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('shows everything when no wave has space (the page reads full anyway)', () => {
    const waves = [w('a', '09:00:00', true), w('b', '12:00:00', true)]
    expect(windowedWaves(waves)).toEqual(waves)
  })

  it('includes a full wave that falls inside the window', () => {
    const waves = [w('a', '10:00:00'), w('b', '10:30:00', true), w('c', '11:00:00')]
    expect(windowedWaves(waves).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('fails open on an unparsable start_time — a wave we cannot place is never hidden', () => {
    const waves = [w('a', '10:00:00'), w('b', null), w('c', '14:00:00')]
    expect(windowedWaves(waves).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('shows everything when NO wave has a parsable time', () => {
    const waves = [w('a', null), w('b', undefined)]
    expect(windowedWaves(waves)).toEqual(waves)
  })

  it('preserves the incoming order and accepts HH:MM times', () => {
    const waves = [w('b', '10:30'), w('a', '10:00'), w('e', '14:00')]
    expect(windowedWaves(waves).map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('honours a custom window length', () => {
    const waves = [w('a', '10:00:00'), w('b', '10:20:00'), w('c', '10:40:00')]
    expect(windowedWaves(waves, 30).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('handles empty and non-array input', () => {
    expect(windowedWaves([])).toEqual([])
    expect(windowedWaves(null)).toEqual([])
  })

  it('exports a 90-minute default', () => {
    expect(WAVE_WINDOW_MINUTES).toBe(90)
  })
})

// WAVEWIN.2 — the window is a per-event setting (race_events.wave_window_minutes,
// mig 825); NULL or anything unreadable falls back to the 90-minute default.
describe('resolveWaveWindowMinutes', () => {
  it('reads the event\'s own window', () => {
    expect(resolveWaveWindowMinutes({ wave_window_minutes: 180 })).toBe(180)
    expect(resolveWaveWindowMinutes({ wave_window_minutes: WAVE_WINDOW_ALL_MINUTES })).toBe(1440)
    expect(resolveWaveWindowMinutes({ wave_window_minutes: WAVE_WINDOW_MIN_MINUTES })).toBe(15)
  })

  it('falls back to the default for a missing, null or out-of-range value', () => {
    for (const v of [undefined, null, '', 'abc', 0, -30, 14, 1441, 90.5, NaN]) {
      expect(resolveWaveWindowMinutes({ wave_window_minutes: v })).toBe(WAVE_WINDOW_MINUTES)
    }
    expect(resolveWaveWindowMinutes(null)).toBe(WAVE_WINDOW_MINUTES)
    expect(resolveWaveWindowMinutes(undefined)).toBe(WAVE_WINDOW_MINUTES)
  })

  it('a whole-day window shows every wave from the first signup', () => {
    const waves = [w('a', '08:00:00'), w('b', '12:30:00'), w('c', '21:45:00')]
    expect(windowedWaves(waves, WAVE_WINDOW_ALL_MINUTES)).toEqual(waves)
  })
})

describe('wave window choices', () => {
  it('offers the default first and "all at once" last, in rising order', () => {
    expect(WAVE_WINDOW_CHOICES[0]).toBe(WAVE_WINDOW_MINUTES)
    expect(WAVE_WINDOW_CHOICES[WAVE_WINDOW_CHOICES.length - 1]).toBe(WAVE_WINDOW_ALL_MINUTES)
    expect([...WAVE_WINDOW_CHOICES].sort((a, b) => a - b)).toEqual([...WAVE_WINDOW_CHOICES])
  })

  it('labels a window in plain words', () => {
    expect(waveWindowLabel(90)).toBe('90 minutes')
    expect(waveWindowLabel(120)).toBe('2 hours')
    expect(waveWindowLabel(150)).toBe('2 hours 30 minutes')
    expect(waveWindowLabel(45)).toBe('45 minutes')
    expect(waveWindowLabel(60)).toBe('1 hour')
    expect(waveWindowLabel(WAVE_WINDOW_ALL_MINUTES)).toBe('the whole day')
  })
})
