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
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data })
}
