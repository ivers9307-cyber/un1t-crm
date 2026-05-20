// TV-TEMPLATE.2 — resolveZone coverage.
//
// Locks the merge contract: a push-time value overrides the zone
// default field-by-field; anything missing or malformed falls back
// to the zone default; a legacy plain-string value is text-only.

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
}

describe('resolveZone', () => {
  it('returns the zone defaults when there is no push value', () => {
    expect(resolveZone(ZONE, undefined)).toEqual({
      text: 'Welcome',
      fontSize: 9,
      fontWeight: 800,
      color: '#FFFFFF',
      align: 'center',
      vAlign: 'middle',
      uppercase: true,
    })
  })

  it('treats a legacy plain-string value as a text-only override', () => {
    const r = resolveZone(ZONE, 'Class at 6pm')
    expect(r.text).toBe('Class at 6pm')
    // styling still comes from the zone default
    expect(r.fontSize).toBe(9)
    expect(r.fontWeight).toBe(800)
    expect(r.uppercase).toBe(true)
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
    })
    expect(r).toEqual({
      text: 'BIG NEWS',
      fontSize: 14,
      fontWeight: 400,
      color: '#FF0000',
      align: 'left',
      vAlign: 'top',
      uppercase: false,
    })
  })

  it('falls back per-field when the override omits some keys', () => {
    const r = resolveZone(ZONE, { text: 'Half', fontSize: 5 })
    expect(r.text).toBe('Half')
    expect(r.fontSize).toBe(5)        // overridden
    expect(r.fontWeight).toBe(800)    // default
    expect(r.color).toBe('#FFFFFF')   // default
    expect(r.align).toBe('center')    // default
  })

  it('respects uppercase:false as an explicit override (not a fallback)', () => {
    expect(resolveZone(ZONE, { uppercase: false }).uppercase).toBe(false)
  })

  it('ignores malformed override values and falls back', () => {
    const r = resolveZone(ZONE, {
      fontSize: 'huge', fontWeight: null, color: 42, align: 'sideways',
    })
    expect(r.fontSize).toBe(9)
    expect(r.fontWeight).toBe(800)
    expect(r.color).toBe('#FFFFFF')
    expect(r.align).toBe('center')
  })

  it('empty text override resolves to an empty string, not the default', () => {
    expect(resolveZone(ZONE, { text: '' }).text).toBe('')
  })

  it('defends against a bare/empty zone', () => {
    const r = resolveZone({}, undefined)
    expect(r).toEqual({
      text: '',
      fontSize: 6,
      fontWeight: 700,
      color: '#FFFFFF',
      align: 'center',
      vAlign: 'middle',
      uppercase: false,
    })
  })
})
