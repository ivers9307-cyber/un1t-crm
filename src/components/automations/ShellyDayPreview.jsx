// SHELLYGROUPS.7 — one day of the schedule, drawn: the studio's classes and
// each group's on-windows, as blocks along the studio's LOCAL day.
//
// THE SERVER DRAWS THE WINDOWS; THIS ONLY PLACES THEM. GET /api/shelly/preview
// resolves them with the engine's own call (the one the cron makes), so nothing
// here re-implements a rule. Positions are % of the local day [00:00, next
// 00:00) taken from the zone helpers, so a DST day (23 or 25 h) still fills the
// strip and a window that runs past midnight is clipped to the day it is shown
// on instead of spilling out. Day stepping walks LOCAL dates (addDaysIn), never
// +24 h.
//
// A TIMETABLE THAT CANNOT BE READ IS NOT AN EMPTY DAY. The route answers 502;
// the strip then says it could not read the timetable rather than drawing
// blank lanes that read as "nothing scheduled".
//
// "Manual override not shown" is only worded for TODAY, and for today it is
// read off the `groups` prop's `now.mode === 'override'` (the page poll's live
// answer), not off the preview response: the revision below deliberately
// leaves the override out, so a group press would otherwise leave the note
// stale until something else refetched. A group with no `now` falls back to
// the route's `ignored_overrides` list.
//
// THE JOIN CAPTION NEVER CLAIMS A GAP IT DID NOT READ. When every class-mode
// group shares one merge gap it is named; when they differ it is worded per
// group ("Gym lights: classes under 30 min apart stay on; Fans: under 15 min").
//
// ONE LABEL PER LANE. A group no schedule runs says "Never automatic" and
// nothing else: its lane is empty whatever the override does, and two labels
// in one lane drew on top of each other (SHELLYICONS.1).

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '@/components/ui'
import { addDaysIn, dayStartMsIn, formatInZone, timeLabelIn, todayStrIn, zonedWallClockToInstant } from '@shared/zoned-time'
import { fetchJson } from './shelly-fetch'
import { DEFAULT_MERGE_GAP_MIN } from '@/lib/shelly/schemas'

// MUST EQUAL MAX_PREVIEW_DAYS in src/app/api/shelly/preview/route.js (the
// route's bound either side of today). Re-typed because a client component
// cannot import a route module (it would pull the server code into the bundle).
const MAX_DAYS = 60
const TICK_HOURS = [0, 3, 6, 9, 12, 15, 18, 21]

const clampPct = (v) => Math.max(0, Math.min(100, v))

function placeBlock(startIso, endIso, dayStart, dayEnd) {
  const a = Date.parse(startIso)
  const b = Date.parse(endIso)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  const span = dayEnd - dayStart
  const left = clampPct(((a - dayStart) / span) * 100)
  const right = clampPct(((b - dayStart) / span) * 100)
  if (right <= left) return null
  return { left, width: right - left }
}

function Lane({ label, children }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 shrink-0 truncate text-xs text-un1t-subtle" title={label}>{label}</div>
      <div className="relative h-6 flex-1 rounded bg-un1t-surface ring-1 ring-un1t-border">{children}</div>
    </div>
  )
}

/**
 * @param {{ groups: Array<{id: string, name: string, sort_order?: number, enabled?: boolean, schedule_mode?: string, class_rule?: object}>, tz: string }} props
 */
export default function ShellyDayPreview({ groups = [], tz }) {
  const [today] = useState(() => todayStrIn(tz))
  const [offset, setOffset] = useState(0)
  const date = addDaysIn(today, offset, tz)
  const [state, setState] = useState({ status: 'loading', data: null, code: null })

  // A revision derived from what the server's windows depend on, so a saved
  // schedule, a new group or a membership change refetches the chosen day,
  // while the 30 s poll handing back identical rows does not (SHELLYGROUPS.8).
  const revision = useMemo(() => JSON.stringify((Array.isArray(groups) ? groups : []).map((g) => [
    g?.id, g?.enabled ?? null, g?.schedule_mode ?? null, g?.fixed_windows ?? null, g?.class_rule ?? null, g?.device_ids ?? null,
  ])), [groups])
  const shownDate = useRef(null)

  useEffect(() => {
    let live = true
    // Only a new DAY blanks the strip; a revision refetch keeps the old lanes
    // on screen until the new answer lands.
    if (shownDate.current !== date) setState({ status: 'loading', data: null, code: null })
    shownDate.current = date
    fetchJson(`/api/shelly/preview?date=${date}`).then(({ ok, json }) => {
      if (!live) return
      if (ok && json?.success) setState({ status: 'ready', data: json, code: null })
      else setState({ status: 'error', data: null, code: json?.code ?? null })
    })
    return () => { live = false }
  }, [date, revision])

  const dayStart = dayStartMsIn(date, tz)
  const dayEnd = dayStartMsIn(addDaysIn(date, 1, tz), tz)
  const dayName = (d, style) => formatInZone(dayStartMsIn(d, tz) + 12 * 3600 * 1000, tz, { weekday: style })
  const prevName = dayName(addDaysIn(date, -1, tz), 'short')
  const nextName = dayName(addDaysIn(date, 1, tz), 'short')

  const ordered = [...groups].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name).localeCompare(String(b.name)))
  const data = state.data
  const windowsOf = (id) => data?.groups?.find((g) => g.id === id)?.windows || []
  const routeIgnored = new Set(data?.ignored_overrides || [])
  const overrideHidden = (g) => date === today && (g?.now ? g.now.mode === 'override' : routeIgnored.has(g.id))
  const neverAutomatic = (g) => g.enabled === false || !g.schedule_mode || g.schedule_mode === 'none'
  const classGroups = ordered.filter((g) => g.enabled !== false && g.schedule_mode === 'class')
  const gapOf = (g) => (Number.isFinite(g.class_rule?.merge_gap_min) ? g.class_rule.merge_gap_min : DEFAULT_MERGE_GAP_MIN)
  const gaps = new Set(classGroups.map(gapOf))
  const joinCaption = gaps.size === 1
    ? `Classes under ${[...gaps][0]} min apart keep the lights on`
    : classGroups.map((g, i) => (i === 0
      ? `${g.name}: classes under ${gapOf(g)} min apart stay on`
      : `${g.name}: under ${gapOf(g)} min`)).join('; ')

  const stepBtn = 'rounded px-2 py-1 text-sm text-un1t-muted hover:bg-un1t-surface hover:text-un1t-text disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-un1t-text">Preview · {dayName(date, 'long')}</h3>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous day" className={stepBtn} disabled={offset <= -MAX_DAYS} onClick={() => setOffset((o) => o - 1)}>‹ {prevName}</button>
          <button type="button" aria-label="Next day" className={stepBtn} disabled={offset >= MAX_DAYS} onClick={() => setOffset((o) => o + 1)}>{nextName} ›</button>
        </div>
      </div>

      {state.status === 'loading' && <p className="text-sm text-un1t-muted">Loading the day…</p>}
      {state.status === 'error' && (
        <p role="alert" className="rounded bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
          {state.code === 'occurrences' ? 'Couldn’t read the timetable for this day' : 'Couldn’t load the preview'}
        </p>
      )}

      {state.status === 'ready' && (
        <div className="space-y-2">
          <div className="flex gap-3">
            <div className="w-28 shrink-0" />
            <div className="relative h-4 flex-1 text-[10px] text-un1t-muted" aria-hidden="true">
              {TICK_HOURS.map((h) => {
                const t = zonedWallClockToInstant(date, `${String(h).padStart(2, '0')}:00`, tz)
                if (t == null) return null
                return <span key={h} className="absolute -translate-x-1/2" style={{ left: `${((t - dayStart) / (dayEnd - dayStart)) * 100}%` }}>{String(h).padStart(2, '0')}</span>
              })}
            </div>
          </div>

          <Lane label="Classes">
            {(data.classes || []).map((c, i) => {
              const p = placeBlock(c.starts_at, c.ends_at, dayStart, dayEnd)
              if (!p) return null
              const label = `${c.name ? `${c.name}, ` : ''}${timeLabelIn(c.starts_at, tz)}–${timeLabelIn(c.ends_at, tz)}`
              return <div key={i} title={label} aria-label={`Class ${label}`} role="img" className="absolute inset-y-1 rounded-sm bg-blue-500/10 ring-1 ring-blue-500/40" style={{ left: `${p.left}%`, width: `${p.width}%` }} />
            })}
          </Lane>

          {ordered.map((g) => (
            <Lane key={g.id} label={g.name}>
              {windowsOf(g.id).map((w, i) => {
                const p = placeBlock(w.on_at, w.off_at, dayStart, dayEnd)
                if (!p) return null
                const label = `On ${timeLabelIn(w.on_at, tz)}–${timeLabelIn(w.off_at, tz)}`
                return <div key={i} title={label} aria-label={`${g.name}: ${label}`} role="img" className="absolute inset-y-1 rounded-sm bg-green-500/10 ring-1 ring-green-600/60" style={{ left: `${p.left}%`, width: `${p.width}%` }} />
              })}
              {neverAutomatic(g) && <span className="absolute inset-0 flex items-center pl-2 text-[10px] text-un1t-subtle">Never automatic</span>}
              {!neverAutomatic(g) && overrideHidden(g) && <span className="absolute inset-0 flex items-center justify-end pr-2 text-[10px] text-amber-700">Manual override not shown</span>}
            </Lane>
          ))}

          {classGroups.length > 0 && (
            <p className="text-xs text-un1t-muted">{joinCaption}</p>
          )}
        </div>
      )}
    </Card>
  )
}
