import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, days , MANAGER_ROLES} from '@/lib/schemas'
import { getEmploymentType, getLeaveEntitlement, getPendingHolidayDays } from '@/lib/time-off-leave'
import { getLieuBalance } from '@/lib/lieu-credits'
import { profileScope } from '@/lib/allowance-scope'
import { ALLOWANCE_YEAR_MIN, ALLOWANCE_YEAR_MAX, parseAllowanceYear } from '@/lib/allowance-year'
import { staffZoneOfUser } from '@/lib/staff-zone'

// ROSTER-FIX.2 / SCHEDROLES.1 — profileScope lives in @/lib/allowance-scope
// since LIEU.1, shared with /api/schedule/allowances/lieu.

const AllowanceUpdateSchema = z.object({
  profile_id: uuidLike,
  year: z.number().int().min(ALLOWANCE_YEAR_MIN).max(ALLOWANCE_YEAR_MAX),
  total_days: days.optional(),
  carried_over: days.optional(),
})

// GET /api/schedule/allowances?profile_id=xxx&year=2026
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const profileId = searchParams.get('profile_id') || user.id
  // RANGEVALID.1 — a four-digit year in the PUT's window, before any read. It went to .eq('year', …) as given: 'abc' came back
  // as Postgres's own text, 99999 as a made-up entitlement.
  // TZ.8b — "this year" is the caller's active studio's calendar year (the
  // leave year turns at that studio's midnight), not Dublin's.
  const { year, error: yearError } = parseAllowanceYear(searchParams.get('year'), staffZoneOfUser(user))
  if (yearError) return NextResponse.json({ success: false, error: yearError }, { status: 400 })
  const db = createServerClient()

  // Staff can only view their own allowance. SCHEDROLES.1 — "staff" means
  // manages nowhere; the per-studio decision is profileScope below.
  if (profileId !== user.id && !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  // ROSTER-FIX.2 — a manager only reads allowances for their own studios.
  if (profileId !== user.id) {
    const scope = await profileScope(db, user, profileId)
    if (scope === 'foreign') {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    if (scope !== 'managed') {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
    }
  }

  // ROSTER-FIX.2 — name the columns rather than `*`: this row is handed
  // straight to the client, and a `*` ships whatever a later migration adds
  // to staff_allowances. Column list is mig 011.
  const { data, error } = await db.from('staff_allowances')
    .select('id, profile_id, year, total_days, used_days, carried_over, created_at, updated_at, profiles!profile_id(id, full_name)')
    .eq('profile_id', profileId)
    .eq('year', year)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // LEAVE.4 — with no row yet, the balance is the person's contract
  // entitlement (profile_compensation, mig 152), not a flat 20. LEAVE.3 —
  // contractors have no holiday allowance at all; say so rather than showing
  // them twenty days they cannot take. A stray row (one exists from before the
  // contractor gate) is still reported as not applicable.
  const { employmentType, error: employmentError } = await getEmploymentType(db, profileId)
  if (employmentError) {
    return NextResponse.json({ success: false, error: employmentError.message }, { status: 500 })
  }
  const notApplicable = employmentType === 'contractor'

  // LEAVEDAYS.1 — `remaining` has never deducted PENDING holiday requests, and
  // the time-off POST refuses on remaining minus them, so a form judging on
  // `remaining` alone stays quiet about a request the POST then refuses.
  // `pending_days` is that sum, from the function the POST judges with.
  // ADDED beside `remaining`, whose meaning is unchanged (the phone subtracts
  // its own pending sum from it). An unreadable sum is OMITTED, never 0: the
  // allowance still loads and the form hedges its wording instead.
  const { days: pendingDays, error: pendingError } = await getPendingHolidayDays(db, profileId, year)
  if (pendingError) console.error('[allowances] pending holiday days unreadable', pendingError.message)
  const pendingField = pendingError ? {} : { pending_days: pendingDays }

  // LIEU.1 — the year's time-in-lieu balance (staff_lieu_credits, mig 761), in
  // HOURS: credited (Sunday at time and a third, public holidays at base time,
  // manual credits), taken, and the signed sum. FTE only; a contractor earns
  // none, so the field is absent for them. Kept beside the day figures, never
  // folded into `remaining`: lieu is hours, the allowance is days, and the
  // time-off POST judges days. An unreadable ledger is OMITTED, never 0, like
  // pending_days.
  let lieuField = {}
  if (!notApplicable) {
    const { lieu, error: lieuError } = await getLieuBalance(db, profileId, year)
    if (lieuError) console.error('[allowances] lieu balance unreadable', lieuError.message)
    else lieuField = { lieu }
  }

  if (!data) {
    const { days, error: entError } = await getLeaveEntitlement(db, profileId)
    if (entError) {
      return NextResponse.json({ success: false, error: entError.message }, { status: 500 })
    }
    return NextResponse.json({
      success: true,
      data: {
        profile_id: profileId,
        year: Number(year),
        total_days: days,
        used_days: 0,
        carried_over: 0,
        remaining: days,
        ...pendingField,
        ...lieuField,
        not_applicable: notApplicable,
      }
    })
  }

  return NextResponse.json({
    success: true,
    data: {
      ...data,
      remaining: data.total_days + data.carried_over - data.used_days,
      ...pendingField,
      ...lieuField,
      not_applicable: notApplicable,
    }
  })
}

// PUT /api/schedule/allowances — Set/update a staff member's allowance (managers only)
export async function PUT(request) {
  const user = await getCurrentUser()
  // ROSTER-FIX.2 — MANAGER_ROLES is the house manager set; the hand-written
  // ['owner','manager'] here locked out master and head_coach.
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, AllowanceUpdateSchema)
  if (!validation.ok) return validation.response
  const { profile_id, year, total_days, carried_over } = validation.data
  const db = createServerClient()

  // SCHEDROLES.1 — manager at one of the profile's studios, not at the
  // caller's active one. A profile only met as a colleague is 403.
  const scope = await profileScope(db, user, profile_id)
  if (scope === 'foreign') {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (scope !== 'managed') {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  // ROSTER-FIX.2 — a partial PUT (say, only carried_over) used to reset
  // total_days to the 20-day default. Read the current row first and only
  // fall back to the default when there is nothing to preserve.
  // ROSTER-FIX.2 — a discarded error here reads as "no row yet", and the
  // upsert below then writes the 20-day DEFAULT over a real entitlement.
  // Fail closed before touching the row.
  const { data: existing, error: existingError } = await db.from('staff_allowances')
    .select('*')
    .eq('profile_id', profile_id)
    .eq('year', year)
    .maybeSingle()

  if (existingError) {
    return NextResponse.json({ success: false, error: existingError.message }, { status: 500 })
  }

  const { data, error } = await db.from('staff_allowances')
    .upsert({
      profile_id,
      year,
      total_days: total_days ?? existing?.total_days ?? 20,
      carried_over: carried_over ?? existing?.carried_over ?? 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'profile_id,year' })
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
