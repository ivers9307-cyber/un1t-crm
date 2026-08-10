// REPORT-SOT.1 — deliverability for the email that is NOT a campaign.
//
// WHY THIS EXISTS. The list-health trend (GAPS-P7, mig 517) reads
// campaign_recipients, so it covers CAMPAIGN email and says so in its own
// column heading. Sequence, transactional and inbox-reply mail lives in
// email_sends and had no deliverability view anywhere in the product. It all
// leaves on the same sending domain, so a reputation problem starting there
// would be invisible on the one page built to catch reputation problems.
//
// ⚠️ THIS IS A COUNTS PANEL, NOT A TREND, AND THAT IS DELIBERATE. Measured
// live on email_sends 2026-08-10:
//
//     source_type      rows    bounces  opens  complaints  span
//     campaign        19,095       217  7,786           1  2026-05-13 .. 2026-08-09
//     transactional      111         3     90           0  2026-06-17 .. 2026-08-10
//     inbox_reply          1         0      0           0  2026-08-07
//
// There are ZERO 'sequence' rows: the value does not occur, because the estate
// has one active sequence. Non-campaign volume is therefore 111 emails and 3
// bounces, an order of magnitude under the 500-send floor list-health-trend.js
// already enforces. A rate-based panel would read "Not enough sends" in every
// month it could ever draw, which is an empty chart implying data exists when
// it does not. So the surface shows what it has: the counts, and a plain
// sentence saying they are too few to divide.
//
// THE FLOOR IS NOT RE-DERIVED HERE. readRate, RATE_BANDS and rateReadings come
// from list-health-trend.js unchanged. The moment a month crosses the floor
// this module returns rates_readable true and the same reading objects the
// campaign table renders, so the component switches with no flag to set, no
// second code path, and no chance of the two halves of the page disagreeing
// about what 500 sends means.
//
// CAMPAIGN EMAIL IS EXCLUDED FROM THE PANEL, not from the RPC. mig 521 returns
// every source_type because a partial aggregate is the thing this programme
// keeps finding. The exclusion is a DISPLAY decision, made here and named in
// `excluded`: campaign figures already have a table on the same page, sourced
// from campaign_recipients, and two different numbers for campaign sends on
// one screen is precisely the ambiguity REPORT-SOT.2 exists to remove.
//
// PURE. No I/O and no clock. The months come from email_sends_monthly_stats
// (mig 521), which aggregates in Postgres because the 1,000-row select cap
// would silently under-report a 19,000-row table in the page.

import { monthLabel, rateReadings } from './list-health-trend.js'

/** The source_type the campaign table above this panel already covers. */
export const CAMPAIGN_SOURCE_TYPE = 'campaign'

/**
 * Operator-facing names for the source_type values the code writes.
 *
 * Staff-facing labels, so they live in code rather than settings. A value NOT
 * in this map is rendered by its raw name and flagged `unlabelled`, the same
 * posture mig 517 takes with unknown_sources: a source nobody has named is
 * surfaced by name, never dropped and never folded into a neighbour.
 */
export const SOURCE_TYPE_LABELS = Object.freeze({
  campaign: 'Campaigns',
  sequence: 'Automated sequences',
  transactional: 'Confirmations and receipts',
  event_reminder: 'Event reminders',
  inbox_reply: 'Replies from the inbox',
  unrecorded: 'Source not recorded',
})

export function sourceTypeLabel(sourceType) {
  return SOURCE_TYPE_LABELS[sourceType] || sourceType
}

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * The cell content when a rate cannot be read: "111 sends, 3 bounces".
 *
 * This is the whole point of the panel. A suppressed rate rendered as a blank
 * or a "Not read" placeholder tells an operator nothing and reads as a broken
 * page; the counts are the measurement, and they are shown as the content of
 * the cell rather than as a footnote under an empty one.
 */
export function countsLabel(sends, bounces) {
  return `${plural(sends, 'send', 'sends')}, ${plural(bounces, 'bounce', 'bounces')}`
}

const num = (v) => Number(v || 0)
const rateOf = (hits, denom) => (denom > 0 ? hits / denom : null)

/**
 * One row's worth of measurement, whichever grain it is at.
 *
 * `rates_readable`, `bounce_reading`, `complaint_reading` and `open_rate_label`
 * all come from rateReadings, so a month here and a month on the campaign
 * table are judged by identical rules.
 */
function shape(counts) {
  const { sends, bounces, hard_bounces, complaints, opens } = counts
  // Trust the RPC's rate when it gave one, but fall back to the counts so a
  // null rate column never reads as "no bounces". Rates arrive from Postgres
  // as `numeric`, which PostgREST serialises as a STRING; a string compared
  // against a band threshold does not error, it silently answers the wrong
  // question.
  const bounce_rate = counts.bounce_rate == null ? rateOf(bounces, sends) : Number(counts.bounce_rate)
  const complaint_rate = counts.complaint_rate == null ? rateOf(complaints, sends) : Number(counts.complaint_rate)
  const open_rate = counts.open_rate == null ? rateOf(opens, sends) : Number(counts.open_rate)
  return {
    sends,
    bounces,
    hard_bounces,
    complaints,
    opens,
    bounce_rate,
    complaint_rate,
    open_rate,
    counts_label: countsLabel(sends, bounces),
    ...rateReadings(sends, { bounce_rate, complaint_rate, open_rate }),
  }
}

const zero = () => ({ sends: 0, bounces: 0, hard_bounces: 0, complaints: 0, opens: 0 })

function add(acc, r) {
  acc.sends += num(r.sends)
  acc.bounces += num(r.bounces)
  acc.hard_bounces += num(r.hard_bounces)
  acc.complaints += num(r.complaints)
  acc.opens += num(r.opens)
  return acc
}

/**
 * Shape email_sends_monthly_stats (mig 521) into the panel.
 *
 * @param {Array<object>|null} rows     one row per (month, source_type)
 * @param {object} [opts]
 * @param {string[]} [opts.exclude]     source types the surface covers elsewhere
 * @returns {{
 *   sources: Array<object>,   one entry per source type, months already trimmed
 *   totals: object,           the pooled non-excluded figures
 *   window: { from: string|null, to: string|null, months: number },
 *   excluded: string[],
 * }}
 */
export function buildEmailSourceTrend(rows, { exclude = [CAMPAIGN_SOURCE_TYPE] } = {}) {
  const all = Array.isArray(rows) ? rows : []

  // The window is measured across EVERY row, excluded ones included: it
  // describes the period the RPC covered, not the period this panel draws.
  const allMonths = [...new Set(all.map((r) => r.month).filter(Boolean))].sort()
  const window = {
    from: allMonths.length ? monthLabel(allMonths[0]) : null,
    to: allMonths.length ? monthLabel(allMonths[allMonths.length - 1]) : null,
    months: allMonths.length,
  }

  const kept = all.filter((r) => !exclude.includes(r.source_type))

  const bySource = new Map()
  for (const r of kept) {
    const key = r.source_type
    if (!bySource.has(key)) bySource.set(key, { total: zero(), months: [] })
    const entry = bySource.get(key)
    add(entry.total, r)
    // A month a source sent nothing in is dropped from the table. The RPC
    // returns the full grid so a quiet month is a fact rather than an absence,
    // but printing nine rows of zeroes next to three real ones would imply a
    // trend where there is only a handful of emails.
    if (num(r.sends) > 0) {
      entry.months.push({
        month: r.month,
        label: monthLabel(r.month),
        ...shape({
          sends: num(r.sends),
          bounces: num(r.bounces),
          hard_bounces: num(r.hard_bounces),
          complaints: num(r.complaints),
          opens: num(r.opens),
          bounce_rate: r.bounce_rate,
          complaint_rate: r.complaint_rate,
          open_rate: r.open_rate,
        }),
      })
    }
  }

  const sources = [...bySource.entries()]
    .map(([source_type, entry]) => ({
      source_type,
      label: sourceTypeLabel(source_type),
      unlabelled: !(source_type in SOURCE_TYPE_LABELS),
      months: entry.months.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)),
      months_with_sends: entry.months.length,
      ...shape({ ...entry.total, bounce_rate: null, complaint_rate: null, open_rate: null }),
    }))
    // Loudest first. The source carrying the volume is the one carrying the
    // reputation risk, and a tie falls back to the name so the order is stable
    // between renders.
    .filter((s) => s.sends > 0 || s.months_with_sends > 0)
    .sort((a, b) => b.sends - a.sends || a.source_type.localeCompare(b.source_type))

  const pooled = sources.reduce((acc, s) => add(acc, s), zero())
  const totals = {
    source_types: sources.length,
    months_with_sends: new Set(sources.flatMap((s) => s.months.map((m) => m.month))).size,
    ...shape({ ...pooled, bounce_rate: null, complaint_rate: null, open_rate: null }),
  }

  return { sources, totals, window, excluded: [...exclude] }
}
