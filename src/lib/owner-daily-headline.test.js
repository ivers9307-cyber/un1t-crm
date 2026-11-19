// OWNERDAILY.1 — the daily briefing's headline: revenue month to date and
// yesterday's new leads and trials, on the studio's own calendar day.
import { describe, it, expect, vi } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db.js'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
const revenueMtd = vi.fn()
vi.mock('@/lib/membership/reads', () => ({
  membershipReadsFor: vi.fn(async () => ({ reads: { revenueMtd: (...a) => revenueMtd(...a) } })),
  supportsRead: (m, k) => typeof m?.reads?.[k] === 'function',
}))
const { fetchDailyHeadline } = await import('./owner-daily-headline.js')
const { headlineHtml } = await import('./morning-briefing.js')

const L = '00000000-0000-4000-8000-0000000000a1'
const O = '00000000-0000-4000-8000-0000000000a2'
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
// 06:00 Dublin on Thu 20 Nov 2026 (GMT): "yesterday" is Wed 19 Nov, 00:00–24:00 GMT.
const NOW = Date.parse('2026-11-20T06:00:00Z')
const contact = (n, loc, created_at) => ({ id: id(n), location_id: loc, first_name: 'A', created_at })
const trial = (n, loc, paid_at) => ({ id: id(n), location_id: loc, customer_email: 'a@x.ie', product_name: 'Trial', amount_cents: 3900, paid_at })

describe('fetchDailyHeadline', () => {
  it('counts yesterday on the studio\'s clock, at this studio only', async () => {
    revenueMtd.mockResolvedValue({ success: true, data: { totalCents: 123400, deltaPct: 12.4 } })
    const db = createFakeDb({ tables: {
      contacts: [contact(1, L, '2026-11-19T00:30:00Z'), contact(2, L, '2026-11-19T23:59:00Z'), contact(3, L, '2026-11-20T00:01:00Z'), contact(4, O, '2026-11-19T10:00:00Z'), contact(5, L, '2026-11-18T23:59:00Z')],
      trial_purchases: [trial(11, L, '2026-11-19T12:00:00Z'), trial(12, L, null), trial(13, O, '2026-11-19T12:00:00Z')],
    } })
    const h = await fetchDailyHeadline(db, L, { nowMs: NOW, zone: 'Europe/Dublin' })
    expect(h).toEqual({ revenue: { totalCents: 123400, deltaPct: 12.4 }, newLeads: 2, trials: 1, dayLabel: '2026-11-19' })
  })
  it('a figure that cannot be read is null, never zero', async () => {
    revenueMtd.mockResolvedValue({ success: false, error: 'down' })
    const db = createFakeDb({ tables: {}, errors: { contacts: { select: { message: 'down' } } } })
    const h = await fetchDailyHeadline(db, L, { nowMs: NOW, zone: 'Europe/Dublin' })
    expect(h).toMatchObject({ revenue: null, newLeads: null, trials: 0 })
  })
})

describe('headlineHtml', () => {
  it('shows what was read and leaves out what was not', () => {
    const html = headlineHtml({ revenue: { totalCents: 123400, deltaPct: -3.2 }, newLeads: 4, trials: null })
    expect(html).toContain('Revenue this month')
    expect(html).toContain('€1,234')
    expect(html).toContain('(-3% on last month)')
    expect(html).toContain('New leads yesterday')
    expect(html).not.toContain('Trials bought yesterday')
  })
  it('nothing readable, no section', () => {
    expect(headlineHtml({ revenue: null, newLeads: null, trials: null })).toBe('')
    expect(headlineHtml(null)).toBe('')
  })
})
