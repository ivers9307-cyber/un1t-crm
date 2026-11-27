'use client'

// EMBEDFORM.1 — the form inside /embed/lead/[path]. Posts to
// /api/public/leads with form: 'embed', where the marketing box is optional.
// The box starts TICKED (owner's choice, 26 Nov 2026); unticking it is
// recorded through applyOfferFormConsent on the server.

import { useState } from 'react'
import EmailTypoHint from '@/components/EmailTypoHint'
import { useTurnstile } from '@/components/useTurnstile'

const input = 'w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900'

export default function EmbedLeadForm({ publicPath, studioName }) {
  const turnstile = useTurnstile()
  const [form, setForm] = useState({ first_name: '', email: '', phone: '', consent: true })
  const [state, setState] = useState({ status: 'idle', error: '' })
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  async function submit(e) {
    e.preventDefault()
    if (!form.first_name.trim() || !form.email.trim() || !form.phone.trim()) {
      setState({ status: 'idle', error: 'Please fill in your name, email and phone.' })
      return
    }
    setState({ status: 'sending', error: '' })
    try {
      const res = await fetch('/api/public/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await turnstile.headers()) },
        body: JSON.stringify({ ...form, public_path: publicPath, form: 'embed' }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d?.success) setState({ status: 'done', error: '' })
      else setState({ status: 'idle', error: d?.error || 'Something went wrong. Please try again.' })
    } catch {
      setState({ status: 'idle', error: 'Something went wrong. Please try again.' })
    }
  }

  if (state.status === 'done') {
    return (
      <div className="max-w-md mx-auto text-center py-10" role="status">
        <p className="text-lg font-semibold text-neutral-900 mb-1">Thanks, you&apos;re on the list</p>
        <p className="text-sm text-neutral-600">{studioName ? `The ${studioName} team` : 'The team'} will be in touch soon.</p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="max-w-md mx-auto space-y-3" noValidate>
      <p className="text-lg font-semibold text-neutral-900">{studioName ? `Join ${studioName}` : 'Get in touch'}</p>
      <input className={input} placeholder="First name" aria-label="First name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="given-name" />
      <div>
        <input className={input} type="email" placeholder="Email" aria-label="Email" value={form.email} onChange={set('email')} maxLength={320} autoComplete="email" />
        <EmailTypoHint email={form.email} onAccept={(v) => setForm((f) => ({ ...f, email: v }))} className="mt-1 text-neutral-600" />
      </div>
      <input className={input} type="tel" placeholder="Phone" aria-label="Phone" value={form.phone} onChange={set('phone')} maxLength={50} autoComplete="tel" />
      <label className="flex items-start gap-2 text-xs text-neutral-600">
        <input type="checkbox" checked={form.consent} onChange={set('consent')} className="mt-0.5 w-4 h-4 accent-black" />
        <span>Send me news, offers and class updates by email and WhatsApp. You can unsubscribe at any time.</span>
      </label>
      {state.error && <p className="text-xs text-red-700" role="alert">{state.error}</p>}
      <button type="submit" disabled={state.status === 'sending'} className="w-full rounded-lg bg-neutral-900 text-white py-2.5 text-sm font-semibold disabled:opacity-60">
        {state.status === 'sending' ? 'Sending…' : 'Sign up'}
      </button>
    </form>
  )
}
