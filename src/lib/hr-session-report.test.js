import { describe, it, expect } from 'vitest'
import fixture from './__fixtures__/session-report.fixture.json'
import { buildSessionReport, SESSION_REPORT_VERSION, buildNextAction, DEFAULT_BOOK_CTA, DEFAULT_JOIN_CTA } from './hr-session-report.js'

describe('buildSessionReport', () => {
  const report = buildSessionReport(fixture.ctx, { nowMs: fixture.nowMs })

  it('stamps the version envelope', () => {
    expect(SESSION_REPORT_VERSION).toBe(1)
    expect(report.version).toBe(1)
  })

  it('builds the session block with duration + class', () => {
    expect(report.session.id).toBe('s-now')
    expect(report.session.duration_seconds).toBe(1800)
    expect(report.session.source).toBe('ble_bridge')
    expect(report.session.class).toEqual({ event_type_id: 'et-ride', name: 'RIDE', category: 'cardio' })
  })

  it('summarises points + zones (5 zones, percents sum to ~1)', () => {
    expect(report.summary.effort_points).toBe(300)
    expect(report.summary.max_hr_used).toBe(190)
    expect(report.summary.zones).toHaveLength(5)
    expect(report.summary.zones[2]).toMatchObject({ id: 3, name: 'Aerobic' })
    const pctSum = report.summary.zones.reduce((a, z) => a + z.percent, 0)
    expect(pctSum).toBeCloseTo(1, 5)
  })

  it('maps the recent + peak trends (both up, enough data)', () => {
    expect(report.comparisons.vs_recent).toMatchObject({ field: 'effort_points', direction: 'up', has_enough_data: true })
    expect(report.comparisons.vs_recent_peak).toMatchObject({ field: 'peak_hr_bpm', has_enough_data: true })
  })

  it('maps the this-class comparison', () => {
    expect(report.comparisons.vs_this_class).toEqual({
      event_type_name: 'RIDE', mean_points: 237, percentile: 1, sample_size: 3,
    })
  })

  it('maps the category comparison (all history is cardio)', () => {
    expect(report.comparisons.vs_category).toEqual({
      category: 'cardio', mean_points: 237, percentile: 1, sample_size: 3,
    })
  })

  it('picks the highlight (first time in Z5)', () => {
    expect(report.highlight.id).toBe('first_z5')
    expect(report.highlight.message).toMatch(/red zone/i)
  })

  it('maps achievements', () => {
    expect(report.achievements).toEqual([
      { slug: 'first_red', name: 'Into the Red', icon: 'Flame', earned_at: '2026-06-18T11:30:05.000Z' },
    ])
  })

  it('fills next_action for an active member (book branch)', () => {
    expect(report.next_action).toEqual({ type: 'book_class', label: 'Book your next class', url: 'https://book.example/ride' })
  })

  it('is JSON-serialisable (surface-agnostic)', () => {
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow()
  })

  it('degrades safely when no cta (no next_action)', () => {
    const r = buildSessionReport(
      { ...fixture.ctx, cta: undefined },
      { nowMs: fixture.nowMs },
    )
    expect(r.next_action).toBeNull()
  })

  it('degrades safely with no history (first ever)', () => {
    const r = buildSessionReport(
      { ...fixture.ctx, history: [], achievements: [] },
      { nowMs: fixture.nowMs },
    )
    expect(r.comparisons.vs_recent.has_enough_data).toBe(false)
    expect(r.comparisons.vs_this_class.sample_size).toBe(0)
    expect(r.achievements).toEqual([])
  })
})

describe('buildNextAction', () => {
  const base = { stage: 'active_member', bookingUrl: 'https://b', bookingLabel: 'Book', membershipSignupUrl: 'https://j', membershipLabel: 'Join' }
  it('members → book_class with custom label', () => {
    expect(buildNextAction(base)).toEqual({ type: 'book_class', label: 'Book', url: 'https://b' })
  })
  it('at_risk_member counts as a member', () => {
    expect(buildNextAction({ ...base, stage: 'at_risk_member' }).type).toBe('book_class')
  })
  it('prospect → join', () => {
    expect(buildNextAction({ ...base, stage: 'active_trial' })).toEqual({ type: 'join', label: 'Join', url: 'https://j' })
  })
  it('null/unknown stage → join', () => {
    expect(buildNextAction({ ...base, stage: null }).type).toBe('join')
  })
  it('blank label → default copy', () => {
    expect(buildNextAction({ ...base, bookingLabel: '' }).label).toBe(DEFAULT_BOOK_CTA)
    expect(buildNextAction({ ...base, stage: 'lapsed', membershipLabel: null }).label).toBe(DEFAULT_JOIN_CTA)
  })
  it('chosen branch URL unset → null', () => {
    expect(buildNextAction({ ...base, bookingUrl: null })).toBeNull()
    expect(buildNextAction({ ...base, stage: 'lapsed', membershipSignupUrl: null })).toBeNull()
  })
  it('null cta → null', () => {
    expect(buildNextAction(null)).toBeNull()
  })
})
