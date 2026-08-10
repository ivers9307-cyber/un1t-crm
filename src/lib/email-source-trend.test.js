// REPORT-SOT.1 — non-campaign email deliverability.
//
// These tests pin the one thing that makes this panel honest: at the volume
// this estate actually sends outside campaigns, a RATE IS NOT AVAILABLE, and
// the panel must say what it has (counts) rather than print "Not enough sends"
// in every cell of an otherwise empty chart.
//
// Measured live 2026-08-10 on email_sends:
//
//     source_type      rows    bounces  opens  complaints  span
//     campaign        19,095       217  7,786           1  2026-05-13 .. 2026-08-09
//     transactional      111         3     90           0  2026-06-17 .. 2026-08-10
//     inbox_reply          1         0      0           0  2026-08-07
//
// There are ZERO 'sequence' rows — the value does not occur, because the
// estate has one active sequence. So the whole non-campaign side is 111
// emails and 3 bounces against a 500-send floor.
//
// The switchover test is the load-bearing one: the SAME builder, fed a month
// that clears the floor, must produce the rate and its band with no flag to
// set and no second path.

import { describe, it, expect } from 'vitest'
import { MIN_RATE_SENDS } from './list-health-trend.js'
import {
  CAMPAIGN_SOURCE_TYPE,
  sourceTypeLabel,
  countsLabel,
  buildEmailSourceTrend,
} from './email-source-trend.js'

// The RPC returns one row per (month, source_type) across the whole grid, with
// numeric rates serialised by PostgREST as STRINGS. Both facts are modelled.
function row(month, source_type, o = {}) {
  const sends = o.sends ?? 0
  const bounces = o.bounces ?? 0
  const complaints = o.complaints ?? 0
  const opens = o.opens ?? 0
  const rate = (hits) => (sends > 0 ? (hits / sends).toFixed(6) : null)
  return {
    month,
    source_type,
    sends,
    bounces,
    hard_bounces: o.hard_bounces ?? 0,
    complaints,
    opens,
    bounce_rate: rate(bounces),
    complaint_rate: rate(complaints),
    open_rate: rate(opens),
  }
}

// The live picture, as the RPC would return it for a 4-month window.
// transactional: 111 sends / 3 bounces / 90 opens spread over Jun-Aug.
// inbox_reply: the single 2026-08-07 row. campaign: the 19,095-row bulk, which
// the builder must exclude — it is already on the campaign table above it.
const LIVE = [
  row('2026-05-01', 'campaign', { sends: 2998, bounces: 36, opens: 777 }),
  row('2026-06-01', 'campaign', { sends: 9739, bounces: 122, opens: 4512 }),
  row('2026-07-01', 'campaign', { sends: 137, bounces: 1, opens: 105 }),
  row('2026-08-01', 'campaign', { sends: 6221, bounces: 58, opens: 2392, complaints: 1 }),

  row('2026-05-01', 'transactional', { sends: 0 }),
  row('2026-06-01', 'transactional', { sends: 14, bounces: 1, opens: 11 }),
  row('2026-07-01', 'transactional', { sends: 46, bounces: 1, opens: 38 }),
  row('2026-08-01', 'transactional', { sends: 51, bounces: 1, opens: 41 }),

  row('2026-05-01', 'inbox_reply', { sends: 0 }),
  row('2026-06-01', 'inbox_reply', { sends: 0 }),
  row('2026-07-01', 'inbox_reply', { sends: 0 }),
  row('2026-08-01', 'inbox_reply', { sends: 1 }),
]

describe('buildEmailSourceTrend — the live shape, which is counts', () => {
  const trend = buildEmailSourceTrend(LIVE)

  it('excludes campaign email, which already has its own table', () => {
    expect(trend.sources.map((s) => s.source_type)).not.toContain(CAMPAIGN_SOURCE_TYPE)
    expect(trend.excluded).toEqual([CAMPAIGN_SOURCE_TYPE])
  })

  it('never invents a sequence row, because there are none', () => {
    expect(trend.sources.map((s) => s.source_type)).toEqual(['transactional', 'inbox_reply'])
  })

  it('totals the whole non-campaign side to the measured 111 sends and 3 bounces', () => {
    expect(trend.totals.sends).toBe(112)
    expect(trend.totals.bounces).toBe(3)
    expect(trend.totals.opens).toBe(90)
    expect(trend.totals.complaints).toBe(0)
  })

  it('refuses a rate on that denominator and offers the counts instead', () => {
    const tx = trend.sources.find((s) => s.source_type === 'transactional')
    expect(tx.sends).toBe(111)
    expect(tx.rates_readable).toBe(false)
    expect(tx.bounce_reading.level).toBe('low_volume')
    expect(tx.bounce_reading.text).toBe('Too few sends to read a rate.')
    // The counts are the content of the cell, not a footnote under a blank.
    expect(tx.counts_label).toBe('111 sends, 3 bounces')
  })

  it('pools the whole period and still cannot read a rate', () => {
    expect(trend.totals.rates_readable).toBe(false)
    expect(trend.totals.counts_label).toBe('112 sends, 3 bounces')
  })

  it('drops months in which a source sent nothing, and says how many', () => {
    const tx = trend.sources.find((s) => s.source_type === 'transactional')
    expect(tx.months.map((m) => m.month)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01'])
    expect(tx.months_with_sends).toBe(3)
    expect(trend.window.months).toBe(4)
    const reply = trend.sources.find((s) => s.source_type === 'inbox_reply')
    expect(reply.months_with_sends).toBe(1)
    expect(reply.counts_label).toBe('1 send, 0 bounces')
  })

  it('labels a month the way the campaign table does', () => {
    const tx = trend.sources.find((s) => s.source_type === 'transactional')
    expect(tx.months[0].label).toBe('Jun 2026')
    expect(trend.window.from).toBe('May 2026')
    expect(trend.window.to).toBe('Aug 2026')
  })

  it('orders sources by volume so the one carrying the risk is first', () => {
    expect(trend.sources[0].source_type).toBe('transactional')
  })
})

describe('buildEmailSourceTrend — the switchover, with no second code path', () => {
  // The SAME builder, the same source type, one month that clears the floor.
  // 5,000 sends and 150 bounces is 3%: over the 2% warning band, under the 5%
  // serious one.
  const HIGH = [
    row('2026-08-01', 'transactional', { sends: 5000, bounces: 150, opens: 1200, complaints: 2 }),
  ]
  const trend = buildEmailSourceTrend(HIGH)
  const tx = trend.sources[0]
  const month = tx.months[0]

  it('reads the rate once the denominator carries it', () => {
    expect(month.sends).toBeGreaterThanOrEqual(MIN_RATE_SENDS)
    expect(month.rates_readable).toBe(true)
    expect(month.bounce_rate).toBeCloseTo(0.03, 6)
  })

  it('shows the band, using the same helper the campaign table uses', () => {
    expect(month.bounce_reading.level).toBe('warn')
    expect(month.bounce_reading.text).toBe('Over the 2% warning level.')
  })

  it('reads the open rate too, instead of the not-enough-sends placeholder', () => {
    expect(month.open_rate_label).toBe('24.0%')
  })

  it('still carries the counts, so nothing is lost by crossing the floor', () => {
    expect(month.counts_label).toBe('5,000 sends, 150 bounces')
  })

  it('applies the complaint band on its own larger denominator', () => {
    // 2 complaints on 5,000 is 0.04%: under the 0.1% warning level, and the
    // 1,000-send minimum for the complaint band is cleared.
    expect(month.complaint_reading.level).toBe('ok')
  })
})

describe('buildEmailSourceTrend — the boundary and the awkward inputs', () => {
  it('switches on exactly at the floor, not one send later', () => {
    const at = buildEmailSourceTrend([row('2026-08-01', 'transactional', { sends: MIN_RATE_SENDS, bounces: 1 })])
    expect(at.sources[0].months[0].rates_readable).toBe(true)
    const under = buildEmailSourceTrend([row('2026-08-01', 'transactional', { sends: MIN_RATE_SENDS - 1, bounces: 1 })])
    expect(under.sources[0].months[0].rates_readable).toBe(false)
  })

  it('coerces the numeric rates PostgREST serialises as strings', () => {
    const t = buildEmailSourceTrend([row('2026-08-01', 'transactional', { sends: 5000, bounces: 150 })])
    expect(typeof t.sources[0].months[0].bounce_rate).toBe('number')
  })

  it('falls back to the counts when the RPC returned a null rate', () => {
    const t = buildEmailSourceTrend([
      { month: '2026-08-01', source_type: 'transactional', sends: 5000, bounces: 150, opens: 0, complaints: 0, bounce_rate: null, complaint_rate: null, open_rate: null },
    ])
    expect(t.sources[0].months[0].bounce_rate).toBeCloseTo(0.03, 6)
  })

  it('returns an empty trend for no rows rather than throwing', () => {
    const t = buildEmailSourceTrend(null)
    expect(t.sources).toEqual([])
    expect(t.totals.sends).toBe(0)
    expect(t.window.months).toBe(0)
  })

  it('returns an empty trend when campaign email is all there is', () => {
    const t = buildEmailSourceTrend([row('2026-08-01', 'campaign', { sends: 6221, bounces: 58 })])
    expect(t.sources).toEqual([])
  })

  it('names a source type nobody has labelled rather than dropping it', () => {
    const t = buildEmailSourceTrend([row('2026-08-01', 'glofox_sync_2027', { sends: 4 })])
    expect(t.sources[0].source_type).toBe('glofox_sync_2027')
    expect(t.sources[0].label).toBe('glofox_sync_2027')
    expect(t.sources[0].unlabelled).toBe(true)
  })
})

describe('the copy', () => {
  it('singularises one send and one bounce', () => {
    expect(countsLabel(1, 1)).toBe('1 send, 1 bounce')
    expect(countsLabel(0, 0)).toBe('0 sends, 0 bounces')
  })

  it('labels the known source types in operator language', () => {
    expect(sourceTypeLabel('transactional')).toBe('Confirmations and receipts')
    expect(sourceTypeLabel('sequence')).toBe('Automated sequences')
    expect(sourceTypeLabel('inbox_reply')).toBe('Replies from the inbox')
  })

  it('carries no em-dash anywhere it generates text', () => {
    const t = buildEmailSourceTrend(LIVE)
    const text = JSON.stringify(t)
    expect(text).not.toContain('—')
  })
})
