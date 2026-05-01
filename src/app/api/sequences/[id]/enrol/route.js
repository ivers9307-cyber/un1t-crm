// POST /api/sequences/[id]/enrol  { contact_ids: [...] }
//
// Manually enrol contacts into a sequence. Idempotent — contacts
// already actively enrolled are skipped, returned in the `skipped`
// count. Email permission required.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { enrolContacts } from '@/lib/sequences'

export const runtime = 'nodejs'

const Body = z.object({
  contact_ids: z.array(z.string().uuid()).min(1).max(1000),
  source_ref: z.string().max(200).nullable().optional(),
})

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'email')) {
    return NextResponse.json({ success: false, error: 'Email permission required' }, { status: 403 })
  }

  const raw = await request.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const db = createServerClient()
  // Verify sequence exists + the caller can see it (RLS-by-location).
  const { data: sequence } = await db
    .from('email_sequences')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (!sequence) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const locationIds = getUserLocationIds(user)
  if (user.role !== 'master' && !locationIds.includes(sequence.location_id)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // Constrain enrolments to contacts at the same location.
  const { data: validContacts } = await db
    .from('contacts')
    .select('id')
    .eq('location_id', sequence.location_id)
    .in('id', parsed.data.contact_ids)
  const validIds = (validContacts || []).map(c => c.id)
  const invalidCount = parsed.data.contact_ids.length - validIds.length

  try {
    const result = await enrolContacts({
      sequenceId: params.id,
      contactIds: validIds,
      sourceType: 'manual',
      sourceRef: parsed.data.source_ref || null,
    })
    return NextResponse.json({
      success: true,
      ...result,
      ignored_invalid: invalidCount,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'Enrol failed' }, { status: 500 })
  }
}
