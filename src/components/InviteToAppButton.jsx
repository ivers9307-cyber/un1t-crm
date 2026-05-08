'use client'

// "Invite to App" — sends a magic-link invite for the customer-facing
// app (champ-app at app.champfitness.com).
//
// Two visual states:
//   - Not yet linked    → "Invite to App"
//   - Already linked    → "Resend sign-in link" (subtle secondary)
//
// We don't expose any of the auth complexity (existing-user fallback,
// link expiry, etc.) — the route handler does the right thing.

import { useState } from 'react'
import { Smartphone, Check } from 'lucide-react'

export default function InviteToAppButton({ contactId, hasUserAccount }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // { ok, message }

  async function send() {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/invite-app`, {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setResult({ ok: false, message: data.error || 'Failed to send invite' })
      } else {
        setResult({ ok: true, message: data.message || 'Invite sent' })
      }
    } catch (e) {
      setResult({ ok: false, message: e.message || 'Network error' })
    } finally {
      setBusy(false)
    }
  }

  const label = hasUserAccount ? 'Resend sign-in link' : 'Invite to App'
  const Icon = result?.ok ? Check : Smartphone

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={send}
        disabled={busy}
        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
          hasUserAccount
            ? 'bg-un1t-gray text-un1t-light hover:bg-un1t-gray/80'
            : 'bg-un1t-purple text-white hover:bg-un1t-purple/90'
        } disabled:opacity-50`}
        title={hasUserAccount
          ? 'Sends a fresh sign-in link to the member by email.'
          : 'Sends a magic-link invite by email so the member can sign in to app.champfitness.com.'}
      >
        <Icon size={14} />
        {busy ? 'Sending…' : label}
      </button>
      {result && (
        <span
          className={`text-xs ${result.ok ? 'text-green-400' : 'text-red-400'}`}
          role="status"
        >
          {result.message}
        </span>
      )}
    </div>
  )
}
