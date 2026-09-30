// /api/contacts/segments/[id]
//
// Update + delete for a single saved segment. Read-by-id isn't
// exposed because the list endpoint already returns the full
// segment shape; there's no per-segment detail page to load.
//
// SEGMENTROUTE.1: both handlers share one gate, in the house order:
// 401 → uuid-shaped id (else 404) → the row (a failed read is a logged 500,
// a missing row the same 404 another studio's gets) → membership (404) →
// contacts at the segment's studio (403) → a segment a sequence starts from
// also needs email or whatsapp there (403). PUT then validates its filter
// with the POST's own rule (FILTER-P1.5 had missed it here).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { audienceFilterSchema } from '@/lib/schemas'
import { validateBody, uuidLike } from '@/lib/validate'
import { logError } from '@/lib/log'
import {
  canWriteSegmentsAt, canBuildSequencesAt, countSequencesUsingSegment, audienceFilterRefusal,
  segmentWriteRefused, segmentInUseRefused, segmentNotFound,
} from '@/lib/segment-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  filter: audienceFilterSchema,
})

// → { segment } when the caller may change it, else { response }.
async function gateSegmentChange(db, user, segmentId) {
  const { data: segment, error } = await db
    .from('contact_segments')
    .select('id, location_id')
    .eq('id', segmentId)
    .maybeSingle()
  if (error) {
    logError('contacts', 'segment read failed', { segmentId, code: error.code || null, err: error.message })
    return { response: NextResponse.json({ success: false, error: 'Could not load the segment' }, { status: 500 }) }
  }
  if (!segment) return { response: segmentNotFound() }
  const hidden = assertLocationAccessOr404(user, segment.location_id)
  if (hidden) return { response: hidden }
  if (!canWriteSegmentsAt(user, segment.location_id)) return { response: segmentWriteRefused() }

  const used = await countSequencesUsingSegment(db, segment)
  if (used.error) {
    logError('contacts', 'segment sequence-use read failed', { segmentId, code: used.error.code || null, err: used.error.message })
    return { response: NextResponse.json({ success: false, error: 'Could not check which sequences use this segment' }, { status: 500 }) }
  }
  if (used.count > 0 && !canBuildSequencesAt(user, segment.location_id)) return { response: segmentInUseRefused() }
  return { segment }
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!uuidLike.safeParse(params.id).success) return segmentNotFound()

  const db = createServerClient()
  const gate = await gateSegmentChange(db, user, params.id)
  if (gate.response) return gate.response

  const validation = await validateBody(request, UpdateBody, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const parsed = { data: validation.data }

  // No filter key (a rename) validates nothing: validateAudienceFilter(undefined) is a no-op.
  const invalid = audienceFilterRefusal(parsed.data.filter)
  if (invalid) return invalid

  const updates = { updated_at: new Date().toISOString() }
  if (parsed.data.name !== undefined) updates.name = parsed.data.name.trim()
  if (parsed.data.description !== undefined) updates.description = parsed.data.description
  if (parsed.data.filter !== undefined) updates.filter = parsed.data.filter

  const { data, error } = await db
    .from('contact_segments')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) {
    if (/duplicate key|unique constraint/i.test(error.message)) {
      return NextResponse.json({ success: false, error: 'A segment with this name already exists.' }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, segment: data })
}

export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!uuidLike.safeParse(params.id).success) return segmentNotFound()

  const db = createServerClient()
  const gate = await gateSegmentChange(db, user, params.id)
  if (gate.response) return gate.response

  const { error } = await db.from('contact_segments').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
