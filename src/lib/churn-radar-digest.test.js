// Tests for churn-radar-digest.js — pure email composition.

import { describe, it, expect } from 'vitest'
import { buildDigestEmail } from './churn-radar-digest.js'

const summary = {
  activeBase: 268, atRisk: 40, highRisk: 12, overdue: 11,
  paused: 17, quarantine: 5, revenueAtRiskCents: 80000, overdueValueCents: 19000,
  recovery: { contacted: 40, recovered: 18, recoveryRate: 0.45 },
  trend: { since: '2026-05-15T06:00:00.000Z', deltas: { activeBase: -4, atRisk: 2, overdue: 3 } },
}

describe('RADAR-DIGEST.1 — buildDigestEmail', () => {
  it('returns a subject naming the location and an HTML body', () => {
    const { subject, html } = buildDigestEmail(summary, [], { locationName: 'UN1T Stillorgan' })
    expect(subject).toContain('UN1T Stillorgan')
    expect(html).toContain('weekly digest')
    expect(html).toContain('Active base')
  })

  it('renders the current value for each metric', () => {
    const { html } = buildDigestEmail(summary, [])
    expect(html).toContain('268')          // active base
    expect(html).toContain('€800')         // revenue at risk, 80000 cents
  })

  it('shows the week-over-week change when a trend is present', () => {
    const { html } = buildDigestEmail(summary, [])
    expect(html).toContain('▼ 4')          // activeBase delta -4
    expect(html).toContain('▲ 2')          // atRisk delta +2
  })

  it('renders the recent-weeks trail from snapshot history', () => {
    const history = [
      { active_base: 285 }, { active_base: 280 }, { active_base: 272 },
    ]
    const { html } = buildDigestEmail(summary, history)
    expect(html).toContain('285 → 280 → 272')
  })

  it('includes the recovery line when there has been outreach', () => {
    const { html } = buildDigestEmail(summary, [])
    expect(html).toContain('18 of 40')
    expect(html).toContain('45%')
  })

  it('omits the recovery line when nobody has been contacted', () => {
    const { html } = buildDigestEmail({ ...summary, recovery: { contacted: 0, recovered: 0, recoveryRate: 0 } }, [])
    expect(html).not.toContain('Outreach effectiveness')
  })

  it('includes a radar link when a URL is given', () => {
    const { html } = buildDigestEmail(summary, [], { radarUrl: 'https://crm.un1t.ie/churn-radar' })
    expect(html).toContain('https://crm.un1t.ie/churn-radar')
  })

  it('handles a missing trend + empty history gracefully', () => {
    const { html } = buildDigestEmail({ activeBase: 5, recovery: {} }, [])
    expect(html).toContain('Active base')
    expect(html).toContain('—')            // no-delta / empty-trail marker
  })
})
