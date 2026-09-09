'use client'

// MonthRoster — personal roster for /dashboard/today.
// Replaces the two-WeekPanel block with a Week | Month toggle
// (Month default). Month mode = calendar grid; Week mode = the
// existing two WeekPanels (markup / styling byte-identical to
// the originals that lived in today/page.js).
//
// Props:
//   weeks        — output of buildMonthMatrix (plain objects, serialisable)
//   monthLabel   — e.g. "June 2026"
//   monthSummary — e.g. "17 shifts · 94h"
//   weekPanels   — [{title, startIso, endIso, shifts}] for Week mode
//   showLocation — boolean; show per-shift location chip when true
//
// Task 2 additions (Phase 2):
//   • Each shift chip / row is clickable → ShiftActionMenu. Hidden for past
//     shifts and swapped shifts.
//   • "Request time off" button in the header → RequestTimeOffModal.
//
// ROSTER-FIX.3 (D3) — this is a COACH surface, so the menu offers swaps
// only. A coach is paid for a window a manager set; the "Adjust time" panel
// that used to live here PUT /api/schedule/assignments/[id], which is now
// manager-only and would 403. The "(adjusted)" marker stays so a coach can
// still see when a manager moved their hours.

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarOff, RefreshCw } from 'lucide-react'
import { pickLocationColor } from '@shared/location-colors'
import Modal from '@/components/ui/Modal'
import Button from '@/components/ui/Button'
import RequestTimeOffModal from './RequestTimeOffModal'
import { formatDate } from '@/lib/roster'
import { shiftHours } from '@/lib/payroll'

// ── Week-mode helpers (moved from today/page.js, byte-identical) ────────────

function shiftTime(shift) {
  const start = (shift.start_time_override || shift.shift_templates?.start_time || '').slice(0, 5)
  const end = (shift.end_time_override || shift.shift_templates?.end_time || '').slice(0, 5)
  return `${start} – ${end}`
}

// ROSTER-FIX.6c — shiftHours and isoDate were local re-implementations of
// shiftHours (@/lib/payroll) and formatDate (@/lib/roster). payroll's returns
// UNROUNDED hours where the local one rounded to 1dp, so the rounding moves to
// the one place that prints it (roundHours below) and the number on screen is
// unchanged.
function roundHours(n) { return Math.round(n * 10) / 10 }

function buildWeek(weekStartIso, shifts) {
  const start = new Date(weekStartIso + 'T00:00:00')
  const todayIso = formatDate(new Date())
  const days = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const iso = formatDate(d)
    const daysShifts = shifts.filter(s => s.shift_date === iso)
    days.push({
      iso,
      label: d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(),
      dayNum: d.getDate(),
      isToday: iso === todayIso,
      isPast: iso < todayIso,
      shifts: daysShifts,
    })
  }
  return days
}

function rangeLabelFor(startIso, endIso) {
  const s = new Date(startIso + 'T00:00:00')
  const e = new Date(endIso + 'T00:00:00')
  const fmt = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `${fmt(s)} – ${fmt(e)}`
}

// ── Shift action helpers ─────────────────────────────────────────────────────

// A shift is "actionable" when it's not past and not already swapped.
function isActionable(shift, isPast) {
  if (isPast) return false
  if (shift.status === 'swapped') return false
  return true
}

// ── ShiftActionMenu — modal that provides the coach's two swap routes ───────

function ShiftActionMenu({ shift, shiftDate, onClose, onDone }) {
  const name = shift.shift_templates?.name || 'Shift'
  const hasOverride    = !!(shift.start_time_override || shift.end_time_override)

  // Which sub-panel is open: null | 'swap' | 'target'
  const [panel, setPanel]       = useState(null)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState(null)
  const [success, setSuccess]   = useState(null)

  // Targeted-swap colleague picker state
  const [colleagues, setColleagues] = useState(null)   // null = not loaded yet
  const [loadingColleagues, setLoadingColleagues] = useState(false)
  const [colleagueSearch, setColleagueSearch] = useState('')

  // ── Post for swap ──────────────────────────────────────────────────────────
  async function handlePostSwap() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/schedule/swaps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requester_shift_id: shift.id }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error || 'Could not post swap request. Please try again.')
        setSaving(false)
        return
      }
      setSuccess('Posted for swap — your manager will confirm it.')
      setSaving(false)
      onDone?.()
    } catch {
      setError('Network error. Please try again.')
      setSaving(false)
    }
  }

  // ── Swap with a specific coach — open the picker + lazy-load colleagues ──────
  async function openTargetPicker() {
    setPanel('target')
    setError(null)
    if (colleagues !== null || loadingColleagues) return
    setLoadingColleagues(true)
    try {
      // ROSTER-FIX.6c — two params, two different defects, one line.
      // `fields=picker` is the pay-free shape: without it an admin caller's
      // browser received `*` off `profiles` (hourly_rate, annual_salary,
      // overtime_rate) to render a list of names, the same leak the calendar
      // just closed. `location_id` is honoured by the route now: the read
      // service scopes to ALL of the caller's locations, so a manager at two
      // studios was offered the other studio's coaches as swap partners for a
      // shift they cannot work.
      const res = await fetch(
        `/api/staff?location_id=${encodeURIComponent(shift.location_id)}&fields=picker`
      )
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error || 'Could not load colleagues. Please try again.')
        setColleagues([])
      } else {
        // Exclude the shift's own coach (the current user posts the swap).
        const list = (data.data || []).filter((p) => p.id && p.id !== shift.profile_id)
        setColleagues(list)
      }
    } catch {
      setError('Network error loading colleagues.')
      setColleagues([])
    } finally {
      setLoadingColleagues(false)
    }
  }

  async function handlePostTargetedSwap(coachId) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/schedule/swaps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requester_shift_id: shift.id, target_id: coachId }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error || 'Could not send swap request. Please try again.')
        setSaving(false)
        return
      }
      setSuccess('Swap request sent — your colleague can accept it, then your manager confirms.')
      setSaving(false)
      onDone?.()
    } catch {
      setError('Network error. Please try again.')
      setSaving(false)
    }
  }

  // ── Shift label ────────────────────────────────────────────────────────────
  const dateLabel = shiftDate
    ? new Date(shiftDate + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })
    : ''

  return (
    <Modal open onClose={onClose} title={`${name}${dateLabel ? ` · ${dateLabel}` : ''}`} size="sm">
      <div className="space-y-3">
        {/* Time display */}
        <p className="text-sm text-un1t-subtle">
          {shiftTime(shift)}
          {hasOverride && (
            <span className="ml-1 text-amber-700 text-xs">(adjusted)</span>
          )}
        </p>

        {/* Success banner */}
        {success && (
          <div className="rounded-lg bg-emerald-500/10 text-emerald-700 text-sm px-3 py-2">
            {success}
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="rounded-lg bg-red-500/10 text-red-700 text-sm px-3 py-2">{error}</div>
        )}

        {/* Action buttons — hidden once a sub-panel is open */}
        {!panel && !success && (
          <div className="space-y-2 pt-1">
            <button
              type="button"
              onClick={() => setPanel('swap')}
              className="w-full text-left px-3 py-2.5 rounded-lg border border-un1t-border bg-un1t-surface hover:bg-un1t-border text-sm text-un1t-text transition-colors"
            >
              <span className="font-medium">Post for swap</span>
              <span className="block text-xs text-un1t-subtle mt-0.5">Open to anyone — first to claim takes it</span>
            </button>
            <button
              type="button"
              onClick={openTargetPicker}
              className="w-full text-left px-3 py-2.5 rounded-lg border border-un1t-border bg-un1t-surface hover:bg-un1t-border text-sm text-un1t-text transition-colors"
            >
              <span className="font-medium">Swap with a specific coach…</span>
              <span className="block text-xs text-un1t-subtle mt-0.5">Send the request straight to one colleague</span>
            </button>
            {/* ROSTER-FIX.3 (D3) — say who owns the hours, now that the coach
                cannot change them here. */}
            <p className="text-xs text-un1t-muted pt-1">
              Your hours are set by your manager. If you worked different hours, tell them and they will adjust the shift.
            </p>
          </div>
        )}

        {/* Swap confirm panel */}
        {panel === 'swap' && !success && (
          <div className="space-y-3">
            <p className="text-sm text-un1t-text">
              Post <strong>{name}</strong> on <strong>{dateLabel}</strong> as open for swap?
              Your manager will be notified and will confirm a replacement.
            </p>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="secondary" onClick={() => { setPanel(null); setError(null) }} disabled={saving}>
                Back
              </Button>
              <Button type="button" variant="primary" loading={saving} onClick={handlePostSwap}>
                Post for swap
              </Button>
            </div>
          </div>
        )}

        {/* Targeted-swap colleague picker panel */}
        {panel === 'target' && !success && (
          <div className="space-y-3">
            <p className="text-sm text-un1t-text">
              Send <strong>{name}</strong> on <strong>{dateLabel}</strong> to a specific colleague.
              They can accept it, then your manager confirms.
            </p>
            <input
              type="text"
              value={colleagueSearch}
              onChange={(e) => setColleagueSearch(e.target.value)}
              disabled={saving}
              placeholder="Search colleagues…"
              className="w-full rounded-lg border border-un1t-border bg-un1t-surface text-un1t-text text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-un1t-accent placeholder:text-un1t-muted"
            />
            <div className="max-h-56 overflow-y-auto rounded-lg border border-un1t-border divide-y divide-un1t-border">
              {loadingColleagues ? (
                <p className="text-sm text-un1t-subtle px-3 py-3">Loading colleagues…</p>
              ) : (() => {
                const q = colleagueSearch.trim().toLowerCase()
                const list = (colleagues || []).filter(
                  (p) => !q || (p.full_name || '').toLowerCase().includes(q),
                )
                if (list.length === 0) {
                  return (
                    <p className="text-sm text-un1t-subtle px-3 py-3">
                      {colleagueSearch.trim() ? 'No matching colleagues.' : 'No colleagues to swap with.'}
                    </p>
                  )
                }
                return list.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={saving}
                    onClick={() => handlePostTargetedSwap(p.id)}
                    className="w-full text-left px-3 py-2.5 text-sm text-un1t-text hover:bg-un1t-surface transition-colors disabled:opacity-50"
                  >
                    {p.full_name || 'Unnamed coach'}
                  </button>
                ))
              })()}
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={() => { setPanel(null); setError(null) }} disabled={saving}>
                Back
              </Button>
            </div>
          </div>
        )}

        {/* Close button when success is shown */}
        {success && (
          <div className="flex justify-end pt-1">
            <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── WeekPanel (moved from today/page.js, byte-identical + clickable shifts) ──

function WeekPanel({ title, startIso, endIso, shifts, showLocation, onShiftClick }) {
  const days = buildWeek(startIso, shifts || [])
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden">
      <div className="px-4 pt-3 pb-2 flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">{title}</span>
        <span className="text-xs text-un1t-muted">{rangeLabelFor(startIso, endIso)}</span>
      </div>
      {days.map((day, idx) => {
        const isLast = idx === days.length - 1
        return (
          <div
            key={day.iso}
            className={`flex px-4 py-2.5 ${!isLast ? 'border-b border-un1t-border' : ''} ${
              day.isToday ? 'bg-un1t-border/30' : ''
            }`}
          >
            <div className="w-14 shrink-0">
              <div className={`text-[10px] font-semibold uppercase tracking-wider ${
                day.isToday ? 'text-un1t-text'
                : day.isPast ? 'text-un1t-muted'
                : 'text-un1t-subtle'
              }`}>
                {day.label}
              </div>
              <div className={`text-base font-semibold ${
                day.isPast ? 'text-un1t-muted' : 'text-un1t-text'
              }`}>
                {day.dayNum}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              {day.shifts.length === 0 ? (
                <div className={`text-sm pt-1 ${day.isPast ? 'text-un1t-muted' : 'text-un1t-subtle'}`}>
                  Off
                </div>
              ) : (
                day.shifts.map((s, i) => {
                  const actionable = isActionable(s, day.isPast)
                  return (
                    <div
                      key={s.id}
                      className={i > 0 ? 'mt-1' : ''}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          disabled={!actionable}
                          onClick={() => actionable && onShiftClick?.(s, day.iso)}
                          className={`text-sm font-medium truncate text-left ${
                            actionable
                              ? 'cursor-pointer hover:text-blue-700 transition-colors'
                              : 'cursor-default'
                          } ${day.isPast ? 'text-un1t-subtle' : 'text-un1t-text'}`}
                        >
                          {s.shift_templates?.name || 'Shift'}
                        </button>
                        <div className="flex items-center gap-1 shrink-0">
                          {s.status === 'swapped' && (
                            <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-700 text-[10px] uppercase font-semibold whitespace-nowrap">
                              Swapped
                            </span>
                          )}
                          {actionable && (
                            <span className="text-un1t-muted" aria-hidden="true" title="Tap to manage">
                              <RefreshCw size={11} />
                            </span>
                          )}
                        </div>
                      </div>
                      <div className={`text-xs flex items-center gap-1.5 flex-wrap ${day.isPast ? 'text-un1t-muted' : 'text-un1t-subtle'}`}>
                        <span>{shiftTime(s)} · {roundHours(shiftHours(s))}h</span>
                        {showLocation && s.locations?.name && (() => {
                          const c = pickLocationColor(s.locations.id || s.location_id)
                          return (
                            <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider whitespace-nowrap ${c.bg} ${c.text} ${day.isPast ? 'opacity-60' : ''}`}>
                              {s.locations.name}
                            </span>
                          )
                        })()}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Toggle button ────────────────────────────────────────────────────────────

// Internal mode value stays 'month' (the calendar-grid view); the label reads
// "Upcoming" because that view now shows a rolling 7-week window, not a month.
const MODE_LABELS = { week: 'Week', month: 'Upcoming' }

function ModeToggle({ mode, onChange }) {
  return (
    <div className="flex items-center rounded-lg border border-un1t-border bg-un1t-surface overflow-hidden text-xs font-medium">
      {['week', 'month'].map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`px-3 py-1 transition-colors ${
            mode === m
              ? 'bg-un1t-accent/10 text-un1t-text font-semibold'
              : 'text-un1t-subtle hover:text-un1t-text'
          }`}
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  )
}

// ── Month chip — one shift entry inside a calendar cell ──────────────────────

function ShiftChip({ shift, isPast, onShiftClick, cellDate }) {
  const time = (shift.start_time_override || shift.shift_templates?.start_time || '').slice(0, 5)
  const name = shift.shift_templates?.name || 'Shift'
  // ROSTER-FIX.1 (D1) — the amber "draft" treatment is gone: this component
  // only ever renders the PERSONAL dashboard's shifts, and those are now
  // published-only (shared/dashboard-data.js fetchPersonalDashboardData).
  const actionable = isActionable(shift, isPast)

  return (
    <button
      type="button"
      disabled={!actionable}
      onClick={() => actionable && onShiftClick?.(shift, cellDate)}
      title={actionable ? `${name} — tap to manage` : undefined}
      className={`w-full flex items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-tight border-l-2 text-left border-blue-500 bg-blue-500/10 text-blue-700 ${isPast ? 'opacity-60' : ''} ${actionable ? 'cursor-pointer hover:opacity-80 transition-opacity' : 'cursor-default'}`}
    >
      <span className="font-semibold whitespace-nowrap">{time}</span>
      <span className="truncate">{name}</span>
    </button>
  )
}

// ── Calendar cell ────────────────────────────────────────────────────────────

// showLocation is not rendered inside month chips (too small) but kept
// for API consistency with WeekPanel.
function CalCell({ day, showLocation: _showLocation, onShiftClick }) {
  const extra = day.shifts.length > 2 ? day.shifts.length - 2 : 0
  const visible = day.shifts.slice(0, 2)

  return (
    <div className={`min-h-[72px] p-1 border-b border-r border-un1t-border flex flex-col gap-0.5 ${
      day.inMonth ? '' : 'bg-un1t-surface'
    }`}>
      {/* Date number */}
      <div className="flex items-center justify-end mb-0.5">
        <span className={`text-[11px] font-semibold w-5 h-5 flex items-center justify-center rounded-full ${
          day.isToday
            ? 'bg-blue-600 text-white'
            : day.inMonth
              ? day.isPast ? 'text-un1t-muted' : 'text-un1t-text'
              : 'text-un1t-muted opacity-40'
        }`}>
          {day.dayNum}
        </span>
      </div>

      {/* Shift chips */}
      {visible.map((s) => (
        <ShiftChip
          key={s.id}
          shift={s}
          isPast={day.isPast}
          onShiftClick={onShiftClick}
          cellDate={day.iso}
        />
      ))}
      {extra > 0 && (
        <div className="text-[10px] text-un1t-muted pl-1">+{extra} more</div>
      )}
    </div>
  )
}

// ── Month grid ───────────────────────────────────────────────────────────────

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function MonthGrid({ weeks, showLocation, onShiftClick }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden">
      {/* Weekday header row */}
      <div className="grid grid-cols-7 border-b border-un1t-border">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-un1t-subtle border-r border-un1t-border last:border-r-0">
            {label}
          </div>
        ))}
      </div>

      {/* Calendar rows */}
      {weeks.map((week, wi) => (
        <div key={wi} className="grid grid-cols-7">
          {week.map((day) => (
            <CalCell key={day.iso} day={day} showLocation={showLocation} onShiftClick={onShiftClick} />
          ))}
        </div>
      ))}
    </div>
  )
}

// ── Main export ──────────────────────────────────────────────────────────────

export default function MonthRoster({ weeks, monthLabel, monthSummary, weekPanels, showLocation, employmentType }) {
  const [mode, setMode] = useState('month')
  const router = useRouter()

  // Shift action menu state
  const [activeShift, setActiveShift]     = useState(null)   // { shift, date }
  const [timeOffOpen, setTimeOffOpen]     = useState(false)
  const [timeOffSuccess, setTimeOffSuccess] = useState(false)

  const handleShiftClick = useCallback((shift, date) => {
    setActiveShift({ shift, date })
  }, [])

  function handleShiftDone() {
    // Refresh the server-rendered page data after a mutation
    router.refresh()
  }

  function handleShiftClose() {
    setActiveShift(null)
  }

  function handleTimeOffSuccess() {
    setTimeOffOpen(false)
    setTimeOffSuccess(true)
    router.refresh()
    // Auto-dismiss success notice after 5s
    setTimeout(() => setTimeOffSuccess(false), 5000)
  }

  return (
    <div>
      {/* Header row: title + label + toggle + summary + time-off button */}
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-un1t-text">My roster</h2>
          {mode === 'month' && (
            <span className="text-sm text-un1t-subtle">{monthLabel}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {mode === 'month' && monthSummary && (
            <span className="text-xs text-un1t-muted">{monthSummary}</span>
          )}
          <ModeToggle mode={mode} onChange={setMode} />
          <button
            type="button"
            onClick={() => { setTimeOffSuccess(false); setTimeOffOpen(true) }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-un1t-border bg-un1t-surface text-xs text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border transition-colors"
          >
            <CalendarOff size={13} aria-hidden="true" />
            Request time off
          </button>
        </div>
      </div>

      {/* Time-off success notice */}
      {timeOffSuccess && (
        <div className="mb-3 rounded-lg bg-emerald-500/10 text-emerald-700 text-sm px-3 py-2">
          Time-off request submitted — your manager will review it.
        </div>
      )}

      {/* Month mode: calendar grid */}
      {mode === 'month' && (
        <MonthGrid weeks={weeks} showLocation={showLocation} onShiftClick={handleShiftClick} />
      )}

      {/* Week mode: two WeekPanels side-by-side on md+ */}
      {mode === 'week' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(weekPanels || []).map((panel) => (
            <WeekPanel
              key={panel.title}
              title={panel.title}
              startIso={panel.startIso}
              endIso={panel.endIso}
              shifts={panel.shifts}
              showLocation={showLocation}
              onShiftClick={handleShiftClick}
            />
          ))}
        </div>
      )}

      {/* Shift action menu */}
      {activeShift && (
        <ShiftActionMenu
          shift={activeShift.shift}
          shiftDate={activeShift.date}
          onClose={handleShiftClose}
          onDone={handleShiftDone}
        />
      )}

      {/* Request time off modal */}
      <RequestTimeOffModal
        open={timeOffOpen}
        onClose={() => setTimeOffOpen(false)}
        onSuccess={handleTimeOffSuccess}
        employmentType={employmentType}
      />
    </div>
  )
}
