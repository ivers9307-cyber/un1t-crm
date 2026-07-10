// TV-TEMPLATE — resolveZone + colour-run coverage.

import { describe, it, expect } from 'vitest'
import {
  resolveZone, mergeRuns, setRunColor, clearRunColor, shiftRuns, textSegments,
  nextFitPx, seedFitPx, fitStepFromLines,
  mergeStyleRuns, setRunStyle, clearRunStyle, rangeStyle, lineRangeAt,
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
  styleRuns: [],
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
      // legacy colour runs fold into the unified styleRuns (TV-STYLE.1)
      styleRuns: runs,
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
      x: 0, y: 0, width: 100, height: 100, colorRuns: [], styleRuns: [],
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

// ── Style runs (TV-STYLE.1) ─────────────────────────────────────

describe('mergeStyleRuns', () => {
  it('sorts, drops empties, and merges touching runs with equal style', () => {
    expect(mergeStyleRuns([
      { start: 5, end: 10, color: 'red', bold: true },
      { start: 0, end: 5, color: 'red', bold: true },
      { start: 12, end: 12, color: 'red' },          // empty → dropped
    ])).toEqual([{ start: 0, end: 10, color: 'red', bold: true }])
  })

  it('keeps adjacent runs apart when any prop differs', () => {
    expect(mergeStyleRuns([
      { start: 0, end: 5, color: 'red' },
      { start: 5, end: 9, color: 'red', bold: true },
    ])).toEqual([
      { start: 0, end: 5, color: 'red' },
      { start: 5, end: 9, color: 'red', bold: true },
    ])
  })

  it('keeps adjacent same-colour runs apart when fontSize differs', () => {
    expect(mergeStyleRuns([
      { start: 0, end: 3, color: 'red', fontSize: 6 },
      { start: 3, end: 6, color: 'red', fontSize: 8 },
    ])).toEqual([
      { start: 0, end: 3, color: 'red', fontSize: 6 },
      { start: 3, end: 6, color: 'red', fontSize: 8 },
    ])
  })

  it('merges adjacent runs when every prop matches', () => {
    expect(mergeStyleRuns([
      { start: 0, end: 3, fontSize: 8, underline: true },
      { start: 3, end: 6, fontSize: 8, underline: true },
    ])).toEqual([{ start: 0, end: 6, fontSize: 8, underline: true }])
  })

  it('drops runs that carry no style props', () => {
    expect(mergeStyleRuns([{ start: 0, end: 4 }])).toEqual([])
  })

  it('treats an explicit bold:false as a real prop, distinct from absent', () => {
    expect(mergeStyleRuns([
      { start: 0, end: 5, color: 'red', bold: false },
      { start: 5, end: 9, color: 'red' },
    ])).toEqual([
      { start: 0, end: 5, color: 'red', bold: false },
      { start: 5, end: 9, color: 'red' },
    ])
  })
})

describe('setRunStyle', () => {
  it('styles a fresh range', () => {
    expect(setRunStyle([], 2, 6, { bold: true }))
      .toEqual([{ start: 2, end: 6, bold: true }])
  })

  it('overlays the patch while preserving other props on the range', () => {
    expect(setRunStyle([{ start: 0, end: 10, color: 'red' }], 3, 7, { bold: true }))
      .toEqual([
        { start: 0, end: 3, color: 'red' },
        { start: 3, end: 7, color: 'red', bold: true },
        { start: 7, end: 10, color: 'red' },
      ])
  })

  it('replaces the patched prop where it already exists', () => {
    expect(setRunStyle([{ start: 0, end: 10, color: 'red' }], 3, 7, { color: 'blue' }))
      .toEqual([
        { start: 0, end: 3, color: 'red' },
        { start: 3, end: 7, color: 'blue' },
        { start: 7, end: 10, color: 'red' },
      ])
  })

  it('ignores patch props whose value is undefined', () => {
    expect(setRunStyle([{ start: 0, end: 4, color: 'red' }], 0, 4, { bold: true, fontSize: undefined }))
      .toEqual([{ start: 0, end: 4, color: 'red', bold: true }])
  })

  it('treats an explicit false as a real value', () => {
    expect(setRunStyle([{ start: 0, end: 4, bold: true }], 0, 4, { bold: false }))
      .toEqual([{ start: 0, end: 4, bold: false }])
  })

  it('ignores an empty selection', () => {
    expect(setRunStyle([{ start: 0, end: 4, color: 'red' }], 2, 2, { bold: true }))
      .toEqual([{ start: 0, end: 4, color: 'red' }])
  })

  it('styles across runs and the gaps between them', () => {
    expect(setRunStyle([
      { start: 0, end: 2, color: 'red' },
      { start: 4, end: 6, color: 'blue' },
    ], 1, 5, { underline: true })).toEqual([
      { start: 0, end: 1, color: 'red' },
      { start: 1, end: 2, color: 'red', underline: true },
      { start: 2, end: 4, underline: true },
      { start: 4, end: 5, color: 'blue', underline: true },
      { start: 5, end: 6, color: 'blue' },
    ])
  })

  it('re-merges runs the patch makes equal', () => {
    expect(setRunStyle([
      { start: 0, end: 3, color: 'red' },
      { start: 3, end: 6, color: 'blue' },
    ], 0, 6, { color: 'red' })).toEqual([{ start: 0, end: 6, color: 'red' }])
  })
})

describe('clearRunStyle', () => {
  it('removes every prop in the range when keys are omitted', () => {
    expect(clearRunStyle([{ start: 0, end: 10, color: 'red', bold: true }], 4, 8))
      .toEqual([
        { start: 0, end: 4, color: 'red', bold: true },
        { start: 8, end: 10, color: 'red', bold: true },
      ])
  })

  it('removes only the listed prop keys', () => {
    expect(clearRunStyle([{ start: 0, end: 10, color: 'red', bold: true }], 4, 8, ['bold']))
      .toEqual([
        { start: 0, end: 4, color: 'red', bold: true },
        { start: 4, end: 8, color: 'red' },
        { start: 8, end: 10, color: 'red', bold: true },
      ])
  })

  it('drops chars left with no props', () => {
    expect(clearRunStyle([{ start: 0, end: 6, bold: true }], 0, 6, ['bold'])).toEqual([])
  })

  it('ignores an empty selection', () => {
    expect(clearRunStyle([{ start: 0, end: 4, color: 'red' }], 2, 2))
      .toEqual([{ start: 0, end: 4, color: 'red' }])
  })

  it('leaves runs untouched when the cleared key is not set', () => {
    expect(clearRunStyle([{ start: 0, end: 4, color: 'red' }], 0, 4, ['underline']))
      .toEqual([{ start: 0, end: 4, color: 'red' }])
  })

  it('re-merges neighbours the clear makes equal', () => {
    expect(clearRunStyle([
      { start: 0, end: 3, color: 'red' },
      { start: 3, end: 6, color: 'red', bold: true },
    ], 3, 6, ['bold'])).toEqual([{ start: 0, end: 6, color: 'red' }])
  })
})

describe('rangeStyle', () => {
  it('returns the props uniform across the whole range', () => {
    expect(rangeStyle([{ start: 0, end: 6, color: 'red', bold: true }], 1, 5))
      .toEqual({ color: 'red', bold: true })
  })

  it('omits a prop that does not cover the whole range', () => {
    expect(rangeStyle([{ start: 0, end: 3, bold: true }], 0, 6)).toEqual({})
  })

  it('keeps uniform props and drops mixed ones', () => {
    expect(rangeStyle([
      { start: 0, end: 3, color: 'red', fontSize: 6 },
      { start: 3, end: 6, color: 'red', fontSize: 8 },
    ], 0, 6)).toEqual({ color: 'red' })
  })

  it('omits uniformly-absent props instead of reporting them', () => {
    expect(rangeStyle([{ start: 0, end: 6, color: 'red' }], 0, 6)).toEqual({ color: 'red' })
  })

  it('returns {} when nothing is styled', () => {
    expect(rangeStyle([], 0, 6)).toEqual({})
  })

  it('reports a uniform explicit false', () => {
    expect(rangeStyle([{ start: 0, end: 6, bold: false }], 2, 4)).toEqual({ bold: false })
  })

  it('treats a gap between styled runs as non-uniform', () => {
    expect(rangeStyle([
      { start: 0, end: 2, bold: true },
      { start: 3, end: 5, bold: true },
    ], 0, 5)).toEqual({})
  })

  it('returns {} for an empty range', () => {
    expect(rangeStyle([{ start: 0, end: 6, bold: true }], 3, 3)).toEqual({})
  })
})

describe('lineRangeAt', () => {
  it('returns the first line for an index inside it', () => {
    expect(lineRangeAt('abc\ndef', 1)).toEqual({ start: 0, end: 3 })
  })

  it('assigns an index sitting on a line\'s end to THAT line', () => {
    expect(lineRangeAt('abc\ndef', 3)).toEqual({ start: 0, end: 3 })
  })

  it('assigns an index right after a newline to the next line', () => {
    expect(lineRangeAt('abc\ndef', 4)).toEqual({ start: 4, end: 7 })
  })

  it('handles the end of the text', () => {
    expect(lineRangeAt('abc\ndef', 7)).toEqual({ start: 4, end: 7 })
  })

  it('clamps the index into [0, text.length]', () => {
    expect(lineRangeAt('abc\ndef', 99)).toEqual({ start: 4, end: 7 })
    expect(lineRangeAt('abc\ndef', -5)).toEqual({ start: 0, end: 3 })
  })

  it('handles an empty string', () => {
    expect(lineRangeAt('', 0)).toEqual({ start: 0, end: 0 })
  })

  it('handles an empty middle line', () => {
    expect(lineRangeAt('a\n\nb', 2)).toEqual({ start: 2, end: 2 })
  })

  it('handles a trailing newline (cursor on the empty last line)', () => {
    expect(lineRangeAt('ab\n', 3)).toEqual({ start: 3, end: 3 })
  })

  it('spans the whole text when there is no newline', () => {
    expect(lineRangeAt('hello', 2)).toEqual({ start: 0, end: 5 })
  })
})

describe('shiftRuns style props', () => {
  it('carries every style prop through an insert', () => {
    expect(shiftRuns(
      [{ start: 3, end: 6, color: 'red', bold: true, fontSize: 5, underline: true }],
      'abcXYZ', 'ab--cXYZ',
    )).toEqual([{ start: 5, end: 8, color: 'red', bold: true, fontSize: 5, underline: true }])
  })

  it('carries every style prop through a delete', () => {
    expect(shiftRuns(
      [{ start: 5, end: 8, bold: false, fontSize: 12 }],
      'ab--cXYZ', 'abcXYZ',
    )).toEqual([{ start: 3, end: 6, bold: false, fontSize: 12 }])
  })
})

describe('textSegments style props', () => {
  it('resolves the base colour for a bold-only run and carries bold', () => {
    expect(textSegments('hello', [{ start: 1, end: 3, bold: true }], '#fff')).toEqual([
      { text: 'h', color: '#fff' },
      { text: 'el', color: '#fff', bold: true },
      { text: 'lo', color: '#fff' },
    ])
  })

  it('splits when ANY prop changes, even with the colour constant', () => {
    expect(textSegments('abcdef', [
      { start: 0, end: 3, color: 'red', fontSize: 4 },
      { start: 3, end: 6, color: 'red' },
    ], '#fff')).toEqual([
      { text: 'abc', color: 'red', fontSize: 4 },
      { text: 'def', color: 'red' },
    ])
  })

  it('carries underline and an explicit bold:false', () => {
    expect(textSegments('ab', [{ start: 0, end: 2, bold: false, underline: true }], '#fff'))
      .toEqual([{ text: 'ab', color: '#fff', bold: false, underline: true }])
  })

  it('lets the run colour win over the base colour', () => {
    expect(textSegments('ab', [{ start: 0, end: 1, color: 'red', bold: true }], '#fff')).toEqual([
      { text: 'a', color: 'red', bold: true },
      { text: 'b', color: '#fff' },
    ])
  })
})

describe('resolveZone styleRuns', () => {
  it('folds legacy colorRuns into styleRuns as colour-only runs', () => {
    const r = resolveZone(ZONE, { colorRuns: [{ start: 0, end: 3, color: '#FF0000' }] })
    expect(r.styleRuns).toEqual([{ start: 0, end: 3, color: '#FF0000' }])
    // The legacy output field is untouched.
    expect(r.colorRuns).toEqual([{ start: 0, end: 3, color: '#FF0000' }])
  })

  it('passes explicit styleRuns through', () => {
    const r = resolveZone(ZONE, { styleRuns: [{ start: 0, end: 4, bold: true, fontSize: 5 }] })
    expect(r.styleRuns).toEqual([{ start: 0, end: 4, bold: true, fontSize: 5 }])
    expect(r.colorRuns).toEqual([])
  })

  it('lets styleRuns win over legacy colorRuns on overlap', () => {
    const r = resolveZone(ZONE, {
      colorRuns: [{ start: 0, end: 10, color: 'red' }],
      styleRuns: [{ start: 3, end: 7, color: 'blue', bold: true }],
    })
    expect(r.styleRuns).toEqual([
      { start: 0, end: 3, color: 'red' },
      { start: 3, end: 7, color: 'blue', bold: true },
      { start: 7, end: 10, color: 'red' },
    ])
    expect(r.colorRuns).toEqual([{ start: 0, end: 10, color: 'red' }])
  })

  it('keeps the legacy colour beneath a styleRun that sets no colour', () => {
    const r = resolveZone(ZONE, {
      colorRuns: [{ start: 0, end: 6, color: 'red' }],
      styleRuns: [{ start: 2, end: 4, bold: true }],
    })
    expect(r.styleRuns).toEqual([
      { start: 0, end: 2, color: 'red' },
      { start: 2, end: 4, color: 'red', bold: true },
      { start: 4, end: 6, color: 'red' },
    ])
  })

  it('falls back to the zone-default styleRuns when the value has none', () => {
    const zone = { ...ZONE, styleRuns: [{ start: 0, end: 2, underline: true }] }
    expect(resolveZone(zone, undefined).styleRuns)
      .toEqual([{ start: 0, end: 2, underline: true }])
  })

  it('prefers the value styleRuns over the zone default', () => {
    const zone = { ...ZONE, styleRuns: [{ start: 0, end: 2, underline: true }] }
    const r = resolveZone(zone, { styleRuns: [{ start: 1, end: 3, bold: true }] })
    expect(r.styleRuns).toEqual([{ start: 1, end: 3, bold: true }])
  })

  it('resolves to an empty styleRuns array when nothing is styled', () => {
    expect(resolveZone(ZONE, undefined).styleRuns).toEqual([])
    expect(resolveZone({}, 'plain text').styleRuns).toEqual([])
  })
})
