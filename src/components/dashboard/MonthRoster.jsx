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

import { useState } from 'react'
import { pickLocationColor } from '@shared/location-colors'

// ── Week-mode helpers (moved from today/page.js, byte-identical) ────────────

function shiftTime(shift) {
  const start = (shift.start_time_override || shift.shift_templates?.start_time || '').slice(0, 5)
  const end = (shift.end_time_override || shift.shift_templates?.end_time || '').slice(0, 5)
  return `${start} – ${end}`
}

function shiftHours(shift) {
  const start = shift.start_time_override || shift.shift_templates?.start_time
  const end = shift.end_time_override || shift.shift_templates?.end_time
  if (!start || !end) return 0
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = eh * 60 + em - (sh * 60 + sm)
  if (mins < 0) mins += 24 * 60
  return Math.round((mins / 60) * 10) / 10
}

function isoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildWeek(weekStartIso, shifts) {
  const start = new Date(weekStartIso + 'T00:00:00')
  const todayIso = isoDate(new Date())
  const days = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const iso = isoDate(d)
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

// ── WeekPanel (moved from today/page.js, byte-identical) ─────────────────────

function WeekPanel({ title, startIso, endIso, shifts, showLocation }) {
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
                day.shifts.map((s, i) => (
                  <div key={s.id} className={i > 0 ? 'mt-1' : ''}>
                    <div className="flex items-center justify-between gap-2">
                      <div className={`text-sm font-medium truncate ${day.isPast ? 'text-un1t-subtle' : 'text-un1t-text'}`}>
                        {s.shift_templates?.name || 'Shift'}
                      </div>
                      {s.published === false && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 text-[10px] uppercase font-semibold whitespace-nowrap">
                          Draft
                        </span>
                      )}
                      {s.status === 'swapped' && (
                        <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-700 text-[10px] uppercase font-semibold whitespace-nowrap">
                          Swapped
                        </span>
                      )}
                    </div>
                    <div className={`text-xs flex items-center gap-1.5 flex-wrap ${day.isPast ? 'text-un1t-muted' : 'text-un1t-subtle'}`}>
                      <span>{shiftTime(s)} · {shiftHours(s)}h</span>
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
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Toggle button ────────────────────────────────────────────────────────────

function ModeToggle({ mode, onChange }) {
  return (
    <div className="flex items-center rounded-lg border border-un1t-border bg-un1t-dark overflow-hidden text-xs font-medium">
      {['week', 'month'].map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`px-3 py-1 capitalize transition-colors ${
            mode === m
              ? 'bg-un1t-accent/10 text-un1t-text font-semibold'
              : 'text-un1t-subtle hover:text-un1t-text'
          }`}
        >
          {m.charAt(0).toUpperCase() + m.slice(1)}
        </button>
      ))}
    </div>
  )
}

// ── Month chip — one shift entry inside a calendar cell ──────────────────────

function ShiftChip({ shift, isPast }) {
  const time = (shift.start_time_override || shift.shift_templates?.start_time || '').slice(0, 5)
  const name = shift.shift_templates?.name || 'Shift'
  const isDraft = shift.published === false

  return (
    <div className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-tight border-l-2 ${
      isDraft
        ? 'border-amber-500 bg-amber-500/10 text-amber-700'
        : 'border-blue-500 bg-blue-500/10 text-blue-700'
    } ${isPast ? 'opacity-60' : ''}`}>
      <span className="font-semibold whitespace-nowrap">{time}</span>
      <span className="truncate">{name}</span>
    </div>
  )
}

// ── Calendar cell ────────────────────────────────────────────────────────────

function CalCell({ day, showLocation }) {
  const extra = day.shifts.length > 2 ? day.shifts.length - 2 : 0
  const visible = day.shifts.slice(0, 2)

  return (
    <div className={`min-h-[72px] p-1 border-b border-r border-un1t-border flex flex-col gap-0.5 ${
      day.inMonth ? '' : 'bg-un1t-dark'
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
        <ShiftChip key={s.id} shift={s} isPast={day.isPast} showLocation={showLocation} />
      ))}
      {extra > 0 && (
        <div className="text-[10px] text-un1t-muted pl-1">+{extra} more</div>
      )}
    </div>
  )
}

// ── Month grid ───────────────────────────────────────────────────────────────

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function MonthGrid({ weeks, showLocation }) {
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
            <CalCell key={day.iso} day={day} showLocation={showLocation} />
          ))}
        </div>
      ))}
    </div>
  )
}

// ── Main export ──────────────────────────────────────────────────────────────

export default function MonthRoster({ weeks, monthLabel, monthSummary, weekPanels, showLocation }) {
  const [mode, setMode] = useState('month')

  return (
    <div>
      {/* Header row: title + label + toggle + summary */}
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-un1t-text">My roster</h2>
          {mode === 'month' && (
            <span className="text-sm text-un1t-subtle">{monthLabel}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {mode === 'month' && monthSummary && (
            <span className="text-xs text-un1t-muted">{monthSummary}</span>
          )}
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
      </div>

      {/* Month mode: calendar grid */}
      {mode === 'month' && (
        <MonthGrid weeks={weeks} showLocation={showLocation} />
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
            />
          ))}
        </div>
      )}
    </div>
  )
}
