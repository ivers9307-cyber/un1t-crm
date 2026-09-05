import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, requireApiKeyOrManager, assertRowInOrg } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { email, phone, leadSourceSchema, MANAGER_ROLES } from '@/lib/schemas'
import { triggerSequencesForTagsAdded } from '@/lib/sequences'
import { getCurrentUser } from '@/lib/auth'
import { redactWhatsAppForContact, redactInBodyForContact, getContactImpact } from '@/lib/contact-merge'
import { redactMailForContact } from '@/lib/contact-mail-erasure'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { emailStatusResetForAddressChange } from '@/lib/email-reputation'
import { logWarn, logError } from '@/lib/log'

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
  // HOST-MASTER.6 (mig 464) — blocks AUTOMATIC sequence/automation enrolment
  // only (manual staff enrolment ignores it). Staff-decision field: writable
  // via the cookie path only (Manager+ — requireApiKeyOrManager gates it);
  // API-key callers get it stripped in the handler below.
  automations_exempt: z.boolean().optional(),
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

  // HOST-MASTER.6 — automations_exempt is a staff decision. The route has no
  // per-field gating, but its cookie path is already Manager+-only
  // (requireApiKeyOrManager), so auth.user present ⇒ MANAGER_ROLES. API-key
  // callers (auth.user null — n8n / integrations) may not flip it: strip
  // rather than 403 so integrations that PUT whole objects keep working.
  if (!auth.user) delete body.automations_exempt

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
    .select('tags, location_id, email, email_status, glofox_member_id')
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

  // EMAILREP.1 — contacts.email_status is reputation for a specific
  // MAILBOX. Correcting a typo'd address here used to leave the old
  // address's `bounced` stamp on the row, and every send path (marketing,
  // transactional, manual staff email, booking + event reminders) blocks
  // on it — so the contact stayed permanently unmailable on an address
  // that had been fixed, with no symptom but a greyed-out button. Folded
  // into THIS update rather than a follow-up write: the reset cannot
  // land without the address change that justifies it. Reputation only —
  // marketing still needs per-location consent, which the hard-bounce
  // handler revoked and nothing here restores.
  //
  // EMAILREP.3 — mig 528 now enforces the SAME rule as a BEFORE UPDATE OF
  // email trigger, covering the three write paths this one never reached
  // (merge, import rollback, the agent's fill-when-empty tools). This call is
  // KEPT rather than deleted:
  //   • the trigger is a migration, and migrations land before the code that
  //     depends on them — deleting this would make correctness on the busiest
  //     write path conditional on a deploy ordering nobody would notice
  //     getting wrong;
  //   • it costs nothing. When it fires it sets email_status='active' in this
  //     same UPDATE, so the trigger's NEW.email_status guard is already false
  //     and the trigger does nothing. One row write either way.
  //   • the two cannot drift silently: src/lib/email-status-reset-trigger.test
  //     pins mig 528's status list to ADDRESS_BOUND_EMAIL_STATUSES, and
  //     email_status is in no Zod schema, so no request body can reach one
  //     implementation with a value the other would judge differently.
  const emailStatusReset = emailStatusResetForAddressChange({
    oldEmail: oldRow?.email,
    newEmail: body.email,
    currentStatus: oldRow?.email_status,
  })
  if (emailStatusReset) updates.email_status = emailStatusReset

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
//
// DELBLOCK.1 — the scrubs above are IRREVERSIBLE and they used to run
// before the one step that can fail. Two FKs reject the delete outright
// (person_groups.primary_contact_id ON DELETE RESTRICT NOT NULL, and
// offer_purchases.contact_id ON DELETE NO ACTION — a NO ACTION violation
// is the same violation, it differs only in deferrability), so for every
// contact holding either, the operator got: WhatsApp history scrubbed,
// InBody scans hard-deleted, contact still there, raw Postgres error on
// screen. Measured against prod on 2026-08-12: 892 of 8,578 contacts —
// 887 via person_groups, 6 via offer_purchases. Same shape as the merge
// bug fixed the same day (mig 533): a destructive act sequenced ahead of
// an operation that can fail, with nothing to roll it back.
//
// So: ask what blocks the delete FIRST, and refuse before touching
// anything. The blocker list comes from getContactImpact, which reads
// pg_constraint via public.contact_delete_impact (mig 538) — deliberately
// NOT a hand-listed pair of tables here, because a hand-maintained FK list
// is the exact thing migs 533 and 538 removed and it would go stale the
// day a third RESTRICT lands.
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

  // DELBLOCK.1 — the blocker check. Runs AFTER the auth + location guards
  // (an unauthorised caller learns nothing about the row) and BEFORE the
  // first destructive statement.
  //
  // FAIL CLOSED. `partial: true` means the preview could not see the whole
  // picture — either the catalog RPC was unavailable or a count errored —
  // and on that path the legacy 21-pair fallback answers, which cannot
  // populate block_delete at all. So partial does not mean "probably fine",
  // it means "we did not look": treating it as a green light is exactly how
  // a blocked contact gets scrubbed. We refuse instead, because a refused
  // delete is recoverable by clicking again and a half-scrubbed contact is
  // not — the WhatsApp bodies and InBody rows do not come back.
  let impact
  try {
    impact = await getContactImpact(db, params.id)
  } catch (e) {
    // Same reasoning: an unexpected throw is "we did not look", not "clear".
    logWarn('contacts.DELETE', `impact check threw for ${params.id}`, { err: e })
    impact = null
  }
  if (!impact || impact.partial) {
    return NextResponse.json({
      success: false,
      error: 'Could not check what depends on this contact, so the delete was refused. Nothing was changed — try again in a moment.',
      data: { partial: true },
    }, { status: 503 })
  }
  const blockers = impact.block_delete || []
  if (blockers.length > 0) {
    // 409, not 400/500: the request is well-formed and authorised: the
    // contact's current state is what forbids it. Names the rows so the
    // operator knows what to reassign rather than reading an FK message.
    return NextResponse.json({
      success: false,
      error: `Cannot delete this contact: ${blockers.map(b => `${b.count} ${b.label}`).join(', ')}. Reassign or remove those first.`,
      data: { block_delete: blockers },
    }, { status: 409 })
  }

  // GDPR scrub first — strip PII from the kept WhatsApp rows so
  // the audit thread is anonymised. Best-effort: even if this
  // partially fails the delete still proceeds (the FK rules will
  // null the contact_id link automatically).
  await redactWhatsAppForContact(db, params.id)

  // GDPR erasure gap (audit M3): the InBody tables SET NULL their
  // contact FK, so raw body-composition payloads + the member's phone
  // would otherwise survive an erasure orphaned. Hard-delete them
  // BEFORE the contact row is removed (once the FK nulls, they can't
  // be found by contact_id). Best-effort, same posture as the WA scrub.
  await redactInBodyForContact(db, params.id)

  // MAIL-GDPR.1: the mail FKs (email_tickets, email_inbox_messages) are SET
  // NULL too, so tickets kept the requester's name + address and every message
  // kept its body — orphaned, unfindable once the FK nulled. Same doctrine as
  // the two scrubs above (anonymise in place, best-effort, delete proceeds),
  // with one difference: this scrub RETURNS its failures instead of losing
  // them, and they go back to the operator as `scrub_warnings`. Failing closed
  // was considered and rejected for consistency — see the PR — so a partial
  // is reported, never a reason to refuse the erasure.
  let mailScrub
  try {
    mailScrub = await redactMailForContact(db, params.id)
  } catch (e) {
    logError('contacts.DELETE', `mail scrub threw for ${params.id}`, { err: e })
    mailScrub = { ok: false, failures: [{ table: 'mail', op: 'scrub', message: e?.message || String(e) }] }
  }

  const { error } = await db.from('contacts').delete().eq('id', params.id)
  if (error) {
    // DELBLOCK.1 — KEPT as the backstop. The check above is a guard, not a
    // transaction: it and this DELETE are two separate statements, so a
    // person_groups or offer_purchases row inserted in between still lands
    // here, and so does any FK added after mig 538 that nothing has counted
    // yet. The guard narrows the window from "892 contacts, every time" to
    // "a concurrent insert"; it does not close it. Closing it properly means
    // one server-side function like merge_contacts() — see the PR body.
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // Byte-identical response on a clean scrub; the warnings key appears only
  // when there is something for the operator to act on.
  if (mailScrub.failures.length > 0) {
    return NextResponse.json({ success: true, data: { scrub_warnings: mailScrub.failures } })
  }
  return NextResponse.json({ success: true })
}
