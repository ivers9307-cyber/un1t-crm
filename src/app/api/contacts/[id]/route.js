import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, requireApiKeyOrManager, assertRowInOrg } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { email, phone, leadSourceSchema, MANAGER_ROLES } from '@/lib/schemas'
import { triggerSequencesForTagsAdded } from '@/lib/sequences'
import { getCurrentUser } from '@/lib/auth'
import { redactWhatsAppForContact } from '@/lib/contact-merge'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { logWarn } from '@/lib/log'

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
  // DECISION #1 (mig 348) — opt this member out of the public HR leaderboard /
  // studio TV. Shown by default (false); set true to hide. Exposed here so the
  // CRM edit form (and, later, a champ-app member-facing toggle) can write it.
  hr_leaderboard_opt_out: z.boolean().optional(),
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
export async function PUT(request, props) {
  const params = await props.params;
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

  const { id } = params
  const validation = await validateBody(request, ContactUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // APIKEYS.3 — per-org key may only update a contact in its org.
  const scopeErr = await assertRowInOrg({ db, orgId: auth.orgId, table: 'contacts', id })
  if (scopeErr) return scopeErr

  // Read the old row first so we can detect tag additions for the
  // sequence trigger below. One extra round trip on every contact
  // update; cheap (PK lookup) and only on mutations, not reads.
  // CLASSIFY.2: status_change triggers now fire from deal stage moves
  // (where pipeline_stage_slug is the source of truth), not from
  // contact PUTs. Contact PUTs no longer accept a status field.
  const { data: oldRow } = await db
    .from('contacts')
    .select('tags, location_id, email, glofox_member_id')
    .eq('id', id)
    .single()

  // SECURITY (audit 2026-06-10): the cookie path must be location-
  // scoped. assertRowInOrg above only guards per-org API keys (it
  // no-ops when orgId is null — the legacy-key and cookie paths), so
  // without this check a manager at one studio could update any
  // contact at any location/org by id. Mirrors the DELETE handler's
  // guard below; 404 (not 403) so a cross-tenant probe can't confirm
  // an id exists — same convention as assertRowInOrg.
  if (auth.user && auth.user.role !== 'master') {
    const userLocIds = (auth.user.locations || []).map((l) => l.id)
    if (!oldRow || !userLocIds.includes(oldRow.location_id)) {
      return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
    }
  }

  // Only forward keys actually present (Zod with .optional() leaves undefined keys out).
  const updates = {}
  for (const [key, value] of Object.entries(body)) {
    updates[key] = value
  }

  const { data, error } = await db.from('contacts').update(updates).eq('id', id).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Fire sequence triggers AFTER the update lands. The helper is
  // best-effort and swallows its own errors so a sequence misconfig
  // can't fail a legit contact mutation. We don't await — the
  // response can ship while the trigger runs; enrolments land in
  // sequence_enrollments and the next cron tick picks them up.
  if (oldRow && Array.isArray(body.tags)) {
    const oldTags = new Set(oldRow.tags || [])
    const added = body.tags.filter(t => !oldTags.has(t))
    if (added.length > 0) {
      triggerSequencesForTagsAdded(id, added)
        .catch(e => logWarn('contacts.PUT', `tag_added trigger error for ${id}`, { err: e }))
    }
  }

  // GLOFOX3.1 — dup-prevention on update. Only fires when the
  // contact has just acquired (or changed) an email AND we don't
  // already have a glofox link. Skips when the operator manually
  // pasted in a glofox_member_id (PUT body) — that's already a link.
  // Search-only, never creates. Best-effort.
  const emailChanged = typeof body.email !== 'undefined' && body.email && body.email !== oldRow?.email
  const stillUnlinked = !data.glofox_member_id && !body.glofox_member_id
  if (emailChanged && stillUnlinked && data.location_id) {
    findOrCreateGlofoxMember({
      db,
      locationId: data.location_id,
      contact: data,
      source: 'dup_check',
      createIfMissing: false,
      attachTrial: false,
    }).catch(e => logWarn('contacts.PUT', `glofox dup_check failed for ${id}`, { err: e }))
  }

  return NextResponse.json({ success: true, data })
}

// GET /api/contacts/:id
export async function GET(request, props) {
  const params = await props.params;
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const { id } = params
  const db = createServerClient()
  const scopeErr = await assertRowInOrg({ db, orgId: auth.orgId, table: 'contacts', id })
  if (scopeErr) return scopeErr
  const { data, error } = await db.from('contacts').select('*').eq('id', id).single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 404 })
  }

  return NextResponse.json({ success: true, data })
}

// DELETE /api/contacts/:id — hard delete + GDPR PII scrub.
//
// Uses the cookie auth path (n8n shouldn't be issuing destructive
// deletes — kept off the API-key surface). MANAGER_ROLES (mig 092
// audit). Mig 094: WhatsApp history no longer blocks the delete —
// PII (wa_phone, wa_profile_name, message body, media URL) is
// scrubbed via redactWhatsAppForContact() BEFORE the contact row
// is deleted, then the FK rules (SET NULL on conversations +
// messages, CASCADE on broadcast_recipients) handle the link.
// Cascades CASCADE_TABLES; SET-NULL tables keep the row with the
// FK nulled (booking + revenue history preserved).
export async function DELETE(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Head coach, manager, owner, or master required' }, { status: 403 })
  }

  const db = createServerClient()
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

  // GDPR scrub first — strip PII from the kept WhatsApp rows so
  // the audit thread is anonymised. Best-effort: even if this
  // partially fails the delete still proceeds (the FK rules will
  // null the contact_id link automatically).
  await redactWhatsAppForContact(db, params.id)

  const { error } = await db.from('contacts').delete().eq('id', params.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
