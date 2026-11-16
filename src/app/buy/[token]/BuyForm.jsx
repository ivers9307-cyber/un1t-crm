'use client'

// STAFFPAYLINK.1 — "Continue to payment" on /buy/<token>. A new customer ticks
// un1t.online's terms and waiver (the /trial tick, TrialTermsTick); an existing
// member just presses the button. The POST answers a hosted-checkout URL
// (followed once, never stored) or a state the card then shows. A
// `terms_required` answer (no account found after all) reveals the tick.
import { useState } from 'react'
import TrialTermsTick from '@/components/landing-page/TrialTermsTick'
import { TRIAL_BTN, TRIAL_ERROR } from '@/components/landing-page/trial-card'

export default function BuyForm({ token, isNew, terms, buttonText, messages }) {
  const [needsTerms, setNeedsTerms] = useState(!!isNew && !!terms)
  const [ticked, setTicked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (needsTerms && !ticked) {
      setError(terms?.required_message || 'Please accept the terms to continue.')
      return
    }
    setBusy(true)
    let kind = 'unavailable'
    try {
      const res = await fetch(`/api/public/buy/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptTerms: needsTerms && ticked }),
      })
      const body = await res.json().catch(() => null)
      kind = body?.data?.kind || 'unavailable'
      if (kind === 'redirect' && typeof body?.data?.url === 'string' && body.data.url) {
        window.location.assign(body.data.url)
        return
      }
    } catch {
      kind = 'unavailable'
    }
    setBusy(false)
    if (kind === 'terms_required') {
      // No terms to tick: pressing again would only loop, so show the help
      // line and stop (the form goes, the customer replies on WhatsApp).
      if (!terms) {
        setDone(messages?.help || messages?.unavailable || '')
        return
      }
      setNeedsTerms(true)
      setError(terms.required_message || messages?.help || '')
      return
    }
    if (kind === 'unavailable') {
      setError(messages?.unavailable || '')
      return
    }
    setDone(messages?.[kind] || messages?.expired || '')
  }

  if (done) return <p className="text-center text-lg leading-relaxed">{done}</p>

  return (
    <form onSubmit={submit} className="space-y-4">
      {needsTerms && terms ? <TrialTermsTick terms={terms} checked={ticked} onChange={setTicked} disabled={busy} /> : null}
      {error ? <p className={TRIAL_ERROR} role="alert">{error}</p> : null}
      <button type="submit" disabled={busy} className={TRIAL_BTN}>{buttonText}</button>
    </form>
  )
}
