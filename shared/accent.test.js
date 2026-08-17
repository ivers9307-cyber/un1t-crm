import { describe, it, expect } from 'vitest'
import { hardestZone, accentFromSessions, PEARL } from './accent'

const DAY = 24 * 3600 * 1000
const NOW = Date.parse('2026-08-01T10:00:00Z')
const sess = (daysAgo, zones) => ({ started_at: new Date(NOW - daysAgo * DAY).toISOString(), zones_seconds: zones })

describe('hardestZone', () => {
  it('returns the highest zone with >=180s, clamped to 3-5', () => {
    expect(hardestZone({ 3: 400, 4: 200, 5: 60 })).toBe(4)
    expect(hardestZone({ 5: 180 })).toBe(5) // boundary: exactly 180 counts
  })
  it('ignores Z1/Z2 entirely and tolerates string keys + junk', () => {
    expect(hardestZone({ 1: 900, 2: 900 })).toBe(null)
    expect(hardestZone({ '4': 200 })).toBe(4)
    expect(hardestZone(null)).toBe(null)
    expect(hardestZone({ 4: 'nope' })).toBe(null)
  })
})

describe('accentFromSessions', () => {
  it('lights up in the hardest earned zone within the trailing 7 days', () => {
    const a = accentFromSessions([sess(2, { 3: 500, 4: 240 }), sess(5, { 3: 900 })], NOW)
    expect(a).toEqual({ zone: 4, color: '#FFA928', lit: true })
  })
  it('a Z5 session beats an earlier Z4 session', () => {
    const a = accentFromSessions([sess(1, { 4: 300 }), sess(6, { 5: 200 })], NOW)
    expect(a.zone).toBe(5)
  })
  it('sessions older than 7 days do not count', () => {
    const a = accentFromSessions([sess(8, { 5: 900 })], NOW)
    expect(a).toEqual({ zone: null, color: PEARL, lit: false })
  })
  it('quiet or Z1/Z2-only weeks rest on Pearl (the unlit identity)', () => {
    expect(accentFromSessions([], NOW).lit).toBe(false)
    expect(accentFromSessions(null, NOW).color).toBe(PEARL)
    expect(accentFromSessions([sess(1, { 1: 1200, 2: 1200 })], NOW).lit).toBe(false)
  })
  it('a sub-3-minute Z5 spike does not light the app', () => {
    expect(accentFromSessions([sess(1, { 5: 179, 3: 60 })], NOW).lit).toBe(false)
  })
})
