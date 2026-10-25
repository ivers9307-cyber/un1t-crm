'use client'

// DonateCard — CHARITY.8: the card-donation card on the public event page,
// beside the signup card. Steps in one card: form (amount chips, an optional
// custom amount inside the operator's bounds, name/email/message, consent) →
// POST /api/public/events/[slug]/donate → payment (the same embedded checkout
// the class funnel uses, against the donation status route) → done.
//
// The done step polls GET /api/public/donations/[id] until the server reports
// `paid`, and only then thanks the donor: that poll is what runs the receipt
// and contact side effects, and a provider's in-page success callback alone
// does not mark the row paid. A return from a redirect checkout
// (?donation=<id>) mounts straight into `confirming` and polls the same way;
// `&cancelled=1` reopens the form instead. Once that poll settles (paid or
// failed) the `donation` and `cancelled` params are stripped from the URL, so a
// reload or a shared link does not show the outcome to everyone.
//
// Also exports the page furniture that only exists with donations on: the
// raised-so-far strip and the OR divider between the two cards.
import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Loader2 } from 'lucide-react'
import { formatCents, renderCharityCopy } from '@/lib/charity-donations'
import { readVisitOrigin } from '@/lib/visit-origin'
import ClassFunnelCheckout from './landing-page/ClassFunnelCheckout'

const STATUS_PATH = '/api/public/donations'
const NAME_KEY = (id) => `un1t_donation_first_name:${id}`
// ~2 minutes of polling, as the paid trial does.
const POLL_MS = 3000
const POLL_BUDGET = 40
// The donate route's attribution bounds: a long referrer is cut rather than
// refused, so it can never block a gift (the server sanitises what remains).
const MAX_REFERRER = 2000
const MAX_LANDING_PATH = 500

// Same recipes as the signup card in RaceSignupWidget.
const inputCls = (invalid) =>
  `w-full bg-white/5 border rounded-xl px-3.5 py-3 text-[15px] text-white placeholder-white/35 focus:outline-none focus:bg-white/10 transition-colors ${invalid ? 'border-red-400/70 focus:border-red-400' : 'border-white/15 focus:border-white/45'}`
const labelCls = 'block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55 mb-2'
const errCls = 'text-[11px] text-red-400 mt-1'
const cardCls = 'lp-card-glow rounded-2xl p-6'

// '€25' on a chip, '€12.50' when there are cents.
const chipLabel = (cents, currency) => formatCents(cents, currency).replace(/\.00$/, '')
const firstWord = (name) => String(name || '').trim().split(/\s+/)[0] || ''
// "Thank you, ." when the name is unknown (a redirect return) reads "Thank you."
const tidy = (s) => s.replace(/\s+([,.!?])/g, '$1').replace(/,([.!?])/g, '$1')
const matchedOf = (cents, multiplier) => Math.round(cents * (Number(multiplier) > 1 ? Number(multiplier) : 1))

function parseOther(text) {
  const n = Number(String(text).replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null
}

// Drop the redirect-return params once the outcome is shown; everything else
// (other params, the hash) stays.
function stripDonationParams() {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('donation') && !url.searchParams.has('cancelled')) return
    url.searchParams.delete('donation')
    url.searchParams.delete('cancelled')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  } catch { /* history unavailable: the URL just keeps the params */ }
}

function readStoredName(id) {
  try { return window.sessionStorage.getItem(NAME_KEY(id)) || '' } catch { return '' }
}
function storeName(id, firstName) {
  try { window.sessionStorage.setItem(NAME_KEY(id), firstName) } catch { /* storage blocked: the thank-you just omits the name */ }
}

export default function DonateCard({ slug, charity, currency = 'EUR', brand = '', resumeDonationId = null, resumeCancelled = false, onRaised }) {
  const resuming = !!resumeDonationId && !resumeCancelled
  // The operator's order, as the event form promises.
  const presets = Array.isArray(charity?.presets_cents) ? charity.presets_cents : []
  const customAllowed = !!charity?.custom_allowed
  const minCents = Number(charity?.min_cents) || 0
  const maxCents = Number(charity?.max_cents) || Infinity
  const multiplier = Number(charity?.match_multiplier) > 1 ? Number(charity.match_multiplier) : 1

  const [step, setStep] = useState(resuming ? 'confirming' : 'form') // form | payment | confirming | done
  const [choice, setChoice] = useState(presets[1] ?? presets[0] ?? (customAllowed ? 'other' : null))
  const [otherText, setOtherText] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [consent, setConsent] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})
  const [error, setError] = useState(resumeDonationId && resumeCancelled ? 'Your donation was cancelled. Nothing was charged; you can try again.' : null)
  const [submitting, setSubmitting] = useState(false)
  const [payment, setPayment] = useState(null) // the POST's donation: { id, amount_cents, currency, checkout }
  const [paid, setPaid] = useState(null) // the poll's paid row: { amount_cents, currency, match_multiplier }
  const [slow, setSlow] = useState(false) // poll budget spent without seeing paid
  // The thank-you's {{first_name}}: the entered name, or on a redirect return
  // what this tab stored before leaving (the status route returns no donor field).
  const [firstName, setFirstName] = useState(() => (resuming ? readStoredName(resumeDonationId) : ''))
  const donationIdRef = useRef(resuming ? resumeDonationId : null)
  const raisedRef = useRef(false)
  const cardRef = useRef(null)

  // A redirect return lands at the top of the page; bring the card into view.
  useEffect(() => {
    if (resumeDonationId) cardRef.current?.scrollIntoView?.({ block: 'center' })
  }, [resumeDonationId])

  const amountCents = choice === 'other' ? parseOther(otherText) : choice
  const amountError = (() => {
    if (choice !== 'other' || otherText === '') return null
    if (amountCents == null) return 'Enter an amount'
    if (amountCents < minCents) return `Minimum ${formatCents(minCents, currency)}`
    if (amountCents > maxCents) return `Maximum ${formatCents(maxCents, currency)}`
    return null
  })()

  const copyVars = (cents, mult, first) => ({
    charity: charity?.name || '',
    brand: brand || '',
    first_name: first || '',
    amount: cents ? formatCents(cents, currency) : '',
    matched: cents ? formatCents(matchedOf(cents, mult), currency) : '',
  })
  const formVars = copyVars(amountCents, multiplier, firstWord(name))

  async function submit(e) {
    e.preventDefault()
    if (submitting) return
    const errs = {}
    if (amountCents == null) errs.amount = choice === 'other' ? 'Enter an amount' : 'Choose an amount'
    else if (amountError) errs.amount = amountError
    if (!name.trim()) errs.name = 'Enter your name'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = 'Enter a valid email'
    setFieldErrors(errs)
    if (Object.keys(errs).length) return

    setSubmitting(true)
    setError(null)
    try {
      const body = {
        amount_cents: amountCents,
        name: name.trim(),
        email: email.trim(),
        ...(message.trim() ? { message: message.trim() } : {}),
        marketing_opt_in: consent,
      }
      const attribution = readVisitOrigin()
      if (attribution) {
        body.attribution = {
          referrer: attribution.referrer.slice(0, MAX_REFERRER),
          landing_path: attribution.landing_path.slice(0, MAX_LANDING_PATH),
        }
      }
      const r = await fetch(`/api/public/events/${slug}/donate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j?.success || !j?.data?.donation?.id) {
        const msg = j?.error || 'Something went wrong. Please try again.'
        if (j?.code === 'invalid_amount') setFieldErrors({ amount: msg })
        else setError(msg)
        return
      }
      const donation = j.data.donation
      donationIdRef.current = donation.id
      setFirstName(firstWord(name))
      storeName(donation.id, firstWord(name))
      setPayment(donation)
      setStep('payment')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // Confirming (redirect return) and done (in-page success): poll until the
  // server has seen the donation paid. Stops on paid, failed or not found.
  useEffect(() => {
    if (step !== 'confirming' && step !== 'done') return
    if (paid) return
    const id = donationIdRef.current
    if (!id) { setStep('form'); return }
    let stopped = false
    let ticks = 0
    const tick = async () => {
      if (stopped) return
      try {
        const r = await fetch(`${STATUS_PATH}/${id}`, { cache: 'no-store' })
        if (r.status === 404) {
          if (!stopped) { setStep('form'); setError('We could not find that donation. Please start again.') }
          return
        }
        const j = await r.json().catch(() => ({}))
        const d = j?.data
        if (stopped) return
        if (d?.state === 'paid') {
          stripDonationParams()
          setPaid({ amount_cents: d.amount_cents, currency: d.currency, match_multiplier: d.match_multiplier })
          setStep('done')
          if (!raisedRef.current) { raisedRef.current = true; onRaised?.() }
          return
        }
        if (d?.state === 'failed') {
          stripDonationParams()
          setStep('form')
          setError('That payment did not go through. Nothing was charged; please try again.')
          return
        }
      } catch { /* keep polling */ }
      if (stopped) return
      if (++ticks < POLL_BUDGET) setTimeout(tick, POLL_MS)
      else setSlow(true)
    }
    const t = setTimeout(tick, step === 'confirming' ? 300 : 1000)
    return () => { stopped = true; clearTimeout(t) }
    // onRaised is a fresh closure each parent render; the poll keys on the step only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, paid])

  if (step === 'done' && paid) {
    const cents = paid.amount_cents ?? payment?.amount_cents ?? amountCents
    const mult = Number(paid.match_multiplier ?? multiplier)
    const cur = paid.currency || currency
    const vars = { ...copyVars(cents, mult, firstName), amount: formatCents(cents, cur), matched: formatCents(matchedOf(cents, mult), cur) }
    const bodyTpl = mult > 1 ? charity?.thank_you_body : charity?.thank_you_body_unmatched
    return (
      <div ref={cardRef} className={cardCls} role="status">
        <div className="w-11 h-11 rounded-full bg-white/10 border border-white/20 grid place-items-center mb-4">
          <Check size={20} className="text-white" />
        </div>
        <h2 className="text-2xl font-semibold text-white">{tidy(renderCharityCopy(charity?.thank_you_title || '', vars))}</h2>
        <p className="mt-2 text-[14px] text-white/70 leading-relaxed">{renderCharityCopy(bodyTpl || '', vars)}</p>
        {email.trim() && (
          <p className="mt-2 text-[14px] text-white/70">A receipt is on its way to {email.trim()}.</p>
        )}
      </div>
    )
  }

  if (step === 'confirming' || step === 'done') {
    return (
      <div ref={cardRef} className={`${cardCls} text-center`} role="status">
        {!slow && <Loader2 size={22} className="mx-auto mb-3 animate-spin text-white/60" />}
        <h2 className="text-lg font-semibold text-white">Confirming your donation</h2>
        <p className="mt-1 text-[13px] text-white/55">
          {slow
            ? 'This is taking longer than usual. If your payment went through, your receipt will arrive by email.'
            : 'One moment while we check with the bank.'}
        </p>
        {slow && (
          <button type="button" onClick={() => { setSlow(false); setStep('form') }} className="mt-4 text-[13px] text-white/60 underline underline-offset-2 hover:text-white">
            Start a new donation
          </button>
        )}
      </div>
    )
  }

  if (step === 'payment' && payment) {
    return (
      <div ref={cardRef} className={cardCls}>
        <ClassFunnelCheckout
          paymentId={payment.id}
          checkout={payment.checkout}
          priceLabel={`${charity?.name ? `Donation to ${charity.name}` : 'Donation'} · ${formatCents(payment.amount_cents, payment.currency || currency)}`}
          statusPath={STATUS_PATH}
          onPaid={() => setStep('done')}
          onCancel={() => setStep('form')}
        />
      </div>
    )
  }

  const consentText = (charity?.consent_label || '').trim()
    || `${brand ? `Yes, send me ${brand} promotional updates and offers via email, SMS or WhatsApp.` : 'Yes, send me promotional updates and offers via email, SMS or WhatsApp.'} You can unsubscribe at any time.`
  const heading = renderCharityCopy(charity?.heading || '', formVars)
  const blurb = renderCharityCopy(charity?.blurb || '', formVars)
  const chipCls = (selected) =>
    `py-3 rounded-xl border text-[15px] font-semibold tabular-nums transition-colors ${selected ? 'border-white bg-white text-black' : 'border-white/15 bg-white/5 text-white hover:border-white/40'}`

  return (
    <div ref={cardRef} className={cardCls}>
      {heading && <h2 className="text-lg font-semibold text-white">{heading}</h2>}
      {blurb && <p className="text-[13px] text-white/55 mt-1 mb-5">{blurb}</p>}

      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label className={labelCls}>Amount</label>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {presets.map((c) => (
              <button key={c} type="button" aria-pressed={choice === c} onClick={() => { setChoice(c); setFieldErrors((f) => ({ ...f, amount: undefined })) }} className={chipCls(choice === c)}>
                {chipLabel(c, currency)}
              </button>
            ))}
            {customAllowed && (
              <button type="button" aria-pressed={choice === 'other'} onClick={() => setChoice('other')} className={chipCls(choice === 'other')}>
                Other
              </button>
            )}
          </div>
          {choice === 'other' && (
            <input
              type="number"
              inputMode="decimal"
              min={minCents / 100}
              max={Number.isFinite(maxCents) ? maxCents / 100 : undefined}
              step="0.01"
              aria-label="Other amount"
              placeholder={`Amount, ${formatCents(minCents, currency)} or more`}
              value={otherText}
              onChange={(e) => { setOtherText(e.target.value); setFieldErrors((f) => ({ ...f, amount: undefined })) }}
              className={`mt-2 ${inputCls(!!(amountError || fieldErrors.amount))}`}
            />
          )}
          {(amountError || fieldErrors.amount) && <p className={errCls}>{amountError || fieldErrors.amount}</p>}
        </div>

        <div className="pt-4 border-t border-white/10 space-y-2.5">
          <label className={labelCls}>Your details</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <input type="text" required maxLength={120} autoComplete="name" placeholder="Your name *" value={name} onChange={(e) => setName(e.target.value)} className={inputCls(!!fieldErrors.name)} />
              {fieldErrors.name && <p className={errCls}>{fieldErrors.name}</p>}
            </div>
            <div>
              <input type="email" required maxLength={254} autoComplete="email" placeholder="Your email *" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls(!!fieldErrors.email)} />
              {fieldErrors.email && <p className={errCls}>{fieldErrors.email}</p>}
            </div>
          </div>
          <input type="text" maxLength={280} placeholder="Message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} className={inputCls(false)} />
        </div>

        <label className="flex items-start gap-2.5 text-[12px] text-white/55 cursor-pointer select-none">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 shrink-0 accent-white" />
          <span>{consentText}</span>
        </label>

        {error && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-200 text-sm flex items-start gap-2" role="alert">
            <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <button type="submit" disabled={submitting} className="lp-btn w-full mt-1 disabled:opacity-50 disabled:pointer-events-none">
          {submitting && <Loader2 size={16} className="animate-spin" />}
          <span>{submitting ? 'One moment…' : amountCents && !amountError ? `Donate ${formatCents(amountCents, currency)}` : 'Donate'}</span>
          {!submitting && <span className="lp-btn-arrow" aria-hidden="true">→</span>}
        </button>
        {multiplier > 1 && amountCents && !amountError && (
          <p className="text-[12px] text-white/55 text-center">
            {[renderCharityCopy(charity?.match_label || '', formVars), `${formatCents(matchedOf(amountCents, multiplier), currency)}${charity?.name ? ` to ${charity.name}` : ''}`].filter(Boolean).join(' · ')}
          </p>
        )}
      </form>
    </div>
  )
}

// The one-line "raised so far" strip above the two cards. Rendered only when
// the operator shows the total and the server sent one (the totals keys are
// dropped when the read fails).
export function CharityRaisedStrip({ charity, currency = 'EUR', brand = '' }) {
  if (!charity?.show_total || !Number.isFinite(Number(charity.raised_cents))) return null
  const raised = Number(charity.raised_cents)
  const goal = Number(charity.goal_cents) > 0 ? Number(charity.goal_cents) : null
  const pct = goal ? Math.min(100, Math.round((raised / goal) * 100)) : 0
  const matched = Number(charity.match_multiplier) > 1
    ? renderCharityCopy(charity.match_label || '', { charity: charity.name || '', brand: brand || '', first_name: '', amount: '', matched: '' })
    : ''
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  const sub = [
    goal ? `Goal ${formatCents(goal, currency)}` : null,
    Number.isFinite(Number(charity.donation_count)) ? plural(Number(charity.donation_count), 'donor') : null,
    Number.isFinite(Number(charity.team_count)) ? plural(Number(charity.team_count), 'team') : null,
  ].filter(Boolean).join(' · ')
  return (
    <div className="mb-8 pb-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="text-[28px] font-bold leading-none text-white whitespace-nowrap tabular-nums">
        {formatCents(raised, currency)}{' '}
        <span className="text-[13px] font-medium text-white/60">raised so far{matched ? ` · ${matched}` : ''}</span>
      </div>
      {goal && (
        <div
          role="progressbar"
          aria-label="Progress to goal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="flex-1 min-w-[160px] max-w-[520px] h-2 rounded-full bg-white/10 overflow-hidden"
        >
          <div className="h-full rounded-full bg-white" style={{ width: `${pct}%` }} />
        </div>
      )}
      {sub && <div className="text-[12px] text-white/60 whitespace-nowrap">{sub}</div>}
    </div>
  )
}

// The OR between the donate card and the signup card: a vertical rule on wide
// screens, horizontal when the cards stack.
export function OrDivider() {
  return (
    <div role="separator" aria-label="or" className="flex md:flex-col md:self-stretch items-center justify-center gap-3 md:py-6">
      <div aria-hidden="true" className="flex-1 h-px md:h-auto md:w-px bg-white/10" />
      <div className="w-12 h-12 shrink-0 rounded-full border border-white/15 bg-black grid place-items-center text-[12px] font-semibold tracking-[0.14em] text-white/60">
        OR
      </div>
      <div aria-hidden="true" className="flex-1 h-px md:h-auto md:w-px bg-white/10" />
    </div>
  )
}
