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
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { linkContactPair } from '@/lib/person-links'

export const runtime = 'nodejs'

const PatchSchema = z.object({
  status: z.enum(['linked', 'dismissed']),
})

// ============================================================
// PATCH /api/contacts/duplicates/[id]
// ============================================================
export async function PATCH(request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'contact_linking')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const validation = await validateBody(request, PatchSchema)
  if (!validation.ok) return validation.response

  const { status } = validation.data
  const { id } = await params

  const db = createServerClient()

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
  const guard = assertLocationAccess(user, suggestion.location_id)
  if (guard) return guard

  const decidedAt = new Date().toISOString()

  if (status === 'dismissed') {
    const { data, error } = await db
      .from('person_link_suggestions')
      .update({ status: 'dismissed', decided_by: user.id, decided_at: decidedAt })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
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
    return NextResponse.json(
      { success: false, error: e?.message || 'Could not link contacts' },
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
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data })
}
