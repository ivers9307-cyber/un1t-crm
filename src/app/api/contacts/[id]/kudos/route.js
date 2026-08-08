// POST /api/contacts/[id]/kudos — send a coach "kudo" to a member.
//
// COACH KUDOS — staff-authored congratulatory note (+ optional emoji) the
// member reads in the champ app. Write-only from the staff side here; the
// member's read + mark-seen lives in champ-app.
//
// Authorization: session auth + `consultations` permission (the coach/member
// surface), THEN an explicit in-location check on the recipient contact.
// Service-role client bypasses RLS, so the guard here IS the access control —
// we never rely on RLS for a route (repo invariant). [id] is the recipient.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { logWarn } from '@/lib/log'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'

const CreateKudosSchema = z.object({
  // 1..500 chars after trimming — mirrors the DB CHECK. z.string().trim()
  // so " " alone is rejected as empty.
  message: z.string().trim().min(1, 'Message is required').max(500, 'Message is too long (max 500)'),
  // Optional short emoji (<= 8 chars mirrors the DB CHECK; a single emoji can
  // be multiple code units, so we allow a little headroom, not 1).
  emoji: z.string().max(8).optional().nullable(),
  // Optional: tie the kudo to a specific HR class session.
  session_id: uuidLike.optional().nullable(),
})

export async function POST(request, props) {
  const params = await props.params
  const { id } = params

  // Validate the path param up front (matches the openapi contract) rather than
  // letting a non-uuid reach PostgREST as a 22P02. Fails closed either way, but
  // 404 keeps ids non-enumerable and avoids a noisy DB error.
  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  // Same gate as consultations — the coach/member surface. Staff without it
  // (default) can't send kudos.
  if (!hasPermission(user, 'consultations')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  // Resolve the recipient's location_id from the contact row (never trust a
  // client-supplied location) — this is also what we location-scope against.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', id)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  // Explicit in-location authorization — a staffer can't kudos a member outside
  // their location(s). 404 (not 403) so contact ids can't be enumerated.
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  const validation = await validateBody(request, CreateKudosSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Integrity check on the optional session link (re-audit): the session must
  // BELONG to the recipient member and live in the same location. Without this
  // any UUID was accepted — a UI bug (or a crafted request) could pin a kudo to
  // another member's session. 400, not 404: the recipient contact is already
  // authorised above; this is a bad linkage in the payload, not enumeration.
  if (body.session_id) {
    const { data: session, error: sessionErr } = await db
      .from('heart_rate_sessions')
      .select('id, contact_id, location_id')
      .eq('id', body.session_id)
      .maybeSingle()
    if (sessionErr || !session || session.contact_id !== id || session.location_id !== contact.location_id) {
      return NextResponse.json(
        { success: false, error: 'session_id does not belong to this member' },
        { status: 400 },
      )
    }
  }

  const insertPayload = {
    contact_id: id,
    location_id: contact.location_id,
    sender_profile_id: user.id,
    // Denormalise the sender's name at send time so it survives profile
    // deletion and is readable by the member (whose role has no grant on
    // public.profiles). Fall back to a neutral label if the profile has none.
    sender_name: user.full_name || 'Your coach',
    message: body.message, // already trimmed + length-validated by Zod
    emoji: body.emoji || null,
    session_id: body.session_id || null,
  }

  const { data, error } = await db
    .from('coach_kudos')
    .insert(insertPayload)
    .select()
    .single()

  if (error) {
    // Log the real DB error server-side; never return PostgREST internals to
    // the client (re-audit H7 class — raw error.message leaks schema detail).
    logWarn('kudos', 'insert failed', { err: error.message, contactId: id })
    return NextResponse.json({ success: false, error: 'Could not send kudos' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data })
}
