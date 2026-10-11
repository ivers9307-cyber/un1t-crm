import { describe, it, expect } from 'vitest'
import { buildChallengeStartPush, buildChallengeResultPush, buildCollectiveTargetPush, metricLabel } from './challenge-notifications.js'

describe('metricLabel', () => {
  it('maps the three metrics (W1.S1a: points on the studio short brand)', () => {
    expect(metricLabel('points', 'UN1T')).toBe('UN1T Points')
    expect(metricLabel('points', 'Northside')).toBe('Northside Points')
    expect(metricLabel('points')).toBe('Points')
    expect(metricLabel('classes')).toBe('classes')
    expect(metricLabel('z4plus_minutes')).toBe('Z4+ minutes')
  })
})
describe('buildChallengeStartPush', () => {
  it('announces the start', () => {
    const r = buildChallengeStartPush({ name: 'June Points Race' })
    expect(r.title).toBe('New challenge: June Points Race')
    expect(r.data).toEqual({ type: 'challenge' })
  })
})
describe('buildChallengeResultPush', () => {
  it('individual → names the winner', () => {
    const r = buildChallengeResultPush({ challenge: { name: 'June Race', mode: 'individual' }, winner: { name: 'Sarah K.' } })
    expect(r.title).toBe('June Race: results')
    expect(r.body).toBe('🏆 Sarah K. took the top spot.')
  })
  it('individual → graceful when no winner', () => {
    const r = buildChallengeResultPush({ challenge: { name: 'X', mode: 'individual' }, winner: null })
    expect(r.body).toBe('The challenge has ended.')
  })
  it('collective hit → celebrates', () => {
    const r = buildChallengeResultPush({ challenge: { name: 'Gym Goal', mode: 'collective', metric: 'points', target: 100000 }, collective: { total: 100000, target: 100000, pct: 1 }, shortName: 'UN1T' })
    expect(r.body).toBe('We smashed the goal: 100000 UN1T Points! 🎉')
  })
  it('collective miss → reports pct', () => {
    const r = buildChallengeResultPush({ challenge: { name: 'Gym Goal', mode: 'collective', metric: 'points', target: 100000 }, collective: { total: 62000, target: 100000, pct: 0.62 } })
    expect(r.body).toBe('We reached 62% of the goal.')
  })
})
describe('buildCollectiveTargetPush', () => {
  it('celebrates the gym hitting target', () => {
    const r = buildCollectiveTargetPush({ name: 'Gym Goal', metric: 'classes', target: 500 })
    expect(r.title).toBe('Goal reached: Gym Goal 🎉')
    expect(r.body).toBe('The gym hit 500 classes!')
  })
  it('W1.S1a: a points target names the studio product, bare "Points" without one', () => {
    expect(buildCollectiveTargetPush({ name: 'G', metric: 'points', target: 9 }, { shortName: 'UN1T' }).body).toBe('The gym hit 9 UN1T Points!')
    expect(buildCollectiveTargetPush({ name: 'G', metric: 'points', target: 9 }).body).toBe('The gym hit 9 Points!')
  })
})
