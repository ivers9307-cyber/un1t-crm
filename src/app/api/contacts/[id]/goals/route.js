// POST /api/contacts/[id]/goals — create a goal for a contact.
//
// CONSULTATIONS SP1 — goals CRUD.
//
// Authorization: session auth + consultations permission.
// [id] is the contact the goal belongs to.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
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
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const id = params?.id

  if (!hasPermissionAtAnyLocation(user, 'consultations')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', id)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard
  // ROLESWEEP.1c — `consultations` judged at the contact's location, not the active studio.
  if (!hasPermissionForLocation(user, contact.location_id, 'consultations')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, CreateGoalSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const { data, error } = await db
    .from('coaching_goals')
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
    logError('coaching-goals', 'goal insert failed', { contactId: id, err: error })
    return NextResponse.json({ success: false, error: 'Could not save the goal.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data })
})
