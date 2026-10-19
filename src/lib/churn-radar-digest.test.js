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
    expect(html).toContain('Weekly radar digest')
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

// LEAD-DIGEST.1 — the Lead Radar funnel folded into the same email.
const leadSummary = {
  funnelTotal: 52,
  funnel: { attending: 14, fresh: 38 },
  cleanupTotal: 120,
  conversion: { contacted: 30, progressed: 12, progressionRate: 0.4 },
  trend: {
    since: '2026-05-15T06:30:00.000Z',
    deltas: { funnelTotal: 6, attending: 3, fresh: 3, cleanupTotal: -9 },
  },
}

describe('LEAD-DIGEST.1 — Lead Radar section', () => {
  it('renders a Lead Radar section when opts.lead is supplied', () => {
    const { html } = buildDigestEmail(summary, [], { lead: { summary: leadSummary, history: [] } })
    expect(html).toContain('Lead radar')
    expect(html).toContain('Funnel total')
    expect(html).toContain('Fresh leads')
    expect(html).toContain('Cleanup queue')
  })

  it('omits the Lead Radar section when no lead data is supplied', () => {
    const { html } = buildDigestEmail(summary, [])
    expect(html).not.toContain('Lead radar')
    expect(html).not.toContain('Funnel total')
  })

  it('renders the current value for each lead metric', () => {
    const { html } = buildDigestEmail(summary, [], { lead: { summary: leadSummary, history: [] } })
    expect(html).toContain('52')           // funnel total
    expect(html).toContain('38')           // fresh leads
    expect(html).toContain('120')          // cleanup queue
  })

  it('shows the week-over-week change for lead metrics', () => {
    const { html } = buildDigestEmail(summary, [], { lead: { summary: leadSummary, history: [] } })
    expect(html).toContain('▲ 6')          // funnelTotal delta +6
    expect(html).toContain('▼ 9')          // cleanupTotal delta -9
  })

  it('renders the recent-weeks trail from lead snapshot history', () => {
    const history = [
      { funnel_total: 40 }, { funnel_total: 46 }, { funnel_total: 49 },
    ]
    const { html } = buildDigestEmail(summary, [], { lead: { summary: leadSummary, history } })
    expect(html).toContain('40 → 46 → 49')
  })

  it('includes the follow-up effectiveness line when leads were contacted', () => {
    const { html } = buildDigestEmail(summary, [], { lead: { summary: leadSummary, history: [] } })
    expect(html).toContain('12 of 30')
    expect(html).toContain('40%')
  })

  it('omits the follow-up line when no leads have been contacted', () => {
    const noConv = { ...leadSummary, conversion: { contacted: 0, progressed: 0, progressionRate: 0 } }
    const { html } = buildDigestEmail(summary, [], { lead: { summary: noConv, history: [] } })
    expect(html).not.toContain('Follow-up effectiveness')
  })

  it('includes a lead radar link when leadRadarUrl is given', () => {
    const { html } = buildDigestEmail(summary, [], {
      lead: { summary: leadSummary, history: [] },
      leadRadarUrl: 'https://crm.un1t.ie/lead-radar',
    })
    expect(html).toContain('https://crm.un1t.ie/lead-radar')
  })

  it('does not link the lead radar when there is no lead section', () => {
    const { html } = buildDigestEmail(summary, [], { leadRadarUrl: 'https://crm.un1t.ie/lead-radar' })
    expect(html).not.toContain('lead-radar')
  })
})

// UN1TRADAR.2 — a un1t.online studio: arrears it cannot read say so, never 0;
// an estimated total is labelled.
describe('buildDigestEmail at a un1t.online studio', () => {
  const base = { activeBase: 10, atRisk: 1, highRisk: 0, overdue: 2, paused: 0, quarantine: 0, revenueAtRiskCents: 0, overdueValueCents: 16500 }
  it('digest renders the not-available line and never "0" for null unpaid counts', () => {
    const { html } = buildDigestEmail({ ...base, unpaidCharges: null, unpaidChargesValueCents: null, awaitingAuth: null, awaitingAuthValueCents: null })
    expect(html).toContain('Unpaid charges and awaiting authorization: not available from un1t.online')
  })
  it('digest Overdue value says "includes an estimate" when estimated', () => {
    const { html } = buildDigestEmail({ ...base, overdueValueEstimated: true })
    expect(html).toContain('€165, includes an estimate')
  })
  it('a Glofox summary renders exactly as before (no new line, no label)', () => {
    const glofox = { ...base, unpaidCharges: 3, unpaidChargesValueCents: 900, awaitingAuth: 0, awaitingAuthValueCents: 0 }
    const { html } = buildDigestEmail(glofox)
    expect(html).not.toContain('not available from un1t.online')
    expect(html).not.toContain('includes an estimate')
    expect(html).toContain('€165')
  })
})
