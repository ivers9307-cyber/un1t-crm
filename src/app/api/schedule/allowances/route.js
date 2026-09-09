import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, days , MANAGER_ROLES} from '@/lib/schemas'

// ROSTER-FIX.2 — a profile is in scope when it shares a location with the
// caller (master = everywhere). Detail-style 404 on miss so a cross-tenant
// id is indistinguishable from a missing one.
async function profileInScope(db, user, profileId) {
  if (user.role === 'master') return true
  const { data } = await db.from('profile_locations').select('location_id').eq('profile_id', profileId)
  const mine = new Set(getUserLocationIds(user))
  return (data || []).some((l) => mine.has(l.location_id))
}

const AllowanceUpdateSchema = z.object({
  profile_id: uuidLike,
  year: z.number().int().min(2020).max(2100),
  total_days: days.optional(),
  carried_over: days.optional(),
})

// GET /api/schedule/allowances?profile_id=xxx&year=2026
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const profileId = searchParams.get('profile_id') || user.id
  const year = searchParams.get('year') || new Date().getFullYear()
  const db = createServerClient()

  // Staff can only view their own allowance
  if (profileId !== user.id && !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  // ROSTER-FIX.2 — a manager only reads allowances for their own studios.
  if (profileId !== user.id && !(await profileInScope(db, user, profileId))) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
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

  // If no allowance record exists, return defaults
  if (!data) {
    return NextResponse.json({
      success: true,
      data: {
        profile_id: profileId,
        year: Number(year),
        total_days: 20,
        used_days: 0,
        carried_over: 0,
        remaining: 20,
      }
    })
  }

  return NextResponse.json({
    success: true,
    data: {
      ...data,
      remaining: data.total_days + data.carried_over - data.used_days,
    }
  })
}

// PUT /api/schedule/allowances — Set/update a staff member's allowance (managers only)
export async function PUT(request) {
  const user = await getCurrentUser()
  // ROSTER-FIX.2 — MANAGER_ROLES is the house manager set; the hand-written
  // ['owner','manager'] here locked out master and head_coach.
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, AllowanceUpdateSchema)
  if (!validation.ok) return validation.response
  const { profile_id, year, total_days, carried_over } = validation.data
  const db = createServerClient()

  if (!(await profileInScope(db, user, profile_id))) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
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
