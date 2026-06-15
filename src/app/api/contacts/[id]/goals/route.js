// POST /api/contacts/[id]/goals — create a goal for a contact.
//
// CONSULTATIONS SP1 — goals CRUD.
//
// Authorization: session auth + consultations permission.
// [id] is the contact the goal belongs to.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { isoDate } from '@/lib/schemas'

export const runtime = 'nodejs'

const CreateGoalSchema = z.object({
  title: z.string().min(1),
  detail: z.string().optional(),
  target_value: z.string().optional(),
  target_date: isoDate.optional(),
})

// ============================================================
// POST /api/contacts/[id]/goals — create a goal
// ============================================================
export async function POST(request, props) {
  const params = await props.params
  const { id } = params

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

  const validation = await validateBody(request, CreateGoalSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const { data, error } = await db
    .from('contact_goals')
    .insert({
      contact_id: id,
      location_id: contact.location_id,
      created_by: user.id,
      title: body.title,
      detail: body.detail,
      target_value: body.target_value,
      target_date: body.target_date,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data })
}
