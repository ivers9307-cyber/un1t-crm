// Monthly host statements (HOST-PORTAL.13) — pure month-list + CSV builder.
//
// Month filtering is deliberately the CALLER's job (the route fetches only the
// requested month's settled rows); buildStatementCsv is tested with
// pre-filtered rows and only guards the settled-status invariant itself.

import { describe, it, expect } from 'vitest'
import { monthsWithActivity, buildStatementCsv } from './host-statements.js'

// A settled stripe_connect payment row: gross = fee + net.
const paid = (over = {}) => ({
  race_event_id: 'ev1', amount_cents: 4700, application_fee_cents: 200,
  net_to_host_cents: 4500, refunded_amount_cents: 0, status: 'completed',
  created_at: '2026-07-03T10:15:00.000Z', ...over,
})

describe('monthsWithActivity', () => {
  it('returns [] for no payments', () => {
    expect(monthsWithActivity([])).toEqual([])
    expect(monthsWithActivity(null)).toEqual([])
  })

  it('dedupes months and sorts newest first', () => {
    const months = monthsWithActivity([
      paid({ created_at: '2026-05-14T09:00:00.000Z' }),
      paid({ created_at: '2026-07-03T10:15:00.000Z' }),
      paid({ created_at: '2026-07-28T23:59:59.000Z' }), // same month — deduped
      paid({ created_at: '2025-12-31T23:00:00.000Z' }),
    ])
    expect(months).toEqual(['2026-07', '2026-05', '2025-12'])
  })

  it('slices the month from the UTC ISO string and skips malformed dates', () => {
    const months = monthsWithActivity([
      paid({ created_at: '2026-07-01T00:00:00+01:00' }), // slice(0,7) — no TZ math
      paid({ created_at: null }),
      paid({ created_at: '' }),
      paid({ created_at: 'not-a-date' }),
    ])
    expect(months).toEqual(['2026-07'])
  })
})

describe('buildStatementCsv', () => {
  const base = {
    hostName: 'Acme Events',
    month: '2026-07',
    eventNameById: { ev1: 'Spring Hyrox', ev2: 'Summer Throwdown' },
  }

  it('renders header rows, column header, one row per payment, and a totals row (CRLF)', () => {
    const csv = buildStatementCsv({
      ...base,
      payments: [
        paid(),
        paid({
          race_event_id: 'ev2', status: 'refunded', refunded_amount_cents: 4700,
          created_at: '2026-07-10T08:00:00.000Z',
        }),
      ],
    })
    const lines = csv.split('\r\n')
    expect(csv).not.toContain('\n\n') // CRLF only — no bare LF endings
    expect(lines[0]).toBe('Statement for Acme Events')
    expect(lines[1]).toBe('Month,2026-07')
    expect(lines[2]).toBe('')
    expect(lines[3]).toBe('Date,Event,Status,Gross,UN1T fee,Net,Refunded')
    expect(lines[4]).toBe('2026-07-03,Spring Hyrox,completed,47.00,2.00,45.00,0.00')
    expect(lines[5]).toBe('2026-07-10,Summer Throwdown,refunded,47.00,2.00,45.00,47.00')
    expect(lines[6]).toBe('')
    expect(lines[7]).toBe('Totals,,,94.00,4.00,90.00,47.00')
    expect(lines.length).toBe(8)
  })

  it('treats NULL fee/net as 0.00 (Revolut/internal hosts) and still totals correctly', () => {
    const csv = buildStatementCsv({
      ...base,
      payments: [
        paid({ application_fee_cents: null, net_to_host_cents: null }),
        paid({ amount_cents: 2500, application_fee_cents: null, net_to_host_cents: null }),
      ],
    })
    const lines = csv.split('\r\n')
    expect(lines[4]).toBe('2026-07-03,Spring Hyrox,completed,47.00,0.00,0.00,0.00')
    expect(lines[5]).toBe('2026-07-03,Spring Hyrox,completed,25.00,0.00,0.00,0.00')
    expect(lines[7]).toBe('Totals,,,72.00,0.00,0.00,0.00')
  })

  it('skips non-settled rows even if the caller leaks them in', () => {
    const csv = buildStatementCsv({
      ...base,
      payments: [paid(), paid({ status: 'pending' }), paid({ status: 'failed' })],
    })
    const lines = csv.split('\r\n')
    expect(lines.length).toBe(7) // 4 header lines + ONE payment row + blank + Totals
    expect(lines[4]).toBe('2026-07-03,Spring Hyrox,completed,47.00,2.00,45.00,0.00')
    expect(lines[6]).toBe('Totals,,,47.00,2.00,45.00,0.00')
  })

  it('applies the csvCell formula-injection guard to event names', () => {
    const csv = buildStatementCsv({
      ...base,
      eventNameById: { ev1: '=SUM(A1:A9)' },
      payments: [paid()],
    })
    // Leading = gets the single-quote prefix so Excel renders text, never a formula.
    expect(csv).toContain("'=SUM(A1:A9)")
    expect(csv.split('\r\n')[4]).toBe("2026-07-03,'=SUM(A1:A9),completed,47.00,2.00,45.00,0.00")
  })

  it('falls back to "Unknown event" for an id missing from eventNameById', () => {
    const csv = buildStatementCsv({ ...base, eventNameById: {}, payments: [paid()] })
    expect(csv.split('\r\n')[4]).toContain('Unknown event')
  })

  it('quotes host names containing commas (RFC-4180 via csvCell)', () => {
    const csv = buildStatementCsv({ ...base, hostName: 'Acme, Ltd', payments: [paid()] })
    expect(csv.split('\r\n')[0]).toBe('"Statement for Acme, Ltd"')
  })

  it('emits an empty statement (headers + zero totals) for no payments', () => {
    const csv = buildStatementCsv({ ...base, payments: [] })
    const lines = csv.split('\r\n')
    expect(lines[3]).toBe('Date,Event,Status,Gross,UN1T fee,Net,Refunded')
    expect(lines[lines.length - 1]).toBe('Totals,,,0.00,0.00,0.00,0.00')
  })
})
