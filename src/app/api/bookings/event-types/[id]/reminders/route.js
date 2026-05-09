// /api/bookings/event-types/[id]/reminders — multi-reminder management.
//
// Relocated from /api/events/[id]/reminders (E2 of events expansion).
// /events URL space freed for the multi-kind events feature; Calendly's
// bookable templates now live alongside their /bookings hub.
//
// Mig 076 added event_type_reminders so each event type can
// have multiple reminders configured. The EventForm needs a way
// to read the current set on load and write the new set on save.
//
// PUT does a "replace whole set" sync rather than a diff:
//   - Insert any reminder without an id (new row from the form)
//   - Update reminders whose ids match existing rows
//   - Delete existing reminders whose ids aren't in the body
// Done in sequence, not a transaction — Supabase JS doesn't
// expose pg transactions cleanly. The DELETE happens last so a
// failed INSERT/UPDATE doesn't wipe reminders. Worst case on a
// partial failure: a duplicate or stale reminder, which the
// operator can clean up via the form on the next save.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'

const ReminderSchema = z.object({
  // Existing rows have a real UUID. New rows from the form may
  // arrive without an id (or with a client-side temp id that
  // isn't a UUID). We treat the absence of a valid UUID as
  // "this is a new reminder".
  id: uuidLike.optional(),
  // Form sends hours; we convert to minutes here. Accept minutes
  // too for callers who already speak the storage unit.
  hours_before: z.number().min(0).max(24 * 30).optional(),
  minutes_before: z.number().int().min(0).max(60 * 24 * 30).optional(),
  channels: z.array(z.enum(['email', 'sms'])).min(1),
  email_template_id: uuidLike.nullable().optional(),
  email_subject: z.string().max(500).nullable().optional(),
  sms_body: z.string().max(1600).nullable().optional(),
  display_order: z.number().int().min(0).max(1000).optional(),
  active: z.boolean().optional(),
}).refine(r => r.hours_before != null || r.minutes_before != null, {
  message: 'Either hours_before or minutes_before is required',
})

const PutSchema = z.object({
  reminders: z.array(ReminderSchema).max(20),
})

async function authoriseEventTypeWrite(db, user, eventTypeId) {
  const { data: et } = await db
    .from('event_types')
    .select('id, location_id')
    .eq('id', eventTypeId)
    .single()
  if (!et) return { error: 'Event type not found', status: 404 }

  if (user.role !== 'master') {
    if (!MANAGER_ROLES.includes(user.role)) return { error: 'Forbidden', status: 403 }
    const userLocationIds = getUserLocationIds(user)
    if (!userLocationIds.includes(et.location_id)) return { error: 'Forbidden', status: 403 }
  }
  return { eventType: et }
}

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const auth = await authoriseEventTypeWrite(db, user, params.id)
  if (auth.error) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

  const { data, error } = await db
    .from('event_type_reminders')
    .select('*')
    .eq('event_type_id', params.id)
    .order('display_order', { ascending: true })
    .order('minutes_before', { ascending: false })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, PutSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const auth = await authoriseEventTypeWrite(db, user, params.id)
  if (auth.error) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

  const incoming = validation.data.reminders.map((r, i) => ({
    ...r,
    minutes_before: r.minutes_before != null ? r.minutes_before : Math.round((r.hours_before || 0) * 60),
    display_order: r.display_order != null ? r.display_order : i,
    active: r.active !== false,
  }))

  // Existing rows for this event type — used to compute deletes
  // and to validate that any incoming id actually belongs here
  // (preventing cross-event reassignment via a forged payload).
  const { data: existing } = await db
    .from('event_type_reminders')
    .select('id')
    .eq('event_type_id', params.id)
  const existingIds = new Set((existing || []).map(r => r.id))

  // Updates: rows with a valid id that exists in our set.
  const updates = incoming.filter(r => r.id && existingIds.has(r.id))
  // Inserts: rows with no id, or with an id we don't recognise
  // (we strip the id in that case to mint a new one).
  const inserts = incoming
    .filter(r => !r.id || !existingIds.has(r.id))
    .map(({ id: _id, hours_before: _hb, ...rest }) => ({
      ...rest,
      event_type_id: params.id,
    }))
  // Deletes: any existing id not present in the incoming update
  // set.
  const keepIds = new Set(updates.map(r => r.id))
  const deleteIds = [...existingIds].filter(id => !keepIds.has(id))

  // Upserts first (insert + update). Safer to leave deletions
  // until last so a partial failure doesn't wipe reminders.
  for (const u of updates) {
    const { hours_before: _hb, ...patch } = u
    const { error } = await db
      .from('event_type_reminders')
      .update(patch)
      .eq('id', u.id)
      .eq('event_type_id', params.id)
    if (error) {
      return NextResponse.json({ success: false, error: `Update failed: ${error.message}` }, { status: 400 })
    }
  }
  if (inserts.length > 0) {
    const { error } = await db.from('event_type_reminders').insert(inserts)
    if (error) {
      return NextResponse.json({ success: false, error: `Insert failed: ${error.message}` }, { status: 400 })
    }
  }
  if (deleteIds.length > 0) {
    const { error } = await db
      .from('event_type_reminders')
      .delete()
      .eq('event_type_id', params.id)
      .in('id', deleteIds)
    if (error) {
      return NextResponse.json({ success: false, error: `Delete failed: ${error.message}` }, { status: 400 })
    }
  }

  // Return the resolved set so the form can rehydrate with
  // server-issued ids on new rows.
  const { data: resolved, error: refetchErr } = await db
    .from('event_type_reminders')
    .select('*')
    .eq('event_type_id', params.id)
    .order('display_order', { ascending: true })
  if (refetchErr) {
    return NextResponse.json({ success: false, error: refetchErr.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: resolved })
}
