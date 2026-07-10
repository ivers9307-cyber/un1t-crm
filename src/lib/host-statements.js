// Monthly host statements (HOST-PORTAL.13) — pure month-list + CSV builder.
//
// A statement is the per-payment breakdown behind the revenue rollup
// (host-revenue.js): one CSV row per settled race_payment in a calendar month,
// with the same gross/fee/net/refunded semantics (mig 381 columns; Revolut/
// internal hosts have NULL fee/net → 0.00). Month filtering is deliberately the
// CALLER's job (the route fetches only the requested month's settled rows);
// buildStatementCsv only re-guards the settled-status invariant itself.
//
// Cells go through csvCell (attendee-csv.js) — RFC-4180 quoting + the
// formula-injection guard, so a host or event name can never execute in Excel.

import { csvCell } from './attendee-csv.js'

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
// Cents → euro decimals ("4700" → "47.00"; null/garbage → "0.00").
const euro = (cents) => (num(cents) / 100).toFixed(2)

// Settled money only — pending/failed/abandoned/cancelled never moved funds.
const isSettled = (p) => p?.status === 'completed' || p?.status === 'refunded'

/**
 * Unique YYYY-MM months (from created_at, UTC string slice — no TZ math),
 * newest first. Malformed/missing created_at rows are skipped.
 * @param {Array<{created_at?:string|null}>} payments
 * @returns {string[]} e.g. ['2026-07', '2026-05']
 */
export function monthsWithActivity(payments) {
  const months = new Set()
  for (const p of (payments || [])) {
    const m = typeof p?.created_at === 'string' ? p.created_at.slice(0, 7) : ''
    if (/^\d{4}-\d{2}$/.test(m)) months.add(m)
  }
  return [...months].sort().reverse()
}

/**
 * Build one month's statement CSV (CRLF line endings):
 *
 *   Statement for <hostName>
 *   Month,<YYYY-MM>
 *   <blank>
 *   Date,Event,Status,Gross,UN1T fee,Net,Refunded
 *   ...one row per settled payment (amounts in euro decimals)...
 *   <blank>
 *   Totals,,,<gross>,<fee>,<net>,<refunded>
 *
 * @param {{hostName:string, month:string, payments:Array<object>, eventNameById:Record<string,string>}} args
 *   payments — settled race_payments rows for the month (non-settled leaks are skipped)
 *   eventNameById — race_event_id → event name (missing → 'Unknown event')
 * @returns {string} CSV text
 */
export function buildStatementCsv({ hostName, month, payments, eventNameById }) {
  const names = eventNameById || {}
  const rows = [
    [`Statement for ${hostName}`],
    ['Month', month],
    [],
    ['Date', 'Event', 'Status', 'Gross', 'UN1T fee', 'Net', 'Refunded'],
  ]

  // Totals accumulate in integer cents (exact) and format once at the end.
  const totals = { gross: 0, fee: 0, net: 0, refunded: 0 }
  for (const p of (payments || [])) {
    if (!isSettled(p)) continue
    const gross = num(p.amount_cents)
    const fee = num(p.application_fee_cents)
    const net = num(p.net_to_host_cents)
    const refunded = num(p.refunded_amount_cents)
    totals.gross += gross
    totals.fee += fee
    totals.net += net
    totals.refunded += refunded
    rows.push([
      String(p.created_at || '').slice(0, 10),
      names[p.race_event_id] || 'Unknown event',
      p.status,
      euro(gross), euro(fee), euro(net), euro(refunded),
    ])
  }

  rows.push([])
  rows.push(['Totals', '', '', euro(totals.gross), euro(totals.fee), euro(totals.net), euro(totals.refunded)])
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}
