// POST /api/contacts/[id]/consultations — create a consultation for a contact.
//
// CONSULTATIONS SP1 — consultations CRUD.
//
// Authorization: session auth + consultations permission.
// [id] is the contact the consultation belongs to.
// withAuth signs the caller in (401) and asks for `consultations` somewhere
// (the same 403 'Unauthorized'); the contact (404), its studio (404) and the
// permission there (403) follow, as before.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
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
export const POST = withAuth({
  permission: null,
  location: false,
  allow: (user) => hasPermissionAtAnyLocation(user, 'consultations'),
  forbiddenMessage: 'Unauthorized',
}, async ({ user, db, request, params }) => {
  const { id } = params

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
    logError('consultations', 'consultation create failed', { contactId: id, err: error })
    return NextResponse.json({ success: false, error: 'Could not save the consultation. Try again.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data })
})
