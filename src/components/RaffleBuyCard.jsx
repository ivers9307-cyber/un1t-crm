'use client'
// RAFFLE.3 — "Buy raffle tickets" on the public charity event page, for people
// who can't come on the day.
//
// POST /api/public/events/[slug]/raffle → the same embedded Revolut checkout
// the donate card uses (ClassFunnelCheckout) → poll
// GET /api/public/raffle-orders/[id] until the server reports the order paid
// AND its tickets numbered, then show the numbers. A return from a redirect
// checkout (?raffle_order=<id>) mounts straight into `confirming`.
//
// The prices shown are priceForQuantity's, the same rule the server charges.

import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Minus, Plus, Ticket } from 'lucide-react'
import ClassFunnelCheckout from './landing-page/ClassFunnelCheckout'
import { formatEuros, formatTicketList, optionLabel, priceForQuantity } from '@/lib/raffle-format'

export const RAFFLE_ANCHOR_ID = 'raffle'
const STATUS_PATH = '/api/public/raffle-orders'
const POLL_MS = 3000
const POLL_BUDGET = 40

const inputCls = (invalid) =>
  `w-full bg-white/5 border rounded-xl px-3.5 py-3 text-[15px] text-white placeholder-white/35 focus:outline-none focus:bg-white/10 transition-colors ${invalid ? 'border-red-400/70 focus:border-red-400' : 'border-white/15 focus:border-white/45'}`
const labelCls = 'block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55 mb-2'
const errCls = 'text-[11px] text-red-400 mt-1'
const cardCls = 'lp-card-glow rounded-2xl p-6 scroll-mt-4'
const chipCls = (selected) =>
  `py-3 px-2 rounded-xl border text-[14px] font-semibold tabular-nums transition-colors ${selected ? 'border-white bg-white text-black' : 'border-white/15 bg-white/5 text-white hover:border-white/40'}`

function stripOrderParam() {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('raffle_order')) return
    url.searchParams.delete('raffle_order')
    window.history.replaceState(null, '', url.toString())
  } catch { /* ignore */ }
}

export default function RaffleBuyCard({ slug, raffle, resumeOrderId = null }) {
  const currency = raffle?.currency || 'EUR'
  const max = raffle?.max_tickets || 50
  const [quantity, setQuantity] = useState(() => (raffle?.ticket_options?.[0]?.tickets) || 1)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [step, setStep] = useState(resumeOrderId ? 'confirming' : 'form')
  const [order, setOrder] = useState(null)
  const [done, setDone] = useState(null) // { first, last, quantity }
  const [slow, setSlow] = useState(false)
  const orderIdRef = useRef(resumeOrderId)

  const price = priceForQuantity(raffle, quantity)
  const choices = [{ tickets: 1, price_cents: raffle.ticket_price_cents }, ...(raffle.ticket_options || [])]

  async function submit(e) {
    e.preventDefault()
    if (submitting) return
    const errs = {}
    if (!name.trim()) errs.name = 'Enter your name'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = 'Enter a valid email'
    setFieldErrors(errs)
    if (Object.keys(errs).length) return
    setSubmitting(true)
    setError(null)
    try {
      const r = await fetch(`/api/public/events/${slug}/raffle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity, name: name.trim(), email: email.trim() }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j?.success || !j?.data?.order?.id) {
        setError(j?.error || 'Something went wrong. Please try again.')
        return
      }
      orderIdRef.current = j.data.order.id
      setOrder(j.data.order)
      setStep('payment')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // After payment (in page or a redirect return): poll until the tickets exist.
  useEffect(() => {
    if (step !== 'confirming') return
    const id = orderIdRef.current
    if (!id) { setStep('form'); return }
    let stopped = false
    let ticks = 0
    const tick = async () => {
      if (stopped) return
      try {
        const r = await fetch(`${STATUS_PATH}/${id}`, { cache: 'no-store' })
        if (r.status === 404) {
          if (!stopped) { setStep('form'); setError('We could not find that order. Please start again.') }
          return
        }
        const j = await r.json().catch(() => ({}))
        const d = j?.data
        if (stopped) return
        if (d?.state === 'paid' && d.tickets) {
          stripOrderParam()
          setDone({ first: d.tickets.first, last: d.tickets.last, quantity: d.quantity })
          setStep('done')
          return
        }
        if (d?.state === 'failed') {
          stripOrderParam()
          setStep('form')
          setError('That payment did not go through. Nothing was charged; please try again.')
          return
        }
      } catch { /* keep polling */ }
      if (stopped) return
      if (++ticks < POLL_BUDGET) setTimeout(tick, POLL_MS)
      else setSlow(true)
    }
    const t = setTimeout(tick, 600)
    return () => { stopped = true; clearTimeout(t) }
  }, [step])

  if (step === 'done' && done) {
    return (
      <div id={RAFFLE_ANCHOR_ID} className={cardCls} role="status">
        <div className="w-11 h-11 rounded-full bg-white/10 border border-white/20 grid place-items-center mb-4">
          <Check size={20} className="text-white" />
        </div>
        <h2 className="text-2xl font-semibold text-white">You&apos;re in the draw!</h2>
        <p className="mt-2 text-[14px] text-white/70">Your ticket number{done.quantity === 1 ? '' : 's'}:</p>
        <p className="mt-1 text-xl font-semibold text-white tabular-nums break-words">{formatTicketList(done.first, done.last)}</p>
        <p className="mt-3 text-[13px] text-white/60">We&apos;ve emailed them to you too. Good luck!</p>
      </div>
    )
  }

  if (step === 'confirming') {
    return (
      <div id={RAFFLE_ANCHOR_ID} className={`${cardCls} text-center`} role="status">
        {!slow && <Loader2 size={22} className="mx-auto mb-3 animate-spin text-white/60" />}
        <h2 className="text-lg font-semibold text-white">Getting your tickets</h2>
        <p className="mt-1 text-[13px] text-white/55">
          {slow
            ? 'This is taking longer than usual. If your payment went through, your ticket numbers will arrive by email.'
            : 'One moment while we confirm your payment.'}
        </p>
      </div>
    )
  }

  if (step === 'payment' && order) {
    return (
      <div id={RAFFLE_ANCHOR_ID} className={cardCls}>
        <ClassFunnelCheckout
          paymentId={order.id}
          checkout={order.checkout}
          priceLabel={`${order.quantity} raffle ticket${order.quantity === 1 ? '' : 's'} · ${formatEuros(order.amount_cents, order.currency || currency)}`}
          statusPath={STATUS_PATH}
          onPaid={() => setStep('confirming')}
          onCancel={() => setStep('form')}
          onFailed={() => { setStep('form'); setError('That payment did not go through. Nothing was charged; please try again.') }}
        />
      </div>
    )
  }

  return (
    <div id={RAFFLE_ANCHOR_ID} className={cardCls}>
      <div className="flex items-center gap-2">
        <Ticket size={18} className="text-white/70" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-white">{raffle.name || 'Raffle'}</h2>
      </div>
      {!raffle.open ? (
        <p className="text-[14px] text-white/60 mt-2">Online raffle sales have closed. Thank you to everyone who entered!</p>
      ) : (
        <>
          <p className="text-[13px] text-white/55 mt-1 mb-5">
            Can&apos;t make it on the day? Buy your tickets here and we&apos;ll email your numbers.
            {raffle.closes_label ? ` Online sales close ${raffle.closes_label}.` : ''}
          </p>
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div>
              <label className={labelCls}>Tickets</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {choices.map((o) => (
                  <button key={o.tickets} type="button" aria-pressed={quantity === o.tickets} onClick={() => setQuantity(o.tickets)} className={chipCls(quantity === o.tickets)}>
                    {o.tickets === 1 ? `1 for ${formatEuros(o.price_cents, currency).replace(/\.00$/, '')}` : optionLabel(o.tickets, o.price_cents)}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 mt-3">
                <button type="button" aria-label="One fewer" onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="h-11 w-11 rounded-xl border border-white/15 bg-white/5 text-white grid place-items-center"><Minus size={16} /></button>
                <input
                  type="number" inputMode="numeric" min="1" max={max} aria-label="Number of tickets"
                  value={quantity} onChange={(e) => setQuantity(Math.min(max, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                  className="h-11 w-20 rounded-xl border border-white/15 bg-white/5 text-center text-lg font-semibold text-white"
                />
                <button type="button" aria-label="One more" onClick={() => setQuantity((q) => Math.min(max, q + 1))} className="h-11 w-11 rounded-xl border border-white/15 bg-white/5 text-white grid place-items-center"><Plus size={16} /></button>
                <div className="ml-auto text-right">
                  <div className="text-xl font-semibold text-white tabular-nums">{formatEuros(price.cents, currency)}</div>
                  {price.label && <div className="text-[11px] text-white/55">{price.label}</div>}
                </div>
              </div>
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
            </div>
            {error && <p className="text-[13px] text-red-400" role="alert">{error}</p>}
            <button type="submit" disabled={submitting} className="lp-btn w-full mt-1 disabled:opacity-50 disabled:pointer-events-none">
              {submitting && <Loader2 size={16} className="animate-spin" />}
              <span>{submitting ? 'One moment…' : `Buy ${quantity} ticket${quantity === 1 ? '' : 's'} · ${formatEuros(price.cents, currency)}`}</span>
              {!submitting && <span className="lp-btn-arrow" aria-hidden="true">→</span>}
            </button>
          </form>
        </>
      )}
    </div>
  )
}
