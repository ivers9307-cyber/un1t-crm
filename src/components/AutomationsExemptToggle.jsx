'use client'

// HOST-MASTER.6 — "No auto-enrol" badge + Manager+ toggle for
// contacts.automations_exempt (mig 464). The flag blocks AUTOMATIC
// sequence/automation enrolment only (manual staff enrolment ignores it) and
// is set on host-sourced contact creation. Everyone sees the chip while the
// flag is on; only Manager+ callers get the toggle (the PUT route's cookie
// path is Manager+-gated anyway — canToggle just hides a button that would
// 401 for staff). After unblocking, the button stays for one render until
// router.refresh() re-renders the server page (which only mounts this
// component while the flag is set) — acceptable.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function AutomationsExemptToggle({ contactId, initial, canToggle = false }) {
  const router = useRouter()
  const [value, setValue] = useState(!!initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function toggle() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ automations_exempt: !value }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || 'Update failed')
      }
      setValue(!value)
      router.refresh()
    } catch (e) {
      setError(e.message || 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {value && (
        <span
          title="Host-sourced contact — automatic sequence/automation enrolment is blocked. Manual enrolment still works."
          className="text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700"
        >
          No auto-enrol
        </span>
      )}
      {canToggle && (
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          className="text-[11px] text-un1t-subtle hover:text-un1t-text underline underline-offset-2 disabled:opacity-50"
        >
          {busy ? 'Saving…' : value ? 'Allow auto-enrol' : 'Block auto-enrol'}
        </button>
      )}
      {error && <span className="text-[11px] text-red-700">{error}</span>}
    </span>
  )
}
