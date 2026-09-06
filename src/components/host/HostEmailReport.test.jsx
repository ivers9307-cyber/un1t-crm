import { describe, it, expect } from 'vitest'
import { statTiles, filterRecipients, FILTERS, outcomeChipClass, formatWhen } from './HostEmailReport.jsx'

const stats = { queued: 0, sent: 124, delivered: 118, opened: 41, clicked: 9, bounced: 2, complained: 0, unsubscribed: 1, failed: 4 }
describe('statTiles', () => {
  it('seven tiles in order with open/click rates of delivered', () => {
    const t = statTiles(stats)
    expect(t.map((x) => x.label)).toEqual(['Sent', 'Delivered', 'Opened', 'Clicked', 'Bounced', 'Unsubscribed', 'Failed'])
    expect(t.map((x) => x.value)).toEqual([124, 118, 41, 9, 2, 1, 4])
    expect(t[2].sub).toBe('35% of delivered'); expect(t[3].sub).toBe('8% of delivered')
  })
  it('0% when nothing delivered, and missing stats read as zeros', () => {
    expect(statTiles({ ...stats, delivered: 0, opened: 0 })[2].sub).toBe('0% of delivered')
    expect(statTiles(undefined).map((x) => x.value)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })
})
describe('filterRecipients', () => {
  const rows = [
    { contact_id: 'a', outcome: 'opened', delivered_at: 'd', opened_at: 'o' },
    { contact_id: 'b', outcome: 'delivered', delivered_at: 'd', opened_at: null },
    { contact_id: 'c', outcome: 'failed' }, { contact_id: 'd', outcome: 'clicked', delivered_at: 'd', opened_at: 'o', clicked_at: 'c' },
    { contact_id: 'e', outcome: 'bounced' }, { contact_id: 'f', outcome: 'unsubscribed' }, { contact_id: 'g', outcome: 'sent' },
  ]
  const ids = (f) => filterRecipients(rows, f).map((r) => r.contact_id)
  it('all', () => expect(ids('all')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']))
  it('opened includes clicked', () => expect(ids('opened')).toEqual(['a', 'd']))
  it('clicked', () => expect(ids('clicked')).toEqual(['d']))
  it('not_opened = delivered but never opened', () => expect(ids('not_opened')).toEqual(['b']))
  it('bounced / unsubscribed / failed', () => { expect(ids('bounced')).toEqual(['e']); expect(ids('unsubscribed')).toEqual(['f']); expect(ids('failed')).toEqual(['c']) })
  it('FILTERS lists the seven chips in order', () => expect(FILTERS.map((f) => f.key)).toEqual(['all', 'opened', 'clicked', 'not_opened', 'bounced', 'unsubscribed', 'failed']))
})
describe('chip + date', () => {
  it('maps every outcome to a class and never returns undefined', () => {
    for (const o of ['failed', 'bounced', 'complained', 'unsubscribed', 'clicked', 'opened', 'delivered', 'sent', 'queued', 'wat']) expect(typeof outcomeChipClass(o)).toBe('string')
  })
  // en-IE abbreviates September as "Sept" (4 letters) while every other
  // month is 3 — \w{3,4} covers both instead of overfitting to Sept.
  it('formatWhen is short and null-safe', () => { expect(formatWhen(null)).toBe(''); expect(formatWhen('2026-09-04T10:58:14Z')).toMatch(/^\d{1,2} \w{3,4}, \d{2}:\d{2}$/) })
})
