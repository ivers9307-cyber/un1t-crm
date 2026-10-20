// LIEU.1 — the time-in-lieu ledger (staff_lieu_credits, mig 760) for one
// person: read it, record lieu taken or a manual credit, remove a manual
// entry. Hours, never days. The automatic rows (sunday_worked,
// public_holiday_worked) are the nightly sweep's record and cannot be written
// or removed here; a correction is a manual entry with a note.
//
//   GET    ?profile_id=&year=      the year's rows and balance (own, or a
//                                  profile the caller manages: profileScope)
//   POST   { profile_id, location_id, source: manual|taken, hours, credit_date, note }
//                                  master / owner / manager AT location_id
//                                  (hasRoleAtLocation + assertLocationAccess),
//                                  and the profile must belong to that studio
//                                  (404 otherwise, so an id cannot be probed).
//                                  'taken' is refused (409) when it exceeds the
//                                  running balance to that date.
//   DELETE ?id=                    removes a manual / taken row: same gate AT
//                                  the row's studio; an automatic row is 409.
//
// Standard shape { success, data | error }.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, realIsoDate, MANAGER_ROLES, ADMIN_ROLES } from '@/lib/schemas'
import { parseAllowanceYear } from '@/lib/allowance-year'
import { staffZoneOfUser } from '@/lib/staff-zone'
import { profileScope } from '@/lib/allowance-scope'
import { readLieuLedger, readLieuLedgerForProfiles } from '@/lib/lieu-credits'
import { lieuBalanceFrom, LIEU_MANUAL_SOURCES } from '@/lib/lieu-rules'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const LIEU_MAX_HOURS_PER_ENTRY = 500

export const LieuEntrySchema = z.object({
  profile_id: uuidLike,
  location_id: uuidLike,
  source: z.enum(LIEU_MANUAL_SOURCES),
  // Always positive on the wire; 'taken' is stored negative.
  hours: z.number().finite().gt(0).max(LIEU_MAX_HOURS_PER_ENTRY),
  credit_date: realIsoDate,
  note: z.string().trim().min(1, 'A note is required').max(500),
})

function entryView(r) {
  return {
    id: r.id,
    profile_id: r.profile_id,
    location_id: r.location_id,
    source: r.source,
    shift_assignment_id: r.shift_assignment_id ?? null,
    credit_date: r.credit_date,
    hours: Number(r.hours),
    worked_hours: r.worked_hours == null ? null : Number(r.worked_hours),
    multiplier: r.multiplier == null ? null : Number(r.multiplier),
    holiday_name: r.holiday_name ?? null,
    note: r.note ?? null,
    created_by: r.created_by ?? null,
    created_at: r.created_at ?? null,
  }
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const profileId = searchParams.get('profile_id') || user.id
  const { year, error: yearError } = parseAllowanceYear(searchParams.get('year'), staffZoneOfUser(user))
  if (yearError) return NextResponse.json({ success: false, error: yearError }, { status: 400 })
  const db = createServerClient()

  if (profileId !== user.id && !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  if (profileId !== user.id) {
    const scope = await profileScope(db, user, profileId)
    if (scope === 'foreign') return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    if (scope !== 'managed') return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { rows, error } = await readLieuLedger(db, profileId, year)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({
    success: true,
    data: { profile_id: profileId, year: Number(year), ...lieuBalanceFrom(rows), entries: rows.map(entryView) },
  })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasRoleAtAnyLocation(user, ADMIN_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, LieuEntrySchema)
  if (!validation.ok) return validation.response
  const { profile_id, location_id, source, hours, credit_date, note } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, location_id, ADMIN_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only owners and managers at this studio can record lieu time.' }, { status: 403 })
  }

  const db = createServerClient()
  // The person must belong to the studio the entry is filed at: a foreign id
  // is a 404, indistinguishable from a missing one.
  const { data: link, error: linkError } = await db.from('profile_locations')
    .select('profile_id')
    .eq('profile_id', profile_id)
    .eq('location_id', location_id)
    .limit(1)
  if (linkError) return NextResponse.json({ success: false, error: linkError.message }, { status: 500 })
  if (!link || link.length === 0) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  if (source === 'taken') {
    const { rows, error } = await readLieuLedgerForProfiles(db, [profile_id], { to: credit_date })
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    const { balance_hours } = lieuBalanceFrom(rows)
    if (hours > balance_hours + 1e-9) {
      return NextResponse.json({
        success: false,
        error: `Only ${balance_hours} lieu hours are banked on ${credit_date}; ${hours} cannot be taken.`,
        data: { balance_hours },
      }, { status: 409 })
    }
  }

  const { data, error } = await db.from('staff_lieu_credits')
    .insert({
      profile_id,
      location_id,
      source,
      shift_assignment_id: null,
      credit_date,
      hours: source === 'taken' ? -hours : hours,
      worked_hours: null,
      multiplier: null,
      holiday_name: null,
      note,
      created_by: user.id,
    })
    .select('id, profile_id, location_id, source, shift_assignment_id, credit_date, hours, worked_hours, multiplier, holiday_name, note, created_by, created_at')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data: entryView(data) }, { status: 201 })
}

export async function DELETE(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasRoleAtAnyLocation(user, ADMIN_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const parsed = uuidLike.safeParse(searchParams.get('id'))
  if (!parsed.success) return NextResponse.json({ success: false, error: 'id must be a uuid' }, { status: 400 })
  const id = parsed.data

  const db = createServerClient()
  const { data: row, error: readError } = await db.from('staff_lieu_credits')
    .select('id, location_id, source')
    .eq('id', id)
    .maybeSingle()                         // primary key; 0 rows = not found
  if (readError) return NextResponse.json({ success: false, error: readError.message }, { status: 500 })
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // Membership before role, and a miss is the same 404 as a missing row.
  const guard = assertLocationAccess(user, row.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!hasRoleAtLocation(user, row.location_id, ADMIN_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only owners and managers at this studio can remove lieu entries.' }, { status: 403 })
  }
  if (!LIEU_MANUAL_SOURCES.includes(row.source)) {
    return NextResponse.json({ success: false, error: 'An automatic credit is the roster\'s record and cannot be removed; add a manual entry with a note instead.' }, { status: 409 })
  }

  const { data: deleted, error } = await db.from('staff_lieu_credits')
    .delete()
    .eq('id', id)
    .eq('location_id', row.location_id)
    .select('id')
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  if (!deleted || deleted.length === 0) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data: { id } })
}
