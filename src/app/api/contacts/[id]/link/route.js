// POST /api/contacts/[id]/link  — link two contacts into a person group,
//                                  or set the primary for [id]'s group.
// DELETE /api/contacts/[id]/link — remove [id] from its person group.
//
// PERSON-LINK.1 — non-destructive identity-link API.
//
// Authorization: session auth + contact_linking permission.
// [id] is the contact the operation acts on.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import {
  createGroup,
  addToGroup,
  removeFromGroup,
  setPrimary,
  getPersonGroup,
} from '@/lib/person-links'

export const runtime = 'nodejs'

const LinkBodySchema = z.object({
  otherContactId: uuidLike,
})

// ============================================================
// POST /api/contacts/[id]/link
//   ?action=set-primary  — make [id] the primary in its group
//   (default)            — link [id] to otherContactId
// ============================================================
export async function POST(request, props) {
  const params = await props.params
  const { id } = params

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'contact_linking')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  // Load the primary contact ([id])
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, location_id, name')
    .eq('id', id)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  const guard = assertLocationAccess(user, contact.location_id)
  if (guard) return guard

  const url = new URL(request.url)
  const action = url.searchParams.get('action')

  // ——— set-primary action ———
  if (action === 'set-primary') {
    const pg = await getPersonGroup(db, id)
    if (!pg) {
      return NextResponse.json(
        { success: false, error: 'Contact is not linked to anyone' },
        { status: 400 }
      )
    }
    const data = await setPrimary(db, { groupId: pg.group.id, contactId: id })
    return NextResponse.json({ success: true, data })
  }

  // ——— link action (default) ———
  const validation = await validateBody(request, LinkBodySchema)
  if (!validation.ok) return validation.response
  const { otherContactId } = validation.data

  // Load the other contact
  const { data: otherContact, error: otherErr } = await db
    .from('contacts')
    .select('id, location_id, name')
    .eq('id', otherContactId)
    .single()

  if (otherErr || !otherContact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  // Cross-location guard
  if (otherContact.location_id !== contact.location_id) {
    return NextResponse.json(
      { success: false, error: 'Cannot link contacts in different locations' },
      { status: 400 }
    )
  }

  // Look up existing groups for both
  const [idGroup, otherGroup] = await Promise.all([
    getPersonGroup(db, id),
    getPersonGroup(db, otherContactId),
  ])

  // Idempotent: already in the same group
  if (idGroup && otherGroup && idGroup.group.id === otherGroup.group.id) {
    return NextResponse.json({ success: true, data: { group: idGroup.group, members: idGroup.members } })
  }

  // Both in different existing groups — Phase 1 declines the merge
  if (idGroup && otherGroup) {
    return NextResponse.json(
      { success: false, error: 'Both contacts are already linked to different people; unlink one first' },
      { status: 400 }
    )
  }

  let data
  if (idGroup) {
    // [id] is already in a group — add the other contact to it
    data = await addToGroup(db, {
      groupId: idGroup.group.id,
      contactIds: [otherContactId],
      method: 'manual',
      confidence: 'manual',
      actorId: user.id,
    })
  } else if (otherGroup) {
    // other is in a group — add [id] to it
    data = await addToGroup(db, {
      groupId: otherGroup.group.id,
      contactIds: [id],
      method: 'manual',
      confidence: 'manual',
      actorId: user.id,
    })
  } else {
    // Neither is in a group — create a new one
    data = await createGroup(db, {
      contactIds: [id, otherContactId],
      method: 'manual',
      confidence: 'manual',
      actorId: user.id,
      locationId: contact.location_id,
    })
  }

  // Best-effort audit activity on [id]
  try {
    await db.from('activities').insert({
      contact_id: id,
      location_id: contact.location_id,
      type: 'contact_linked',
      subject: `Linked to ${otherContact.name || 'another account'}`,
      created_by: user.id,
    })
  } catch (_) {
    // swallow — audit failure must not block the primary response
  }

  return NextResponse.json({ success: true, data })
}

// ============================================================
// DELETE /api/contacts/[id]/link — unlink [id] from its group
// ============================================================
export async function DELETE(request, props) {
  const params = await props.params
  const { id } = params

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'contact_linking')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  // Load the contact
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, location_id, name')
    .eq('id', id)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  const guard = assertLocationAccess(user, contact.location_id)
  if (guard) return guard

  const pg = await getPersonGroup(db, id)
  if (!pg) {
    return NextResponse.json(
      { success: false, error: 'Contact is not linked' },
      { status: 400 }
    )
  }

  const data = await removeFromGroup(db, { groupId: pg.group.id, contactId: id })
  return NextResponse.json({ success: true, data })
}
