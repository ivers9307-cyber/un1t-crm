'use client'

// One row per location on /settings/integrations. Shows the current
// connection state and offers a Connect / Disconnect / Reconnect
// action depending on the row's state. Also captures the per-org
// Xero "Email to Bills" address so the document → draft bill
// auto-forward has somewhere to send to.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plug, RefreshCw, Unlink, Mail, Check } from 'lucide-react'

function fmt(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}

export default function XeroLocationCard({ location, connection }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [billsEmail, setBillsEmail] = useState(connection?.bills_email_address || '')
  const [savingEmail, setSavingEmail] = useState(false)
  const [emailSaved, setEmailSaved] = useState(false)

  const onConnect = () => {
    window.location.href = `/api/xero/connect?location_id=${location.id}`
  }

  const onDisconnect = async () => {
    if (!confirm(`Disconnect Xero from ${location.name}? Future invoice pushes will fail until you reconnect.`)) return
    setBusy(true)
    try {
      const res = await fetch('/api/xero/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: location.id }),
      })
      const j = await res.json()
      if (!j.success) alert(j.error || 'Disconnect failed')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const onSaveBillsEmail = async (e) => {
    e?.preventDefault?.()
    const trimmed = (billsEmail || '').trim()
    setSavingEmail(true); setEmailSaved(false)
    try {
      const res = await fetch('/api/xero/bills-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: location.id, bills_email_address: trimmed || null }),
      })
      const j = await res.json()
      if (!j.success) {
        alert(j.error || 'Save failed')
        return
      }
      setEmailSaved(true)
      setTimeout(() => setEmailSaved(false), 1500)
      router.refresh()
    } finally {
      setSavingEmail(false)
    }
  }

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-un1t-white">{location.name}</div>
          {connection ? (
            <div className="text-xs text-un1t-light mt-1 space-y-0.5">
              <div>
                Connected to <span className="text-un1t-white">{connection.tenant_name || connection.tenant_id}</span>
              </div>
              <div className="text-un1t-mid">
                Linked {fmt(connection.connected_at)}
                {connection.last_refreshed_at && <> · refreshed {fmt(connection.last_refreshed_at)}</>}
              </div>
            </div>
          ) : (
            <div className="text-xs text-un1t-light mt-1">Not connected.</div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {connection ? (
            <>
              <button
                onClick={onConnect}
                disabled={busy}
                className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-gray/40 hover:bg-un1t-gray text-un1t-white rounded-md disabled:opacity-50"
              >
                <RefreshCw size={12} /> Reconnect
              </button>
              <button
                onClick={onDisconnect}
                disabled={busy}
                className="flex items-center gap-1 text-xs px-3 py-1.5 border border-red-500/40 hover:bg-red-500/10 text-red-400 rounded-md disabled:opacity-50"
              >
                <Unlink size={12} /> Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={onConnect}
              disabled={busy}
              className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-white text-un1t-black rounded-md font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              <Plug size={12} /> Connect Xero
            </button>
          )}
        </div>
      </div>

      {connection && (
        <div className="mt-4 pt-3 border-t border-un1t-gray/50">
          <label className="block text-xs uppercase tracking-wider text-un1t-light font-semibold mb-1">
            <Mail size={11} className="inline-block mr-1 mb-0.5" /> Email-to-Bills address
          </label>
          <p className="text-[11px] text-un1t-light mb-2">
            Find this in Xero under <strong>Business → Bills to pay → Create bill from email</strong>. Required for the &ldquo;Send to Xero&rdquo; button on supplier docs to work.
          </p>
          <form onSubmit={onSaveBillsEmail} className="flex items-center gap-2">
            <input
              type="email"
              value={billsEmail}
              onChange={e => setBillsEmail(e.target.value)}
              placeholder="bills+xxxxxxxxxx@xerofiles.com"
              className="flex-1 bg-un1t-black/30 border border-un1t-gray rounded-md px-3 py-1.5 text-xs text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-light"
            />
            <button
              type="submit"
              disabled={savingEmail}
              className="text-xs px-3 py-1.5 bg-un1t-white text-un1t-black rounded-md font-semibold hover:bg-un1t-accent disabled:opacity-50 inline-flex items-center gap-1"
            >
              {emailSaved ? <><Check size={12} /> Saved</> : (savingEmail ? 'Saving…' : 'Save')}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
