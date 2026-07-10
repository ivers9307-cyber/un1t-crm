// TV-TEMPLATE — resolveZone + colour-run coverage.

import { describe, it, expect } from 'vitest'
import {
  resolveZone, mergeRuns, setRunColor, clearRunColor, shiftRuns, textSegments,
  nextFitPx, seedFitPx, fitStepFromLines,
} from './tv-template'

const ZONE = {
  id: 'z1',
  label: 'Headline',
  defaultText: 'Welcome',
  fontSize: 9,
  fontWeight: 800,
  color: '#FFFFFF',
  align: 'center',
  vAlign: 'middle',
  uppercase: true,
  lineHeight: 1.2,
  x: 10, y: 20, width: 80, height: 30,
}

const FULL = {
  text: 'Welcome',
  fontSize: 9,
  fontWeight: 800,
  color: '#FFFFFF',
  align: 'center',
  vAlign: 'middle',
  uppercase: true,
  lineHeight: 1.2,
  x: 10, y: 20, width: 80, height: 30,
  colorRuns: [],
}

describe('resolveZone', () => {
  it('returns the zone defaults when there is no push value', () => {
    expect(resolveZone(ZONE, undefined)).toEqual(FULL)
  })

  it('treats a legacy plain-string value as a text-only override', () => {
    const r = resolveZone(ZONE, 'Class at 6pm')
    expect(r.text).toBe('Class at 6pm')
    expect(r.fontSize).toBe(9)
    expect(r.colorRuns).toEqual([])
  })

  it('applies per-field push overrides incl. geometry + colour runs', () => {
    const runs = [{ start: 0, end: 3, color: '#FF0000' }]
    const r = resolveZone(ZONE, {
      text: 'BIG NEWS', fontSize: 14, fontWeight: 400, color: '#FF0000',
      align: 'left', vAlign: 'top', uppercase: false, lineHeight: 1.6,
      x: 5, y: 5, width: 50, height: 40, colorRuns: runs,
    })
    expect(r).toEqual({
      text: 'BIG NEWS', fontSize: 14, fontWeight: 400, color: '#FF0000',
      align: 'left', vAlign: 'top', uppercase: false, lineHeight: 1.6,
      x: 5, y: 5, width: 50, height: 40, colorRuns: runs,
    })
  })

  it('falls back per-field when the override omits some keys', () => {
    const r = resolveZone(ZONE, { text: 'Half', fontSize: 5 })
    expect(r.text).toBe('Half')
    expect(r.fontSize).toBe(5)
    expect(r.fontWeight).toBe(800)
    expect(r.colorRuns).toEqual([])
  })

  it('defends against a bare/empty zone', () => {
    expect(resolveZone({}, undefined)).toEqual({
      text: '', fontSize: 6, fontWeight: 700, color: '#FFFFFF',
      align: 'center', vAlign: 'middle', uppercase: false, lineHeight: 1.15,
      x: 0, y: 0, width: 100, height: 100, colorRuns: [],
    })
  })
})

describe('mergeRuns', () => {
  it('sorts, drops empties, and merges touching same-colour runs', () => {
    expect(mergeRuns([
      { start: 5, end: 10, color: 'red' },
      { start: 0, end: 5, color: 'red' },
      { start: 12, end: 12, color: 'red' },   // empty → dropped
    ])).toEqual([{ start: 0, end: 10, color: 'red' }])
  })

  it('keeps adjacent runs of different colours separate', () => {
    expect(mergeRuns([
      { start: 0, end: 5, color: 'red' },
      { start: 5, end: 9, color: 'blue' },
    ])).toEqual([
      { start: 0, end: 5, color: 'red' },
      { start: 5, end: 9, color: 'blue' },
    ])
  })
})

describe('setRunColor', () => {
  it('paints a fresh range', () => {
    expect(setRunColor([], 2, 6, 'red')).toEqual([{ start: 2, end: 6, color: 'red' }])
  })

  it('carves an overlapping run and replaces the middle', () => {
    const r = setRunColor([{ start: 0, end: 10, color: 'red' }], 3, 7, 'blue')
    expect(r).toEqual([
      { start: 0, end: 3, color: 'red' },
      { start: 3, end: 7, color: 'blue' },
      { start: 7, end: 10, color: 'red' },
    ])
  })

  it('ignores an empty selection', () => {
    expect(setRunColor([{ start: 0, end: 4, color: 'red' }], 5, 5, 'blue'))
      .toEqual([{ start: 0, end: 4, color: 'red' }])
  })
})

describe('clearRunColor', () => {
  it('removes colour from the selected range', () => {
    expect(clearRunColor([{ start: 0, end: 10, color: 'red' }], 4, 8)).toEqual([
      { start: 0, end: 4, color: 'red' },
      { start: 8, end: 10, color: 'red' },
    ])
  })
})

describe('shiftRuns', () => {
  it('shifts runs right when text is inserted before them', () => {
    // "abcXYZ" → "ab--cXYZ": 2 chars inserted at index 2
    expect(shiftRuns([{ start: 3, end: 6, color: 'red' }], 'abcXYZ', 'ab--cXYZ'))
      .toEqual([{ start: 5, end: 8, color: 'red' }])
  })

  it('shifts runs left when text is deleted before them', () => {
    // "ab--cXYZ" → "abcXYZ": 2 chars deleted
    expect(shiftRuns([{ start: 5, end: 8, color: 'red' }], 'ab--cXYZ', 'abcXYZ'))
      .toEqual([{ start: 3, end: 6, color: 'red' }])
  })

  it('leaves runs before the edit untouched', () => {
    expect(shiftRuns([{ start: 0, end: 2, color: 'red' }], 'abcd', 'abcdEFG'))
      .toEqual([{ start: 0, end: 2, color: 'red' }])
  })
})

// ── Auto-fit helpers (TV-TEMPLATE.6 / TV-MOBILE.G) ──────────────

describe('nextFitPx', () => {
  it('keeps the current size when nothing overflows', () => {
    expect(nextFitPx(40, 1, 1)).toBe(40)
  })

  it('shrinks by the worst overflow axis', () => {
    expect(nextFitPx(40, 0.5, 0.8)).toBe(20)
  })

  it('never grows past the current size', () => {
    expect(nextFitPx(40, 1.4, 1.2)).toBe(40)
  })

  it('floors at minPx', () => {
    expect(nextFitPx(40, 0.01, 1, 9)).toBe(9)
  })

  it('falls to the floor on a nonsense scale', () => {
    expect(nextFitPx(40, NaN, 0)).toBe(9)
  })
})

describe('seedFitPx', () => {
  it('caps the starting size so every hard newline gets a line slot', () => {
    const text = Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n')
    // 200px-tall zone, lineHeight 1.15 → 13 lines only fit at ≤ ~13.4px
    expect(seedFitPx(text, 200, 1.15, 40)).toBeCloseTo(200 / (13 * 1.15), 5)
  })

  it('returns maxPx when the line count already fits', () => {
    expect(seedFitPx('one\ntwo', 200, 1.15, 40)).toBe(40)
  })

  it('never seeds below the legibility floor', () => {
    expect(seedFitPx('a\n'.repeat(100), 100, 1.15, 40)).toBe(9)
  })

  it('keeps the floor below maxPx for tiny zones', () => {
    expect(seedFitPx('a\n'.repeat(100), 100, 1.15, 5)).toBe(5)
  })

  it('treats empty text as a single line', () => {
    expect(seedFitPx('', 200, 1.15, 40)).toBe(40)
  })
})

describe('fitStepFromLines', () => {
  it('reports a fit when the measured lines stay inside the box', () => {
    expect(fitStepFromLines([{ width: 100, height: 20 }], 200, 100, 40, 9))
      .toEqual({ fits: true, nextPx: 40 })
  })

  it('shrinks in proportion to vertical overflow (truncated multi-line paste)', () => {
    const lines = Array.from({ length: 13 }, () => ({ width: 150, height: 20 }))
    const r = fitStepFromLines(lines, 200, 130, 40, 9)   // 260px of text in a 130px box
    expect(r.fits).toBe(false)
    expect(r.nextPx).toBeCloseTo(20, 5)
  })

  it('shrinks for an unbreakable line wider than the box', () => {
    const r = fitStepFromLines([{ width: 400, height: 20 }], 200, 100, 40, 9)
    expect(r.fits).toBe(false)
    expect(r.nextPx).toBeCloseTo(20, 5)
  })

  it('floors at minPx', () => {
    const lines = Array.from({ length: 50 }, () => ({ width: 10, height: 20 }))
    expect(fitStepFromLines(lines, 200, 100, 40, 9).nextPx).toBe(9)
  })

  it('treats no measured lines as fitting', () => {
    expect(fitStepFromLines([], 200, 100, 40, 9)).toEqual({ fits: true, nextPx: 40 })
  })
})

describe('textSegments', () => {
  it('returns one base-coloured segment when there are no runs', () => {
    expect(textSegments('hello', [], '#fff')).toEqual([{ text: 'hello', color: '#fff' }])
  })

  it('splits the text around a colour run', () => {
    expect(textSegments('hello', [{ start: 0, end: 2, color: 'red' }], '#fff')).toEqual([
      { text: 'he', color: 'red' },
      { text: 'llo', color: '#fff' },
    ])
  })

  it('handles an empty string', () => {
    expect(textSegments('', [], '#fff')).toEqual([{ text: '', color: '#fff' }])
  })
})
