import { describe, it, expect } from 'vitest'
import { arcSchema, sessionSchema, parseArc, parseSession } from './schema'

const validWeek = { week_no: 1, phase: 'base', stimulus: 'Aerobic base', is_benchmark: false, progression: 'RPE 6-7, build volume' }
const validArc = { weeks: 12, dial: 'mixed', plan: [validWeek] }

const validSession = {
  week_no: 5, slot: 1, phase: 'build', focus: 'Engine', is_benchmark: false,
  full_session: { warmup: 'row + drills', main: '4 RFT', cues: ['brace'], why: 'engine block; race energy' },
  board: {
    location_label: 'UN1T STILLORGAN', week_label: 'WEEK 5 / 12', focus: 'ENGINE',
    format: '4 ROUNDS FOR TIME', cap_minutes: 45,
    stations: [{ name: 'Run', performance: '400m', elite: '500m' }],
    target: 'Target sub-32:00',
  },
}

describe('arcSchema', () => {
  it('accepts a valid arc and defaults wordmark on the board', () => {
    expect(parseArc(validArc).ok).toBe(true)
    const s = parseSession(validSession)
    expect(s.ok).toBe(true)
    expect(s.data.board.wordmark).toBe('HYROX TRAINING CLUB')
  })
  it('rejects an unknown phase', () => {
    const bad = { ...validSession, phase: 'endurance' }
    expect(parseSession(bad).ok).toBe(false)
  })
  it('rejects a station missing the elite tier', () => {
    const bad = { ...validSession, board: { ...validSession.board, stations: [{ name: 'Run', performance: '400m' }] } }
    expect(parseSession(bad).ok).toBe(false)
  })
})
