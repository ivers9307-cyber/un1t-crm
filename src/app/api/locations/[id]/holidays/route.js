import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { isoDate, MANAGER_ROLES } from '@/lib/schemas'
import { mergeHolidays } from '@/lib/bank-holidays'

export const runtime = 'nodejs'

const HolidayCreateSchema = z.object({
  date: isoDate,
  name: z.string().min(1).max(200),
})

// GET /api/locations/[id]/holidays?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// Returns the merged static + custom holiday list for the location.
// Both query params optional; without them the full static list (2025-2030)
// is returned along with all custom entries.
//
// Each holiday in the response has:
//   { date, name, source: 'national' | 'custom', id?, location_id? }
// Static (national) holidays have no id; custom ones do.
export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard

  const { searchParams } = new URL(request.url)
  const start = searchParams.get('start') || undefined
  const end = searchParams.get('end') || undefined

  const db = createServerClient()

  // Look up the location's country — drives which static holiday list
  // we merge in. Default to 'IE' if the row is somehow missing the field.
  const { data: locRow } = await db.from('locations')
    .select('country')
    .eq('id', params.id)
    .single()
  const country = locRow?.country || 'IE'

  let query = db.from('location_holidays')
    .select('id, location_id, date, name')
    .eq('location_id', params.id)
    .order('date', { ascending: true })
  if (start) query = query.gte('date', start)
  if (end) query = query.lte('date', end)

  const { data: custom, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const merged = mergeHolidays(custom || [], { start, end, country })
  return NextResponse.json({ success: true, data: merged, country })
}

// POST /api/locations/[id]/holidays — add a custom holiday (manager+).
// Same-date entries override the static name when GET merges them.
//
// LOCFIX-ROLEGATE.1 — the role is judged AT params.id, never via `user.role`.
// That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while this write lands on the
// path-param location — so the old `MANAGER_ROLES.includes(user.role)` check
// let a manager at studio A who is plain STAFF at studio B POST
// /api/locations/<B>/holidays and close a day on B's calendar with a 201.
// Same shape and order as the #1589 email-copy route: target from the path,
// then MEMBERSHIP (assertLocationAccess — so a manager of a DIFFERENT studio
// is told "not one of your locations" rather than a role complaint that
// confirms the studio exists), then the role AT THAT TARGET, then validation.
// The tier stays MANAGER_ROLES, which INCLUDES head_coach — deliberately
// wider than the ['master','owner','manager'] list the money-adjacent
// stripe-connect routes use. The role-miss copy and the 403-for-anonymous are
// this route's own, kept verbatim.
export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, HolidayCreateSchema)
  if (!validation.ok) return validation.response
  const { date, name } = validation.data

  const db = createServerClient()
  const { data, error } = await db.from('location_holidays')
    .upsert(
      { location_id: locationId, date, name, created_by: user.id },
      { onConflict: 'location_id,date' }
    )
    .select('id, location_id, date, name')
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data: { ...data, source: 'custom' } }, { status: 201 })
}
