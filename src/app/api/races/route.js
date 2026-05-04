// /api/races
//
// List + create race events. Manager+ permission. Scoped to the
// caller's active location (mig 082).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, getUserLocationIds, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { MANAGER_ROLES } from '@/lib/schemas'
import { toSlug } from '@/lib/slug'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateSchema = z.object({
  location_id: uuidLike,
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase kebab-case').optional(),
  description: z.string().max(4000).nullable().optional(),
  race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  registration_opens_at: z.string().datetime().nullable().optional(),
  registration_closes_at: z.string().datetime().nullable().optional(),
  capacity: z.number().int().positive().max(10000).nullable().optional(),
  allowed_team_sizes: z.array(z.number().int().positive().max(50)).min(1).max(20).optional(),
  active: z.boolean().optional(),
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const url = new URL(request.url)
  const filterLocation = url.searchParams.get('location_id')

  const db = createServerClient()
  const locationIds = filterLocation ? [filterLocation] : getUserLocationIds(user)
  if (locationIds.length === 0) {
    return NextResponse.json({ success: true, data: [] })
  }
  if (filterLocation) {
    const guard = assertLocationAccess(user, filterLocation)
    if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { data, error } = await db
    .from('race_events')
    .select(`
      id, location_id, name, slug, description, race_date, start_time,
      registration_opens_at, registration_closes_at, capacity,
      allowed_team_sizes, active, created_at, updated_at,
      registrations:race_registrations ( id, status, race_started_at, race_finished_at )
    `)
    .in('location_id', locationIds)
    .order('race_date', { ascending: false })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const slug = body.slug || toSlug(body.name)
  if (!slug) {
    return NextResponse.json({
      success: false,
      error: 'Could not derive a valid slug from the name. Provide one explicitly.',
    }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('race_events')
    .insert({
      location_id: body.location_id,
      name: body.name,
      slug,
      description: body.description ?? null,
      race_date: body.race_date,
      start_time: body.start_time ?? null,
      registration_opens_at: body.registration_opens_at ?? null,
      registration_closes_at: body.registration_closes_at ?? null,
      capacity: body.capacity ?? null,
      allowed_team_sizes: body.allowed_team_sizes && body.allowed_team_sizes.length > 0
        ? [...body.allowed_team_sizes].sort((a, b) => a - b)
        : [1, 2, 4],
      active: body.active ?? true,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505' || /duplicate key|already exists|unique/i.test(error.message || '')) {
      return NextResponse.json({
        success: false,
        error: `A race with slug "${slug}" already exists at this location.`,
        code: 'duplicate_slug',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data }, { status: 201 })
}
