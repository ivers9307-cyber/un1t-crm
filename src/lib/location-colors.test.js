// Smoke tests for shared/location-colors.js — the per-location chip
// colour helper used by the personal dashboard on web + mobile.

import { describe, it, expect } from 'vitest'
import { LOCATION_CHIP_PALETTE, pickLocationColor } from '@shared/location-colors'

describe('pickLocationColor', () => {
  it('returns a valid palette entry for any input', () => {
    const ids = [
      'a0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000002',
      'plain-string-id',
      '',
    ]
    for (const id of ids) {
      const c = pickLocationColor(id)
      expect(c).toBeDefined()
      expect(typeof c.bg).toBe('string')
      expect(typeof c.text).toBe('string')
      expect(LOCATION_CHIP_PALETTE.some(p => p.key === c.key)).toBe(true)
    }
  })

  it('is deterministic — same input always returns the same colour', () => {
    const id = 'a0000000-0000-0000-0000-000000000001'
    const a = pickLocationColor(id)
    const b = pickLocationColor(id)
    const c = pickLocationColor(id)
    expect(a.key).toBe(b.key)
    expect(b.key).toBe(c.key)
  })

  it('returns the first palette entry as a safe default for null/undefined', () => {
    expect(pickLocationColor(null).key).toBe(LOCATION_CHIP_PALETTE[0].key)
    expect(pickLocationColor(undefined).key).toBe(LOCATION_CHIP_PALETTE[0].key)
  })

  it('distributes across the palette for distinct UUIDs', () => {
    // Generate 200 plausible-looking IDs and bucket them. We expect
    // every colour to be hit at least once with a 10-colour palette.
    const buckets = new Set()
    for (let i = 0; i < 200; i++) {
      const id = [
        i.toString(16).padStart(8, '0'),
        '0000', '0000', '0000', '000000000000',
      ].join('-')
      buckets.add(pickLocationColor(id).key)
    }
    expect(buckets.size).toBe(LOCATION_CHIP_PALETTE.length)
  })

  it('palette entries use Tailwind classes (so JIT picks them up)', () => {
    for (const p of LOCATION_CHIP_PALETTE) {
      expect(p.bg).toMatch(/^bg-[a-z]+-\d+\/\d+$/)
      expect(p.text).toMatch(/^text-[a-z]+-\d+$/)
    }
  })

  it('text uses a -700 saturation (light-theme readable, matches DRAFT badge)', () => {
    // Tunes against the existing convention in src/ (e.g. DRAFT
    // badges use `text-amber-700` over `bg-amber-500/20`). If we
    // ever switch to dark theme this assertion is the canary that
    // says "go retune".
    for (const p of LOCATION_CHIP_PALETTE) {
      expect(p.text).toMatch(/-700$/)
    }
  })
})
