// /api/contacts/segments/[id]
//
// Update + delete for a single saved segment. Read-by-id isn't
// exposed because the list endpoint already returns the full
// segment shape — there's no per-segment detail page to load.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { audienceFilterSchema } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  filter: audienceFilterSchema,
})

export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const db = createServerClient()
  const { data: existing } = await db
    .from('contact_segments')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (!existing) return NextResponse.json({ success: false, error: 'Segment not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard

  const raw = await request.json().catch(() => ({}))
  const parsed = UpdateBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const updates = { updated_at: new Date().toISOString() }
  if (parsed.data.name !== undefined) updates.name = parsed.data.name.trim()
  if (parsed.data.description !== undefined) updates.description = parsed.data.description
  if (parsed.data.filter !== undefined) updates.filter = parsed.data.filter

  const { data, error } = await db
    .from('contact_segments')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) {
    if (/duplicate key|unique constraint/i.test(error.message)) {
      return NextResponse.json({ success: false, error: 'A segment with this name already exists.' }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, segment: data })
}

export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const db = createServerClient()
  const { data: existing } = await db
    .from('contact_segments')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (!existing) return NextResponse.json({ success: false, error: 'Segment not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard

  const { error } = await db.from('contact_segments').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
