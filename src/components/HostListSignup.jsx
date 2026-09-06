'use client'

// Public mailing-list signup form for /h/[slug] (HOST-EMAIL.2). Dark,
// host-branded, deliberately tiny: name + email + join (both required —
// a nameless lead is unusable for the host's outreach). The
// consent copy can now be host-customised (headline/blurb/button
// label/success message, mig 460) but the API's opt-in basis is
// unchanged — it stamps marketing consent TRUE regardless of copy. The
// unsubscribe promise remains in the default copy, and the unsubscribe
// link in every email footer is the actual binding mechanism, not the
// on-page wording. Inline success (no redirect); the API always answers
// { success: true } once the host resolves, so "done" here means "recorded
// or already on the list" — indistinguishable by design.
//
// HOST-CONSENT.1 — the footer names TWO independent consents: the host's
// own list (this form) and the studio's (UN1T / orgName) marketing. Both
// are granted by joining; either can be left independently.

import { useState } from 'react'

const INPUT_CLASS =
  'w-full rounded-lg border border-white/15 bg-white/5 px-4 py-3 text-sm text-white ' +
  'placeholder:text-white/40 focus:outline-none focus:border-white/40'

export default function HostListSignup({ slug, hostName, orgName, headline, blurb, buttonLabel, successMessage }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (submitting) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Enter your name.')
      return
    }
    const trimmedEmail = email.trim()
    if (!trimmedEmail) {
      setError('Enter your email address.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/public/host-list/${encodeURIComponent(slug)}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmedEmail,
          name: trimmedName,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) {
        throw new Error(j.error || 'Something went wrong — please try again.')
      }
      setDone(true)
    } catch (err) {
      setError(err.message || 'Something went wrong — please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className="w-full max-w-md text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/50">Mailing list</p>
        <h1 className="mt-3 text-3xl font-bold">You&apos;re on the list</h1>
        <p className="mt-4 text-sm text-white/70">
          {successMessage || `We'll email you about ${hostName}'s upcoming events. You can unsubscribe anytime from any email.`}
        </p>
      </div>
    )
  }

  return (
    <div className="w-full max-w-md">
      <p className="text-center text-xs font-semibold uppercase tracking-[0.3em] text-white/50">Mailing list</p>
      <h1 className="mt-3 text-center text-3xl font-bold">{headline || hostName}</h1>
      <p className="mt-3 text-center text-sm text-white/70">
        {blurb || `Get emails about ${hostName}'s events. Unsubscribe anytime.`}
      </p>

      <form onSubmit={submit} className="mt-8 space-y-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="Your name"
          maxLength={200}
          aria-label="Your name"
          className={INPUT_CLASS}
        />
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          maxLength={320}
          aria-label="Your email address"
          className={INPUT_CLASS}
        />
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-white px-4 py-3 text-sm font-semibold uppercase tracking-widest text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Joining…' : (buttonLabel || 'Join the list')}
        </button>
      </form>

      {error && <p className="mt-3 text-center text-sm text-red-400">{error}</p>}

      <p className="mt-6 text-center text-xs text-white/40">
        By joining you agree to receive emails from {hostName} about their events, and from {orgName || 'the studio'} about events and promotions. You can leave either list at any time.
      </p>
    </div>
  )
}
