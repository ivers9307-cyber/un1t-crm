import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds, assertLocationAccess } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { timeOffTypeSchema, MANAGER_ROLES } from '@/lib/schemas'
import { notifyUsersAtRolesOnce } from '@/lib/push-dedup'
import { countLeaveDays, splitAtYearEnd } from '@/lib/time-off-days'

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const TimeOffRequestSchema = z.object({
  // Use the shared catalogue (holiday/sick/unpaid/other/unavailable) — the
  // employment-gated UI decides which of these a given user is offered, but the
  // API must accept every valid type. A hard-coded enum here drifted from the
  // shared schema + the DB CHECK (mig 283) and rejected contractors' 'unavailable'.
  type: timeOffTypeSchema,
  start_date: ISO_DATE,
  end_date: ISO_DATE,
  reason: z.string().max(2000).nullable().optional(),
  location_id: uuidLike.optional(),
})

// GET /api/schedule/time-off?location_id=xxx&start_date=xxx&end_date=xxx&status=xxx&profile_id=xxx
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')
  const status = searchParams.get('status')
  const profileId = searchParams.get('profile_id')
  const db = createServerClient()

  let query = db.from('time_off_requests')
    .select(`
      *,
      profiles!profile_id(id, full_name, avatar_url, role),
      reviewer:profiles!reviewed_by(id, full_name)
    `)
    .order('start_date', { ascending: true })

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, data: [] })
    query = query.in('location_id', userLocationIds)
  }
  if (status) query = query.eq('status', status)

  // Date range filter — show requests that overlap with the given range
  if (startDate) query = query.lte('start_date', endDate || startDate)
  if (endDate) query = query.gte('end_date', startDate || endDate)

  // ROSTER-FIX.2 — anyone who is not a manager sees only their own requests.
  // The old `['staff']` list let `reception` (and any future non-manager
  // role) read the whole studio's leave.
  if (!MANAGER_ROLES.includes(user.role)) {
    query = query.eq('profile_id', user.id)
  } else if (profileId) {
    query = query.eq('profile_id', profileId)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// POST /api/schedule/time-off — Create a time-off request
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, TimeOffRequestSchema)
  if (!validation.ok) return validation.response
  const { type, start_date, end_date, reason, location_id } = validation.data

  // If location_id is explicitly passed, it must be one the caller belongs to.
  // Otherwise fall through to user.activeLocation below.
  if (location_id) {
    const guard = assertLocationAccess(user, location_id)
    if (guard) return guard
  }

  const db = createServerClient()

  if (end_date < start_date) {
    return NextResponse.json({ success: false, error: 'End date must be on or after start date' }, { status: 400 })
  }

  // ROSTER-FIX.2 — nothing stopped a coach filing the same week twice (or
  // ten times), which double-counted against the allowance and put two
  // rows on the manager's inbox for one absence.
  const { data: clashes } = await db.from('time_off_requests')
    .select('id, start_date, end_date, status, type')
    .eq('profile_id', user.id)
    .in('status', ['pending', 'approved'])
    .lte('start_date', end_date)
    .gte('end_date', start_date)

  if ((clashes || []).length > 0) {
    const c = clashes[0]
    const range = c.start_date === c.end_date ? c.start_date : `${c.start_date} – ${c.end_date}`
    return NextResponse.json({ success: false, error: `Overlaps your existing request for ${range}` }, { status: 409 })
  }

  // ROSTER-FIX.2 — a range that straddles 31 December becomes one row per
  // year, so each year's allowance is charged its own days. Each segment is
  // counted with the leave-type's own day rule (holiday = Mon-Fri).
  const segments = splitAtYearEnd(start_date, end_date)
    .map(([s, e]) => ({ s, e, days: countLeaveDays(type, s, e) }))

  if (segments.reduce((sum, seg) => sum + seg.days, 0) < 1) {
    return NextResponse.json({ success: false, error: 'No working days in that range' }, { status: 400 })
  }

  // If it's a holiday, check remaining allowance — per segment year, since
  // each year has its own allowance row.
  if (type === 'holiday') {
    for (const seg of segments) {
      if (seg.days < 1) continue
      const year = Number(seg.s.slice(0, 4))
      // K8 — `.maybeSingle()`: staff with no allowance row for the year skip the
      // remaining-days check entirely (`if (allowance)` below), so 0 rows is the
      // designed path, not an error. (profile_id, year) is uniquely indexed.
      const { data: allowance } = await db.from('staff_allowances')
        .select('*')
        .eq('profile_id', user.id)
        .eq('year', year)
        .maybeSingle()

      if (!allowance) continue
      const remaining = allowance.total_days + allowance.carried_over - allowance.used_days
      // Check pending requests too
      const { data: pending } = await db.from('time_off_requests')
        .select('total_days')
        .eq('profile_id', user.id)
        .eq('type', 'holiday')
        .eq('status', 'pending')
        .gte('start_date', `${year}-01-01`)
        .lte('start_date', `${year}-12-31`)

      const pendingDays = (pending || []).reduce((sum, r) => sum + Number(r.total_days), 0)
      if (seg.days > remaining - pendingDays) {
        return NextResponse.json({
          success: false,
          error: `Insufficient holiday balance. You have ${remaining - pendingDays} days remaining (including pending requests).`
        }, { status: 400 })
      }
    }
  }

  const rows = []
  for (const seg of segments) {
    if (seg.days < 1) continue
    const { data: row, error } = await db.from('time_off_requests').insert({
      profile_id: user.id,
      location_id: location_id || user.activeLocation?.id,
      type,
      start_date: seg.s,
      end_date: seg.e,
      total_days: seg.days,
      reason: reason || null,
      status: 'pending',
    }).select(`
      *,
      profiles!profile_id(id, full_name, avatar_url, role)
    `).single()

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    rows.push(row)
  }

  // `data` stays the first row so every existing client keeps working;
  // `data_all` carries the year-split siblings for anyone who wants them.
  const data = rows[0]

  // Notify owners + managers at the request's location that a new
  // time-off request needs review. Best-effort — never block the API
  // response on push delivery.
  const targetLocation = data.location_id || user.activeLocation?.id
  if (targetLocation) {
    const range = data.start_date === data.end_date
      ? data.start_date
      : `${data.start_date} – ${data.end_date}`
    // NOTIF.9 — migrated to notifyUsersAtRoles. Owners/managers
    // who don't have the mobile app get the request by email so
    // they can still review and decide within reasonable hours.
    notifyUsersAtRolesOnce(db, `time_off_inbound:${data.id}`, targetLocation, ['owner', 'manager'], {
      title: 'New time-off request',
      body: `${user.full_name} requested ${data.type} for ${range}.`,
      category: 'time_off',
      emailSubject: `Time-off request from ${user.full_name}`,
      data: { type: 'time_off_inbound', request_id: data.id },
    }).catch(err => console.error('[time-off] notify failed', err))
  }

  return NextResponse.json({ success: true, data, data_all: rows }, { status: 201 })
}
