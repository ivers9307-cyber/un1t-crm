'use client'

// FEES.3 — the member's appeal form on /fee-appeal/<token>. A dark studio
// page, so the low-contrast ramp rules for light cards do not apply here.

import { useState } from 'react'

const REASONS = [
  { value: 'illness', label: 'I was ill' },
  { value: 'injury', label: 'I was injured' },
  { value: 'emergency', label: 'An emergency came up' },
  { value: 'other', label: 'Something else' },
]

export default function FeeAppealForm({ token }) {
  const [reason, setReason] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/public/fee-appeal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, reason, text: text.trim() || undefined }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || 'Something went wrong. Please try again in a minute.')
      setDone(true)
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return <p className="text-lg text-white/90 leading-relaxed text-center">Thanks, we have your appeal. The fee is on hold until the team has looked at it.</p>
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-white/80">If something came up, tell us what happened. The fee is put on hold until the team has looked at it.</p>
      <fieldset className="space-y-2">
        <legend className="sr-only">What happened</legend>
        {REASONS.map((r) => (
          <label key={r.value} className="flex items-center gap-3 rounded-xl border border-white/15 px-4 py-3 cursor-pointer">
            <input type="radio" name="reason" value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} />
            <span>{r.label}</span>
          </label>
        ))}
      </fieldset>
      <label className="block">
        <span className="block text-sm text-white/70 mb-1">Anything you want to add (optional)</span>
        <textarea
          rows={4}
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-xl bg-white/5 border border-white/15 px-3 py-2 text-white"
        />
      </label>
      {err && <p className="text-sm text-red-300 bg-black">{err}</p>}
      <button
        type="submit"
        disabled={busy || !reason}
        className="w-full rounded-xl bg-white text-black font-semibold py-3 disabled:opacity-50"
      >
        {busy ? 'Sending…' : 'Send appeal'}
      </button>
    </form>
  )
}
