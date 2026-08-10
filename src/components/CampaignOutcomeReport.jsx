'use client'

// GAPS-P2 (mig 513) — what a campaign actually produced.
//
// THE COMPARISON IS THE HEADLINE, not the attributed number. A campaign's
// clickers registering for 5 events means nothing on its own; it means a great
// deal against 0 for people who never opened it. The real Nutrable send makes
// the case in one screen: event registrations ran 11.1% vs 0% (a genuine
// effect), while class attendance ran 11.1% vs 9.2% (noise — members attend
// anyway). Shown alone, that second row reads as a result and an operator
// spends money on it.
//
// WHAT IS DELIBERATELY ABSENT: recurring membership revenue. It was measured
// at €0-10 per campaign because UN1T's income is monthly direct debit, which
// does not correlate with an email click — a windowed figure would relabel
// whatever debits landed that week as "campaign revenue". Only discrete
// purchases appear here. Omitting a number nobody can stand behind is the
// feature.
//
// The window is on screen and adjustable because the answer genuinely depends
// on it: two independent runs of this join disagreed (6 vs 5 registrations)
// purely on window choice.

import { useEffect, useState } from 'react'
import { Target, Users, AlertTriangle, Loader2 } from 'lucide-react'

const WINDOW_OPTIONS = [3, 7, 14, 30]

const METRICS = [
  { key: 'event_registrations', label: 'Event registrations' },
  { key: 'class_attendances', label: 'Classes attended', note: 'Attendance, not booking — Glofox gives us the class time, not when it was booked.' },
  { key: 'purchases', label: 'Purchases' },
]

const pct = (r) => (r == null ? '—' : `${(r * 100).toFixed(1)}%`)

/**
 * The comparison in words. Deliberately refuses to call anything a result when
 * the control matched it: "no measurable difference" is the honest reading of
 * 11.1% against 9.2%, and an operator who skims should get that, not a number.
 */
export function readOutcome(clickedRate, controlRate) {
  if (clickedRate == null) return { tone: 'none', text: 'No clickers to measure.' }
  if (clickedRate === 0 && (controlRate ?? 0) === 0) return { tone: 'none', text: 'Nothing recorded either way.' }
  if (controlRate == null || controlRate === 0) {
    return clickedRate > 0
      ? { tone: 'good', text: 'Only clickers did this.' }
      : { tone: 'none', text: 'Nothing recorded either way.' }
  }
  const lift = clickedRate / controlRate
  // Thresholds are deliberately conservative. On these volumes (45 clickers,
  // 5 events) a 1.2x ratio is noise — the real Nutrable send produced exactly
  // that on class attendance, 11.1% vs 9.2%, and calling it "slightly above"
  // would be the panel committing the very error it exists to prevent. A
  // difference has to be half again as large before it is worth a word.
  if (lift >= 2) return { tone: 'good', text: `${lift.toFixed(1)}× the people who never opened it.` }
  if (lift >= 1.5) return { tone: 'mild', text: `Somewhat above the people who never opened it (${lift.toFixed(1)}×).` }
  return { tone: 'none', text: 'No measurable difference from people who never opened it.' }
}

export default function CampaignOutcomeReport({ campaignId }) {
  const [windowDays, setWindowDays] = useState(7)
  const [state, setState] = useState({ status: 'loading', data: null })

  useEffect(() => {
    let live = true
    setState(s => ({ ...s, status: 'loading' }))
    fetch(`/api/campaigns/${campaignId}/outcomes?window_days=${windowDays}`)
      .then(r => r.json())
      .then(j => {
        if (!live) return
        setState(j?.success
          ? { status: 'ready', data: j.data }
          : { status: 'error', data: null, error: j?.error || 'Could not load the outcome report' })
      })
      .catch(() => { if (live) setState({ status: 'error', data: null, error: 'Could not load the outcome report' }) })
    return () => { live = false }
  }, [campaignId, windowDays])

  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-sm text-un1t-subtle">
        <Loader2 size={14} className="animate-spin" /> Working out what this campaign produced…
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="flex items-start gap-2 text-sm text-rose-700">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />{state.error}
      </div>
    )
  }

  const { clicked, not_opened: control } = state.data

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-un1t-text">
          <Target size={15} className="text-un1t-subtle" aria-hidden="true" />
          <span className="font-medium">What happened next</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-un1t-subtle" id="outcome-window-label">Counted within</span>
          {WINDOW_OPTIONS.map(d => (
            <button
              key={d}
              type="button"
              onClick={() => setWindowDays(d)}
              aria-pressed={windowDays === d}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                windowDays === d
                  ? 'border-un1t-text/30 bg-un1t-text/[0.06] text-un1t-text font-medium'
                  : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {clicked.contacts === 0 ? (
        <p className="text-sm text-un1t-subtle">
          Nobody clicked a link in this campaign, so there is nothing to attribute to it.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-4 text-xs text-un1t-subtle">
            <span className="flex items-center gap-1.5">
              <Users size={13} aria-hidden="true" />
              <b className="text-un1t-text">{clicked.contacts.toLocaleString()}</b> clicked
            </span>
            <span>
              compared against <b className="text-un1t-text">{control.contacts.toLocaleString()}</b> who were sent it and never opened it
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Outcomes within {windowDays} days, for people who clicked compared with people who never opened
              </caption>
              <thead>
                <tr className="text-left text-xs text-un1t-subtle">
                  <th scope="col" className="py-1.5 pr-3 font-medium">Outcome</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Clicked</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Never opened</th>
                  <th scope="col" className="py-1.5 font-medium">Reading</th>
                </tr>
              </thead>
              <tbody>
                {METRICS.map(m => {
                  const reading = readOutcome(clicked.rates[m.key], control.rates[m.key])
                  const toneCls = reading.tone === 'good'
                    ? 'bg-green-500/10 text-green-700'
                    : reading.tone === 'mild'
                      ? 'bg-amber-500/10 text-amber-700'
                      : 'bg-slate-500/10 text-slate-700'
                  return (
                    <tr key={m.key} className="border-t border-un1t-border align-top">
                      <th scope="row" className="py-2 pr-3 font-normal text-un1t-text">
                        {m.label}
                        {m.note && <span className="block text-[11px] text-un1t-subtle">{m.note}</span>}
                      </th>
                      <td className="py-2 pr-3 text-un1t-text">
                        <b>{clicked[m.key].toLocaleString()}</b>
                        <span className="text-un1t-subtle"> · {pct(clicked.rates[m.key])}</span>
                      </td>
                      <td className="py-2 pr-3 text-un1t-subtle">
                        {control[m.key].toLocaleString()} · {pct(control.rates[m.key])}
                      </td>
                      <td className="py-2">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] ${toneCls}`}>
                          {reading.text}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] leading-relaxed text-un1t-subtle">
            Counted for {windowDays} days from each person&apos;s first click, and for the comparison group from when the
            email was sent. These are outcomes <b>attributed</b> to the campaign, not caused by it — the comparison
            group is what tells you the difference. Monthly membership payments are not counted: they run on direct
            debit and do not follow a click, so including them would credit the campaign with income it did not produce.
          </p>
        </>
      )}
    </div>
  )
}
