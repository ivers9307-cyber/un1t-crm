'use client'

// SUPPORT-ACCESS (Repset Phase 3) — persistent, unmissable banner shown
// across the whole app while a master is in a tenant support session.
// Distinct from ImpersonationBanner: it names the MODE (read-only vs
// acting-on-behalf) and the TENANT, offers a one-click mode switch, and
// an Exit that ends the session and returns to the Platform Console.
//
// The read-only ENFORCEMENT is server-side in src/proxy.js — this banner
// is purely the operator's situational awareness + controls.

import { useState } from 'react'
import { Eye, PencilLine, X, ShieldAlert } from 'lucide-react'

export default function SupportBanner({ user }) {
  const [busy, setBusy] = useState(false)
  const support = user?.supportSession
  if (!support) return null

  const readOnly = support.mode !== 'act_on_behalf'
  const tenant = support.organizationName || 'tenant'

  async function exit() {
    setBusy(true)
    try {
      await fetch('/api/support-session/exit', { method: 'POST' })
      // Hard navigation back to the Platform Console so every server
      // component re-resolves getCurrentUser() without the cookies.
      window.location.assign('/admin/tenants')
    } catch {
      setBusy(false)
    }
  }

  async function switchMode() {
    setBusy(true)
    try {
      await fetch('/api/support-session/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: readOnly ? 'act_on_behalf' : 'read_only' }),
      })
      window.location.reload()
    } catch {
      setBusy(false)
    }
  }

  // Read-only = calm slate/indigo (safe); act-on-behalf = amber caution
  // (writes are LIVE against a tenant).
  const wrap = readOnly
    ? 'bg-indigo-600 text-white border-indigo-700'
    : 'bg-amber-500 text-un1t-bg border-amber-600'
  const btnBase = readOnly
    ? 'bg-white/15 hover:bg-white/25 text-white'
    : 'bg-un1t-bg/90 hover:bg-un1t-bg text-amber-700'

  return (
    <div className={`text-sm flex items-center justify-between gap-3 px-4 py-2 shrink-0 border-b ${wrap}`}>
      <div className="flex items-center gap-2 min-w-0">
        {readOnly ? <Eye size={16} className="shrink-0" /> : <ShieldAlert size={16} className="shrink-0" />}
        <span className="truncate">
          {readOnly ? (
            <>
              <strong>Support mode: READ-ONLY</strong>
              <span className="opacity-80"> · {tenant}</span>
              <span className="opacity-70"> — writes are disabled</span>
            </>
          ) : (
            <>
              <strong>Acting on behalf of</strong>
              <span className="opacity-90"> · {tenant}</span>
              <span className="opacity-75"> — changes are LIVE</span>
            </>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={switchMode}
          disabled={busy}
          className={`flex items-center gap-1 text-xs font-semibold px-3 py-1 rounded-md disabled:opacity-50 ${btnBase}`}
        >
          {readOnly ? <PencilLine size={12} /> : <Eye size={12} />}
          {readOnly ? 'Act on behalf' : 'Back to read-only'}
        </button>
        <button
          type="button"
          onClick={exit}
          disabled={busy}
          className={`flex items-center gap-1 text-xs font-semibold px-3 py-1 rounded-md disabled:opacity-50 ${btnBase}`}
        >
          <X size={12} /> {busy ? 'Exiting…' : 'Exit'}
        </button>
      </div>
    </div>
  )
}
