// REPORT-SOT.1 — deliverability for the email that is not a campaign.
//
// A server component with no client JavaScript, matching ListHealthTrend
// directly above it on the page.
//
// WHY THIS IS A COUNTS PANEL. Measured on email_sends 2026-08-10, everything
// outside campaigns is 111 emails and 3 bounces, plus a single inbox reply.
// The minimum denominator for reporting any rate is 500 sends
// (list-health-trend.js), so a rate-shaped panel would print "Not enough
// sends" in every cell it could ever draw, in every month, forever. That is an
// empty chart implying data exists when it does not. So the rate cell holds
// the COUNTS, which are the measurement, and a sentence saying why they are
// not divided.
//
// THE SWITCHOVER IS AUTOMATIC AND HAS NO SECOND CODE PATH. The cell branches
// once, on rates_readable, which comes from the same helper the campaign table
// above uses. The first month that clears 500 sends prints its rate and its
// band here with nobody changing anything.
//
// CAMPAIGN EMAIL IS NOT HERE. It has its own table on this page, sourced from
// campaign_recipients. Two numbers for campaign sends on one screen is the
// ambiguity the rest of this change exists to remove.

import ReadingChip from './ReadingChip'
import { MIN_RATE_SENDS } from '@/lib/list-health-trend'

const n = (v) => Number(v || 0).toLocaleString()

const TH = 'py-2 px-3 font-medium text-right'
const TD = 'py-2 px-3 text-right text-un1t-text'

/**
 * The one cell that decides what this panel is.
 *
 * Above the floor: the rate and its band. Below it: the counts and the reason.
 * Never a blank, and never a placeholder standing alone where a measurement
 * should be.
 */
function BounceCell({ figures }) {
  const readable = figures.rates_readable && figures.bounce_rate != null
  return (
    <td className="py-2 pl-3">
      <div className="text-un1t-text">
        {readable ? `${(figures.bounce_rate * 100).toFixed(2)}%` : figures.counts_label}
      </div>
      <div className="mt-1"><ReadingChip reading={figures.bounce_reading} /></div>
    </td>
  )
}

function Cells({ figures }) {
  return (
    <>
      <td className={TD}>{n(figures.sends)}</td>
      <td className={TD}>
        {n(figures.bounces)}
        {figures.hard_bounces > 0 && (
          <span className="block text-[11px] text-un1t-subtle">{n(figures.hard_bounces)} permanent</span>
        )}
      </td>
      <td className={TD}>
        {n(figures.opens)}
        {/* The open-rate label only appears once the denominator can carry it.
            Below the floor the count is the whole answer, and a placeholder
            under it would just be noise repeated on every row. */}
        {figures.rates_readable && (
          <span className="block text-[11px] text-un1t-subtle">{figures.open_rate_label}</span>
        )}
      </td>
      <td className={TD}>{n(figures.complaints)}</td>
      <BounceCell figures={figures} />
    </>
  )
}

export default function OtherEmailDeliverability({ trend }) {
  const { sources, totals, window } = trend

  const heading = 'Other email: sequences, confirmations and replies'

  if (!sources.length) {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-un1t-text mb-1">{heading}</h3>
        <p className="text-sm text-un1t-subtle py-4">
          No sequence, confirmation or reply email has gone out from this studio in this period. Campaign
          email is counted in the table above.
        </p>
      </div>
    )
  }

  const windowLabel = window.from && window.to && window.from !== window.to
    ? `${window.from} to ${window.to}`
    : window.from || ''

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
      <h3 className="text-sm font-semibold text-un1t-text mb-1">{heading}</h3>
      <p className="text-xs text-un1t-subtle mb-4">
        Email sent outside a campaign{windowLabel ? `, ${windowLabel}` : ''}: automated sequence steps,
        booking and payment confirmations, and replies sent from the inbox. It leaves on the same sending
        domain as the campaigns above, so a problem here affects those too. This is what has been sent, not a
        direction of travel: the volume is far too small to read a rate from, so the counts are shown instead.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Non-campaign email sends, bounces, opens and spam reports by type and month
          </caption>
          <thead>
            <tr className="border-b border-un1t-border text-left text-xs uppercase tracking-wide text-un1t-muted">
              <th scope="col" className="py-2 pr-3 font-medium">Month</th>
              <th scope="col" className={TH}>Sends</th>
              <th scope="col" className={TH}>Bounces</th>
              <th scope="col" className={TH}>Opens</th>
              <th scope="col" className={TH}>Spam reports</th>
              <th scope="col" className="py-2 pl-3 font-medium">Bounce rate</th>
            </tr>
          </thead>
          {sources.map((s) => (
            <tbody key={s.source_type}>
              <tr className="border-b border-un1t-border/50 bg-un1t-bg/30">
                <th scope="colgroup" colSpan={6} className="py-2 pr-3 text-left text-un1t-text font-medium">
                  {s.label}
                  {s.unlabelled && (
                    <span className="ml-2 text-[11px] font-normal text-amber-700">
                      not categorised yet, shown by its raw name
                    </span>
                  )}
                </th>
              </tr>
              {s.months.map((m) => (
                <tr key={`${s.source_type}-${m.month}`} className="border-b border-un1t-border/50 align-top">
                  <th scope="row" className="py-2 pr-3 font-normal text-left text-un1t-text whitespace-nowrap">
                    {m.label}
                  </th>
                  <Cells figures={m} />
                </tr>
              ))}
              <tr className="border-b border-un1t-border align-top">
                <th scope="row" className="py-2 pr-3 text-left font-medium text-un1t-text whitespace-nowrap">
                  Whole period
                </th>
                <Cells figures={s} />
              </tr>
            </tbody>
          ))}
        </table>
      </div>

      <div className="mt-4 space-y-1.5 text-[11px] leading-relaxed text-un1t-subtle">
        <p>
          {n(totals.sends)} {totals.sends === 1 ? 'email' : 'emails'} in total, with {n(totals.bounces)}{' '}
          {totals.bounces === 1 ? 'bounce' : 'bounces'} and {n(totals.complaints)} spam{' '}
          {totals.complaints === 1 ? 'report' : 'reports'}. {totals.bounce_reading.text}
        </p>
        <p>
          A rate is only shown once a figure covers at least {n(MIN_RATE_SENDS)} sends. Below that, one or two
          bounces are enough to cross a warning level on their own, so the counts are shown and the rate is
          left out rather than read as a result. Nothing needs switching on when the volume arrives: the rate
          and its band appear in this table on their own.
        </p>
        <p>
          Only months in which something was sent are listed. A type with no row for a month sent nothing that
          month.
        </p>
        <p>
          Opens are counted from a tracking image, which is switched off for everything except marketing mail,
          so the open figures here are not comparable with the campaign ones above and are lower than the real
          number.
        </p>
      </div>
    </div>
  )
}
