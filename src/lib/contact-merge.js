// Contact merge + impact helpers (mig 092 / contacts CRUD audit).
//
// Two operations live here:
//
//   1. getContactImpact(db, id)
//      Returns counts of rows that point at this contact, split into
//      "cascade-on-delete" (lost forever if you delete) and
//      "FK-set-null-on-delete" (kept, just unlinked from the contact).
//      Used by both the delete confirm dialog AND the merge confirm
//      dialog so the operator sees what's at stake before clicking.
//
//   2. mergeContacts(db, { survivorId, loserId })
//      Folds the loser into the survivor and deletes the loser. The
//      survivor wins for every field; loser's value is copied across
//      ONLY when the survivor's field is null/empty. Tags + open
//      sequence enrolments union (with conflict-handling for the
//      partial UNIQUE indexes — see DEDUPE_PRE_UPDATE below).
//
// Both helpers expect a service-role Supabase client. RLS doesn't
// apply; the route layer is responsible for verifying the caller is
// allowed to touch both contacts.

// Tables that point at contacts.id with ON DELETE CASCADE — these
// rows GO AWAY when the contact is deleted. The merge path UPDATEs
// these to the survivor instead so history is preserved.
import { logWarn } from './log'

const CASCADE_TABLES = Object.freeze([
  { table: 'activities',                column: 'contact_id', label: 'activities & tasks' },
  { table: 'campaign_recipients',       column: 'contact_id', label: 'campaign send history' },
  { table: 'consent_log',               column: 'contact_id', label: 'consent log entries' },
  { table: 'contact_preferences',       column: 'contact_id', label: 'communication preferences' },
  { table: 'contact_tags',              column: 'contact_id', label: 'tags' },
  { table: 'deals',                     column: 'contact_id', label: 'deals' },
  { table: 'email_sends',               column: 'contact_id', label: 'email send history' },
  { table: 'notes',                     column: 'contact_id', label: 'notes' },
  { table: 'sequence_enrollments',      column: 'contact_id', label: 'sequence enrolments' },
  { table: 'sms_broadcast_recipients',  column: 'contact_id', label: 'SMS broadcast history' },
])

// Tables that point at contacts.id with ON DELETE SET NULL — these
// rows STAY on delete (their FK just becomes null). The merge path
// also UPDATEs these so the rows follow the survivor.
const SET_NULL_TABLES = Object.freeze([
  { table: 'bookings',                  column: 'contact_id',         label: 'Calendly bookings' },
  { table: 'contact_events',            column: 'contact_id',         label: 'event timeline entries' },
  { table: 'orders',                    column: 'contact_id',         label: 'orders' },
  { table: 'race_payments',             column: 'contact_id',         label: 'race payments' },
  { table: 'race_registrations',        column: 'contact_id',         label: 'race registrations' },
  { table: 'team_members',              column: 'contact_id',         label: 'team memberships (captain)' },
  { table: 'team_members',              column: 'member_contact_id',  label: 'team memberships (member)' },
  { table: 'teams',                     column: 'captain_contact_id', label: 'teams (as captain)' },
])

// Tables that need an explicit PII scrub before the contact row is
// deleted (GDPR right-to-erasure, mig 094). The conversation rows
// stay — operator + regulator audit trail — but identifying fields
// (wa_phone, wa_profile_name, message body, media URL,
// template variables) are wiped to NULL or '[redacted]'. The FK
// itself is now ON DELETE SET NULL on conversations + messages and
// CASCADE on broadcast_recipients (mig 094) so no row blocks the
// delete; the scrub is what makes the kept rows GDPR-safe.
//
// Used by the impact preview as a third "Will be redacted"
// category, and by redactWhatsAppForContact() below as the work
// list.
const REDACT_ON_DELETE_TABLES = Object.freeze([
  { table: 'whatsapp_broadcast_recipients', column: 'contact_id', label: 'WhatsApp broadcast history (cascade-deleted; per-recipient send status)' },
  { table: 'whatsapp_conversations',        column: 'contact_id', label: 'WhatsApp conversations (PII redacted, thread preserved)' },
  { table: 'whatsapp_messages',             column: 'contact_id', label: 'WhatsApp messages (body + media redacted, metadata preserved)' },
])

// Pre-UPDATE dedupe: when both contacts have a row sharing a unique
// constraint we have to delete the loser's row first or the UPDATE
// fails with a 23505 conflict. These are the (table, column,
// conflict-shape) triples we know about.
//
// contact_preferences has a UNIQUE(contact_id) — if survivor has
// one, the loser's must go. We pick the survivor's because the
// preferences map to the surviving identity (their unsubscribe
// state, their administrative-opt-in posture, etc).
//
// sequence_enrollments has UNIQUE(sequence_id, contact_id). If both
// contacts are in the same sequence, drop the loser's row (the
// survivor's enrolment is what continues; the loser was a
// duplicate that wouldn't have made sense to keep on a single
// person's timeline).
//
// contact_tags has a partial UNIQUE(contact_id, tag) WHERE
// removed_at IS NULL. For each loser-active tag that the survivor
// also has active, drop the loser's row before the UPDATE.
//
// MERGE-LOSS.1 — every read AND write in here now throws on error,
// matching the convention the rest of this file already follows. They
// used to discard their errors, and a discarded one is not harmless:
// a failed read yields "the survivor has none of these", the dedupe is
// skipped, and the FK update that follows in mergeContacts hits the
// very UNIQUE index this function exists to clear. The merge then dies
// at a confusing 23505 on a table that looks unrelated, instead of at
// the read that actually failed. Failing here also means we abort
// BEFORE anything destructive has run.
async function dedupePreUpdate(db, { survivorId, loserId }) {
  // 1. contact_preferences — UNIQUE(contact_id)
  // maybeSingle, not single: "the survivor has no preferences row" is a
  // normal answer, and the unique constraint makes >1 impossible.
  const { data: survivorPrefs, error: prefsErr } = await db
    .from('contact_preferences').select('id').eq('contact_id', survivorId).maybeSingle()
  if (prefsErr) {
    throw new Error(`mergeContacts: dedupe read of contact_preferences failed: ${prefsErr.message}`)
  }
  if (survivorPrefs) {
    const { error: prefsDelErr } = await db
      .from('contact_preferences').delete().eq('contact_id', loserId)
    if (prefsDelErr) {
      throw new Error(`mergeContacts: dedupe delete of contact_preferences failed: ${prefsDelErr.message}`)
    }
  }

  // 2. sequence_enrollments — UNIQUE(sequence_id, contact_id)
  const { data: survivorEnrols, error: enrolErr } = await db
    .from('sequence_enrollments').select('sequence_id').eq('contact_id', survivorId)
  if (enrolErr) {
    throw new Error(`mergeContacts: dedupe read of sequence_enrollments failed: ${enrolErr.message}`)
  }
  const survivorSeqIds = new Set((survivorEnrols || []).map(r => r.sequence_id))
  if (survivorSeqIds.size > 0) {
    const { error: enrolDelErr } = await db
      .from('sequence_enrollments')
      .delete()
      .eq('contact_id', loserId)
      .in('sequence_id', [...survivorSeqIds])
    if (enrolDelErr) {
      throw new Error(`mergeContacts: dedupe delete of sequence_enrollments failed: ${enrolDelErr.message}`)
    }
  }

  // 3. contact_tags — partial UNIQUE(contact_id, tag) WHERE removed_at IS NULL
  const { data: survivorTags, error: tagsErr } = await db
    .from('contact_tags').select('tag').eq('contact_id', survivorId).is('removed_at', null)
  if (tagsErr) {
    throw new Error(`mergeContacts: dedupe read of contact_tags failed: ${tagsErr.message}`)
  }
  const survivorActiveTags = new Set((survivorTags || []).map(r => r.tag))
  if (survivorActiveTags.size > 0) {
    const { error: tagsDelErr } = await db
      .from('contact_tags')
      .delete()
      .eq('contact_id', loserId)
      .is('removed_at', null)
      .in('tag', [...survivorActiveTags])
    if (tagsDelErr) {
      throw new Error(`mergeContacts: dedupe delete of contact_tags failed: ${tagsDelErr.message}`)
    }
  }
}

/**
 * Returns counts of every dependent row for a contact, split by
 * delete-rule. The shape is friendly to UI rendering — caller can
 * map each entry to a "X rows of <label>" line.
 *
 * Mig 094 introduced a new `redact_on_delete` category for the
 * WhatsApp tables (was `block_delete` before — they used to refuse
 * the delete entirely). `block_delete` is retained as an empty
 * array for back-compat with the existing UI (renders nothing when
 * empty); future add-only protected FKs can land in there without
 * a UI change.
 */
export async function getContactImpact(db, contactId) {
  if (!contactId) throw new Error('getContactImpact: contactId required')
  const out = {
    cascade_on_delete: [],
    keep_on_delete: [],
    redact_on_delete: [],
    block_delete: [],
    total_rows: 0,
  }

  // Helper — single COUNT, ignore errors (best-effort reporting).
  async function countAt({ table, column }) {
    try {
      const { count } = await db
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq(column, contactId)
      return count || 0
    } catch {
      return 0
    }
  }

  for (const t of CASCADE_TABLES) {
    const n = await countAt(t)
    if (n > 0) {
      out.cascade_on_delete.push({ ...t, count: n })
      out.total_rows += n
    }
  }
  for (const t of SET_NULL_TABLES) {
    const n = await countAt(t)
    if (n > 0) {
      out.keep_on_delete.push({ ...t, count: n })
      out.total_rows += n
    }
  }
  for (const t of REDACT_ON_DELETE_TABLES) {
    const n = await countAt(t)
    if (n > 0) {
      out.redact_on_delete.push({ ...t, count: n })
      out.total_rows += n
    }
  }

  return out
}

/**
 * Mig 094: GDPR right-to-erasure scrub for the WhatsApp tables.
 * Strips wa_phone, wa_profile_name, message body, media URL,
 * template variables. Leaves audit-friendly metadata (timestamps,
 * status, message_type, direction). Idempotent — running twice on
 * the same contact_id is a no-op since the second run finds
 * everything already null.
 *
 * Caller is responsible for issuing the `DELETE FROM contacts`
 * AFTER this completes. The FK rules (mig 094) handle the
 * contact_id → null transition automatically once the parent row
 * is gone.
 *
 * Best-effort: each UPDATE is independent. If one fails (e.g.
 * permission issue, schema drift), we log and continue so a
 * partial scrub is better than no scrub. The caller still attempts
 * the contact delete which will surface the underlying error if
 * something is genuinely broken.
 *
 * @param {SupabaseClient} db          service-role client
 * @param {string}        contactId
 */
export async function redactWhatsAppForContact(db, contactId) {
  if (!contactId) throw new Error('redactWhatsAppForContact: contactId required')

  // whatsapp_conversations — strip the phone, profile name, last
  // message preview. Keep timestamps + status + assigned_to (those
  // are operator-side audit, not customer PII).
  try {
    await db
      .from('whatsapp_conversations')
      .update({
        wa_phone: null,
        wa_profile_name: null,
        last_message_preview: '[redacted]',
      })
      .eq('contact_id', contactId)
  } catch (e) {
    logWarn('contact-merge', 'redact whatsapp_conversations failed', { contactId, err: e })
  }

  // whatsapp_messages — strip body + media URL + template
  // variables. Keep direction, message_type, status, sent_at /
  // delivered_at / read_at (operator-side audit).
  try {
    await db
      .from('whatsapp_messages')
      .update({
        body: '[redacted at user request]',
        media_url: null,
        media_mime_type: null,
        template_variables: null,
      })
      .eq('contact_id', contactId)
  } catch (e) {
    logWarn('contact-merge', 'redact whatsapp_messages failed', { contactId, err: e })
  }

  // whatsapp_broadcast_recipients — no body to scrub here, the row
  // gets cascaded on contact delete (mig 094 FK rule). No-op for
  // the scrub function but kept for symmetry / future-proofing.
}

/**
 * GDPR erasure for InBody body-composition data (audit M3).
 *
 * The InBody tables were created with `ON DELETE SET NULL` FKs to
 * contacts, so deleting a contact leaves their raw body-composition
 * payloads + phone orphaned but intact:
 *   - inbody_webhook_events.matched_contact_id → SET NULL (mig 284):
 *     the row survives carrying `tel_hp` (member phone) + `payload`
 *     (full raw notification jsonb).
 *   - inbody_scans.contact_id → SET NULL (mig 272): the row survives
 *     carrying `matched_phone`, `raw` (raw scan jsonb) + the actual
 *     body-composition metrics (weight/pbf/smm/…).
 * (inbody_backfill_requests.contact_id is already ON DELETE CASCADE —
 * mig 305 — so it needs no explicit handling here.)
 *
 * Body-composition data is special-category-adjacent health data and
 * has no value once its member is erased, so we HARD-DELETE the rows
 * for this contact rather than merely null the link. This must run
 * BEFORE the contact row is deleted, because once the FK nulls the
 * link we can no longer find the rows by contact_id.
 *
 * Best-effort + independent per table, matching redactWhatsAppForContact:
 * a failure on one table logs and lets the others (and the parent
 * delete) proceed. Idempotent — safe to call for a contact with no
 * InBody history.
 *
 * @param {SupabaseClient} db          service-role client
 * @param {string}        contactId
 */
export async function redactInBodyForContact(db, contactId) {
  if (!contactId) throw new Error('redactInBodyForContact: contactId required')

  // inbody_webhook_events — hard-delete the staging notifications for
  // this contact (tel_hp + raw payload). SET NULL FK means these would
  // otherwise survive erasure orphaned.
  try {
    await db
      .from('inbody_webhook_events')
      .delete()
      .eq('matched_contact_id', contactId)
  } catch (e) {
    logWarn('contact-merge', 'redact inbody_webhook_events failed', { contactId, err: e })
  }

  // inbody_scans — hard-delete the enriched body-composition scans for
  // this contact (matched_phone + raw jsonb + metrics).
  try {
    await db
      .from('inbody_scans')
      .delete()
      .eq('contact_id', contactId)
  } catch (e) {
    logWarn('contact-merge', 'redact inbody_scans failed', { contactId, err: e })
  }

  // inbody_backfill_requests is ON DELETE CASCADE (mig 305) — the
  // parent contact delete removes it automatically. Listed for symmetry.
}

/**
 * Compute the merged scalar field-set: survivor wins, but loser's
 * value is copied across when survivor's is null/empty. Pure helper
 * — no DB side-effects — so it's easily unit-tested. Tags are NOT
 * included here; they're handled separately because the survivor's
 * own tag rows are not overwritten (we just absorb the loser's
 * non-conflicting tags via the FK update).
 *
 * Mutable fields only — id, created_at, location_id are NOT in the
 * picker (location_id has its own pre-merge check; id stays the
 * survivor's; created_at takes whichever is older so the
 * "longest-known" date wins).
 */
export function pickMergedFields(survivor, loser) {
  const FIELDS = [
    'name', 'first_name', 'last_name',
    'email', 'phone', 'label',
    'glofox_member_id', 'trial_credits_remaining',
    'lead_source', 'lead_created_at',
    'last_emailed_at', 'last_active_at',
  ]
  const isEmpty = (v) =>
    v === null || v === undefined || v === '' ||
    (typeof v === 'string' && v.trim() === '')
  const merged = {}
  for (const f of FIELDS) {
    const sv = survivor?.[f]
    const lv = loser?.[f]
    merged[f] = isEmpty(sv) && !isEmpty(lv) ? lv : sv
  }
  // created_at — keep the older of the two so the lead-age math
  // doesn't reset on merge.
  const sCreated = survivor?.created_at ? new Date(survivor.created_at).getTime() : Infinity
  const lCreated = loser?.created_at ? new Date(loser.created_at).getTime() : Infinity
  if (Number.isFinite(lCreated) && lCreated < sCreated) {
    merged.created_at = loser.created_at
  }
  return merged
}

/**
 * Compute the union of tags. Survivor's tags + loser's tags, deduped
 * by string equality (case-sensitive — tags are operator-controlled
 * so casing is intentional).
 */
export function mergeTagArrays(survivorTags, loserTags) {
  const seen = new Set()
  const out = []
  for (const arr of [survivorTags || [], loserTags || []]) {
    for (const t of arr) {
      if (typeof t !== 'string' || !t.trim()) continue
      const k = t.trim()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(k)
    }
  }
  return out
}

/**
 * Fold loser into survivor, then delete loser.
 *
 * Steps:
 *   1. Load both rows + validate same location_id.
 *   2. Pre-update dedupe (delete loser's would-be conflicts).
 *   3. UPDATE every dependent table's contact_id from loser → survivor.
 *   4. UPDATE survivor with merged fields + union tags.
 *   5. DELETE the loser row.
 *
 * Returns { survivor, folded: { tableA: count, ... } } so the API
 * can stamp an audit-friendly response.
 *
 * Throws on validation failure or DB error. Caller should wrap in
 * try/catch and surface the message.
 */
export async function mergeContacts(db, { survivorId, loserId }) {
  if (!survivorId || !loserId) throw new Error('mergeContacts: survivorId and loserId required')
  if (survivorId === loserId) throw new Error('mergeContacts: cannot merge a contact with itself')

  const [{ data: survivor, error: sErr }, { data: loser, error: lErr }] = await Promise.all([
    db.from('contacts').select('*').eq('id', survivorId).single(),
    db.from('contacts').select('*').eq('id', loserId).single(),
  ])
  if (sErr || !survivor) throw new Error(`mergeContacts: survivor ${survivorId} not found`)
  if (lErr || !loser)    throw new Error(`mergeContacts: loser ${loserId} not found`)
  if (survivor.location_id !== loser.location_id) {
    throw new Error('mergeContacts: contacts must be at the same location')
  }

  await dedupePreUpdate(db, { survivorId, loserId })

  // Re-point every dependent row's FK from loser to survivor. Done
  // table-by-table because Supabase doesn't expose a multi-table
  // transaction primitive — partial failure here would leave the
  // contact half-merged, but every UPDATE is idempotent (UPDATE x
  // SET fk=A WHERE fk=B is a no-op on retry once x=A) so a re-run
  // is safe.
  const folded = {}
  // Merge re-points every dependent FK from loser → survivor.
  // After mig 094 the WhatsApp tables are SET NULL / CASCADE on
  // delete, but during MERGE we still want their rows to follow the
  // survivor (the conversation thread should track the kept
  // identity, not get nulled out). So include REDACT_ON_DELETE_TABLES
  // here even though the delete-path handles them via the scrub.
  const everyTable = [...CASCADE_TABLES, ...SET_NULL_TABLES, ...REDACT_ON_DELETE_TABLES]
  for (const t of everyTable) {
    const { error: upErr, count } = await db
      .from(t.table)
      .update({ [t.column]: survivorId }, { count: 'exact' })
      .eq(t.column, loserId)
    if (upErr) {
      throw new Error(`mergeContacts: failed to fold ${t.table}.${t.column}: ${upErr.message}`)
    }
    if (count && count > 0) {
      folded[`${t.table}.${t.column}`] = (folded[`${t.table}.${t.column}`] || 0) + count
    }
  }

  // Stamp survivor with merged scalars + union tags. We do this
  // AFTER the FK updates so a partial failure mid-update doesn't
  // leave the survivor's fields modified while the loser still has
  // its dependents.
  //
  // MERGE-LOSS.1 — this write used to be a bare `await` with no error
  // binding, alone among the writes in this function. A failed stamp
  // therefore fell straight through to the DELETE below: the loser was
  // destroyed, everything folded into `mergedFields` went with it
  // unrecoverably, and the caller got back a success object listing
  // fields that were never written.
  //
  // What "stop" means here, given the FK updates above have ALREADY
  // run. We cannot undo them — `UPDATE x SET fk=survivor WHERE
  // fk=loser` is not reversible (the survivor's own rows are now
  // indistinguishable from the ones that just arrived), and Supabase
  // gives us no multi-table transaction to roll back into. So the
  // honest failure mode is to throw BEFORE the delete and leave the
  // merge half-done in its RECOVERABLE direction: the loser row still
  // exists carrying every one of its own scalars and tags, its
  // dependents have moved to the survivor, and nothing is destroyed.
  // Re-running mergeContacts on the same pair completes it —
  // pickMergedFields/mergeTagArrays re-read both rows fresh (the FK
  // updates touched neither row's scalars), the FK updates are
  // idempotent as noted above, and dedupePreUpdate is a no-op second
  // time round. Deleting the loser anyway is the single outcome that
  // is NOT recoverable, which is why it is the one we refuse.
  //
  // A zero-row stamp counts as a failure too: PostgREST reports no
  // error when an UPDATE matches nothing, and "the survivor's fields
  // were never written" is precisely the state being guarded, however
  // it arose. `count` is only judged when the client actually returned
  // one, so a client that omits it can't produce a false failure.
  const mergedFields = pickMergedFields(survivor, loser)
  const mergedTags = mergeTagArrays(survivor.tags, loser.tags)
  const { error: stampErr, count: stampCount } = await db
    .from('contacts')
    .update({ ...mergedFields, tags: mergedTags }, { count: 'exact' })
    .eq('id', survivorId)
  if (stampErr || stampCount === 0) {
    throw new Error(
      `mergeContacts: failed to stamp survivor ${survivorId} with the merged fields` +
      `${stampErr ? `: ${stampErr.message}` : ' (the update matched no row)'}. ` +
      `Loser ${loserId} has NOT been deleted and no data is lost — its dependent rows have ` +
      'already moved to the survivor, so a re-run of this merge is safe and completes it.',
    )
  }

  // Delete the loser. By this point nothing should still point at it
  // — the FK updates moved everything to the survivor. CASCADE
  // delete-rule rows that were missed (e.g. a table added since
  // this code was written) get cleaned up here as a backstop.
  const { error: delErr } = await db.from('contacts').delete().eq('id', loserId)
  if (delErr) {
    throw new Error(`mergeContacts: failed to delete loser: ${delErr.message}`)
  }

  return {
    survivor: { ...survivor, ...mergedFields, tags: mergedTags },
    folded,
  }
}
