// SHELLYGROUPS.5 — a day of the schedule: the location's classes and each
// group's on-windows for one local date, for the web's day preview strip.
//
// COMPUTED BY THE SAME ENGINE CALL THE CRON MAKES. Each group's windows are
// resolveServeWindows(group, date, occurrences, tz) — exactly what
// planDeviceAction evaluates for a grouped device every tick (fixed windows
// include the previous day's tail past midnight; class windows honour lead,
// lag, merge gap and days). The browser never re-implements the rules.
//
// WHAT IT IGNORES, IT SAYS. A live group override changes what the relays do
// today but is not drawn as a window, so its group id is listed in
// `ignored_overrides` and the strip can say "Manual override not shown".
// (Members' own device overrides are per device and not part of a group lane.)
//
// THE DAY IS THE LOCATION'S. `date` defaults to today in the location's zone,
// the timetable is read for exactly that local day ([day start, next day
// start) — never ±24h, loadDayOccurrences), and the range is capped at
// MAX_PREVIEW_DAYS either side of today: the class mirror only holds a few
// weeks ahead, and a far date would draw an empty day that looks like a bug.
//
// A timetable that cannot be read is a 502, not an empty day: a class group
// drawn with no windows on the strength of a failed read is the silent wrong
// value.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { strictDayStrIn } from '@/lib/location-time'
import { resolveServeWindows } from '@/lib/schedule/desired-state'
import { requestTz } from '@/lib/shelly/device-load'
import { GROUP_COLUMNS } from '@/lib/shelly/effective'
import { isLiveOverride } from '@/lib/shelly/plan'
import { loadDayOccurrences, MAX_GROUPS } from '@/lib/shelly/reconcile'
import { ShellyPreviewQuery } from '@/lib/shelly/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-preview'
export const MAX_PREVIEW_DAYS = 60
const DAY_MS = 24 * 60 * 60 * 1000

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

// Whole calendar days between two YYYY-MM-DD strings. Date-only values have no
// zone to get wrong, so UTC midnight is exact here.
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)
const iso = (ms) => new Date(ms).toISOString()

export const GET = withAuth({ permission: 'device_control' }, async ({ user, db, locationId, request }) => {
  const parsed = ShellyPreviewQuery.safeParse({ date: new URL(request.url).searchParams.get('date') })
  if (!parsed.success) {
    return bad(parsed.error.issues[0]?.message || 'Invalid date', 400, { issues: parsed.error.issues })
  }

  const tz = requestTz(user)
  const nowMs = Date.now()
  const today = strictDayStrIn(nowMs, tz)
  const date = parsed.data.date ?? today
  if (Math.abs(daysBetween(today, date)) > MAX_PREVIEW_DAYS) {
    return bad(`Pick a date within ${MAX_PREVIEW_DAYS} days of today`, 400)
  }

  const { data: rows, error } = await db
    .from('shelly_groups')
    .select(GROUP_COLUMNS)
    .eq('location_id', locationId)
    .order('sort_order')
    .order('name')
    .limit(MAX_GROUPS + 1)
  if (error) {
    logError(MODULE, 'group read failed', { locationId, error: error.message })
    return bad('Could not load your groups', 500)
  }
  let groups = rows || []
  if (groups.length > MAX_GROUPS) {
    logWarn(MODULE, 'group cap exceeded, excess groups hidden', { locationId, cap: MAX_GROUPS })
    groups = groups.slice(0, MAX_GROUPS)
  }

  const occ = await loadDayOccurrences(db, locationId, tz, date)
  if (!occ.ok) {
    logWarn(MODULE, 'occurrence read failed', { locationId, date, error: occ.error })
    return bad('Could not read the timetable for that day', 502, { code: 'occurrences' })
  }

  return NextResponse.json({
    success: true,
    date,
    classes: occ.occurrences.map((o) => ({ starts_at: o.starts_at, ends_at: o.ends_at, name: o.name ?? null })),
    groups: groups.map((g) => ({
      id: g.id,
      windows: g.enabled && g.schedule_mode !== 'none'
        ? resolveServeWindows(g, date, occ.occurrences, tz).map((w) => ({ on_at: iso(w.on_at), off_at: iso(w.off_at) }))
        : [],
    })),
    ignored_overrides: groups.filter((g) => isLiveOverride(g.override, nowMs)).map((g) => g.id),
  })
})
