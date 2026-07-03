'use client'

// Public waitlist form. Posts to /api/public/leads with the page's
// public_path; the endpoint resolves the studio + tag/source. Mirrors
// the booking/event widgets' role: an interactive client island the
// (server-rendered) LeadFormBlock embeds.
//
// Conversion notes (WEBSITE-REDESIGN 2026-06): 3 fields + consent,
// nothing else — friction stays minimal. Inputs are 16px so iOS never
// zoom-jumps the viewport mid-form; the submit button is the page's
// one white pill; success replaces the form with an animated check so
// the visitor gets an unmistakable "done" moment.

import { useState } from 'react'

export default function WaitlistWidget({ publicPath, campaign, buttonLabel, successMessage, consentLabel }) {
  const [form, setForm] = useState({ first_name: '', email: '', phone: '', consent: false })
  const [status, setStatus] = useState('idle') // idle | submitting | done | error
  const [error, setError] = useState(null)

  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  async function onSubmit(e) {
    e.preventDefault()
    setStatus('submitting'); setError(null)
    try {
      const r = await fetch('/api/public/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, public_path: publicPath, ...(campaign ? { campaign } : {}) }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || 'Something went wrong. Please try again.')
        setStatus('error')
        return
      }
      // Meta Pixel standard Lead event. fbq only exists once the visitor
      // has accepted marketing cookies (CookieConsent loads it then), so
      // guard for it. This is the conversion signal Meta optimises ad
      // delivery toward; Ads Manager attributes it to the campaign/ad via
      // the landing URL's UTM params.
      if (typeof window !== 'undefined' && typeof window.fbq === 'function') {
        window.fbq('track', 'Lead')
      }
      setStatus('done')
    } catch {
      setError('Something went wrong. Please try again.')
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <div className="px-6 py-10 text-center" role="status">
        <span className="mx-auto mb-5 flex w-16 h-16 items-center justify-center rounded-full bg-white text-black">
          <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path className="lp-check-path" d="M20 6L9 17l-5-5" />
          </svg>
        </span>
        <p className="font-display font-extrabold uppercase tracking-wide text-2xl text-white mb-2">You&apos;re in</p>
        <p className="text-white/70 text-sm leading-relaxed max-w-xs mx-auto">
          {successMessage || "You're on the list — we'll be in touch soon."}
        </p>
      </div>
    )
  }

  const inputCls =
    'w-full bg-white/[0.06] border border-white/15 rounded-xl px-4 py-3.5 text-base text-white placeholder-white/40 transition-colors focus:outline-none focus:border-white/50 focus:bg-white/[0.09]'

  return (
    <form onSubmit={onSubmit} className="space-y-3.5 text-left">
      <input className={inputCls} type="text"  required placeholder="Your name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="name" aria-label="Your name" />
      <input className={inputCls} type="email" required placeholder="Email"     value={form.email}      onChange={set('email')}      maxLength={320} autoComplete="email" aria-label="Email" />
      <input className={inputCls} type="tel"   required placeholder="Phone"     value={form.phone}      onChange={set('phone')}      maxLength={50}  autoComplete="tel" aria-label="Phone" />

      <label className="flex items-start gap-2.5 text-xs text-white/65 leading-relaxed pt-1 cursor-pointer">
        <input
          type="checkbox"
          required
          checked={form.consent}
          onChange={set('consent')}
          className="mt-0.5 shrink-0 w-4 h-4 rounded accent-white cursor-pointer"
        />
        <span>
          {consentLabel || 'I’d like to hear from UN1T about the Hatch Street launch and offers by email, SMS and WhatsApp. I can opt out anytime.'}{' '}
          <a href="/privacy" target="_blank" rel="noreferrer" className="underline hover:text-white">Privacy</a>
        </span>
      </label>

      {error && (
        <p className="text-sm text-red-700 bg-red-500/10 border border-red-400/20 rounded-lg px-3 py-2" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={status === 'submitting'}
        className="lp-btn w-full disabled:opacity-60 disabled:hover:transform-none"
      >
        {status === 'submitting' ? (
          <>
            <span
              className="inline-block w-4 h-4 rounded-full border-2 border-black/25 border-t-black animate-spin"
              aria-hidden="true"
            />
            Submitting…
          </>
        ) : (
          <>
            {buttonLabel || 'Join the waitlist'}
            <span className="lp-btn-arrow" aria-hidden="true">→</span>
          </>
        )}
      </button>
      <p className="text-center text-[11px] text-white/40 pt-1">Takes 20 seconds. No spam — ever.</p>
    </form>
  )
}
