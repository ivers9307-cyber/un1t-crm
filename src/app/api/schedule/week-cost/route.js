// ROSTER-FIX.6c — GET /api/schedule/week-cost
//
// Per-coach FTE hours for one Mon-Sun week at one location, computed server-
// side. Drives ScheduleCalendar's "Weekly hours notice" panel.
//
// Why it exists: the panel used to run computeWeeklyCost() in the BROWSER, over
// annual_salary / hourly_rate / overtime_rate / contracted_hours_per_week
// pulled from /api/staff. So opening the roster put the studio's pay data in a
// manager's tab to render a panel that prints no money at all — it says
// "34.0h / 30h · +4.0h OT". The rates are read with the service-role client in
// @/lib/roster-week-cost now and ONLY hours cross the wire; a route test
// stringifies the body and greps it for a pay field.
//
// Gate: MANAGER_ROLES, then assertLocationAccess on the caller-supplied
// location_id — a query-param route, so a foreign location is a 403 (the
// 404 rule is for detail routes whose id comes from the path).
//
// Query params:
//   location_id  uuid (required)
//   week_start   YYYY-MM-DD anywhere inside the target week (required; the
//                helper snaps it to that week's Monday)
//
// Returns:
//   { success, data: { weekStartIso, weekEndIso, coaches: [...], totals } }

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { uuidLike, isoDate, MANAGER_ROLES } from '@/lib/schemas'
import { computeWeeklyFteHours } from '@/lib/roster-week-cost'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  location_id: uuidLike,
  week_start: isoDate,
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    location_id: url.searchParams.get('location_id'),
    week_start: url.searchParams.get('week_start'),
  })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }
  const { location_id, week_start } = parsed.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  try {
    const db = createServerClient()
    const data = await computeWeeklyFteHours({ db, locationId: location_id, weekStart: week_start })
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e?.message || 'Failed to compute weekly hours' },
      { status: 500 },
    )
  }
}
