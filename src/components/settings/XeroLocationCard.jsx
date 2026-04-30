'use client'

// One row per location on /settings/integrations. Shows the current
// connection state and offers a Connect / Disconnect / Reconnect
// action depending on the row's state. Keeps state simple — re-fetch
// happens by full-page reload after disconnect since it's a rare op.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plug, RefreshCw, Unlink } from 'lucide-react'

function fmt(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}

export default function XeroLocationCard({ location, connection }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

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
    </div>
  )
}
