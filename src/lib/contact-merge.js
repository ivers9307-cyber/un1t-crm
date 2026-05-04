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

// Tables with NO ACTION delete rule — these BLOCK a hard delete if
// any rows exist. The route's delete confirm dialog refuses with a
// clear error; the merge path UPDATEs them so they follow the
// survivor and the loser becomes deletable.
const BLOCK_DELETE_TABLES = Object.freeze([
  { table: 'whatsapp_broadcast_recipients', column: 'contact_id', label: 'WhatsApp broadcast history' },
  { table: 'whatsapp_conversations',        column: 'contact_id', label: 'WhatsApp conversations' },
  { table: 'whatsapp_messages',             column: 'contact_id', label: 'WhatsApp messages' },
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
async function dedupePreUpdate(db, { survivorId, loserId }) {
  // 1. contact_preferences — UNIQUE(contact_id)
  const { data: survivorPrefs } = await db
    .from('contact_preferences').select('id').eq('contact_id', survivorId).maybeSingle()
  if (survivorPrefs) {
    await db.from('contact_preferences').delete().eq('contact_id', loserId)
  }

  // 2. sequence_enrollments — UNIQUE(sequence_id, contact_id)
  const { data: survivorEnrols } = await db
    .from('sequence_enrollments').select('sequence_id').eq('contact_id', survivorId)
  const survivorSeqIds = new Set((survivorEnrols || []).map(r => r.sequence_id))
  if (survivorSeqIds.size > 0) {
    await db
      .from('sequence_enrollments')
      .delete()
      .eq('contact_id', loserId)
      .in('sequence_id', [...survivorSeqIds])
  }

  // 3. contact_tags — partial UNIQUE(contact_id, tag) WHERE removed_at IS NULL
  const { data: survivorTags } = await db
    .from('contact_tags').select('tag').eq('contact_id', survivorId).is('removed_at', null)
  const survivorActiveTags = new Set((survivorTags || []).map(r => r.tag))
  if (survivorActiveTags.size > 0) {
    await db
      .from('contact_tags')
      .delete()
      .eq('contact_id', loserId)
      .is('removed_at', null)
      .in('tag', [...survivorActiveTags])
  }
}

/**
 * Returns counts of every dependent row for a contact, split by
 * delete-rule. The shape is friendly to UI rendering — caller can
 * map each entry to a "X rows of <label>" line.
 */
export async function getContactImpact(db, contactId) {
  if (!contactId) throw new Error('getContactImpact: contactId required')
  const out = {
    cascade_on_delete: [],
    keep_on_delete: [],
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
  for (const t of BLOCK_DELETE_TABLES) {
    const n = await countAt(t)
    if (n > 0) {
      out.block_delete.push({ ...t, count: n })
      out.total_rows += n
    }
  }

  return out
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
    'lead_source', 'lead_status', 'lead_created_at',
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
  const everyTable = [...CASCADE_TABLES, ...SET_NULL_TABLES, ...BLOCK_DELETE_TABLES]
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
  const mergedFields = pickMergedFields(survivor, loser)
  const mergedTags = mergeTagArrays(survivor.tags, loser.tags)
  await db
    .from('contacts')
    .update({ ...mergedFields, tags: mergedTags })
    .eq('id', survivorId)

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
