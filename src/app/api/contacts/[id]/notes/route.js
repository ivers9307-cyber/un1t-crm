// POST /api/contacts/[id]/notes — create a staff note on a contact.
//
// GLOFOX-NOTES — this is the SESSION-AUTHED staff surface (used by
// ContactActions.jsx). It inserts the note AND fires a best-effort push into
// Glofox as an interaction so the front desk sees it in the member's timeline.
// The API-key path (/api/notes) is the n8n / bulk-import route and deliberately
// does NOT push (it would mass-spam Glofox with thousands of imported history
// notes). Only THIS path has the session user, so it's the one that carries the
// author name.
//
// Authorization: session auth + `contacts` permission (notes are a core contact
// action; every role has it by default), THEN an explicit in-location check on
// the target contact. Service-role client bypasses RLS, so the guard here IS the
// access control — we never rely on RLS for a route (repo invariant). [id] is the
// contact. Detail routes return 404 (not 403) so ids can't be enumerated.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'

const CreateNoteSchema = z.object({
  // 1..20000 chars after trimming — z.string().trim() so " " alone is rejected.
  content: z.string().trim().min(1, 'Content is required').max(20_000, 'Content is too long (max 20000)'),
})

export async function POST(request, props) {
  const params = await props.params
  const { id } = params

  // Validate the path param up front rather than letting a non-uuid reach
  // PostgREST as a 22P02. 404 keeps ids non-enumerable.
  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  // Notes are a core contact action — gate on `contacts` (granted to every role
  // by default). Staff with contacts access off can't add notes.
  if (!hasPermission(user, 'contacts')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  // Resolve the contact's location from the row (never trust a client-supplied
  // location) — this is what we location-scope against.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', id)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  // Explicit in-location authorization — a staffer can't note a contact outside
  // their location(s). 404 (not 403) so contact ids can't be enumerated.
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  const validation = await validateBody(request, CreateNoteSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const { data, error } = await db
    .from('notes')
    .insert({
      contact_id: id,
      content: body.content,
      location_id: contact.location_id,
    })
    .select('id')
    .single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // GLOFOX-NOTES — copy the note into Glofox for the front desk (fire-and-forget;
  // only for Glofox-linked contacts; edits/deletes are NOT synced back). Never
  // awaited so it can't block or fail the response; the service swallows its own
  // errors. authorName = the session user so the interaction is attributed.
  if (data?.id) {
    import('@/lib/glofox-note-push').then(({ pushNoteToGlofox }) =>
      pushNoteToGlofox(db, {
        contactId: id,
        sourceTable: 'notes',
        sourceId: data.id,
        type: 'NOTE',
        authorName: user.full_name || null,
        content: body.content,
      }),
    ).catch(() => {})
  }

  return NextResponse.json({ success: true, data })
}
