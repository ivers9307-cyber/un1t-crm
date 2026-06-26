// POST /api/contacts/[id]/consultations — create a consultation for a contact.
//
// CONSULTATIONS SP1 — consultations CRUD.
//
// Authorization: session auth + consultations permission.
// [id] is the contact the consultation belongs to.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'

const CreateConsultationSchema = z.object({
  // consulted_at is a timestamptz — accept any ISO datetime string Postgres
  // can parse (e.g. "2026-06-15T10:00:00Z" or "2026-06-15T10:00:00+01:00").
  consulted_at: z.string().optional(),
  coach_id: uuidLike.optional(),
  notes: z.string().optional(),
  // Coach-authored feedback shown to the member in the champ-app (mig 318);
  // distinct from the staff-only `notes`. Nullable so it can be cleared.
  member_feedback: z.string().nullable().optional(),
})

// ============================================================
// POST /api/contacts/[id]/consultations — create a consultation
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

  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  const validation = await validateBody(request, CreateConsultationSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const insertPayload = {
    contact_id: id,
    location_id: contact.location_id,
    created_by: user.id,
    coach_id: body.coach_id || user.id,
    notes: body.notes,
    member_feedback: body.member_feedback ?? null,
  }

  // Only set consulted_at if provided — otherwise let the DB default to now().
  if (body.consulted_at !== undefined) {
    insertPayload.consulted_at = body.consulted_at
  }

  const { data, error } = await db
    .from('consultations')
    .insert(insertPayload)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data })
}
