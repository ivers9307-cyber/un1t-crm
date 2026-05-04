import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey, requireApiKeyOrManager } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { email, phone, leadSourceSchema, leadStatusSchema, MANAGER_ROLES } from '@/lib/schemas'
import { triggerSequencesForStatusChange, triggerSequencesForTagsAdded } from '@/lib/sequences'
import { logPipelineEvent } from '@/lib/activity-events'
import { getCurrentUser } from '@/lib/auth'

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

// PUT /api/contacts/:id — Update a contact.
//
// Accepts either the n8n API key OR a logged-in manager+. Web UI
// uses the cookie path; n8n keeps using the bearer token.
export async function PUT(request, { params }) {
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

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

// DELETE /api/contacts/:id — hard delete.
//
// Uses the cookie auth path (n8n shouldn't be issuing destructive
// deletes — kept off the API-key surface). Permission widened
// (Nov 2026) from owner+ to MANAGER_ROLES (head_coach / manager /
// owner / master). Cascades the rows listed in CASCADE_TABLES;
// SET-NULL tables keep the row with the FK nulled (history
// preserved). If the contact still has whatsapp_* rows (NO ACTION)
// the delete will fail at the DB layer — caller should merge into
// another contact first.
export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Head coach, manager, owner, or master required' }, { status: 403 })
  }

  const db = createServerClient()
  // Verify the contact is at the caller's location before deleting.
  // Master bypasses the location check (mig 033 master semantics).
  const { data: existing } = await db.from('contacts')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (!existing) return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  if (user.role !== 'master') {
    const userLocIds = (user.locations || []).map(l => l.id)
    if (!userLocIds.includes(existing.location_id)) {
      return NextResponse.json({ success: false, error: 'Contact is at a different location' }, { status: 403 })
    }
  }

  const { error } = await db.from('contacts').delete().eq('id', params.id)
  if (error) {
    // 23503 = FK violation (NO ACTION row blocking the delete —
    // most likely whatsapp_*). Return a friendlier error pointing
    // the operator at merge instead of just dumping the SQL message.
    if (error.code === '23503' || /foreign key|violates/i.test(error.message || '')) {
      return NextResponse.json({
        success: false,
        error: 'Cannot delete: contact has WhatsApp history. Merge into another contact first.',
        code: 'has_protected_history',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
