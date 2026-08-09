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
import { validateBody, uuidLike } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  filter: audienceFilterSchema,
  // SEGSAVE.1 — uuidLike, NOT z.string().uuid(). Zod 4 enforces the RFC 4122
  // version digit (1-8); Stillorgan's seeded id (a0000000-…-0001) has version
  // digit 0, so the strict validator 400'd every save at the ONLY live
  // location — which is why contact_segments was empty estate-wide. Postgres
  // accepts any 36-char hex string; validate.js documents this and CLAUDE.md
  // makes it an invariant.
  location_id: uuidLike.optional(),
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

  const validation = await validateBody(request, CreateBody)
  if (!validation.ok) return validation.response
  const parsed = { data: validation.data }

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
