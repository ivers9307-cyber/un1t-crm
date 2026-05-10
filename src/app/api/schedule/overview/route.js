// GET /api/schedule/overview?from=YYYY-MM-DD&to=YYYY-MM-DD&location_id=...
//
// Per-day demand-vs-supply summary for the studio overview strip
// rendered above the schedule calendar (mig 125). Manager+ at the
// location.
//
// Demand is COMMITMENT-based:
//   events scheduled today      → SUM(events.staff_required)
//   Calendly templates with     → SUM(event_types.staff_required)
//     a window for today        ← uses availability JSON's day-of-week key
//
// Supply is the count of distinct staff scheduled to work today minus
// staff with approved time off overlapping today.
//
// Each day gets classified red / amber / green by the schedule-overview
// classifier (also used in unit tests). Returned shape is intentionally
// flat per-day for easy iteration in the React strip component.
//
// Range bounds: max 60 days per request (defensive — the strip is
// designed for week / month views, not multi-year drill-ins).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import {
  eventTypeHasWindowForDate,
  sumStaffRequired,
  classifyDayLoad,
} from '@/lib/schedule-overview'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// uuidLike (not z.string().uuid()) because Zod 4's .uuid() validator
// requires the version digit (3rd group, 1st char) to be 1-8 per
// RFC 4122. UN1T location IDs are hand-seeded with version digit 0
// (e.g. "a0000000-0000-0000-0000-000000000001" for Stillorgan) so
// strict UUID validation rejects them. uuidLike is the codebase's
// shared lenient regex (src/lib/schemas.js) — UUID-shaped, no
// version assertion. Same choice every other API route makes.
const QuerySchema = z.object({
  from:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  to:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  location_id: uuidLike,
})

// Defensive max — strip uses week (7) or month (~31) views.
const MAX_DAYS_PER_REQUEST = 60

function* dateRange(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split('-').map(Number)
  const [ty, tm, td] = toStr.split('-').map(Number)
  let cursor = Date.UTC(fy, fm - 1, fd)
  const end = Date.UTC(ty, tm - 1, td)
  while (cursor <= end) {
    const d = new Date(cursor)
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    yield iso
    cursor += 86400_000
  }
}

export async function GET(request) {
  try {
    return await handleGet(request)
  } catch (e) {
    logWarn('schedule-overview', 'handler threw', {
      err: e?.message || String(e),
      stack: e?.stack,
    })
    return NextResponse.json({
      success: false,
      error: e?.message || 'Internal error',
    }, { status: 500 })
  }
}

async function handleGet(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermission(user, 'schedule')) {
    return NextResponse.json({ success: false, error: 'Schedule feature is disabled at this location' }, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    from:        url.searchParams.get('from'),
    to:          url.searchParams.get('to'),
    location_id: url.searchParams.get('location_id'),
  })
  if (!parsed.success) {
    // Codebase convention is .issues (not .errors) — see
    // src/lib/validate.js + every other route under src/app/api.
    // Map all issues so the operator sees which field is wrong.
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') || 'Bad query',
    }, { status: 400 })
  }
  const { from, to, location_id } = parsed.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // Reject ranges over the cap (one round-trip would otherwise pull
  // a year of events at once). Explicit destructure rather than spread
  // because spread + Date.UTC was triggering a build-time mangling
  // issue on Vercel's serverless bundler.
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const fromMs = Date.UTC(fy, fm - 1, fd)
  const toMs   = Date.UTC(ty, tm - 1, td)
  if (toMs < fromMs) {
    return NextResponse.json({ success: false, error: 'to must be on or after from' }, { status: 400 })
  }
  const dayCount = Math.floor((toMs - fromMs) / 86400_000) + 1
  if (dayCount > MAX_DAYS_PER_REQUEST) {
    return NextResponse.json({
      success: false,
      error: `Range too wide (${dayCount} days). Max ${MAX_DAYS_PER_REQUEST}.`,
    }, { status: 400 })
  }

  const db = createServerClient()

  // ── Pull all four data sources in parallel ──────────────────
  const [eventsRes, eventTypesRes, blocksRes, timeOffRes] = await Promise.all([
    // Multi-kind events (race / workshop / etc.) on or between [from, to].
    // start_time included so the day-detail modal can show "Workshop @ 18:00".
    db.from('race_events')
      .select('id, name, kind, race_date, start_time, staff_required, active')
      .eq('location_id', location_id)
      .eq('active', true)
      .gte('race_date', from)
      .lte('race_date', to),

    // ALL active Calendly templates at the location — we filter
    // per-day in-memory using availability's day-of-week key.
    db.from('event_types')
      .select('id, name, availability, staff_required, active')
      .eq('location_id', location_id)
      .eq('active', true),

    // Shift blocks in the range, with embedded assignment count.
    // Each distinct profile_id assigned counts as 1 supply unit
    // for that day. shift_assignments.status='cancelled' excluded.
    db.from('shift_blocks')
      .select(`
        id, block_date,
        shift_assignments ( profile_id, status )
      `)
      .eq('location_id', location_id)
      .gte('block_date', from)
      .lte('block_date', to),

    // Approved time off overlapping the range. We expand to per-day
    // membership in JS below.
    db.from('time_off_requests')
      .select('profile_id, start_date, end_date, profiles:profile_id ( full_name )')
      .eq('location_id', location_id)
      .eq('status', 'approved')
      .lte('start_date', to)
      .gte('end_date', from),
  ])

  for (const r of [eventsRes, eventTypesRes, blocksRes, timeOffRes]) {
    if (r.error) {
      return NextResponse.json({ success: false, error: r.error.message }, { status: 500 })
    }
  }

  const events = eventsRes.data || []
  const event_types = eventTypesRes.data || []
  const blocks = blocksRes.data || []
  const time_off = timeOffRes.data || []

  // ── Index events by date for fast per-day lookup ────────────
  const eventsByDate = new Map()
  for (const ev of events) {
    if (!eventsByDate.has(ev.race_date)) eventsByDate.set(ev.race_date, [])
    eventsByDate.get(ev.race_date).push(ev)
  }

  // Distinct profile_ids per date (each assignment by one profile
  // contributes 1 supply, even if they have multiple blocks on the
  // same day — they're one human).
  const staffByDate = new Map()  // date → Set<profile_id>
  for (const block of blocks) {
    const assignments = block.shift_assignments || []
    for (const a of assignments) {
      if (a.status === 'cancelled') continue
      if (!a.profile_id) continue
      if (!staffByDate.has(block.block_date)) staffByDate.set(block.block_date, new Set())
      staffByDate.get(block.block_date).add(a.profile_id)
    }
  }

  // ── Build per-day rows ──────────────────────────────────────
  const days = []
  for (const date of dateRange(from, to)) {
    const eventsToday = eventsByDate.get(date) || []
    const eventTypesToday = event_types.filter(
      (et) => eventTypeHasWindowForDate(et?.availability, date),
    )

    const staffSet = staffByDate.get(date) || new Set()

    // Staff on leave today: any time_off row whose [start_date, end_date]
    // window contains this date AND whose profile_id is in the scheduled
    // set (people on leave only matter if they were going to work).
    const onLeaveSet = new Set()
    const onLeaveNames = []
    for (const off of time_off) {
      if (date < off.start_date || date > off.end_date) continue
      onLeaveNames.push(off.profiles?.full_name || 'Unknown')
      if (staffSet.has(off.profile_id)) onLeaveSet.add(off.profile_id)
    }

    const staff_scheduled = staffSet.size
    const staff_on_leave  = onLeaveSet.size
    const eventDemand     = sumStaffRequired(eventsToday)
    const bookingDemand   = sumStaffRequired(eventTypesToday)
    const demand          = eventDemand + bookingDemand

    // Day-of-week key for extracting the per-day availability window
    // from each Calendly type's availability JSON. Mirrors
    // eventTypeHasWindowForDate's lookup.
    const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
    const [yy, mm, dd] = date.split('-').map(Number)
    const dayKey = DAY_NAMES[new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()]

    days.push({
      date,
      events: eventsToday.map((e) => ({
        id: e.id,
        name: e.name,
        kind: e.kind,
        start_time: e.start_time,    // HH:MM:SS or null
        staff_required: e.staff_required,
      })),
      event_types: eventTypesToday.map((et) => {
        // Surface the day's bookable window so the modal can show
        // "PT bookings — bookable 09:00–17:00" instead of just "PT".
        const win = et?.availability?.[dayKey] || null
        return {
          id: et.id,
          name: et.name,
          staff_required: et.staff_required,
          window_start: win?.start || null,
          window_end:   win?.end   || null,
        }
      }),
      time_off: onLeaveNames,
      staff_scheduled,
      staff_on_leave,
      demand,
      classification: classifyDayLoad({ demand, staff_scheduled, staff_on_leave }),
    })
  }

  return NextResponse.json({ success: true, data: { from, to, location_id, days } })
}
