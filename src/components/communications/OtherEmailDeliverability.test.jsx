// REPORT-SOT.1 — the non-campaign deliverability panel.
//
// Rendered to static markup (this repo runs vitest under the node environment;
// the component is a server component with no client JavaScript, so static
// markup is exactly what ships).
//
// The assertions are about HONESTY, not layout. At the volume this estate
// actually sends outside campaigns — 111 emails and 3 bounces, measured
// 2026-08-10 — no cell may print a percentage, and no cell may be left blank
// or filled with a placeholder either: the counts ARE the content. And the
// SAME component, given a month that clears the 500-send floor, must print the
// rate and its band without anybody changing a setting.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import OtherEmailDeliverability from './OtherEmailDeliverability.jsx'
import { buildEmailSourceTrend } from '@/lib/email-source-trend'

function row(month, source_type, o = {}) {
  const sends = o.sends ?? 0
  const rate = (h) => (sends > 0 ? (h / sends).toFixed(6) : null)
  return {
    month,
    source_type,
    sends,
    bounces: o.bounces ?? 0,
    hard_bounces: o.hard_bounces ?? 0,
    complaints: o.complaints ?? 0,
    opens: o.opens ?? 0,
    bounce_rate: rate(o.bounces ?? 0),
    complaint_rate: rate(o.complaints ?? 0),
    open_rate: rate(o.opens ?? 0),
  }
}

// The live picture: 111 transactional sends over three months, one inbox
// reply, and the campaign bulk the panel must leave to the table above it.
const LIVE = [
  row('2026-05-01', 'campaign', { sends: 2998, bounces: 36, opens: 777 }),
  row('2026-08-01', 'campaign', { sends: 6221, bounces: 58, opens: 2392, complaints: 1 }),
  row('2026-05-01', 'transactional', { sends: 0 }),
  row('2026-06-01', 'transactional', { sends: 14, bounces: 1, opens: 11 }),
  row('2026-07-01', 'transactional', { sends: 46, bounces: 1, opens: 38 }),
  row('2026-08-01', 'transactional', { sends: 51, bounces: 1, opens: 41 }),
  row('2026-08-01', 'inbox_reply', { sends: 1 }),
]

const render = (rows) => renderToStaticMarkup(<OtherEmailDeliverability trend={buildEmailSourceTrend(rows)} />)

describe('below the floor: counts are the content', () => {
  const html = render(LIVE)

  it('prints the counts in the rate cell', () => {
    expect(html).toContain('111 sends, 3 bounces')
  })

  it('says plainly why there is no rate', () => {
    expect(html).toContain('Too few sends to read a rate.')
  })

  it('prints no bounce percentage anywhere, on any row', () => {
    // The monthly figures are 1/14, 1/46 and 1/51 — 7.1%, 2.2%, 2.0%. Any of
    // them rendered as a percentage would be a serious-looking deliverability
    // number built on one email.
    expect(html).not.toMatch(/\d+\.\d+%/)
  })

  it('names the source types in operator language', () => {
    expect(html).toContain('Confirmations and receipts')
    expect(html).toContain('Replies from the inbox')
  })

  it('leaves campaign email to the table that already covers it', () => {
    expect(html).not.toContain('Campaigns')
    expect(html).not.toContain('2,998')
    expect(html).not.toContain('6,221')
  })

  it('does not claim a trend', () => {
    expect(html).not.toMatch(/trend/i)
  })

  it('carries no em-dash', () => {
    expect(html).not.toContain('—')
  })
})

describe('above the floor: the same component reads the rate and its band', () => {
  // 5,000 transactional sends, 150 bounces: 3%, over the 2% warning level.
  const html = render([row('2026-08-01', 'transactional', { sends: 5000, bounces: 150, opens: 1200, complaints: 2 })])

  it('prints the rate', () => {
    expect(html).toContain('3.00%')
  })

  it('prints the band reading from the shared helper', () => {
    expect(html).toContain('Over the 2% warning level.')
  })

  it('prints the open rate instead of the placeholder', () => {
    expect(html).toContain('24.0%')
    expect(html).not.toContain('Not enough sends')
  })

  it('stops saying there are too few sends', () => {
    expect(html).not.toContain('Too few sends to read a rate.')
  })
})

describe('nothing to report', () => {
  it('says so in a sentence rather than drawing an empty table', () => {
    const html = render([row('2026-08-01', 'campaign', { sends: 6221, bounces: 58 })])
    expect(html).toContain('No sequence, confirmation or reply email')
    expect(html).not.toContain('<table')
  })
})
