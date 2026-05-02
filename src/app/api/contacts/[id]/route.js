import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { email, phone, leadSourceSchema, leadStatusSchema } from '@/lib/schemas'
import { triggerSequencesForStatusChange, triggerSequencesForTagsAdded } from '@/lib/sequences'
import { logPipelineEvent } from '@/lib/activity-events'

const ContactUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  first_name: z.string().max(100).nullable().optional(),
  last_name: z.string().max(100).nullable().optional(),
  email: email.optional(),
  phone: phone.nullable().optional(),
  label: z.string().max(100).nullable().optional(),
  glofox_member_id: z.string().max(100).nullable().optional(),
  trial_credits_remaining: z.number().int().min(0).max(100).optional(),
  lead_source: leadSourceSchema.optional(),
  lead_status: leadStatusSchema.optional(),
  // tags is a TEXT[] in Postgres. Frontend code that wants to "add a tag"
  // fetches current tags, appends, and PUTs the full new array. Sequence
  // tag_added triggers (sequences.js) fire on the set difference of
  // (new − old) — we compute that here after the update lands.
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
})

// PUT /api/contacts/:id — Update a contact (replaces Pipedrive PUT /v1/persons/:id)
export async function PUT(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { id } = params
  const validation = await validateBody(request, ContactUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Read the old row first so we can detect lead_status flips and
  // tag additions for the sequence triggers below. One extra round
  // trip on every contact update; cheap (PK lookup) and only on
  // mutations, not reads. location_id is also pulled here so the
  // activities phase-1 pipeline-event writer can stamp the right
  // tenant on its timeline row.
  const { data: oldRow } = await db
    .from('contacts')
    .select('lead_status, tags, location_id')
    .eq('id', id)
    .single()

  // Only forward keys actually present (Zod with .optional() leaves undefined keys out).
  const updates = {}
  for (const [key, value] of Object.entries(body)) {
    updates[key] = value
  }

  const { data, error } = await db.from('contacts').update(updates).eq('id', id).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Fire sequence triggers AFTER the update lands. Both helpers are
  // best-effort and swallow their own errors so a sequence misconfig
  // can't fail a legit contact mutation. We don't await — the
  // response can ship while the triggers run; enrolments land in
  // sequence_enrollments and the next cron tick picks them up.
  if (oldRow) {
    if (typeof body.lead_status !== 'undefined' && body.lead_status !== oldRow.lead_status) {
      triggerSequencesForStatusChange(id, oldRow.lead_status, body.lead_status)
        .catch(e => console.warn(`[contacts.PUT] status_change trigger error for ${id}: ${e.message}`))

      // Activities revamp phase 1 (mig 073) — log the stage change
      // to the contact's timeline. Best-effort, fire-and-forget.
      logPipelineEvent(db, {
        contactId: id,
        locationId: oldRow.location_id,
        oldStatus: oldRow.lead_status,
        newStatus: body.lead_status,
      }).catch(e => console.warn(`[contacts.PUT] pipeline-event log failed for ${id}: ${e.message}`))
    }
    if (Array.isArray(body.tags)) {
      const oldTags = new Set(oldRow.tags || [])
      const added = body.tags.filter(t => !oldTags.has(t))
      if (added.length > 0) {
        triggerSequencesForTagsAdded(id, added)
          .catch(e => console.warn(`[contacts.PUT] tag_added trigger error for ${id}: ${e.message}`))
      }
    }
  }

  return NextResponse.json({ success: true, data })
}

// GET /api/contacts/:id
export async function GET(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { id } = params
  const db = createServerClient()
  const { data, error } = await db.from('contacts').select('*').eq('id', id).single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 404 })
  }

  return NextResponse.json({ success: true, data })
}
