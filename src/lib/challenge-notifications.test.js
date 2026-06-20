import { describe, it, expect } from 'vitest'
import { buildChallengeStartPush, buildChallengeResultPush, buildCollectiveTargetPush, metricLabel } from './challenge-notifications.js'

describe('metricLabel', () => {
  it('maps the three metrics', () => {
    expect(metricLabel('points')).toBe('UN1T Points')
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
    expect(r.title).toBe('June Race — results')
    expect(r.body).toBe('🏆 Sarah K. took the top spot.')
  })
  it('individual → graceful when no winner', () => {
    const r = buildChallengeResultPush({ challenge: { name: 'X', mode: 'individual' }, winner: null })
    expect(r.body).toBe('The challenge has ended.')
  })
  it('collective hit → celebrates', () => {
    const r = buildChallengeResultPush({ challenge: { name: 'Gym Goal', mode: 'collective', metric: 'points', target: 100000 }, collective: { total: 100000, target: 100000, pct: 1 } })
    expect(r.body).toBe('We smashed the goal — 100000 UN1T Points! 🎉')
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
})
