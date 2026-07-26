import { describe, it, expect } from 'vitest'
import { parseArc, parseSession } from './schema'

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

describe('hyrox schemas', () => {
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
  it('rejects a station with no target or performance value', () => {
    const bad = { ...validSession, board: { ...validSession.board, stations: [{ name: 'Run' }] } }
    expect(parseSession(bad).ok).toBe(false)
  })
  it('lifts an old-style performance value into target (back-compat)', () => {
    const raw = { ...validSession, board: { ...validSession.board, stations: [{ name: 'Run', performance: '400m', elite: '500m' }] } }
    const s = parseSession(raw)
    expect(s.ok).toBe(true)
    expect(s.data.board.stations[0].target).toBe('400m')
  })
  it('accepts a session with no warmup (leaner single-level card)', () => {
    const fs = { ...validSession.full_session }
    delete fs.warmup
    const s = parseSession({ ...validSession, full_session: fs })
    expect(s.ok).toBe(true)
  })
})

describe('LLM output coercion (regression: session_generation_failed)', () => {
  it('coerces numeric station performance/elite to strings', () => {
    const raw = { ...validSession, board: { ...validSession.board, stations: [{ name: 'Wall balls', performance: 20, elite: 25 }] } }
    const s = parseSession(raw)
    expect(s.ok).toBe(true)
    expect(s.data.board.stations[0]).toMatchObject({ performance: '20', elite: '25' })
  })
  it('accepts cues as a single string', () => {
    const raw = { ...validSession, full_session: { ...validSession.full_session, cues: 'brace and breathe' } }
    const s = parseSession(raw)
    expect(s.ok).toBe(true)
    expect(s.data.full_session.cues).toEqual(['brace and breathe'])
  })
  it('parses cap_minutes given as "45 min"', () => {
    const raw = { ...validSession, board: { ...validSession.board, cap_minutes: '45 min' } }
    const s = parseSession(raw)
    expect(s.ok).toBe(true)
    expect(s.data.board.cap_minutes).toBe(45)
  })
  it('accepts a title-cased phase', () => {
    const s = parseSession({ ...validSession, phase: 'Build' })
    expect(s.ok).toBe(true)
    expect(s.data.phase).toBe('build')
  })
  it('lifts focus out of the board when omitted at the top level', () => {
    const noFocus = { ...validSession }
    delete noFocus.focus
    const s = parseSession(noFocus)
    expect(s.ok).toBe(true)
    expect(s.data.focus).toBe('ENGINE')
  })
  it('unwraps a single-key wrapper object', () => {
    const s = parseSession({ session: validSession })
    expect(s.ok).toBe(true)
    expect(s.data.board.stations).toHaveLength(1)
  })
  it('joins an array-valued warmup into text', () => {
    const raw = { ...validSession, full_session: { ...validSession.full_session, warmup: ['row 500m', 'dynamic drills'] } }
    const s = parseSession(raw)
    expect(s.ok).toBe(true)
    expect(s.data.full_session.warmup).toContain('row 500m')
  })
  it('coerces arc weeks/dial/phase variances', () => {
    const raw = { weeks: '12', dial: 'Mixed', plan: [{ ...validWeek, phase: 'Base' }] }
    const a = parseArc(raw)
    expect(a.ok).toBe(true)
    expect(a.data.dial).toBe('mixed')
    expect(a.data.plan[0].phase).toBe('base')
  })
  it('flattens a nested-object full_session field into readable text, not raw JSON', () => {
    const raw = {
      ...validSession,
      full_session: {
        ...validSession.full_session,
        main: { part_a: { label: 'Aerobic floor', structure: '4 x 500m run' }, part_b: { label: 'Sled circuit', estimated_time_minutes: 18 } },
      },
    }
    const s = parseSession(raw)
    expect(s.ok).toBe(true)
    expect(s.data.full_session.main).toContain('Aerobic floor')
    expect(s.data.full_session.main).toContain('Sled circuit')
    expect(s.data.full_session.main).not.toContain('{')
    expect(s.data.full_session.main).not.toContain('"')
  })
})

describe('board brevity guards (regression: 2026-07-23 text-dump board)', () => {
  const longSentence = '600m opening, then 400m between each station at an easy aerobic pace'
  it('rejects a coaching sentence in a station target value', () => {
    const bad = { ...validSession, board: { ...validSession.board, stations: [{ name: 'Run', target: longSentence }] } }
    expect(parseSession(bad).ok).toBe(false)
  })
  it('rejects a paragraph-length board.format', () => {
    const bad = { ...validSession, board: { ...validSession.board, format: 'Solo timed stations - staggered start - full loop within a 45 minute cap' } }
    expect(parseSession(bad).ok).toBe(false)
  })
  it('still accepts normal short scoreboard values', () => {
    const ok = { ...validSession, board: { ...validSession.board, stations: [{ name: 'Farmers Carry', target: '2x16kg' }] } }
    expect(parseSession(ok).ok).toBe(true)
  })
  it('collapses whitespace/newlines in board values to one line', () => {
    const raw = { ...validSession, board: { ...validSession.board, format: '4 ROUNDS\n  FOR   TIME', stations: [{ name: 'Ski\nErg', target: ' 650m ' }] } }
    const s = parseSession(raw)
    expect(s.ok).toBe(true)
    expect(s.data.board.format).toBe('4 ROUNDS FOR TIME')
    expect(s.data.board.stations[0].name).toBe('Ski Erg')
    expect(s.data.board.stations[0].target).toBe('650m')
  })
})
