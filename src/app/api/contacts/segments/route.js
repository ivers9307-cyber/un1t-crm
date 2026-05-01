// /api/contacts/segments
//
// CRUD for saved contact filters (segments). Operators build a filter
// on the /contacts page using AudienceBuilder, then save it as a
// named segment for one-click reload.
//
// Storage shape mirrors campaigns.audience_filter / sequences.audience_filter
// — same JSON: { logic, filters: [{ field, op, value }] } — so a
// segment can later be promoted to drive an audience filter for a
// campaign or sequence with no transformation.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { audienceFilterSchema } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  filter: audienceFilterSchema,
  location_id: z.string().uuid().optional(),
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: true, segments: [] })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const db = createServerClient()
  const { data, error } = await db
    .from('contact_segments')
    .select('id, name, description, filter, created_at, updated_at, created_by')
    .eq('location_id', locationId)
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, segments: data || [] })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const raw = await request.json().catch(() => ({}))
  const parsed = CreateBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const locationId = parsed.data.location_id || user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const db = createServerClient()
  const { data, error } = await db
    .from('contact_segments')
    .insert({
      location_id: locationId,
      name: parsed.data.name.trim(),
      description: parsed.data.description ?? null,
      filter: parsed.data.filter ?? { logic: 'and', filters: [] },
      created_by: user.id,
    })
    .select()
    .single()

  if (error) {
    // Friendly message on the unique-name collision (UNIQUE(location_id, name))
    if (/duplicate key|unique constraint/i.test(error.message)) {
      return NextResponse.json({ success: false, error: 'A segment with this name already exists.' }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, segment: data })
}
