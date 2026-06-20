import { describe, it, expect } from 'vitest'
import { metricValue, rankStandings, challengePhase, windowIso, shortName } from './challenges.js'

const sess = (o) => ({ effort_points: 0, zones_seconds: {}, ...o })

describe('metricValue', () => {
  it('points = effort_points', () => { expect(metricValue(sess({ effort_points: 240 }), 'points')).toBe(240) })
  it('classes = 1 per session', () => { expect(metricValue(sess({}), 'classes')).toBe(1) })
  it('z4plus_minutes = (z4+z5)/60', () => {
    expect(metricValue(sess({ zones_seconds: { 4: 300, 5: 120 } }), 'z4plus_minutes')).toBe(7)
  })
  it('unknown metric → 0', () => { expect(metricValue(sess({ effort_points: 9 }), 'nope')).toBe(0) })
})

describe('rankStandings', () => {
  it('sorts desc and shares ranks on ties', () => {
    const r = rankStandings([
      { contactId: 'a', value: 100 }, { contactId: 'b', value: 300 },
      { contactId: 'c', value: 300 }, { contactId: 'd', value: 50 },
    ])
    expect(r.map((x) => [x.contactId, x.rank])).toEqual([['b', 1], ['c', 1], ['a', 3], ['d', 4]])
  })
})

describe('challengePhase', () => {
  const at = (iso) => new Date(iso).getTime()
  const ch = { starts_on: '2026-06-10', ends_on: '2026-06-20' }
  it('upcoming before start', () => { expect(challengePhase(ch, at('2026-06-09T12:00:00Z'))).toBe('upcoming') })
  it('active within window incl. end day', () => {
    expect(challengePhase(ch, at('2026-06-10T00:00:00Z'))).toBe('active')
    expect(challengePhase(ch, at('2026-06-20T23:00:00Z'))).toBe('active')
  })
  it('ended after end day', () => { expect(challengePhase(ch, at('2026-06-21T00:00:00Z'))).toBe('ended') })
})

describe('windowIso', () => {
  it('inclusive day range → [start 00:00Z, end+1 00:00Z)', () => {
    expect(windowIso({ starts_on: '2026-06-10', ends_on: '2026-06-20' }))
      .toEqual({ fromIso: '2026-06-10T00:00:00.000Z', toIso: '2026-06-21T00:00:00.000Z' })
  })
})

describe('shortName', () => {
  it('first name + last initial', () => { expect(shortName('Sarah Kelly')).toBe('Sarah K.') })
  it('single name → first only', () => { expect(shortName('Sarah')).toBe('Sarah') })
  it('empty → Member', () => { expect(shortName('')).toBe('Member') })
  it('multi-part → last-token initial', () => { expect(shortName('Mary Jane Watson')).toBe('Mary W.') })
})
