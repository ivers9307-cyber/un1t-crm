'use client'

// CANCEL-FORM.3 — the member-facing pause / cancel form.
//
// Reached from a staff-sent link (email or WhatsApp). Every word on it is
// operator-editable (Settings → Customer agent → Membership cancellation
// form) and arrives already rendered from the GET, so this component owns
// layout and flow only. Steps: pause offer → reason → end date → review →
// done. Shows the member's first name and plan up front so a forwarded link
// visibly lands on someone else's membership.
//
// Styling follows the public site (black ground, Poppins, the one white pill
// button) like PreferenceCentre, not the CRM's admin tokens.

import { useState, useEffect, useCallback } from 'react'

const CARD = 'bg-white/[0.06] border border-white/15 rounded-2xl'
const INPUT = 'w-full bg-black border border-white/25 rounded-xl px-4 py-3 text-white text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60'
const PRIMARY = 'inline-flex items-center justify-center w-full rounded-full bg-white text-black font-semibold py-3.5 px-6 disabled:opacity-40'
const SECONDARY = 'inline-flex items-center justify-center w-full rounded-full border border-white/30 text-white py-3.5 px-6 hover:bg-white/10 disabled:opacity-40'

function fill(template, vars) {
  return String(template || '').replace(/\{([a-z_]+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])))
}

function prettyDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export default function CancellationForm({ token }) {
  const [state, setState] = useState('loading') // loading | not_found | submitted | form | done
  const [data, setData] = useState(null)
  const [step, setStep] = useState('pause') // pause | reason | date | review
  const [choice, setChoice] = useState(null) // 'pause' | 'cancel'
  const [pauseStart, setPauseStart] = useState('')
  const [pauseEnd, setPauseEnd] = useState('')
  const [pauseNote, setPauseNote] = useState('')
  const [reasonCode, setReasonCode] = useState('')
  const [reasonText, setReasonText] = useState('')
  const [endDate, setEndDate] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [doneKind, setDoneKind] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/public/cancellation-form/${encodeURIComponent(token)}`, { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) { setState('not_found'); return }
      setData(j.data)
      if (j.data.state === 'submitted') { setDoneKind(j.data.submitted_kind); setState('submitted'); return }
      setStep(j.data.options.pause_offer_enabled ? 'pause' : 'reason')
      setPauseStart(j.data.options.today)
      setEndDate(j.data.options.min_end_date)
      setState('form')
    } catch {
      setState('not_found')
    }
  }, [token])

  useEffect(() => { load() }, [load])

  async function submit(body) {
    setSubmitting(true); setError(null)
    try {
      const res = await fetch(`/api/public/cancellation-form/${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (res.status === 404) { setState('not_found'); return }
      if (!res.ok || !j.success) { setError(j.error || 'Something went wrong. Please try again.'); return }
      setDoneKind(j.data?.kind || body.choice === 'pause' ? 'pause' : 'cancellation')
      setState('done')
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const shell = (children) => (
    <main className="min-h-screen bg-black text-white px-5 py-10">
      <div className="max-w-md mx-auto">
        {data?.branding?.logoUrl
          ? <img src={data.branding.logoUrl} alt={data.branding.companyName || ''} className="h-8 w-auto mb-8" />
          : <div className="text-lg font-display font-bold tracking-wide mb-8">{data?.branding?.companyName || ''}</div>}
        {children}
      </div>
    </main>
  )

  if (state === 'loading') return shell(<p className="text-white/60">Loading…</p>)

  if (state === 'not_found') {
    return shell(
      <div className={`${CARD} p-6`}>
        <h1 className="text-xl font-semibold mb-2">This link is no longer valid</h1>
        <p className="text-white/70">It may have expired or already been used. Reply to the message you received and the team will send a fresh one.</p>
      </div>,
    )
  }

  if (state === 'submitted' || state === 'done') {
    const kind = doneKind || 'cancellation'
    const text = kind === 'pause'
      ? fill(data.copy.thanks_pause_text, { start_date: prettyDate(pauseStart), end_date: prettyDate(pauseEnd) })
      : fill(data.copy.thanks_cancel_text, { end_date: prettyDate(endDate) })
    return shell(
      <div className={`${CARD} p-6`}>
        <h1 className="text-xl font-semibold mb-2">{state === 'done' ? 'Request received' : 'Already submitted'}</h1>
        <p className="text-white/80">{state === 'done' ? text : 'This form has already been sent to the team. They will be in touch.'}</p>
      </div>,
    )
  }

  const { copy, options, first_name: firstName, plan_name: planName } = data
  const pauseMaxEnd = pauseStart ? addDays(pauseStart, options.pause_max_weeks * 7) : ''

  return shell(
    <>
      <p className="text-white/60 text-sm mb-1">{firstName ? `${firstName}${planName ? ` · ${planName}` : ''}` : planName || ''}</p>
      <h1 className="text-2xl font-semibold mb-3">Your membership</h1>
      <p className="text-white/80 mb-6">{copy.form_intro}</p>

      {step === 'pause' && (
        <div className={`${CARD} p-6 space-y-4`}>
          <h2 className="text-lg font-semibold">Pause instead?</h2>
          <p className="text-white/80">{copy.pause_offer_text}</p>
          {choice === 'pause' ? (
            <div className="space-y-3">
              <label className="block text-sm text-white/70">Pause from
                <input type="date" className={`${INPUT} mt-1`} min={options.today} value={pauseStart}
                  onChange={(e) => setPauseStart(e.target.value)} />
              </label>
              <label className="block text-sm text-white/70">Until
                <input type="date" className={`${INPUT} mt-1`} min={pauseStart || options.today} max={pauseMaxEnd} value={pauseEnd}
                  onChange={(e) => setPauseEnd(e.target.value)} />
              </label>
              <label className="block text-sm text-white/70">Anything we should know? (optional)
                <textarea className={`${INPUT} mt-1`} rows={2} maxLength={1000} value={pauseNote} onChange={(e) => setPauseNote(e.target.value)} />
              </label>
              {error && <p className="text-sm text-red-300">{error}</p>}
              <button type="button" className={PRIMARY} disabled={submitting || !pauseStart || !pauseEnd}
                onClick={() => submit({ choice: 'pause', start_date: pauseStart, end_date: pauseEnd, note: pauseNote || undefined })}>
                {submitting ? 'Sending…' : 'Request this pause'}
              </button>
              <button type="button" className={SECONDARY} disabled={submitting} onClick={() => { setChoice(null); setError(null) }}>Back</button>
            </div>
          ) : (
            <div className="space-y-3">
              <button type="button" className={PRIMARY} onClick={() => setChoice('pause')}>Pause my membership</button>
              <button type="button" className={SECONDARY} onClick={() => { setChoice('cancel'); setStep('reason') }}>No thanks, continue to cancel</button>
            </div>
          )}
        </div>
      )}

      {step === 'reason' && (
        <div className={`${CARD} p-6 space-y-4`}>
          <h2 className="text-lg font-semibold">What is the main reason?</h2>
          <div className="space-y-2">
            {options.reasons.map((r) => (
              <label key={r.code} className={`flex items-center gap-3 rounded-xl border px-4 py-3 cursor-pointer ${reasonCode === r.code ? 'border-white bg-white/10' : 'border-white/20'}`}>
                <input type="radio" name="reason" className="accent-white" checked={reasonCode === r.code} onChange={() => setReasonCode(r.code)} />
                <span>{r.label}</span>
              </label>
            ))}
          </div>
          <label className="block text-sm text-white/70">Anything you would like to add? (optional)
            <textarea className={`${INPUT} mt-1`} rows={3} maxLength={1000} value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
          </label>
          <button type="button" className={PRIMARY} disabled={!reasonCode} onClick={() => setStep('date')}>Continue</button>
          {options.pause_offer_enabled && (
            <button type="button" className={SECONDARY} onClick={() => { setChoice(null); setStep('pause') }}>Back</button>
          )}
        </div>
      )}

      {step === 'date' && (
        <div className={`${CARD} p-6 space-y-4`}>
          <h2 className="text-lg font-semibold">When should it end?</h2>
          <p className="text-white/80">{copy.end_date_help_text}</p>
          <input type="date" className={INPUT} min={options.min_end_date} max={options.max_end_date} value={endDate}
            onChange={(e) => setEndDate(e.target.value)} />
          <button type="button" className={PRIMARY} disabled={!endDate} onClick={() => setStep('review')}>Continue</button>
          <button type="button" className={SECONDARY} onClick={() => setStep('reason')}>Back</button>
        </div>
      )}

      {step === 'review' && (
        <div className={`${CARD} p-6 space-y-4`}>
          <h2 className="text-lg font-semibold">Check the details</h2>
          <p className="text-white/80">{copy.confirm_text}</p>
          <dl className="text-sm space-y-2">
            <div className="flex justify-between gap-4"><dt className="text-white/60">Membership</dt><dd>{planName || 'Current membership'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-white/60">Reason</dt><dd className="text-right">{options.reasons.find((r) => r.code === reasonCode)?.label}</dd></div>
            {reasonText.trim() && <div className="flex justify-between gap-4"><dt className="text-white/60">Note</dt><dd className="text-right">{reasonText.trim()}</dd></div>}
            <div className="flex justify-between gap-4"><dt className="text-white/60">End date</dt><dd>{prettyDate(endDate)}</dd></div>
          </dl>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 accent-white" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>This is my membership and I want to cancel it.</span>
          </label>
          {error && <p className="text-sm text-red-300">{error}</p>}
          <button type="button" className={PRIMARY} disabled={!confirm || submitting}
            onClick={() => submit({ choice: 'cancel', reason_code: reasonCode, reason_text: reasonText || undefined, requested_end_date: endDate, confirm: true })}>
            {submitting ? 'Sending…' : 'Send cancellation request'}
          </button>
          <button type="button" className={SECONDARY} disabled={submitting} onClick={() => setStep('date')}>Back</button>
        </div>
      )}
    </>,
  )
}

// YYYY-MM-DD + n days, string arithmetic (UTC anchored so no TZ drift).
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) + n * 86400_000
  return new Date(t).toISOString().slice(0, 10)
}
