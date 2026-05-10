'use client'

// StudioOverviewStrip — per-day demand-vs-supply summary rendered
// above ScheduleCalendar inside the Schedule tab (mig 125).
//
// Re-fetches /api/schedule/overview whenever the calendar below it
// changes its date range (parent ScheduleTabs holds the range state
// and pipes it in via the `range` prop).
//
// Each day-card shows:
//   - Date
//   - 🎯 N events    (multi-kind events scheduled this day)
//   - 📅 N booking types  (Calendly templates with availability today)
//   - 🌴 N on leave
//   - Staff scheduled vs demand
//   - Border colour: red / amber / green per the classifier
//
// Hover any number for the breakdown. Read-only — clicking through
// a count opens the source view (events / booking-types / staff
// time-off list).

import { useEffect, useState } from 'react'
import { Calendar, AlertCircle, Loader2, Flag, Palmtree, Users } from 'lucide-react'

const STATUS_STYLES = {
  red:   { border: 'border-red-500/60',    bg: 'bg-red-500/5',    label: 'Uncovered' },
  amber: { border: 'border-amber-500/60',  bg: 'bg-amber-500/5',  label: 'Undermanned' },
  green: { border: 'border-emerald-500/30', bg: 'bg-un1t-dark',   label: 'OK' },
}

export default function StudioOverviewStrip({ range, locationId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!range?.from || !range?.to || !locationId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const url = `/api/schedule/overview?from=${range.from}&to=${range.to}&location_id=${locationId}`
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (!j.success) {
          setError(j.error || 'Failed to load overview')
          setData(null)
        } else {
          setData(j.data)
        }
      })
      .catch((e) => { if (!cancelled) setError(e.message || 'Network error') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [range?.from, range?.to, locationId])

  if (!range?.from || !range?.to) return null
  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md px-3 py-2 mb-4 inline-flex items-center gap-2">
        <AlertCircle size={12} /> Overview: {error}
      </div>
    )
  }
  if (!data) {
    return (
      <div className="text-xs text-un1t-light inline-flex items-center gap-2 mb-4">
        <Loader2 size={12} className="animate-spin" /> Loading overview…
      </div>
    )
  }

  const days = data.days || []
  // Summary stats for the range header.
  const flagged = days.filter((d) => d.classification !== 'green').length
  const range_label = `${days.length} day${days.length === 1 ? '' : 's'}, ${flagged} flagged`

  return (
    <section className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <Calendar size={13} className="text-un1t-light" />
        <h3 className="text-xs uppercase tracking-wider text-un1t-light font-semibold">Studio overview</h3>
        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${
          flagged === 0 ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-700'
        }`}>
          {range_label}
        </span>
        {loading && <Loader2 size={11} className="animate-spin text-un1t-light" />}
      </div>

      {/* Horizontal scroll on narrow viewports — week view fits in
          ~7 cards; month view (~31) overflows on most screens. */}
      <div className="overflow-x-auto -mx-2 px-2">
        <div className="flex gap-2 pb-1" style={{ minWidth: 'min-content' }}>
          {days.map((d) => (
            <DayCard key={d.date} day={d} />
          ))}
        </div>
      </div>
    </section>
  )
}

function DayCard({ day }) {
  const status = STATUS_STYLES[day.classification] || STATUS_STYLES.green
  const dt = new Date(day.date + 'T00:00:00')
  const dayName = dt.toLocaleDateString('en-IE', { weekday: 'short' })
  const dayNum  = dt.getDate()
  const monthShort = dt.toLocaleDateString('en-IE', { month: 'short' })
  const supply = day.staff_scheduled - day.staff_on_leave
  const tooltip = [
    `${dt.toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })}`,
    `Demand: ${day.demand} (${day.events.length} events + ${day.event_types.length} bookable types)`,
    `Supply: ${supply} (${day.staff_scheduled} scheduled${day.staff_on_leave > 0 ? `, ${day.staff_on_leave} on leave` : ''})`,
    day.events.length > 0
      ? `Events: ${day.events.map((e) => `${e.name} (${e.staff_required})`).join(', ')}`
      : null,
    day.time_off.length > 0
      ? `On leave: ${day.time_off.join(', ')}`
      : null,
  ].filter(Boolean).join('\n')

  return (
    <div
      className={`min-w-[110px] border rounded-md p-2 text-xs ${status.border} ${status.bg}`}
      title={tooltip}
    >
      <div className="flex items-baseline justify-between mb-1.5">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-un1t-light">{dayName}</div>
          <div className="text-base font-semibold text-un1t-white leading-none">{dayNum}</div>
          <div className="text-[10px] text-un1t-mid">{monthShort}</div>
        </div>
        <div className="text-right">
          <div className={`text-[10px] uppercase tracking-wider ${
            day.classification === 'red' ? 'text-red-700' :
            day.classification === 'amber' ? 'text-amber-700' :
            'text-emerald-700'
          }`}>
            {status.label}
          </div>
          <div className="font-mono tabular-nums text-sm font-semibold text-un1t-white">
            {Math.max(0, supply)}<span className="text-un1t-mid">/{day.demand}</span>
          </div>
        </div>
      </div>

      <div className="space-y-0.5 text-[11px] text-un1t-light">
        {day.events.length > 0 && (
          <div className="flex items-center gap-1">
            <Flag size={10} /> {day.events.length}
          </div>
        )}
        {day.event_types.length > 0 && (
          <div className="flex items-center gap-1">
            <Calendar size={10} /> {day.event_types.length}
          </div>
        )}
        {day.staff_scheduled > 0 && (
          <div className="flex items-center gap-1">
            <Users size={10} /> {day.staff_scheduled}
          </div>
        )}
        {day.time_off.length > 0 && (
          <div className="flex items-center gap-1 text-un1t-mid">
            <Palmtree size={10} /> {day.time_off.length}
          </div>
        )}
      </div>
    </div>
  )
}
