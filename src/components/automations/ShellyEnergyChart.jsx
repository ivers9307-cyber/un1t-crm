// SHELLY-UI.6 — a device's daily kWh, as plain divs.
//
// No charting dependency (the DASH-M.1 precedent): thirty bars whose only job
// is "which days did this plug draw power" do not justify a library, and a
// div with a height renders identically in every browser this app supports.
//
// Fetched on MOUNT, and the card only mounts it when the Energy section is
// expanded — so a page of ten devices costs zero energy queries until someone
// asks. Reads GET /api/shelly/devices/<id>/energy?days=N, which zero-fills
// every day in the range, so `days.length` is the range and not the number of
// rows on disk.
//
// THREE VALUES THAT LOOK ALIKE AND ARE NOT:
//   kwh 0 + samples 0  — no reading that day (the plug was unreachable, or it
//                        was not adopted yet). Rendered as an empty slot.
//   kwh 0 + samples >0 — we read it and it drew nothing. A real, flat day.
//   kwh null           — a row exists whose wh_total could not be read. Marked
//                        with a "?" rather than drawn as zero, because zero is
//                        a measurement and this is the absence of one.

'use client'

import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { fetchJson, errorText } from './shelly-fetch'

const BAR_MAX_PX = 56

// 'YYYY-MM-DD' → 'Mon 23'. Parsed as parts rather than through Date so the
// browser's timezone cannot shift a date-only string onto the day before.
function dayLabel(day) {
  const [y, m, d] = String(day || '').split('-').map(Number)
  if (!y || !m || !d) return String(day || '')
  return `${d}/${m}`
}

export default function ShellyEnergyChart({ deviceId, days = 30 }) {
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    fetchJson(`/api/shelly/devices/${encodeURIComponent(deviceId)}/energy?days=${days}`).then((res) => {
      if (!live) return
      setLoading(false)
      if (!res.ok || res.json?.success === false) {
        setError(errorText(res.json, 'Could not load this device’s energy history'))
        return
      }
      setState(res.json)
    })
    return () => { live = false }
  }, [deviceId, days])

  if (loading) return <p className="text-xs text-un1t-subtle">Loading energy…</p>
  if (error) {
    return (
      <p className="flex items-center gap-1 text-xs text-red-700" role="alert">
        <AlertCircle size={12} aria-hidden="true" /> {error}
      </p>
    )
  }

  const rows = state?.days || []
  // "Nothing has ever been read" is different from "it drew nothing" — a
  // studio that has just adopted a plug should be told readings are coming,
  // not shown a month of confident zeroes.
  const anySamples = rows.some((r) => (r.samples || 0) > 0)
  if (!rows.length || !anySamples) {
    return <p className="text-xs text-un1t-subtle">No energy data yet — readings accrue once the plug is online.</p>
  }

  const total = rows.reduce((sum, r) => sum + (typeof r.kwh === 'number' ? r.kwh : 0), 0)
  const max = rows.reduce((m, r) => (typeof r.kwh === 'number' && r.kwh > m ? r.kwh : m), 0)
  // `to` is today in the LOCATION's zone, computed by the route — never
  // recomputed here from the browser's clock, which is a different day for a
  // studio abroad.
  const today = state?.to

  return (
    <div className="space-y-2">
      <p className="text-xs text-un1t-subtle">
        {total.toFixed(1)} kWh over {rows.length} day{rows.length === 1 ? '' : 's'}
      </p>
      <div className="flex items-end gap-[3px]" style={{ height: BAR_MAX_PX }}>
        {rows.map((r) => {
          const unreadable = r.kwh === null || r.kwh === undefined
          const value = unreadable ? 0 : r.kwh
          const height = max > 0 ? Math.max(2, Math.round((value / max) * BAR_MAX_PX)) : 2
          const isToday = r.day === today
          const title = unreadable
            ? `${r.day}: reading unavailable`
            : `${r.day}: ${value.toFixed(1)} kWh`
          return (
            <div key={r.day} className="flex flex-1 flex-col items-center justify-end" style={{ height: BAR_MAX_PX }}>
              {unreadable ? (
                <span
                  title={title}
                  aria-label={title}
                  className="w-full rounded-sm border border-dashed border-un1t-muted text-center text-[9px] leading-none text-un1t-subtle"
                  style={{ height: BAR_MAX_PX }}
                >
                  ?
                </span>
              ) : (
                <span
                  title={title}
                  aria-label={title}
                  // Today is lighter: its bar is a part-day and will keep
                  // growing, so it must not read as a completed comparison.
                  className={`w-full rounded-sm ${isToday ? 'bg-un1t-accent/30' : 'bg-un1t-accent/70'}`}
                  style={{ height }}
                />
              )}
            </div>
          )
        })}
      </div>
      <div className="flex justify-between text-[10px] text-un1t-subtle">
        <span>{dayLabel(rows[0]?.day)}</span>
        <span>{dayLabel(rows[rows.length - 1]?.day)}</span>
      </div>
    </div>
  )
}
