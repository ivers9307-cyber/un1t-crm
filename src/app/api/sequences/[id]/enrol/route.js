// POST /api/sequences/[id]/enrol  { contact_ids: [...], dry_run?: boolean }
//
// Manually enrol contacts into a sequence. Idempotent — contacts
// already actively enrolled are skipped, returned in the `skipped`
// count. Email permission required.
//
// Dry-run mode (`dry_run: true`): does all the validation + filtering +
// already-enrolled lookup, then returns a preview WITHOUT inserting.
// Powers the "Preview enrolments" two-step flow in `<SequencePicker>`
// — operator sees what would happen before committing. Same auth and
// validation gates as the real call so the preview is a faithful
// representation of the eventual outcome.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sequenceNotFound } from '@/lib/sequence-access'
import { logError } from '@/lib/log'
import { uuidLike } from '@/lib/schemas'
import { enrolContacts } from '@/lib/sequences'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'

const Body = z.object({
  contact_ids: z.array(z.string().uuid()).min(1).max(1000),
  source_ref: z.string().max(200).nullable().optional(),
  dry_run: z.boolean().optional().default(false),
})

// Number of contact rows to include in the preview sample. Kept small
// because the operator just needs to spot-check, not see the whole list.
const PREVIEW_SAMPLE_SIZE = 20

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'email')) {
    return NextResponse.json({ success: false, error: 'Email permission required' }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const parsed = { data: validation.data }

  // SEQPAGEGATE.1 — a missing sequence and another studio's answer the same
  // 404 (was 404 vs 403, which confirmed the id existed). A failed read is a
  // logged 500, not "not found"; a garbage id is not found without a read.
  if (!uuidLike.safeParse(params.id).success) return sequenceNotFound()
  const db = createServerClient()
  const { data: sequence, error: seqErr } = await db
    .from('email_sequences')
    .select('id, location_id, name')
    .eq('id', params.id)
    .maybeSingle()
  if (seqErr) {
    logError('sequences', 'enrol: sequence read failed', { sequenceId: params.id, code: seqErr.code || null })
    return NextResponse.json({ success: false, error: 'Could not load the sequence' }, { status: 500 })
  }
  if (!sequence) return sequenceNotFound()
  const hidden = assertLocationAccessOr404(user, sequence.location_id)
  if (hidden) return hidden
  // ROLESWEEP.1a — the permission is judged at the sequence's location.
  if (!hasPermissionForLocation(user, sequence.location_id, 'email')) {
    return NextResponse.json({ success: false, error: 'Email permission required' }, { status: 403 })
  }

  // Constrain enrolments to contacts at the same location.
  const { data: validContacts } = await db
    .from('contacts')
    .select('id')
    .eq('location_id', sequence.location_id)
    .in('id', parsed.data.contact_ids)
  const validIds = (validContacts || []).map(c => c.id)
  const invalidIds = parsed.data.contact_ids.filter((id) => !validIds.includes(id))
  const invalidCount = invalidIds.length

  // Already-active enrolment lookup — same shape that enrolContacts
  // does internally. Done explicitly here so the preview can classify
  // each contact accurately.
  let alreadyActiveIds = new Set()
  if (validIds.length > 0) {
    const { data: existing } = await db
      .from('sequence_enrollments')
      .select('contact_id')
      .eq('sequence_id', params.id)
      .eq('status', 'active')
      .in('contact_id', validIds)
    alreadyActiveIds = new Set((existing || []).map((r) => r.contact_id))
  }

  const eligibleIds = validIds.filter((id) => !alreadyActiveIds.has(id))

  // ── Dry-run branch — return preview, no DB writes. ──────────────
  if (parsed.data.dry_run) {
    // Build a compact sample for the operator to spot-check — pulls
    // names + emails for up to PREVIEW_SAMPLE_SIZE contacts across all
    // three classifications, weighted toward the eligible bucket since
    // that's what the operator most cares about reviewing.
    const sampleIds = []
    for (const id of eligibleIds.slice(0, Math.ceil(PREVIEW_SAMPLE_SIZE * 0.7))) sampleIds.push(id)
    for (const id of [...alreadyActiveIds].slice(0, Math.ceil(PREVIEW_SAMPLE_SIZE * 0.2))) sampleIds.push(id)
    for (const id of invalidIds.slice(0, Math.ceil(PREVIEW_SAMPLE_SIZE * 0.2))) sampleIds.push(id)

    let sample = []
    if (sampleIds.length > 0) {
      const { data: contactRows } = await db
        .from('contacts')
        .select('id, name, first_name, last_name, email')
        .in('id', sampleIds)
      // Annotate each row with the classification bucket. Defensive: a
      // contact in `invalidIds` won't actually be returned because the
      // RLS filter on contacts is also location-scoped — show those
      // as "no_access" so the operator sees something rather than a
      // silent omission.
      const byId = new Map((contactRows || []).map((c) => [c.id, c]))
      sample = sampleIds.map((id) => {
        const c = byId.get(id)
        const status = alreadyActiveIds.has(id)
          ? 'already_active'
          : invalidIds.includes(id)
            ? 'wrong_location'
            : 'eligible'
        return {
          id,
          name: c?.name || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || '(unknown)',
          email: c?.email || '',
          status,
        }
      })
    }

    return NextResponse.json({
      success: true,
      dry_run: true,
      sequence: { id: sequence.id, name: sequence.name },
      total_requested: parsed.data.contact_ids.length,
      would_enrol: eligibleIds.length,
      already_active: alreadyActiveIds.size,
      ignored_invalid: invalidCount,
      sample,
    })
  }

  // ── Real enrol branch ────────────────────────────────────────────
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
