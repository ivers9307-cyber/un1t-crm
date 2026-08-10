// GAPS-P7 — is the list growing or shrinking, and is deliverability drifting.
//
// A server component with no client JavaScript and no chart library. The repo
// has recharts and it would have worked, but it costs a ~150KB lazy chunk and
// a 'use client' boundary to draw twelve rows of mixed units (counts, rates,
// and a signed net) that a table already shows exactly. The bars here are two
// divs and a width percentage.
//
// THE HEADLINE IS NET LIST CHANGE, and at Stillorgan it is negative. The
// number is stated plainly and left to speak: no verdict, no advice, no
// commentary about what it means for the business.
//
// NOT EVERY OPT-OUT IS A DEPARTURE, and the second table is why this component
// has two of them. 5,519 opt-out rows landed on 2026-05-13 as a data
// migration. They are excluded from the net (consent-sources.js) but they are
// NOT hidden: the "recorded but not counted" table puts them on screen with
// their reason, so an operator can see that May's consent activity was an
// import rather than wondering why the numbers moved. Excluding something from
// a headline and deleting it from a page are different things.
//
// Rates below the minimum denominator are NOT SHOWN. Measured 2026-08-09, July
// carried 137 sends and a 76.64% open rate. Printed in the same column as
// June's 46.33% on 9,739 sends it reads as the best month of the year; it is
// 105 people. The month still appears, with its counts, and the cell says why
// there is no rate. Same posture as readOutcome in CampaignOutcomeReport.

import { MIN_RATE_SENDS } from '@/lib/list-health-trend'
// REPORT-SOT.1 — the chip moved to its own file so this table and the
// non-campaign panel below it render an identical reading identically.
import ReadingChip from './ReadingChip'

const n = (v) => Number(v || 0).toLocaleString()
const signed = (v) => (v > 0 ? `+${n(v)}` : v < 0 ? `-${n(Math.abs(v))}` : '0')

const readingChip = (reading) => <ReadingChip reading={reading} />

function Headline({ label, value, hint, tone }) {
  const valueCls = tone === 'down' ? 'text-rose-700' : tone === 'up' ? 'text-emerald-700' : 'text-un1t-text'
  return (
    <div className="rounded-xl border border-un1t-border p-4">
      <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-1">{label}</div>
      <div className={`text-2xl font-bold ${valueCls}`}>{value}</div>
      {hint && <div className="text-xs text-un1t-subtle mt-1">{hint}</div>}
    </div>
  )
}

const TH = 'py-2 px-3 font-medium text-right'
const TD = 'py-2 px-3 text-right text-un1t-text'

export default function ListHealthTrend({ trend }) {
  const { months, totals } = trend
  // A studio with nothing on record gets a sentence, not twelve rows of
  // zeroes. The grid always returns the current month, so "no months" and
  // "one empty month" are the same state.
  const nothingRecorded = totals.sends === 0 && totals.opt_ins === 0 && totals.unsubscribes === 0
    && totals.unsub_policy === 0 && totals.excluded_bulk === 0 && totals.consent_unknown === 0
  if (!months.length || nothingRecorded) {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-un1t-text mb-1">Growth and deliverability by month</h3>
        <p className="text-sm text-un1t-subtle py-4">No sends or consent changes recorded at this studio yet.</p>
      </div>
    )
  }

  const windowLabel = months.length === 1
    ? months[0].label
    : `${months[0].label} to ${months[months.length - 1].label}`

  // The second table earns its space only when there is something in it.
  const hasExcluded = totals.unsub_policy > 0 || totals.excluded_bulk > 0 || totals.consent_unknown > 0

  return (
    <div className="space-y-6 mb-8">
      <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-un1t-text mb-1">List growth</h3>
        <p className="text-xs text-un1t-subtle mb-4">
          People joining and leaving the marketing list at this studio, {windowLabel}. Leaving counts
          unsubscribes people made themselves, plus addresses that permanently failed or reported the mail as
          spam. One-off imports and automatic ClassPass exclusions are listed separately below and are not
          counted here.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
          <Headline
            label="Net change"
            value={signed(totals.net_list_change)}
            hint={`Across ${totals.months} ${totals.months === 1 ? 'month' : 'months'}`}
            tone={totals.direction === 'shrinking' ? 'down' : totals.direction === 'growing' ? 'up' : null}
          />
          <Headline label="Joined" value={n(totals.opt_ins)} hint="Opted in to marketing email" />
          <Headline
            label="Left"
            value={n(totals.unsubscribes)}
            hint={`${n(totals.unsub_deliverability)} of these were failed addresses`}
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Marketing list joiners and leavers by month</caption>
            <thead>
              <tr className="border-b border-un1t-border text-left text-xs uppercase tracking-wide text-un1t-muted">
                <th scope="col" className="py-2 pr-3 font-medium">Month</th>
                <th scope="col" className={TH}>Joined</th>
                <th scope="col" className={TH}>Left</th>
                <th scope="col" className={TH}>Net</th>
                <th scope="col" className="py-2 pl-3 font-medium w-2/5">Joined against left</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} className="border-b border-un1t-border/50 align-top">
                  <th scope="row" className="py-2 pr-3 font-normal text-left text-un1t-text whitespace-nowrap">{m.label}</th>
                  <td className={TD}>{n(m.opt_ins)}</td>
                  <td className={TD}>
                    {n(m.unsubscribes)}
                    {m.unsub_deliverability > 0 && (
                      <span className="block text-[11px] text-un1t-subtle">{n(m.unsub_deliverability)} failed addresses</span>
                    )}
                  </td>
                  <td className={`py-2 px-3 text-right font-medium ${m.net_list_change < 0 ? 'text-rose-700' : m.net_list_change > 0 ? 'text-emerald-700' : 'text-un1t-subtle'}`}>
                    {signed(m.net_list_change)}
                  </td>
                  <td className="py-2 pl-3">
                    {/* CSS-only bars on one shared scale, so the two series are
                        comparable by eye without a chart library. */}
                    <div className="space-y-1" aria-hidden="true">
                      <div className="h-1.5 rounded-full bg-emerald-500/70" style={{ width: `${m.opt_in_bar}%` }} />
                      <div className="h-1.5 rounded-full bg-rose-500/70" style={{ width: `${m.unsubscribe_bar}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {hasExcluded && (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-un1t-text mb-1">Recorded, but not counted as leaving</h3>
          <p className="text-xs text-un1t-subtle mb-4">
            These consent changes are on the record and are the reason a month can look busy without anyone
            actually leaving. They are kept out of the figures above so a one-off data update does not read
            as people unsubscribing.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Consent changes excluded from the net list change, by month</caption>
              <thead>
                <tr className="border-b border-un1t-border text-left text-xs uppercase tracking-wide text-un1t-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">Month</th>
                  <th scope="col" className={TH}>ClassPass rule</th>
                  <th scope="col" className={TH}>One-off updates</th>
                  <th scope="col" className={TH}>Unclassified</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month} className="border-b border-un1t-border/50">
                    <th scope="row" className="py-2 pr-3 font-normal text-left text-un1t-text whitespace-nowrap">{m.label}</th>
                    <td className={TD}>{n(m.unsub_policy)}</td>
                    <td className={TD}>{n(m.excluded_bulk)}</td>
                    <td className={m.consent_unknown > 0 ? 'py-2 px-3 text-right font-medium text-amber-700' : TD}>
                      {n(m.consent_unknown)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-un1t-border">
                  <th scope="row" className="py-2 pr-3 text-left font-medium text-un1t-text">Whole period</th>
                  <td className={TD}>{n(totals.unsub_policy)}</td>
                  <td className={TD}>{n(totals.excluded_bulk)}</td>
                  <td className={TD}>{n(totals.consent_unknown)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="mt-4 space-y-1.5 text-[11px] leading-relaxed text-un1t-subtle">
            <p>
              <b className="text-un1t-text">ClassPass rule.</b> Moving a member onto ClassPass pay as you go
              switches off their marketing consent automatically. They cannot be emailed, and the
              &quot;can be emailed now&quot; figure at the top of this page already reflects that, but nobody
              chose to leave, so it is not counted as a departure.
            </p>
            <p>
              <b className="text-un1t-text">One-off updates.</b> Imports and corrections applied in bulk. They
              record a change to what was already true rather than someone acting on an email.
            </p>
            {totals.consent_unknown > 0 && (
              <p className="text-amber-700">
                <b>Unclassified.</b> {n(totals.consent_unknown)} consent{' '}
                {totals.consent_unknown === 1 ? 'change' : 'changes'} came from{' '}
                {totals.unknown_sources.length === 1 ? 'a source' : 'sources'} nobody has categorised:{' '}
                {totals.unknown_sources.join(', ') || 'not recorded'}. They are counted nowhere until someone
                decides what they mean. Add them to the consent source list to bring them into the figures.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-un1t-text mb-1">Deliverability by month</h3>
        <p className="text-xs text-un1t-subtle mb-4">
          All marketing email from this studio goes out on one sending domain, so bounces and spam reports
          from any campaign affect every campaign. A bounce rate over 2% is the usual warning level and over
          5% is serious; for spam reports the levels are 0.1% and 0.3%.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Campaign sends, bounce rate, open rate and spam reports by month</caption>
            <thead>
              <tr className="border-b border-un1t-border text-left text-xs uppercase tracking-wide text-un1t-muted">
                <th scope="col" className="py-2 pr-3 font-medium">Month</th>
                <th scope="col" className={TH}>Campaigns</th>
                <th scope="col" className={TH}>Campaign sends</th>
                <th scope="col" className={TH}>Bounces</th>
                <th scope="col" className={TH}>Opens</th>
                <th scope="col" className={TH}>Spam reports</th>
                <th scope="col" className="py-2 pl-3 font-medium">Bounce rate</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} className="border-b border-un1t-border/50 align-top">
                  <th scope="row" className="py-2 pr-3 font-normal text-left text-un1t-text whitespace-nowrap">{m.label}</th>
                  <td className={TD}>{n(m.campaigns)}</td>
                  <td className={TD}>{n(m.sends)}</td>
                  <td className={TD}>
                    {n(m.bounces)}
                    {m.hard_bounces > 0 && (
                      <span className="block text-[11px] text-un1t-subtle">{n(m.hard_bounces)} permanent</span>
                    )}
                  </td>
                  <td className={TD}>
                    {n(m.opens)}
                    <span className="block text-[11px] text-un1t-subtle">{m.open_rate_label}</span>
                  </td>
                  <td className={TD}>{n(m.complaints)}</td>
                  <td className="py-2 pl-3">
                    <div className="text-un1t-text">
                      {m.rates_readable && m.bounce_rate != null ? `${(m.bounce_rate * 100).toFixed(2)}%` : 'Not read'}
                    </div>
                    <div className="mt-1">{readingChip(m.bounce_reading)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-un1t-border align-top">
                <th scope="row" className="py-2 pr-3 text-left font-medium text-un1t-text whitespace-nowrap">Whole period</th>
                <td className={TD}>{n(totals.campaigns)}</td>
                <td className={TD}>{n(totals.sends)}</td>
                <td className={TD}>{n(totals.bounces)}</td>
                <td className={TD}>
                  {n(totals.opens)}
                  <span className="block text-[11px] text-un1t-subtle">{totals.open_rate_label}</span>
                </td>
                <td className={TD}>{n(totals.complaints)}</td>
                <td className="py-2 pl-3">
                  <div className="text-un1t-text">
                    {totals.rates_readable && totals.bounce_rate != null ? `${(totals.bounce_rate * 100).toFixed(2)}%` : 'Not read'}
                  </div>
                  <div className="mt-1">{readingChip(totals.bounce_reading)}</div>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="mt-4 space-y-1.5 text-[11px] leading-relaxed text-un1t-subtle">
          <p>
            Spam reports across the whole period: {n(totals.complaints)} on {n(totals.sends)} campaign sends.{' '}
            {totals.complaint_reading.text}
          </p>
          <p>
            A rate is only shown for a month with at least {n(MIN_RATE_SENDS)} sends. Below that, two or
            three bounces are enough to cross a warning level on their own, so the counts are shown and the
            rate is left out rather than read as a result.
          </p>
          <p>
            Campaigns only. Automated sequence email and booking confirmations are sent through a different
            path and are not counted in this table, so these figures are not the studio&apos;s total email
            volume. An automatic resend to people who did not open counts as its own campaign, and a campaign
            still sending at midnight on the 1st appears in both months.
          </p>
          <p>
            Opens are counted from a tracking image, and some mail providers load that image without anyone
            reading the email, so the open rate is a direction of travel rather than an exact figure.
            Addresses the provider refused at send time carry no send timestamp and appear in the bounce
            breakdown below rather than in a month here.
          </p>
        </div>
      </div>
    </div>
  )
}
