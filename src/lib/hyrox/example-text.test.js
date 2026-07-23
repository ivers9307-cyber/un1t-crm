import { describe, it, expect } from 'vitest'
import { sessionToExampleText } from './example-text'

const session = {
  week_no: 5, slot: 1, phase: 'build', focus: 'Engine',
  full_session: { warmup: 'row 500m + drills', strength: null, main: '4 rounds for time', finisher: '200m cool down', cues: ['brace', 'smooth pace'], why: 'engine block' },
  board: { format: '4 ROUNDS FOR TIME', cap_minutes: 45, target: 'sub-32', stations: [{ name: 'Run', performance: '400m', elite: '500m' }, { name: 'Wall balls', performance: '9kg x 20', elite: '9kg x 25' }] },
}

describe('sessionToExampleText', () => {
  it('renders a compact readable coaching text block', () => {
    const t = sessionToExampleText(session)
    expect(t).toContain('Engine')
    expect(t).toContain('Warmup: row 500m')
    expect(t).toContain('Main: 4 rounds for time')
    expect(t).toContain('brace')
    expect(t).toContain('Run: Performance 400m / Elite 500m')
    expect(t).not.toContain('{')  // not JSON
  })
  it('skips empty optional sections', () => {
    const t = sessionToExampleText(session)
    expect(t).not.toContain('Strength:')  // strength was null
  })
})
