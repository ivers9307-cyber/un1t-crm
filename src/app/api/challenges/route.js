import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, getUserLocationIds, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
// HUBDOOR.2 — the role floor is exported from challenges-access so the
// page gate, the (members) tab strip and the Members redirect chain are
// bound to THIS route's rule rather than each re-deriving it. Same value
// (MANAGER_ROLES); the two-step check stays so the 403 keeps saying which
// half failed.
import { CHALLENGE_ADMIN_ROLES } from '@/lib/challenges-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
export const CreateSchema = z.object({
  location_id: uuidLike,
  name: z.string().trim().min(1).max(200),
  mode: z.enum(['individual', 'collective']),
  metric: z.enum(['points', 'classes', 'z4plus_minutes']),
  starts_on: DATE,
  ends_on: DATE,
  target: z.number().int().positive().max(100000000).nullable().optional(),
  // Flagship transformation challenge (Pulse sub-project 3): turns this into the
  // marquee event — InBody bookend + Challenge Wrapped + consistency scoring in
  // the member app. A flagship is always an individual challenge.
  is_flagship: z.boolean().optional().default(false),
})
  .refine((d) => d.mode !== 'collective' || (d.target != null && d.target > 0), { message: 'Collective challenges need a positive target.', path: ['target'] })
  .refine((d) => d.ends_on >= d.starts_on, { message: 'ends_on must be on or after starts_on.', path: ['ends_on'] })
  .refine((d) => !d.is_flagship || d.mode === 'individual', { message: 'A flagship transformation challenge must be an individual challenge.', path: ['is_flagship'] })

function guard(user) {
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!CHALLENGE_ADMIN_ROLES.includes(user.role)) return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  if (!hasPermission(user, 'challenges')) return NextResponse.json({ success: false, error: 'Challenges feature is disabled at this location' }, { status: 403 })
  return null
}

export async function GET(request) {
  const user = await getCurrentUser()
  const g = guard(user); if (g) return g
  const filterLocation = new URL(request.url).searchParams.get('location_id')
  const db = createServerClient()
  const locationIds = filterLocation ? [filterLocation] : getUserLocationIds(user)
  if (locationIds.length === 0) return NextResponse.json({ success: true, data: [] })
  if (filterLocation) { const a = assertLocationAccess(user, filterLocation); if (a) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  const { data, error } = await db.from('challenges').select('*').in('location_id', locationIds).order('ends_on', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}

export async function POST(request) {
  const user = await getCurrentUser()
  const g = guard(user); if (g) return g
  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const a = assertLocationAccess(user, body.location_id); if (a) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  const db = createServerClient()
  const { data, error } = await db.from('challenges').insert({
    location_id: body.location_id, name: body.name, mode: body.mode, metric: body.metric,
    starts_on: body.starts_on, ends_on: body.ends_on,
    target: body.mode === 'collective' ? body.target : null,
    is_flagship: body.is_flagship,
    created_by: user.id,
  }).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data }, { status: 201 })
}
