'use client'

// EventWaitlistForm — EVENT-WAITLIST.1. The "join the waitlist" form on a
// SOLD-OUT event's public signup page (RaceSignupWidget renders it only when
// registration_state === 'full'). Posts to /api/public/events/[slug]/waitlist.
//
// 🔴 Never shows how many people are waiting, nor any capacity (Richard's
// rule): the server answers only "you're on the list" or a refusal.
//
// The success sentence and the field labels are short fixed transactional
// copy (they describe what the form just did, like a receipt); the offer
// email that goes out later is the operator-editable copy
// (race_events.waitlist_email_subject/intro).

import { useState } from 'react'
import { AlertCircle, Check, Loader2 } from 'lucide-react'

export const WAITLIST_SUCCESS_COPY =
  "You're on the list. If a spot opens, we'll email you (and WhatsApp if you gave a number); the first to book gets it."

function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

export default function EventWaitlistForm({ slug, allowedTeamSizes, sizeLabel = 'Group size', hostName = null, organizationName = null }) {
  const sizes = (Array.isArray(allowedTeamSizes) && allowedTeamSizes.length ? [...allowedTeamSizes] : [1]).sort((a, b) => a - b)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [headcount, setHeadcount] = useState(sizes[0])
  const [consent, setConsent] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) { setError('Add your name.'); return }
    if (!validEmail(email.trim())) { setError('Add a valid email.'); return }
    if (phone.trim() && phone.replace(/\D/g, '').length < 7) { setError('Enter a valid phone number, or leave it blank.'); return }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/public/events/${slug}/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          headcount,
          consent,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.success === false) {
        setError(json.error || 'Could not add you to the waitlist. Please try again.')
        return
      }
      setDone(true)
    } catch {
      setError('Could not add you to the waitlist. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls = 'w-full bg-white/5 border border-white/15 rounded-xl px-3.5 py-3 text-[15px] text-white placeholder-white/35 focus:outline-none focus:bg-white/10 focus:border-white/45 transition-colors'
  const labelCls = 'block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55 mb-2'

  if (done) {
    return (
      <div className="mb-5 p-4 rounded-xl bg-white/5 border border-white/15 text-white/85 text-sm flex items-start gap-2" role="status">
        <Check size={16} className="mt-0.5 shrink-0" />
        <span>{WAITLIST_SUCCESS_COPY}</span>
      </div>
    )
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="mb-6 p-4 rounded-xl border border-white/15 bg-white/[0.03] space-y-3" aria-label="Join the waitlist">
      <div>
        <h3 className="text-base font-semibold text-white">Join the waitlist</h3>
        <p className="text-[13px] text-white/55 mt-1">If a spot opens up, we&apos;ll let you know. The first to book gets it.</p>
      </div>
      <div>
        <label className={labelCls} htmlFor={`wl-name-${slug}`}>Name *</label>
        <input id={`wl-name-${slug}`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </div>
      <div>
        <label className={labelCls} htmlFor={`wl-email-${slug}`}>Email *</label>
        <input id={`wl-email-${slug}`} type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </div>
      <div>
        <label className={labelCls} htmlFor={`wl-phone-${slug}`}>Phone</label>
        <input id={`wl-phone-${slug}`} type="tel" className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="For a WhatsApp when a spot opens" />
      </div>
      {sizes.length > 1 && (
        <div>
          <label className={labelCls} htmlFor={`wl-size-${slug}`}>{sizeLabel}</label>
          <select id={`wl-size-${slug}`} className={inputCls} value={headcount} onChange={(e) => setHeadcount(Number(e.target.value))}>
            {sizes.map((n) => <option key={n} value={n} className="bg-black">{n}</option>)}
          </select>
        </div>
      )}
      {/* Worded like the register form's CONSENT.4 / HOST-CONSENT.1 checkbox. */}
      <label className="flex items-start gap-2.5 text-[12px] text-white/55 cursor-pointer select-none">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 shrink-0 accent-white" />
        <span>
          {hostName
            ? `Yes, send me emails from ${hostName} about their events, and promotional updates from ${organizationName || 'the studio'} via email, SMS or WhatsApp. You can leave either list at any time. Event-related notifications are sent regardless.`
            : 'Yes, send me UN1T promotional updates and offers via email, SMS or WhatsApp. You can unsubscribe at any time. Event-related notifications are sent regardless.'}
        </span>
      </label>
      {error && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm flex items-start gap-2" role="alert">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      <button type="submit" disabled={submitting} className="lp-btn w-full disabled:opacity-50 disabled:pointer-events-none">
        {submitting && <Loader2 size={16} className="animate-spin" />}
        <span>{submitting ? 'Joining…' : 'Join the waitlist'}</span>
      </button>
    </form>
  )
}
