// PATCH /api/contacts/duplicates/[id]
//
// Review-queue action route for person_link_suggestions.
//
// PATCH body: { status: 'linked' | 'dismissed' }
//
//   dismissed → update suggestion status only.
//   linked    → call linkContactPair to create/extend the person group,
//               then flip suggestion to 'linked'.
//
// If linkContactPair throws (contacts already in different groups),
// returns 400 with the error message.
//
// PERSON-LINK.2 — duplicates review queue.
//
// Authorization: session auth + contact_linking permission.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { linkContactPair } from '@/lib/person-links'

export const runtime = 'nodejs'

const MODULE = 'contact-duplicates'
// linkContactPair's one refusal a person can act on; anything else it throws
// carries database text, which stays in the log.
const DIFFERENT_PEOPLE = 'Both contacts are already linked to different people'

const PatchSchema = z.object({
  status: z.enum(['linked', 'dismissed']),
})

// ============================================================
// PATCH /api/contacts/duplicates/[id]
// ============================================================
// withAuth only signs the caller in (the same 401); contact_linking somewhere,
// the body, the suggestion's studio (404) and contact_linking there stay by
// hand, in their old order.
export const PATCH = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'contact_linking')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const validation = await validateBody(request, PatchSchema)
  if (!validation.ok) return validation.response

  const { status } = validation.data
  const id = params?.id

  // Load the suggestion
  const { data: suggestion, error: suggestionError } = await db
    .from('person_link_suggestions')
    .select('*')
    .eq('id', id)
    .single()

  if (suggestionError || !suggestion) {
    return NextResponse.json(
      { success: false, error: 'Suggestion not found' },
      { status: 404 }
    )
  }

  // Location access guard
  const guard = assertLocationAccessOr404(user, suggestion.location_id)
  if (guard) return guard
  // ROLESWEEP.1c — `contact_linking` judged at the suggestion's location, not the active studio.
  if (!hasPermissionForLocation(user, suggestion.location_id, 'contact_linking')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const decidedAt = new Date().toISOString()

  if (status === 'dismissed') {
    const { data, error } = await db
      .from('person_link_suggestions')
      .update({ status: 'dismissed', decided_by: user.id, decided_at: decidedAt })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      logError(MODULE, 'dismiss failed', { suggestionId: id, code: error.code || null, err: error.message })
      return NextResponse.json({ success: false, error: 'Could not update the suggestion' }, { status: 500 })
    }

    return NextResponse.json({ success: true, data })
  }

  // status === 'linked'
  try {
    await linkContactPair(db, {
      aId: suggestion.contact_id_a,
      bId: suggestion.contact_id_b,
      method: suggestion.match_method,
      confidence: suggestion.confidence,
      actorId: user.id,
      locationId: suggestion.location_id,
    })
  } catch (e) {
    if (e?.message !== DIFFERENT_PEOPLE) logError(MODULE, 'link failed', { suggestionId: id, err: e?.message || String(e) })
    return NextResponse.json(
      { success: false, error: e?.message === DIFFERENT_PEOPLE ? DIFFERENT_PEOPLE : 'Could not link contacts' },
      { status: 400 }
    )
  }

  // Flip suggestion to linked
  const { data, error } = await db
    .from('person_link_suggestions')
    .update({ status: 'linked', decided_by: user.id, decided_at: decidedAt })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    logError(MODULE, 'mark linked failed', { suggestionId: id, code: error.code || null, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not update the suggestion' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data })
})
