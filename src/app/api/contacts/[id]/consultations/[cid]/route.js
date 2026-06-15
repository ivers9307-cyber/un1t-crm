// PUT /api/contacts/[id]/consultations/[cid] — update a consultation.
// DELETE /api/contacts/[id]/consultations/[cid] — delete a consultation.
//
// CONSULTATIONS SP1 — consultations CRUD.
//
// Authorization: session auth + consultations permission.
// [id] is the contact; [cid] is the consultation id.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'

const UpdateConsultationSchema = z.object({
  // consulted_at is a timestamptz — accept any ISO datetime string Postgres can parse.
  consulted_at: z.string().optional(),
  coach_id: uuidLike.optional(),
  notes: z.string().optional(),
})

// ============================================================
// PUT /api/contacts/[id]/consultations/[cid] — update a consultation
// ============================================================
export async function PUT(request, props) {
  const params = await props.params
  const { id, cid } = params

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

  const validation = await validateBody(request, UpdateConsultationSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const updates = {
    updated_at: new Date().toISOString(),
  }

  if (body.consulted_at !== undefined) updates.consulted_at = body.consulted_at
  if (body.coach_id !== undefined) updates.coach_id = body.coach_id
  if (body.notes !== undefined) updates.notes = body.notes

  const { data, error } = await db
    .from('consultations')
    .update(updates)
    .eq('id', cid)
    .eq('contact_id', id)
    .select()
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Consultation not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true, data })
}

// ============================================================
// DELETE /api/contacts/[id]/consultations/[cid] — delete a consultation
// ============================================================
export async function DELETE(request, props) {
  const params = await props.params
  const { id, cid } = params

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
    .from('consultations')
    .delete()
    .eq('id', cid)
    .eq('contact_id', id)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
