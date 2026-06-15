// PUT /api/contacts/[id]/goals/[gid] — update a goal.
// DELETE /api/contacts/[id]/goals/[gid] — delete a goal.
//
// CONSULTATIONS SP1 — goals CRUD.
//
// Authorization: session auth + consultations permission.
// [id] is the contact the goal belongs to; [gid] is the goal id.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { isoDate } from '@/lib/schemas'

export const runtime = 'nodejs'

const UpdateGoalSchema = z.object({
  title: z.string().min(1).optional(),
  detail: z.string().optional(),
  target_value: z.string().optional(),
  target_date: isoDate.optional(),
  status: z.enum(['open', 'achieved', 'dropped']).optional(),
})

// ============================================================
// PUT /api/contacts/[id]/goals/[gid] — update a goal
// ============================================================
export async function PUT(request, props) {
  const params = await props.params
  const { id, gid } = params

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'consultations')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', id)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  const guard = assertLocationAccess(user, contact.location_id)
  if (guard) return guard

  const validation = await validateBody(request, UpdateGoalSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const updates = {
    updated_at: new Date().toISOString(),
  }

  if (body.title !== undefined) updates.title = body.title
  if (body.detail !== undefined) updates.detail = body.detail
  if (body.target_value !== undefined) updates.target_value = body.target_value
  if (body.target_date !== undefined) updates.target_date = body.target_date

  if (body.status !== undefined) {
    updates.status = body.status
    if (body.status === 'achieved') {
      updates.achieved_at = new Date().toISOString()
    } else {
      updates.achieved_at = null
    }
  }

  const { data, error } = await db
    .from('contact_goals')
    .update(updates)
    .eq('id', gid)
    .eq('contact_id', id)
    .select()
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Goal not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true, data })
}

// ============================================================
// DELETE /api/contacts/[id]/goals/[gid] — delete a goal
// ============================================================
export async function DELETE(request, props) {
  const params = await props.params
  const { id, gid } = params

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'consultations')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', id)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  const guard = assertLocationAccess(user, contact.location_id)
  if (guard) return guard

  const { error } = await db
    .from('contact_goals')
    .delete()
    .eq('id', gid)
    .eq('contact_id', id)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
