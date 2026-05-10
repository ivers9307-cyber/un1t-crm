'use client'

// StudioOverviewStrip — per-day demand-vs-supply summary rendered
// above ScheduleCalendar inside the Schedule tab (mig 125).
//
// Re-fetches /api/schedule/overview whenever the calendar below it
// changes its date range (parent ScheduleTabs holds the range state
// and pipes it in via the `range` prop).
//
// Each day-card shows a compact summary; clicking opens a modal with
// the full breakdown (event names + times, booking-type windows, who's
// on leave, etc.). Read-only — modal is informational, all editing
// happens in the source views (/events/[id]/edit, /bookings/event-
// types/[id]/edit, /schedule).

import { useState, useEffect } from 'react'
import { Calendar, AlertCircle, Loader2, Flag, Palmtree, Users, X as XIcon, Clock } from 'lucide-react'

const STATUS_STYLES = {
  red:   { border: 'border-red-500/60',    bg: 'bg-red-500/5',    label: 'Uncovered' },
  amber: { border: 'border-amber-500/60',  bg: 'bg-amber-500/5',  label: 'Undermanned' },
  green: { border: 'border-emerald-500/30', bg: 'bg-un1t-dark',   label: 'OK' },
}

const KIND_LABELS = {
  race:        'Race',
  workshop:    'Workshop',
  seminar:     'Seminar',
  open_day:    'Open day',
  masterclass: 'Masterclass',
}

// Strip seconds off "HH:MM:SS" → "HH:MM". Handles null defensively.
function fmtTime(t) {
  if (!t) return null
  return String(t).slice(0, 5)
}

export default function StudioOverviewStrip({ range, locationId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [openDate, setOpenDate] = useState(null)  // YYYY-MM-DD of currently-open detail modal

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

  // ESC closes modal — common modal UX, free win.
  useEffect(() => {
    if (!openDate) return
    const onKey = (e) => { if (e.key === 'Escape') setOpenDate(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openDate])

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
  const flagged = days.filter((d) => d.classification !== 'green').length
  const range_label = `${days.length} day${days.length === 1 ? '' : 's'}, ${flagged} flagged`
  const openDay = days.find((d) => d.date === openDate) || null

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

      <div className="overflow-x-auto -mx-2 px-2">
        <div className="flex gap-2 pb-1" style={{ minWidth: 'min-content' }}>
          {days.map((d) => (
            <DayCard key={d.date} day={d} onClick={() => setOpenDate(d.date)} />
          ))}
        </div>
      </div>

      {openDay && <DayDetailModal day={openDay} onClose={() => setOpenDate(null)} />}
    </section>
  )
}

function DayCard({ day, onClick }) {
  const status = STATUS_STYLES[day.classification] || STATUS_STYLES.green
  const dt = new Date(day.date + 'T00:00:00')
  const dayName = dt.toLocaleDateString('en-IE', { weekday: 'short' })
  const dayNum  = dt.getDate()
  const monthShort = dt.toLocaleDateString('en-IE', { month: 'short' })
  const supply = day.staff_scheduled - day.staff_on_leave

  return (
    <button
      type="button"
      onClick={onClick}
      title="Click for details"
      className={`min-w-[110px] border rounded-md p-2 text-xs text-left transition-colors hover:brightness-110 cursor-pointer ${status.border} ${status.bg}`}
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
    </button>
  )
}

// Day-detail modal. Read-only summary; click-out + ESC + X all close.
// Renders three sections: events (with start times), Calendly booking
// types (with bookable windows for the day), and staffing (scheduled
// count + who's on leave).
function DayDetailModal({ day, onClose }) {
  const dt = new Date(day.date + 'T00:00:00')
  const longDate = dt.toLocaleDateString('en-IE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
  const status = STATUS_STYLES[day.classification] || STATUS_STYLES.green
  const supply = Math.max(0, day.staff_scheduled - day.staff_on_leave)

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-un1t-dark border border-un1t-gray rounded-lg max-w-md w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-un1t-gray">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-un1t-light">Studio overview</div>
            <div className="text-base font-semibold text-un1t-white">{longDate}</div>
          </div>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white p-1" title="Close (Esc)">
            <XIcon size={18} />
          </button>
        </div>

        {/* Demand-vs-supply summary headline */}
        <div className={`mx-5 mt-4 px-3 py-2 rounded-md border ${status.border} ${status.bg}`}>
          <div className="flex items-center justify-between text-xs">
            <span className={`uppercase tracking-wider font-semibold ${
              day.classification === 'red' ? 'text-red-700' :
              day.classification === 'amber' ? 'text-amber-700' :
              'text-emerald-700'
            }`}>
              {status.label}
            </span>
            <span className="font-mono tabular-nums text-un1t-white">
              Supply {supply} / Demand {day.demand}
            </span>
          </div>
        </div>

        {/* Events section */}
        <DetailSection icon={Flag} title="Events">
          {day.events.length === 0 ? (
            <Muted>No events scheduled.</Muted>
          ) : (
            <ul className="space-y-1.5">
              {day.events.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="text-un1t-white truncate">{e.name}</div>
                    <div className="text-[10px] text-un1t-mid uppercase tracking-wider">
                      {KIND_LABELS[e.kind] || e.kind}
                      {e.start_time && (
                        <span className="ml-1.5 text-un1t-light normal-case tracking-normal">
                          @ {fmtTime(e.start_time)}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-un1t-light tabular-nums shrink-0">
                    needs {e.staff_required}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        {/* Bookable Calendly types section */}
        <DetailSection icon={Calendar} title="Bookable today">
          {day.event_types.length === 0 ? (
            <Muted>No booking types open today.</Muted>
          ) : (
            <ul className="space-y-1.5">
              {day.event_types.map((et) => (
                <li key={et.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="text-un1t-white truncate">{et.name}</div>
                    <div className="text-[10px] text-un1t-mid">
                      {fmtTime(et.window_start) && fmtTime(et.window_end) ? (
                        <span className="inline-flex items-center gap-1">
                          <Clock size={9} />
                          {fmtTime(et.window_start)}–{fmtTime(et.window_end)}
                        </span>
                      ) : 'window unknown'}
                    </div>
                  </div>
                  <span className="text-xs text-un1t-light tabular-nums shrink-0">
                    {et.staff_required === 0 ? 'no own demand' : `needs ${et.staff_required}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        {/* Staffing section */}
        <DetailSection icon={Users} title="Staffing">
          <div className="text-sm text-un1t-white">
            <span className="tabular-nums font-semibold">{day.staff_scheduled}</span>
            <span className="text-un1t-light"> scheduled</span>
            {day.staff_on_leave > 0 && (
              <>
                <span className="text-un1t-light">, </span>
                <span className="tabular-nums font-semibold text-amber-700">{day.staff_on_leave}</span>
                <span className="text-un1t-light"> on leave</span>
              </>
            )}
          </div>
          {day.time_off.length > 0 && (
            <div className="mt-1.5">
              <div className="text-[10px] uppercase tracking-wider text-un1t-mid mb-1 inline-flex items-center gap-1">
                <Palmtree size={10} /> On leave
              </div>
              <ul className="text-xs text-un1t-light space-y-0.5">
                {day.time_off.map((name, i) => (
                  <li key={`${name}-${i}`}>{name}</li>
                ))}
              </ul>
            </div>
          )}
        </DetailSection>

        <div className="px-5 py-3 border-t border-un1t-gray text-[11px] text-un1t-mid">
          Edit events at <code>/events</code>, booking types at <code>/bookings/event-types</code>, shifts inside the calendar below.
        </div>
      </div>
    </div>
  )
}

function DetailSection({ icon: Icon, title, children }) {
  return (
    <section className="px-5 py-4 border-t border-un1t-gray first:border-t-0">
      <h4 className="text-[10px] uppercase tracking-wider text-un1t-light font-semibold mb-2 inline-flex items-center gap-1.5">
        <Icon size={11} /> {title}
      </h4>
      {children}
    </section>
  )
}

function Muted({ children }) {
  return <p className="text-xs text-un1t-mid italic">{children}</p>
}
