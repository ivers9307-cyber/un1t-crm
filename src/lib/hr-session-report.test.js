import { describe, it, expect } from 'vitest'
import fixture from './__fixtures__/session-report.fixture.json'
import { buildSessionReport, SESSION_REPORT_VERSION, buildNextAction, DEFAULT_JOIN_CTA } from './hr-session-report.js'

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

  it('flags the Burn + Zone 4+ minutes from zones_seconds', () => {
    // Fixture zones_seconds: Z4=600 + Z5=300 = 900s ≥ 720s → Burn earned;
    // 900/60 = 15 Zone-4+ minutes. Computed from the helper, not the fixture.
    expect(report.summary.burn).toBe(true)
    expect(report.summary.z4plus_minutes).toBe(15)
  })

  // PAIRSYNC.1 — ported from shared/hr-session-report.test.js, which had both
  // of these and this file did not. The module itself is byte-identical
  // between the two copies and both assert against the same fixture, so the
  // web suite was simply testing less: only the ABOVE-threshold case was
  // covered here, i.e. nothing pinned the Burn boolean actually going false.
  it('no Burn when Zone 4+ is under 12 min', () => {
    const r = buildSessionReport(
      {
        ...fixture.ctx,
        session: { ...fixture.ctx.session, zones_seconds: { 4: 300, 5: 60 } }, // 6 min
      },
      { nowMs: fixture.nowMs },
    )
    expect(r.summary.burn).toBe(false)
    expect(r.summary.z4plus_minutes).toBe(6)
  })

  it('degrades safely with missing zones (no Burn, z4plus 0)', () => {
    const r = buildSessionReport(
      { ...fixture.ctx, session: { ...fixture.ctx.session, zones_seconds: null } },
      { nowMs: fixture.nowMs },
    )
    expect(r.summary.burn).toBe(false)
    expect(r.summary.z4plus_minutes).toBe(0)
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

  it('gives an active member NO next_action (Pulse stays out of booking)', () => {
    // Fixture cta.stage is active_member — the report must not surface a
    // book-class (or any) CTA to members. Glofox owns booking.
    expect(report.next_action).toBeNull()
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
  // Merge of FUNNEL.1 slugs × the Pulse-scope rule (members get NO
  // next-action — booking stays in the Glofox member app).
  const base = { stage: 'member', membershipSignupUrl: 'https://j', membershipLabel: 'Join' }
  it('members → no next-action (Pulse stays out of booking)', () => {
    expect(buildNextAction(base)).toBeNull()
  })
  it('recently converted (FUNNEL.1 converted stage) counts as a member → null', () => {
    expect(buildNextAction({ ...base, stage: 'converted' })).toBeNull()
  })
  it('prospect → join with custom label', () => {
    expect(buildNextAction({ ...base, stage: 'first_class' })).toEqual({ type: 'join', label: 'Join', url: 'https://j' })
  })
  it('null/unknown stage → join', () => {
    expect(buildNextAction({ ...base, stage: null }).type).toBe('join')
  })
  it('blank membership label → default copy', () => {
    expect(buildNextAction({ ...base, stage: 'lapsed', membershipLabel: null }).label).toBe(DEFAULT_JOIN_CTA)
  })
  it('join URL unset → null', () => {
    expect(buildNextAction({ ...base, stage: 'lapsed', membershipSignupUrl: null })).toBeNull()
  })
  it('null cta → null', () => {
    expect(buildNextAction(null)).toBeNull()
  })
})
