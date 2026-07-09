// POST /api/contacts/[id]/pipeline-status — operator "Cold" dismissal.
//
// FUNNEL.4 — take a lead off the pipeline ({ cold: true }) or return them to
// it ({ cold: false }). Reserved for a lead not worth selling to / who said
// they're not interested. Sets/clears contacts.pipeline_dismissed_at, then
// re-places the deal immediately (ensureDealForContact runs the classifier)
// so the board reflects the change without waiting for the nightly cron. The
// classifier auto-revives a cold lead the moment they attend a class after
// the dismissal — no un-cold click needed if they simply come back and train.
//
// Authorization: session + `pipeline` permission (same gate as the board),
// THEN an explicit in-location check on the contact. Service-role client
// bypasses RLS, so this guard IS the access control (repo invariant).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { ensureDealForContact } from '@/lib/glofox-sync'

export const runtime = 'nodejs'

const PipelineStatusSchema = z.object({
  // true → mark Cold (dismiss); false → return to the pipeline (clear).
  cold: z.boolean(),
})

// Classifier input columns — must include everything classifyContact reads so
// the immediate re-placement matches what the nightly cron would compute.
const SNAPSHOT_COLS =
  'id, name, location_id, glofox_membership_status, joined_at, created_at, ' +
  'last_attended_at, trial_credits_remaining, recent_bookings, converted_at, ' +
  'pack_customer_at, pipeline_dismissed_at'

export async function POST(request, props) {
  const params = await props.params
  const { id } = params

  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'pipeline')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, PipelineStatusSchema)
  if (!validation.ok) return validation.response
  const { cold } = validation.data

  const db = createServerClient()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select(SNAPSHOT_COLS)
    .eq('id', id)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  // now (ISO) when dismissing, null when clearing. Idempotent — setting the
  // same value twice is harmless.
  const dismissedAt = cold ? new Date().toISOString() : null
  const { error: updateErr } = await db
    .from('contacts')
    .update({ pipeline_dismissed_at: dismissedAt })
    .eq('id', id)
  if (updateErr) {
    return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 })
  }

  // Move the deal now so the board updates immediately, mirroring the persisted
  // change. Best-effort: the nightly cron + next webhook sync also converge, so
  // a placement hiccup here is not fatal to the (already-saved) dismissal.
  let deal = null
  try {
    deal = await ensureDealForContact(
      db,
      contact.location_id,
      id,
      { ...contact, pipeline_dismissed_at: dismissedAt },
      contact.name || null,
    )
  } catch (e) {
    deal = { action: 'error', error: e?.message || 'deal placement threw' }
  }

  return NextResponse.json({ success: true, data: { cold, pipeline_dismissed_at: dismissedAt, deal } })
}
