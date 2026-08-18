'use client'

// "Invite to App" — sends a magic-link invite for the customer-facing
// member app.
//
// Two visual states:
//   - Not yet linked    → "Invite to App"
//   - Already linked    → "Resend sign-in link" (subtle secondary)
//
// We don't expose any of the auth complexity (existing-user fallback,
// link expiry, etc.) — the route handler does the right thing.

import { useState } from 'react'
import { Smartphone, Check } from 'lucide-react'

// REPSET-P6.S2 — the tooltip names the member-app host. Derived from the
// SAME env var the invite route builds the magic link with (NEXT_PUBLIC_*
// vars are inlined into the client bundle at build time), so the copy can
// never drift from where the invite actually lands; code default = the
// canonical repset member host.
const MEMBER_APP_HOST = (process.env.NEXT_PUBLIC_CHAMP_APP_URL || 'https://api.repset.ie')
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '')

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

  // Two visual variants. Both pin solid bg + white text against the
  // light page background (un1t-bg is white in this theme; the
  // earlier first-cut styling used un1t-border which is the panel
  // colour, leaving the button nearly invisible).
  //   - First-time invite: indigo, the brand-ish "go" colour. Stands out.
  //   - Resend: neutral slate. Clear it's a secondary, but still readable.
  const variantClasses = hasUserAccount
    ? 'bg-slate-600 text-white hover:bg-slate-500 border border-slate-700'
    : 'bg-indigo-600 text-white hover:bg-indigo-500 border border-indigo-700'

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={send}
        disabled={busy}
        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition shadow-sm ${variantClasses} disabled:opacity-50 disabled:cursor-not-allowed`}
        title={hasUserAccount
          ? 'Sends a fresh sign-in link to the member by email.'
          : `Sends a magic-link invite by email so the member can sign in to ${MEMBER_APP_HOST}.`}
      >
        <Icon size={14} />
        {busy ? 'Sending…' : label}
      </button>
      {result && (
        <span
          className={`text-xs font-medium ${result.ok ? 'text-green-700' : 'text-red-700'}`}
          role="status"
        >
          {result.message}
        </span>
      )}
    </div>
  )
}
