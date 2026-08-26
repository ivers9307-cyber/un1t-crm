'use client'

// Enquiry form for the giversautos.com coming-soon page (GIVERS-WEB.1).
// POSTs to /api/public/givers-enquiry; success swaps the card content,
// failure surfaces the API error (which carries the phone number as
// the fallback contact). Styles live in page.js's scoped stylesheet.

import { useState } from 'react'

export default function EnquiryForm() {
  const [status, setStatus] = useState('idle') // idle | sending | sent | error
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (status === 'sending') return
    setStatus('sending')
    setError('')
    const form = new FormData(e.currentTarget)
    try {
      const res = await fetch('/api/public/givers-enquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: (form.get('name') || '').toString(),
          phone: (form.get('phone') || '').toString(),
          email: (form.get('email') || '').toString(),
          message: (form.get('message') || '').toString(),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.success) {
        setStatus('sent')
      } else {
        setStatus('error')
        setError(body.error || 'Could not send your enquiry. Please call us on 086 822 5779.')
      }
    } catch {
      setStatus('error')
      setError('Could not send your enquiry. Please call us on 086 822 5779.')
    }
  }

  if (status === 'sent') {
    return (
      <div className="givers-form-card givers-sent" role="status">
        <span className="givers-sent-mark" aria-hidden="true">✓</span>
        <h3>Thanks, we&apos;ll be in touch.</h3>
        <p>
          Your enquiry is with us. If it&apos;s urgent, call{' '}
          <a href="tel:+353868225779">086 822 5779</a>.
        </p>
      </div>
    )
  }

  return (
    <form className="givers-form-card" onSubmit={handleSubmit}>
      <div className="givers-field-row">
        <label className="givers-field">
          <span>Name *</span>
          <input name="name" required maxLength={120} autoComplete="name" placeholder="Your name" />
        </label>
        <label className="givers-field">
          <span>Phone *</span>
          <input name="phone" required maxLength={40} autoComplete="tel" inputMode="tel" placeholder="08X XXX XXXX" />
        </label>
      </div>
      <label className="givers-field">
        <span>Email</span>
        <input name="email" type="email" maxLength={320} autoComplete="email" placeholder="you@example.com (optional)" />
      </label>
      <label className="givers-field">
        <span>What are you looking for?</span>
        <textarea
          name="message"
          maxLength={2000}
          rows={4}
          placeholder="Make, model, budget, or anything else we can help with (optional)"
        />
      </label>
      {status === 'error' && (
        <p className="givers-form-error" role="alert">{error}</p>
      )}
      <button type="submit" className="givers-submit" disabled={status === 'sending'}>
        {status === 'sending' ? 'Sending…' : 'Send enquiry'}
      </button>
      <p className="givers-form-note">We&apos;ll only use your details to reply to this enquiry.</p>
    </form>
  )
}
