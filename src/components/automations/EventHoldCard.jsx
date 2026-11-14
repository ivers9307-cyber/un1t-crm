'use client'

// SHELLYEVENTS.3 — one number per studio: how long an event held here keeps
// the studio on after its last start time. Read by the Shelly timers and the
// air-conditioning automations (src/lib/event-hold.js). Saved through the same
// PUT /api/automations/[key] every other card uses; there is no on/off switch
// (events always count), so the row is always saved enabled.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, Loader2 } from 'lucide-react'
import {
  EVENT_HOLD_KEY, resolveEventHoldMinutes,
  DEFAULT_EVENT_HOLD_MINUTES, MIN_EVENT_HOLD_MINUTES, MAX_EVENT_HOLD_MINUTES,
} from '@/lib/event-hold'

export default function EventHoldCard({ locationId, locationName = '', initialConfig = null }) {
  const router = useRouter()
  const [minutes, setMinutes] = useState(String(resolveEventHoldMinutes(initialConfig)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  async function save(e) {
    e.preventDefault()
    const n = Number(minutes)
    if (!Number.isInteger(n) || n < MIN_EVENT_HOLD_MINUTES || n > MAX_EVENT_HOLD_MINUTES) {
      setError(`Enter a whole number of minutes between ${MIN_EVENT_HOLD_MINUTES} and ${MAX_EVENT_HOLD_MINUTES}.`)
      return
    }
    setBusy(true); setError(null); setSaved(false)
    try {
      const res = await fetch(`/api/automations/${EVENT_HOLD_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, enabled: true, config: { hold_minutes: n } }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.success === false) throw new Error(j.error || 'Save failed')
      setSaved(true)
      router.refresh()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={save} noValidate className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-center gap-2">
        <CalendarClock size={16} className="text-purple-700" />
        <h2 className="font-semibold text-un1t-text">Events keep the studio on</h2>
      </div>
      <p className="text-sm text-un1t-subtle mt-1">
        An event held at {locationName || 'this studio'} keeps its lights, power and air conditioning on like a class does.
        This is how long the studio stays on after the event&apos;s last start time.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="event-hold-minutes" className="block text-xs text-un1t-subtle mb-1">Keep the studio on for (minutes)</label>
          <input
            id="event-hold-minutes"
            type="number"
            min={MIN_EVENT_HOLD_MINUTES}
            max={MAX_EVENT_HOLD_MINUTES}
            step={5}
            value={minutes}
            onChange={(e) => { setMinutes(e.target.value); setSaved(false) }}
            className="w-32 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          />
        </div>
        <button type="submit" disabled={busy || !locationId}
          className="text-xs font-semibold px-3 py-2 rounded bg-un1t-text text-un1t-bg disabled:opacity-40">
          {busy ? <Loader2 size={12} className="animate-spin inline" /> : 'Save'}
        </button>
        {saved && <span className="text-[11px] text-emerald-700">Saved ✓</span>}
      </div>
      <p className="text-[11px] text-un1t-muted mt-2">
        Applies to every event held here, yours and a host&apos;s. An event with a longer duration stays on for its duration.
        Smart plug groups add their own time before and after. Default {DEFAULT_EVENT_HOLD_MINUTES} minutes.
      </p>
      {error && <p role="alert" className="mt-2 text-sm text-amber-700">{error}</p>}
    </form>
  )
}
