'use client'

// Recipient-side signing form. Renders the contract body (frozen
// at issue time), shows the issuer's countersignature, and gives
// the recipient a typed-name signature box + decline option.
//
// On sign:
//   POST /api/contracts/[id]/sign { signature_value, signature_method: 'typed' }
//   → server stamps signed_at + IP + UA, flips status, fires the
//     two confirmation emails. We refresh on success so the
//     status flips on this page too.
//
// On decline:
//   POST /api/contracts/[id]/decline { declined_reason }

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, X } from 'lucide-react'

export default function ContractSignForm({ contract, recipientName }) {
  const router = useRouter()
  const [signature, setSignature] = useState(recipientName || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [showDecline, setShowDecline] = useState(false)
  const [declineReason, setDeclineReason] = useState('')

  async function handleSign() {
    if (!signature.trim()) {
      setError('Please type your full name to sign.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/contracts/${contract.id}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature_value: signature.trim(),
          signature_method: 'typed',
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      router.refresh()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  async function handleDecline() {
    if (!declineReason.trim()) {
      setError('Please tell us why you\'re declining.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/contracts/${contract.id}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ declined_reason: declineReason.trim() }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      router.refresh()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  if (showDecline) {
    return (
      <div className="bg-red-500/5 border border-red-500/30 rounded-lg p-4 print:hidden">
        <h3 className="text-sm font-semibold text-red-700 mb-2">Decline this contract</h3>
        <p className="text-xs text-un1t-light mb-3">
          Let UN1T Dublin know why you&apos;re declining. They&apos;ll be notified by email.
        </p>
        <textarea
          rows={3}
          value={declineReason}
          onChange={e => setDeclineReason(e.target.value)}
          placeholder="Reason (required)…"
          className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm"
        />
        {error && <p className="text-xs text-red-700 mt-2">{error}</p>}
        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={() => { setShowDecline(false); setError(null) }}
            className="text-xs px-3 py-1.5 rounded-md border border-un1t-gray text-un1t-light"
          >Cancel</button>
          <button
            type="button"
            onClick={handleDecline}
            disabled={busy}
            className="text-xs bg-red-600 text-white px-3 py-1.5 rounded-md font-medium disabled:opacity-50"
          >{busy ? 'Sending…' : 'Decline contract'}</button>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 md:p-5 print:hidden">
      <h3 className="text-sm font-semibold mb-2">Your signature</h3>
      <p className="text-xs text-un1t-light mb-3">
        Type your full name as it appears on the contract. By signing, you agree to the terms above.
      </p>
      <input
        type="text"
        value={signature}
        onChange={e => setSignature(e.target.value)}
        placeholder="Your full name"
        className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-3 text-base font-serif italic"
        style={{ fontFamily: 'Georgia, serif' }}
      />
      {error && <p className="text-xs text-red-700 mt-2">{error}</p>}
      <p className="text-[10px] text-un1t-mid mt-2">
        We record the time, your IP address, and browser to verify the signature for legal purposes (eIDAS Article 25).
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2 mt-4">
        <button
          type="button"
          onClick={() => setShowDecline(true)}
          className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-700 hover:bg-red-500/10 inline-flex items-center gap-1"
        >
          <X size={11} /> Decline
        </button>
        <button
          type="button"
          onClick={handleSign}
          disabled={busy || !signature.trim()}
          className="text-xs bg-un1t-white text-un1t-black px-4 py-1.5 rounded-md font-medium hover:bg-un1t-accent disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <Check size={12} /> {busy ? 'Signing…' : 'Sign contract'}
        </button>
      </div>
    </div>
  )
}
