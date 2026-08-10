// GAPS-P7 — the trend surface. Rendered to static markup (this repo runs
// vitest under the node environment; the component is a server component with
// no client JavaScript, so static markup is exactly what ships).
//
// The assertions are about HONESTY, not layout: the 5,519-row May import must
// never reach the headline but must still be visible on the page, July's
// 76.64% open rate on 137 sends must not reach the screen as a percentage,
// August's must, an unclassified source must be named, and no reading may
// carry an em-dash.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ListHealthTrend from './ListHealthTrend.jsx'
import { buildListHealthTrend } from '@/lib/list-health-trend'

// The four live months as measured at Stillorgan. Send-side figures and the
// one-click / hard bounce / complaint splits are measured; the remaining
// voluntary rows and the auto_classpass rows are distributed for the fixture.
// Column totals are exact: 36 counted opt-ins, 146 counted departures, 5,521
// bulk rows, 82 policy rows.
const LIVE = [
  {
    month: '2026-05-01', campaigns: 1, sends: 2998, bounces: 31, hard_bounces: 0, complaints: 0, opens: 777,
    bounce_rate: 0.010340, open_rate: 0.259172, complaint_rate: 0,
    opt_ins_counted: 2, opt_ins_bulk: 0,
    unsubscribes_counted: 28, unsub_voluntary: 28, unsub_deliverability: 0,
    unsub_policy: 12, unsub_bulk: 5519, consent_unknown: 0, unknown_sources: [],
  },
  {
    month: '2026-06-01', campaigns: 6, sends: 9739, bounces: 122, hard_bounces: 16, complaints: 0, opens: 4512,
    bounce_rate: 0.012527, open_rate: 0.463293, complaint_rate: 0,
    opt_ins_counted: 8, opt_ins_bulk: 0,
    unsubscribes_counted: 60, unsub_voluntary: 44, unsub_deliverability: 16,
    unsub_policy: 30, unsub_bulk: 0, consent_unknown: 0, unknown_sources: [],
  },
  {
    month: '2026-07-01', campaigns: 3, sends: 137, bounces: 1, hard_bounces: 0, complaints: 0, opens: 105,
    bounce_rate: 0.007299, open_rate: 0.766423, complaint_rate: 0,
    opt_ins_counted: 20, opt_ins_bulk: 0,
    unsubscribes_counted: 12, unsub_voluntary: 12, unsub_deliverability: 0,
    unsub_policy: 25, unsub_bulk: 0, consent_unknown: 0, unknown_sources: [],
  },
  {
    month: '2026-08-01', campaigns: 4, sends: 6221, bounces: 74, hard_bounces: 2, complaints: 1, opens: 2104,
    bounce_rate: 0.011895, open_rate: 0.338209, complaint_rate: 0.000161,
    opt_ins_counted: 6, opt_ins_bulk: 0,
    unsubscribes_counted: 46, unsub_voluntary: 43, unsub_deliverability: 3,
    unsub_policy: 15, unsub_bulk: 2, consent_unknown: 0, unknown_sources: [],
  },
]

const render = (rows) => renderToStaticMarkup(<ListHealthTrend trend={buildListHealthTrend(rows)} />)
const html = () => render(LIVE)

describe('ListHealthTrend', () => {
  it('leads with the net list change, negative and unhedged', () => {
    expect(html()).toContain('-110')
  })

  it('never lets the May import reach the headline', () => {
    const out = html()
    // The blind sum was -5,534 for May and -5,631 for the window.
    expect(out).not.toContain('-5,534')
    expect(out).not.toContain('-5,631')
  })

  it('still shows the import on the page, with its reason', () => {
    const out = html()
    expect(out).toContain('5,519')
    expect(out).toContain('Recorded, but not counted as leaving')
    expect(out).toContain('One-off updates')
  })

  it('shows the ClassPass exclusions separately from departures', () => {
    const out = html()
    expect(out).toContain('ClassPass rule')
    expect(out).toContain('82')
  })

  it('names an unclassified source instead of absorbing it', () => {
    const out = render([{ ...LIVE[3], consent_unknown: 3, unknown_sources: ['glofox_sync_2027'] }])
    expect(out).toContain('glofox_sync_2027')
    expect(out).toContain('Unclassified')
  })

  it('drops the excluded table entirely when there is nothing in it', () => {
    const clean = LIVE.map((m) => ({ ...m, unsub_policy: 0, unsub_bulk: 0, opt_ins_bulk: 0, consent_unknown: 0 }))
    expect(render(clean)).not.toContain('Recorded, but not counted as leaving')
  })

  it('never prints July\'s 76.6% open rate', () => {
    const out = html()
    // The percent sign matters: 76.6 on its own also matches a bar width.
    expect(out).not.toContain('76.6%')
    expect(out).toContain('Not enough sends')
    // The counts behind it are still on screen.
    expect(out).toContain('137')
    expect(out).toContain('105')
  })

  it('prints August\'s rates, which have the denominator to carry them', () => {
    const out = html()
    expect(out).toContain('33.8%')
    expect(out).toContain('1.19%')
  })

  it('labels the send column for what it actually counts', () => {
    const out = html()
    expect(out).toContain('Campaign sends')
    expect(out).toMatch(/sequence email|sequence/i)
  })

  it('states the deliverability bands without inventing a sector benchmark', () => {
    const out = html()
    expect(out).toContain('over 2%')
    expect(out).toContain('0.1%')
    expect(out).not.toMatch(/industry average|benchmark/i)
  })

  it('draws its bars with CSS widths, not a chart library', () => {
    expect(html()).toMatch(/style="width:\d/)
  })

  it('carries no em-dash and no emoji in the operator copy', () => {
    const out = html()
    expect(out).not.toMatch(/[—–]/)
    expect(out).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it('says so plainly when a studio has no history at all', () => {
    expect(render([])).toContain('No sends or consent changes recorded')
  })

  it('says the same rather than rendering a grid of zeroes', () => {
    // The RPC always returns the current month, so an inactive studio arrives
    // as one empty row, not as an empty array.
    const blank = ['2026-07-01', '2026-08-01'].map((month) => ({
      month, campaigns: 0, sends: 0, bounces: 0, hard_bounces: 0, complaints: 0, opens: 0,
      bounce_rate: null, complaint_rate: null, open_rate: null,
      opt_ins_counted: 0, opt_ins_bulk: 0, unsubscribes_counted: 0,
      unsub_voluntary: 0, unsub_deliverability: 0, unsub_policy: 0, unsub_bulk: 0,
      consent_unknown: 0, unknown_sources: [],
    }))
    expect(render(blank)).toContain('No sends or consent changes recorded')
  })
})
