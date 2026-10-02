import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, audienceFilterSchema, url } from '@/lib/schemas'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { logError } from '@/lib/log'

// GATES-2 — GET/PUT/DELETE took membership only, so a member with WhatsApp
// switched off could read the recipient list, rewrite or delete a broadcast
// that /send would refuse them. Same rule as /send: `whatsapp` at SOME studio
// before any read, then at the BROADCAST's studio.
const waForbidden = () => NextResponse.json(
  { success: false, error: 'Forbidden — WhatsApp not enabled' }, { status: 403 })

const BroadcastUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  template_id: uuidLike.optional(),
  variable_mapping: z.unknown().optional(),
  header_media_url: url.nullable().optional(),
  audience_filter: audienceFilterSchema,
  // C123 GATES-4 (a) — 'sending' and 'sent' are owned by /send and the send
  // engines + cron (same rule as the POST schema): a PUT to 'sending' started
  // a drip with none of /send's checks. The web editor PUTs only 'draft'
  // (unschedule) and 'cancelled' (tests/wa-broadcast-editor-put-statuses.test.js).
  status: z.enum(['draft', 'scheduled', 'cancelled'], {
    error: "status may be 'draft', 'scheduled' or 'cancelled'; use Send to start sending",
  }).optional(),
  // WA-SCHEDULE — set/clear the scheduled send time. Going to 'scheduled'
  // requires a future scheduled_at (in the same request or already on the row).
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  // Drip pacing — editable while a drip is in flight (next tick uses the new values).
  daily_cap: z.number().int().positive().max(100000).optional(),
  per_tick_max: z.number().int().positive().max(5000).optional(),
})

// GATES-3 (f) — the read's error is read: a failed read is a 500, never
// "not found" (PGRST116 = no row).
async function loadBroadcastForUpdate(db, id) {
  const { data, error } = await db.from('whatsapp_broadcasts').select('location_id, status, scheduled_at').eq('id', id).single()
  if (error && error.code !== 'PGRST116') return { row: null, failed: true }
  return { row: data || null, failed: false }
}
const readFailed = () => NextResponse.json({ success: false, error: 'Could not read the broadcast' }, { status: 500 })

// C120 GATES-3 (f) — which status a PUT may move a broadcast to, from where.
// 'draft' only un-schedules: never an un-cancel, and never a reset of a row
// the send engines own (sending/sent). 'cancelled' stops a draft, a scheduled
// row or a running send (the editor's Cancel on a drip), never a finished or
// already-cancelled one. 'scheduled' keeps its own check below.
const STATUS_FROM = {
  draft: ['draft', 'scheduled'],
  cancelled: ['draft', 'scheduled', 'sending'],
}

// GET /api/whatsapp/broadcasts/[id]
export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'whatsapp')) return waForbidden()

  const db = createServerClient()
  const { data, error } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(*), whatsapp_broadcast_recipients(*, contacts(name, phone, wa_phone))')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  const guard = assertLocationAccessOr404(user, data.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, data.location_id, 'whatsapp')) return waForbidden()

  return NextResponse.json({ success: true, broadcast: data })
}

// PUT /api/whatsapp/broadcasts/[id]
export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'whatsapp')) return waForbidden()

  const db = createServerClient()
  const { row, failed } = await loadBroadcastForUpdate(db, params.id)
  if (failed) return readFailed()
  if (!row) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, row.location_id, 'whatsapp')) return waForbidden()

  const validation = await validateBody(request, BroadcastUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }

  // GATES-2 — a template is sent on its OWN studio's number, so a broadcast
  // may only point at a template of the broadcast's studio (the id is
  // caller-supplied: another studio's template would otherwise be sent to
  // this studio's audience).
  if (updates.template_id) {
    const { data: tpl, error: tplErr } = await db.from('whatsapp_templates')
      .select('id, location_id')
      .eq('id', updates.template_id)
      .maybeSingle()
    if (tplErr) return NextResponse.json({ success: false, error: 'Could not check the template' }, { status: 500 })
    if (!tpl || tpl.location_id !== row.location_id) {
      return NextResponse.json({ success: false, error: 'Template not found at this location' }, { status: 400 })
    }
  }

  // WA-SCHEDULE — validate the scheduled transition (mirrors the SMS PATCH):
  // only a draft or an already-scheduled row may be (re)scheduled, and the
  // effective scheduled_at (from this request, else the row) must be a future
  // time — a past one would fire on the next cron tick, which is a send-now
  // the operator didn't ask for.
  if (updates.status === 'scheduled') {
    if (row.status !== 'draft' && row.status !== 'scheduled') {
      return NextResponse.json({
        success: false,
        error: `Broadcast is in '${row.status}' state — only drafts can be scheduled`,
      }, { status: 409 })
    }
    const nextScheduledAt = updates.scheduled_at !== undefined ? updates.scheduled_at : row.scheduled_at
    if (!nextScheduledAt) {
      return NextResponse.json({ success: false, error: 'scheduled_at is required to schedule a broadcast' }, { status: 400 })
    }
    if (new Date(nextScheduledAt).getTime() <= Date.now()) {
      return NextResponse.json({ success: false, error: 'scheduled_at must be in the future' }, { status: 400 })
    }
  }

  if (updates.status && STATUS_FROM[updates.status] && !STATUS_FROM[updates.status].includes(row.status)) {
    return NextResponse.json({
      success: false,
      error: `Broadcast is in '${row.status}' state, so it cannot be set to '${updates.status}'`,
    }, { status: 409 })
  }

  // GATES-3 (f) — a status change is a compare-and-swap on the state it was
  // judged against: the cron may promote a scheduled row (or finish a send) in
  // between, and the write must not overwrite that.
  let write = db.from('whatsapp_broadcasts')
    .update(updates)
    .eq('id', params.id)
  if (updates.status) write = write.eq('status', row.status)
  const { data, error } = await write.select().maybeSingle()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!data) {
    return NextResponse.json({
      success: false,
      error: 'The broadcast changed while you were editing it. Reload the page and try again.',
    }, { status: 409 })
  }
  return NextResponse.json({ success: true, broadcast: data })
}

// DELETE /api/whatsapp/broadcasts/[id]
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'whatsapp')) return waForbidden()

  const db = createServerClient()
  const { row, failed } = await loadBroadcastForUpdate(db, params.id)
  if (failed) return readFailed()
  if (!row) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, row.location_id, 'whatsapp')) return waForbidden()

  // C138 (c) — ONE statement. The recipient rows go with the broadcast through
  // whatsapp_broadcast_recipients.broadcast_id ON DELETE CASCADE (mig 007), so
  // the delete is atomic: all of it or none of it. It used to delete the
  // recipients first and the broadcast second. whatsapp_messages.broadcast_id
  // has NO cascade, so the broadcast delete of any broadcast that has sent a
  // message fails (23503) — after its recipient rows (the per-recipient send
  // claims) were already gone. The broadcast survived with no claims, and a
  // later Send (or the cron's resume of a part-sent scheduled blast) went to
  // the WHOLE audience again, people already messaged included.
  const { error } = await db.from('whatsapp_broadcasts').delete().eq('id', params.id)
  if (error) {
    logError('api:whatsapp-broadcasts', 'broadcast delete failed; nothing deleted', { broadcastId: params.id, code: error.code || null })
    if (error.code === '23503') {
      return NextResponse.json({ success: false, error: 'This broadcast has sent messages, so it cannot be deleted' }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: 'Could not delete the broadcast; nothing was deleted' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
