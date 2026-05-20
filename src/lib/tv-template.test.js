// TV-TEMPLATE — resolveZone coverage.
//
// Locks the merge contract: a push-time value overrides the zone
// default field-by-field (text, styling AND geometry); anything
// missing or malformed falls back to the zone default; a legacy
// plain-string value is text-only.

import { describe, it, expect } from 'vitest'
import { resolveZone } from './tv-template'

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
}

describe('resolveZone', () => {
  it('returns the zone defaults when there is no push value', () => {
    expect(resolveZone(ZONE, undefined)).toEqual(FULL)
  })

  it('treats a legacy plain-string value as a text-only override', () => {
    const r = resolveZone(ZONE, 'Class at 6pm')
    expect(r.text).toBe('Class at 6pm')
    // styling + geometry still come from the zone default
    expect(r.fontSize).toBe(9)
    expect(r.uppercase).toBe(true)
    expect(r.width).toBe(80)
  })

  it('applies per-field push overrides', () => {
    const r = resolveZone(ZONE, {
      text: 'BIG NEWS',
      fontSize: 14,
      fontWeight: 400,
      color: '#FF0000',
      align: 'left',
      vAlign: 'top',
      uppercase: false,
      lineHeight: 1.6,
      x: 5, y: 5, width: 50, height: 40,
    })
    expect(r).toEqual({
      text: 'BIG NEWS',
      fontSize: 14,
      fontWeight: 400,
      color: '#FF0000',
      align: 'left',
      vAlign: 'top',
      uppercase: false,
      lineHeight: 1.6,
      x: 5, y: 5, width: 50, height: 40,
    })
  })

  it('overrides geometry (drag/resize on the push screen) field-by-field', () => {
    const r = resolveZone(ZONE, { x: 42, width: 33 })
    expect(r.x).toBe(42)        // dragged
    expect(r.width).toBe(33)    // resized
    expect(r.y).toBe(20)        // untouched → zone default
    expect(r.height).toBe(30)   // untouched → zone default
  })

  it('falls back per-field when the override omits some keys', () => {
    const r = resolveZone(ZONE, { text: 'Half', fontSize: 5 })
    expect(r.text).toBe('Half')
    expect(r.fontSize).toBe(5)        // overridden
    expect(r.fontWeight).toBe(800)    // default
    expect(r.color).toBe('#FFFFFF')   // default
    expect(r.lineHeight).toBe(1.2)    // default
  })

  it('respects uppercase:false as an explicit override (not a fallback)', () => {
    expect(resolveZone(ZONE, { uppercase: false }).uppercase).toBe(false)
  })

  it('ignores malformed override values and falls back', () => {
    const r = resolveZone(ZONE, {
      fontSize: 'huge', fontWeight: null, color: 42, align: 'sideways',
      x: 'left', width: NaN,
    })
    expect(r.fontSize).toBe(9)
    expect(r.fontWeight).toBe(800)
    expect(r.color).toBe('#FFFFFF')
    expect(r.align).toBe('center')
    expect(r.x).toBe(10)
    expect(r.width).toBe(80)
  })

  it('empty text override resolves to an empty string, not the default', () => {
    expect(resolveZone(ZONE, { text: '' }).text).toBe('')
  })

  it('defends against a bare/empty zone', () => {
    expect(resolveZone({}, undefined)).toEqual({
      text: '',
      fontSize: 6,
      fontWeight: 700,
      color: '#FFFFFF',
      align: 'center',
      vAlign: 'middle',
      uppercase: false,
      lineHeight: 1.15,
      x: 0, y: 0, width: 100, height: 100,
    })
  })
})
