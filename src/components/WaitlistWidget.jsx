'use client'

// Public waitlist form. Posts to /api/public/leads with the page's
// public_path; the endpoint resolves the studio + tag/source. Mirrors
// the booking/event widgets' role: an interactive client island the
// (server-rendered) LeadFormBlock embeds.

import { useState } from 'react'

export default function WaitlistWidget({ publicPath, buttonLabel, successMessage, consentLabel }) {
  const [form, setForm] = useState({ first_name: '', email: '', phone: '', consent: false, company: '' })
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
        body: JSON.stringify({ ...form, public_path: publicPath }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || 'Something went wrong. Please try again.')
        setStatus('error')
        return
      }
      setStatus('done')
    } catch {
      setError('Something went wrong. Please try again.')
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <div className="rounded-lg border border-white/15 bg-white/5 px-6 py-8 text-center">
        <p className="text-lg font-semibold text-white">
          {successMessage || "You're on the list — we'll be in touch soon."}
        </p>
      </div>
    )
  }

  const inputCls =
    'w-full bg-white/5 border border-white/15 rounded-md px-3 py-2.5 text-sm text-white placeholder-white/40 focus:outline-none focus:border-white/40'

  return (
    <form onSubmit={onSubmit} className="space-y-3 text-left">
      {/* Honeypot — off-screen, not tab-focusable. Bots fill it; humans don't. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px', overflow: 'hidden' }}>
        <label>Company
          <input type="text" tabIndex={-1} autoComplete="off" value={form.company} onChange={set('company')} />
        </label>
      </div>

      <input className={inputCls} type="text"  required placeholder="Your name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="name" />
      <input className={inputCls} type="email" required placeholder="Email"     value={form.email}      onChange={set('email')}      maxLength={320} autoComplete="email" />
      <input className={inputCls} type="tel"   required placeholder="Phone"     value={form.phone}      onChange={set('phone')}      maxLength={50}  autoComplete="tel" />

      <label className="flex items-start gap-2 text-xs text-white/70 leading-relaxed">
        <input type="checkbox" required checked={form.consent} onChange={set('consent')} className="mt-0.5 shrink-0" />
        <span>
          {consentLabel || 'I’d like to hear from UN1T about the Hatch Street launch and offers by email, SMS and WhatsApp. I can opt out anytime.'}{' '}
          <a href="/privacy" target="_blank" rel="noreferrer" className="underline hover:text-white">Privacy</a>
        </span>
      </label>

      {error && <p className="text-sm text-red-300">{error}</p>}

      <button
        type="submit"
        disabled={status === 'submitting'}
        className="w-full bg-white text-black font-semibold text-sm py-3 rounded-full hover:bg-white/90 disabled:opacity-60 transition-colors"
      >
        {status === 'submitting' ? 'Submitting…' : (buttonLabel || 'Join the waitlist')}
      </button>
    </form>
  )
}
