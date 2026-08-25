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
import { windowedWaves, WAVE_WINDOW_MINUTES } from './wave-window'

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
