import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, audienceFilterSchema, url } from '@/lib/schemas'

const BroadcastUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  template_id: uuidLike.optional(),
  variable_mapping: z.unknown().optional(),
  header_media_url: url.nullable().optional(),
  audience_filter: audienceFilterSchema,
  status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'cancelled']).optional(),
  // WA-SCHEDULE — set/clear the scheduled send time. Going to 'scheduled'
  // requires a future scheduled_at (in the same request or already on the row).
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  // Drip pacing — editable while a drip is in flight (next tick uses the new values).
  daily_cap: z.number().int().positive().max(100000).optional(),
  per_tick_max: z.number().int().positive().max(5000).optional(),
})

async function loadBroadcastForUpdate(db, id) {
  const { data } = await db.from('whatsapp_broadcasts').select('location_id, status, scheduled_at').eq('id', id).single()
  return data
}

// GET /api/whatsapp/broadcasts/[id]
export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(*), whatsapp_broadcast_recipients(*, contacts(name, phone, wa_phone))')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  const guard = assertLocationAccessOr404(user, data.location_id)
  if (guard) return guard

  return NextResponse.json({ success: true, broadcast: data })
}

// PUT /api/whatsapp/broadcasts/[id]
export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const row = await loadBroadcastForUpdate(db, params.id)
  if (!row) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard

  const validation = await validateBody(request, BroadcastUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }

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

  const { data, error } = await db.from('whatsapp_broadcasts')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, broadcast: data })
}

// DELETE /api/whatsapp/broadcasts/[id]
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const row = await loadBroadcastForUpdate(db, params.id)
  if (!row) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard

  await db.from('whatsapp_broadcast_recipients').delete().eq('broadcast_id', params.id)
  const { error } = await db.from('whatsapp_broadcasts').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
