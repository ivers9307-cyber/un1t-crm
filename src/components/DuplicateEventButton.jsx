'use client'
// DuplicateEventButton — HOSTSERIES.1. "Duplicate" opens a small date form
// (default: a week after the source) and posts to `apiUrl`; on success the
// copy's edit page opens. Shared by the host event page (dark) and the staff
// events list (light): only the endpoint, the destination and the surface
// colour differ, so they are props.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Copy, Loader2 } from 'lucide-react'

/** YYYY-MM-DD plus `days`, on the calendar (no zone maths: a date, not an instant). */
export function addDays(isoDate, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ''))
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days))
  return d.toISOString().slice(0, 10)
}

export default function DuplicateEventButton({ eventId, raceDate, apiUrl, editHrefFor, dark = false }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(() => addDays(raceDate, 7))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const btn = dark
    ? 'rounded-lg border border-white/20 text-white text-sm px-4 py-2 hover:bg-white/5'
    : 'rounded-lg border border-un1t-border text-un1t-text text-sm px-3 py-1.5 hover:bg-un1t-bg'
  const input = dark
    ? 'bg-white/[0.04] border border-white/12 rounded-lg px-3 py-2 text-sm text-white [color-scheme:dark]'
    : 'bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'
  const label = dark ? 'text-xs uppercase tracking-wide text-white/45' : 'text-xs text-un1t-subtle'
  const errCls = dark ? 'text-sm text-amber-200' : 'text-sm text-amber-700'

  async function submit(e) {
    e.preventDefault()
    if (busy || !date) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ race_date: date }) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'The event could not be copied. Try again.')
        return
      }
      router.push(editHrefFor(json.data.id))
    } catch (err) {
      setError(err?.message || 'Network error. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={`${btn} inline-flex items-center gap-1.5`} title="Copy this event to a new date as a draft">
        <Copy size={13} /> Duplicate
      </button>
    )
  }
  return (
    <form onSubmit={submit} className="inline-flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor={`dup-date-${eventId}`} className={`block mb-1 ${label}`}>New date</label>
        <input id={`dup-date-${eventId}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} required />
      </div>
      <button type="submit" disabled={busy || !date} className={`${btn} inline-flex items-center gap-1.5 disabled:opacity-50`}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />} Create copy
      </button>
      <button type="button" onClick={() => { setOpen(false); setError(null) }} className={dark ? 'text-xs text-white/50 hover:text-white' : 'text-xs text-un1t-subtle hover:text-un1t-text'}>
        Cancel
      </button>
      {error && <p role="alert" className={`basis-full ${errCls}`}>{error}</p>}
    </form>
  )
}
