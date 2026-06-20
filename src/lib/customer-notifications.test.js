import { describe, it, expect } from 'vitest'
import { buildSessionPush, buildGoalPush, buildStreakAtRiskPush, periodKey, streakAtRisk } from './customer-notifications.js'

describe('buildSessionPush', () => {
  const base = { effortPoints: 280, className: 'Conditioning', sessionId: 'sess-1' }
  it('no achievement → session-ready copy', () => {
    expect(buildSessionPush({ ...base, unlocked: [] })).toEqual({
      title: 'Your session is ready',
      body: '280 UN1T Points · Conditioning',
      data: { type: 'session_report', session_id: 'sess-1' },
    })
  })
  it('one achievement → leads with the name', () => {
    const r = buildSessionPush({ ...base, unlocked: [{ name: 'First Z5' }] })
    expect(r.title).toBe('New achievement — First Z5')
    expect(r.body).toBe('280 UN1T Points · Conditioning. Tap to see your stats.')
    expect(r.data).toEqual({ type: 'achievement', session_id: 'sess-1', count: 1 })
  })
  it('two+ achievements → counts them', () => {
    const r = buildSessionPush({ ...base, unlocked: [{ name: 'A' }, { name: 'B' }] })
    expect(r.title).toBe('You unlocked 2 achievements')
    expect(r.data.count).toBe(2)
  })
  it('missing points → fallback phrase, missing class → no suffix', () => {
    const r = buildSessionPush({ effortPoints: null, className: null, sessionId: 's', unlocked: [] })
    expect(r.body).toBe('Tap to see your stats')
  })
})

describe('buildGoalPush', () => {
  it('weekly goal copy', () => {
    const r = buildGoalPush({ goal: { id: 'g1', target_value: 500 }, def: { unit: 'points', period: 'week' } })
    expect(r.title).toBe('Goal smashed — 500 points this week')
    expect(r.body).toBe('Weekly target complete. Nice work.')
    expect(r.data).toEqual({ type: 'goal', goal_id: 'g1' })
  })
  it('monthly goal copy', () => {
    const r = buildGoalPush({ goal: { id: 'g2', target_value: 16 }, def: { unit: 'classes', period: 'month' } })
    expect(r.title).toBe('Goal smashed — 16 classes this month')
    expect(r.body).toBe('Monthly target complete. Nice work.')
  })
})

describe('buildStreakAtRiskPush', () => {
  it('names the streak length', () => {
    const r = buildStreakAtRiskPush({ streak: 5 })
    expect(r.title).toBe('Keep the 5-day streak alive')
    expect(r.body).toBe("Train today so you don't lose it.")
    expect(r.data).toEqual({ type: 'streak_at_risk' })
  })
})

describe('periodKey', () => {
  it('month key', () => {
    expect(periodKey('month', new Date('2026-06-20T12:00:00Z').getTime())).toBe('2026-06')
  })
  it('ISO week key', () => {
    expect(periodKey('week', new Date('2026-06-20T12:00:00Z').getTime())).toBe('2026-W25')
  })
})

describe('streakAtRisk', () => {
  const N = new Date('2026-06-20T18:00:00Z').getTime()
  const dayAgo = (n) => new Date(N - n * 24 * 3600 * 1000).toISOString()
  it('flags a >=3 run ending yesterday with nothing today', () => {
    const ss = [{ started_at: dayAgo(1) }, { started_at: dayAgo(2) }, { started_at: dayAgo(3) }]
    expect(streakAtRisk(ss, N, 3)).toBe(3)
  })
  it('does not flag if they already trained today', () => {
    const ss = [{ started_at: dayAgo(0) }, { started_at: dayAgo(1) }, { started_at: dayAgo(2) }]
    expect(streakAtRisk(ss, N, 3)).toBe(0)
  })
  it('does not flag a run below the threshold', () => {
    const ss = [{ started_at: dayAgo(1) }, { started_at: dayAgo(2) }]
    expect(streakAtRisk(ss, N, 3)).toBe(0)
  })
  it('does not flag a streak already broken (last session 2 days ago)', () => {
    const ss = [{ started_at: dayAgo(2) }, { started_at: dayAgo(3) }, { started_at: dayAgo(4) }]
    expect(streakAtRisk(ss, N, 3)).toBe(0)
  })
})
