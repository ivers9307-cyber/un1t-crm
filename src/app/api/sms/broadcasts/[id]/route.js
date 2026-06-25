// /api/sms/broadcasts/[id] — get, update, delete.
//
// PATCH allows editing draft fields (name, body, audience_filter,
// scheduled_at). Once a broadcast is in 'sending' or 'sent' state,
// it's immutable except for cancel-on-draft.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { audienceFilterSchema } from '@/lib/schemas'

export const runtime = 'nodejs'

const PatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(1600).optional(),
  audience_filter: audienceFilterSchema.optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  // User-settable status transitions only:
  //   draft -> scheduled  (requires scheduled_at to be set + future)
  //   scheduled -> draft  (un-schedule)
  //   draft|scheduled -> cancelled  (abort)
  status: z.enum(['draft', 'scheduled', 'cancelled']).optional(),
}).strict()

async function loadBroadcast(db, id) {
  const { data, error } = await db.from('sms_broadcasts')
    .select('*, locations:location_id(id, name, twilio_alpha_sender_id)')
    .eq('id', id)
    .single()
  return { broadcast: data, error }
}

export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'sms')) {
    return NextResponse.json({ success: false, error: 'Forbidden — SMS not enabled' }, { status: 403 })
  }

  const db = createServerClient()
  const { broadcast, error } = await loadBroadcast(db, params.id)
  if (error || !broadcast) {
    return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, broadcast.location_id)
  if (guard) return guard

  // Include recipients summary so the detail page can render
  // sent/failed counts + a few sample errors without a second
  // round-trip.
  const { data: recipients } = await db.from('sms_broadcast_recipients')
    .select('id, contact_id, status, twilio_message_sid, error_message, sent_at, failed_at')
    .eq('broadcast_id', params.id)
    .order('created_at', { ascending: false })
    .limit(500)

  return NextResponse.json({ success: true, broadcast, recipients: recipients || [] })
}

export async function PATCH(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'sms')) {
    return NextResponse.json({ success: false, error: 'Forbidden — SMS not enabled' }, { status: 403 })
  }

  const validation = await validateBody(request, PatchSchema)
  if (!validation.ok) return validation.response
  const patch = validation.data

  const db = createServerClient()
  const { broadcast, error } = await loadBroadcast(db, params.id)
  if (error || !broadcast) {
    return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, broadcast.location_id)
  if (guard) return guard

  // State machine. Editable from 'draft' or 'scheduled'. Going to
  // 'scheduled' requires a future scheduled_at — set it in the same
  // PATCH or have it already on the row. Sending and sent are
  // immutable (sent is audit history).
  if (broadcast.status !== 'draft' && broadcast.status !== 'scheduled') {
    return NextResponse.json({
      success: false,
      error: `Broadcast is in '${broadcast.status}' state — only drafts and scheduled broadcasts are editable`,
    }, { status: 409 })
  }

  // Validate the transition before writing.
  if (patch.status === 'scheduled') {
    const nextScheduledAt = patch.scheduled_at !== undefined
      ? patch.scheduled_at
      : broadcast.scheduled_at
    if (!nextScheduledAt) {
      return NextResponse.json({
        success: false,
        error: 'scheduled_at is required to schedule a broadcast',
      }, { status: 400 })
    }
    if (new Date(nextScheduledAt).getTime() <= Date.now()) {
      return NextResponse.json({
        success: false,
        error: 'scheduled_at must be in the future',
      }, { status: 400 })
    }
  }

  const { data, error: updErr } = await db.from('sms_broadcasts')
    .update(patch)
    .eq('id', params.id)
    .select()
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })

  return NextResponse.json({ success: true, broadcast: data })
}

export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'sms')) {
    return NextResponse.json({ success: false, error: 'Forbidden — SMS not enabled' }, { status: 403 })
  }

  const db = createServerClient()
  const { broadcast, error } = await loadBroadcast(db, params.id)
  if (error || !broadcast) {
    return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, broadcast.location_id)
  if (guard) return guard

  // Don't permanently delete sent / sending / scheduled broadcasts —
  // sent is audit history; sending shouldn't be touched mid-loop;
  // scheduled is queued and should be unscheduled (-> draft) before
  // deletion. Cascade DELETE on recipients would also wipe
  // per-contact send results, which we want to keep.
  if (broadcast.status === 'sent' || broadcast.status === 'sending' || broadcast.status === 'scheduled') {
    return NextResponse.json({
      success: false,
      error: `Cannot delete broadcasts in '${broadcast.status}' state — un-schedule first if needed`,
    }, { status: 409 })
  }

  const { error: delErr } = await db.from('sms_broadcasts').delete().eq('id', params.id)
  if (delErr) return NextResponse.json({ success: false, error: delErr.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
