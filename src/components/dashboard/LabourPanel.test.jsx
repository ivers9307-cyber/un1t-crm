// LABOUR.1 — what the owner's labour block puts in the markup. Rendered to
// static markup in the node environment (no jsdom), like RosterRunwayChip.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LabourPanel } from './LabourPanel'

const part = (employees, contractors, hours) => ({
  employees_cents: employees, contractors_cents: contractors, cost_cents: employees + contractors, hours,
})
const STILL = {
  location_id: 'loc-still', name: 'UN1T Stillorgan',
  revenue_status: 'tracked', mrr_cents: 1_000_000, recurring_members: 191, revenue_to_date_cents: 500_000,
  forecast: part(325_000, 9_000, 7), actual: part(162_500, 6_000, 6),
  forecast_pct: 33.4, actual_pct: 33.7, draft_hours: 1,
}
const HATCH = {
  location_id: 'loc-hatch', name: 'UN1T Hatch Street',
  revenue_status: 'none', mrr_cents: null, recurring_members: null, revenue_to_date_cents: null,
  forecast: part(175_000, 5_426, 3), actual: part(87_500, 5_426, 2),
  forecast_pct: null, actual_pct: null, draft_hours: 0,
}
const VM = {
  month: '2026-09', month_label: 'September 2026', day_of_month: 16, days_in_month: 30,
  studios: [STILL, HATCH],
  total: {
    name: 'All studios shown', revenue_status: 'tracked', mrr_cents: 1_000_000, recurring_members: 191,
    revenue_to_date_cents: 500_000, forecast: part(500_000, 14_426, 10), actual: part(250_000, 11_426, 8),
    forecast_pct: 33.4, actual_pct: 33.7, draft_hours: 1, ratio_excludes: [{ name: 'UN1T Hatch Street', status: 'none' }],
    ratio_base: { studios: ['UN1T Stillorgan'], forecast_cost_cents: 334_000, actual_cost_cents: 168_500 },
  },
  uncosted: [{ name: 'Sam Demo', reason: 'no_salary', hours: 1 }],
  untimed_shifts: 0,
}

const html = (vm = VM) => renderToStaticMarkup(<LabourPanel vm={vm} />)

describe('LabourPanel', () => {
  it('heads the block with the month and the day', () => {
    expect(html()).toContain('Labour against revenue · September 2026')
    expect(html()).toContain('Day 16 of 30')
  })

  it('shows each studio: forecast and so far, in euros and as a share of revenue', () => {
    const out = html()
    expect(out).toContain('UN1T Stillorgan')
    expect(out).toContain('€3,340')
    expect(out).toContain('33.4%')
    expect(out).toContain('€1,685')
    expect(out).toContain('33.7%')
    expect(out).toContain('€10,000/month recurring (MRR), 191 members')
  })

  it('a studio with no revenue says so and shows no percentage', () => {
    const out = html({ ...VM, studios: [HATCH], total: null })
    expect(out).toContain('Not tracked here')
    expect(out).not.toContain('%')
  })

  it('an unreadable revenue says so', () => {
    expect(html({ ...VM, studios: [{ ...HATCH, revenue_status: 'unavailable' }], total: null })).toContain('Could not be read')
  })

  it('the total, and which studios its ratios leave out, with why', () => {
    const out = html()
    expect(out).toContain('All studios shown')
    expect(out).toContain('Ratios leave out UN1T Hatch Street (no revenue tracked there).')
  })

  it('an excluded studio whose revenue could not be read says so, and a total with no revenue read says "Could not be read"', () => {
    const total = {
      ...VM.total, revenue_status: 'unavailable', mrr_cents: null, recurring_members: null, revenue_to_date_cents: null,
      forecast_pct: null, actual_pct: null, ratio_base: null,
      ratio_excludes: [{ name: 'UN1T Stillorgan', status: 'unavailable' }, { name: 'UN1T Hatch Street', status: 'none' }],
    }
    const out = html({ ...VM, studios: [{ ...STILL, revenue_status: 'unavailable', forecast_pct: null, actual_pct: null }, HATCH], total })
    expect(out).toContain('No ratio: UN1T Stillorgan (revenue could not be read), UN1T Hatch Street (no revenue tracked there).')
    const totalCard = out.slice(out.indexOf('All studios shown'))
    expect(totalCard).toContain('Could not be read')
    expect(totalCard).not.toContain('Not tracked here')
  })

  it('the total never puts a subset ratio beside totals that include excluded studios: it names the base', () => {
    const out = html()
    expect(out).toContain('33.4% on UN1T Stillorgan: €3,340 of €10,000 MRR')
    expect(out).toContain('33.7% on UN1T Stillorgan: €1,685 of €5,000 to date')
    // "of revenue" appears on Stillorgan's own card only, never on the total's €5,144.
    expect(out.split('33.4% of revenue').length - 1).toBe(1)
    expect(out).not.toMatch(/€5,144[^<]*%/)
    expect(out).toContain('191 members, UN1T Stillorgan only')
  })

  it('a total with every studio tracked keeps its ratio beside the totals', () => {
    const total = { ...VM.total, ratio_excludes: [], ratio_base: null, forecast_pct: 34.3, actual_pct: 34.9 }
    const out = html({ ...VM, total })
    expect(out).toContain('34.3% of revenue')
    expect(out).not.toContain('Stillorgan only')
    expect(out).not.toContain('% on ')
  })

  it('names who worked with no pay on file, with hours and reason', () => {
    expect(html()).toContain('No pay on file, so not counted: Sam Demo (1h, no salary)')
  })

  it('a salaried person with no studio to charge is named on their own line, not as "no pay on file"', () => {
    const out = html({ ...VM, uncosted: [...VM.uncosted, { name: 'Max Beta', reason: 'no_studio', hours: 0 }] })
    expect(out).toContain('No pay on file, so not counted: Sam Demo (1h, no salary).')
    expect(out).toContain('Salary not counted (no active studio): Max Beta.')
    expect(out).not.toContain('no_studio')
    expect(out).not.toContain('Max Beta (0h')
  })

  it('says a salary is split across every organisation the person works for', () => {
    expect(html()).toContain('split between their studios in every organisation by rostered hours')
  })

  it('says how many draft hours the forecast leaves out, and any untimed shifts', () => {
    expect(html()).toContain('1h in draft rosters not counted')
    expect(html({ ...VM, untimed_shifts: 2 })).toContain('2 published shifts have no times and are not counted')
  })

  it('says what revenue means', () => {
    expect(html()).toContain('Class packs, drop-ins and one-off charges are not in it')
  })
})
