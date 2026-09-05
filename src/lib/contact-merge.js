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

// IMPACTCAT.1 — the three lists below are NO LONGER the source of truth for
// the impact preview. getContactImpact now derives every referencing (table,
// column) from pg_constraint via public.contact_delete_impact (migration 538),
// because these 21 pairs covered barely a quarter of the 80 columns that
// actually reference contacts(id), and neither of the two FKs that would BLOCK
// a delete was among them.
//
// They are kept for two live reasons, not for sentiment:
//   1. FALLBACK. Migration 538 is applied by hand and Vercel auto-deploys
//      main, so this code must work before the function exists. When the RPC
//      is unavailable the preview falls back to exactly the behaviour below
//      and flags itself `partial`.
//   2. LABELS + the redaction override. The catalog knows a column name; it
//      does not know that whatsapp_messages is "WhatsApp messages (body +
//      media redacted, metadata preserved)". See LABEL_OVERRIDES.
// REDACT_ON_DELETE_TABLES additionally remains the work list for
// redactWhatsAppForContact().

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

// MAIL-GDPR.1 — the mail tables, scrubbed by redactMailForContact()
// (src/lib/contact-mail-erasure.js) under the same doctrine. Both FKs are SET
// NULL in the catalog (migs 482, 394), so without this override the dialog
// truthfully said "kept, unlinked" — which was precisely the orphaned-PII bug.
// email_ticket_attachments has no contact column and never appears in the
// catalog; it is deleted via message_id and named in the messages label.
// Kept as its own list so REDACT_ON_DELETE_TABLES stays exactly the WhatsApp
// scrub's work list, which its tests pin.
const REDACT_MAIL_TABLES = Object.freeze([
  { table: 'email_tickets',        column: 'contact_id', label: 'email tickets (requester + subject redacted, thread preserved)' },
  { table: 'email_inbox_messages', column: 'contact_id', label: 'email messages (addresses + body redacted, attachments deleted, metadata preserved)' },
])

// MERGE-TX.1 — dedupePreUpdate lived here. It deleted the loser's colliding
// rows in contact_preferences, sequence_enrollments and contact_tags so the FK
// re-points that followed could not hit a 23505. Those deletes were the first
// destructive act of the merge and ran with nothing to roll them back, so an
// abandoned merge left the loser permanently stripped of its preferences row —
// the state migration 532 had to repair.
//
// The rule now lives in public.merge_contacts() (migration 533), derived from
// pg_index rather than hand-listed, and runs inside the same transaction as
// everything else. The three cases above are exactly what that derivation
// produces for today's catalog; the migration header shows the generated SQL
// for each.


// IMPACTCAT.1 — human labels for the (table, column) pairs someone has
// actually written prose for. Derived from the three lists above so there is
// one place to edit, and applied as an OVERRIDE on top of the catalog: where
// an override exists it wins, everything else gets humaniseRef().
const LABEL_OVERRIDES = Object.freeze(Object.fromEntries(
  [...CASCADE_TABLES, ...SET_NULL_TABLES, ...REDACT_ON_DELETE_TABLES, ...REDACT_MAIL_TABLES]
    .map(t => [`${t.table}.${t.column}`, t.label]),
))

// The WhatsApp tables are CASCADE / SET NULL in the catalog, but the delete
// path scrubs their PII (mig 094) and that scrub — not the FK rule — is what
// makes the kept rows GDPR-safe. So they are bucketed as `redact_on_delete`
// regardless of what pg_constraint says, applied AFTER catalog bucketing.
const REDACT_KEYS = Object.freeze(
  [...REDACT_ON_DELETE_TABLES, ...REDACT_MAIL_TABLES].map(t => `${t.table}.${t.column}`),
)

// confdeltype → bucket. 'r' (restrict) and 'a' (no action) both raise a
// foreign-key violation on delete — they differ only in deferrability — so
// both BLOCK. 'd' (set default) keeps the row, just pointed elsewhere.
const BUCKET_BY_ACTION = Object.freeze({
  c: 'cascade_on_delete',
  n: 'keep_on_delete',
  d: 'keep_on_delete',
  r: 'block_delete',
  a: 'block_delete',
})

// "member_health_metrics" → "member health metrics". Deliberately mechanical:
// there are ~60 columns with no hand-written label and inventing prose for
// each would recreate the hand-maintained list this change exists to retire.
// A column other than the plain contact_id is suffixed so two references from
// the same table don't render as two identical lines.
function humaniseRef(table, column) {
  const base = String(table).replace(/_/g, ' ')
  if (column === 'contact_id') return base
  return `${base} (${String(column).replace(/_id$/, '').replace(/_/g, ' ')})`
}

function emptyImpact() {
  return {
    cascade_on_delete: [],
    keep_on_delete: [],
    redact_on_delete: [],
    block_delete: [],
    total_rows: 0,
    partial: false,
  }
}

/**
 * Returns counts of every dependent row for a contact, split by
 * delete-rule. The shape is friendly to UI rendering — caller can
 * map each entry to a "X rows of <label>" line.
 *
 * IMPACTCAT.1 — the referencing columns come from pg_constraint via
 * public.contact_delete_impact (migration 538), not from a hand-maintained
 * list. Buckets:
 *   cascade_on_delete  the rows are destroyed with the contact
 *   keep_on_delete     the rows survive, unlinked (SET NULL / SET DEFAULT)
 *   redact_on_delete   kept but PII-scrubbed (mig 094 WhatsApp override)
 *   block_delete       RESTRICT / NO ACTION — the DELETE itself will fail
 *
 * `block_delete` was an always-empty back-compat array until now; two real
 * blockers live in the schema (person_groups.primary_contact_id RESTRICT,
 * offer_purchases.contact_id NO ACTION) and ContactEditDeleteActions hides
 * the type-to-confirm input while it is non-empty.
 *
 * `partial: true` means the list may be INCOMPLETE — either the catalog RPC
 * was unavailable (migration 538 not applied yet, so the old 21-pair lists
 * answered) or an individual count failed. A preview whose whole job is to
 * say how much gets destroyed must not report a confident 0 when it did not
 * actually manage to look.
 */
export async function getContactImpact(db, contactId) {
  if (!contactId) throw new Error('getContactImpact: contactId required')

  const rows = await fetchCatalogImpact(db, contactId)
  if (rows) return bucketCatalogRows(rows)
  return legacyImpact(db, contactId)
}

/**
 * One round trip for all ~80 referencing columns. Returns the rows, or null
 * when the function is unavailable / errored — which is the signal to fall
 * back. supabase-js builders are thenables with no .catch (CLAUDE.md), so the
 * transport failure is caught and the database's refusal is read off `error`.
 */
async function fetchCatalogImpact(db, contactId) {
  let data, error
  try {
    ({ data, error } = await db.rpc('contact_delete_impact', { p_contact_id: contactId }))
  } catch (e) {
    error = { message: e?.message || String(e) }
  }
  if (error || !Array.isArray(data)) {
    // Expected — and silent-by-design — until migration 538 is applied.
    logWarn('contact-merge', 'contact_delete_impact unavailable, falling back to the hand-maintained lists', {
      contactId,
      err: error?.message || 'no rows returned',
    })
    return null
  }
  return data
}

function bucketCatalogRows(rows) {
  const out = emptyImpact()
  for (const row of rows) {
    const table = row?.table_name
    const column = row?.column_name
    if (!table || !column) continue
    const count = Number(row.row_count) || 0
    if (count <= 0) continue

    const key = `${table}.${column}`
    const bucket = REDACT_KEYS.includes(key)
      ? 'redact_on_delete'
      : BUCKET_BY_ACTION[row.delete_action] || 'keep_on_delete'

    out[bucket].push({
      table,
      column,
      label: LABEL_OVERRIDES[key] || humaniseRef(table, column),
      count,
    })
    out.total_rows += count
  }
  return out
}

/**
 * Pre-538 behaviour, kept verbatim apart from the `partial` flag: count the 21
 * hand-listed pairs one request at a time. It under-reports by ~60 columns and
 * never populates block_delete, which is why `partial` is set unconditionally
 * here — the operator is told the list may be incomplete, because it is.
 */
async function legacyImpact(db, contactId) {
  const out = emptyImpact()
  out.partial = true

  // Single COUNT per table. Errors are swallowed (best-effort preview) but
  // recorded, so a failed count reads as "we could not look" rather than "0".
  async function countAt({ table, column }) {
    try {
      const { count, error } = await db
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq(column, contactId)
      if (error) return { count: 0, failed: true }
      return { count: count || 0, failed: false }
    } catch {
      return { count: 0, failed: true }
    }
  }

  const passes = [
    [CASCADE_TABLES, 'cascade_on_delete'],
    [SET_NULL_TABLES, 'keep_on_delete'],
    [REDACT_ON_DELETE_TABLES, 'redact_on_delete'],
    [REDACT_MAIL_TABLES, 'redact_on_delete'],
  ]
  for (const [list, bucket] of passes) {
    for (const t of list) {
      const { count, failed } = await countAt(t)
      // Redundant on this path (partial is already true) and deliberately
      // kept: it is the line that must survive if the fallback ever stops
      // being partial by construction.
      if (failed) out.partial = true
      if (count > 0) {
        out[bucket].push({ ...t, count })
        out.total_rows += count
      }
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
  // MERGE-TX.1 — every name here must be a REAL column on public.contacts, and
  // the same list is whitelisted in public.merge_contacts (migration 533),
  // which raises on an unknown key. That guard exists because this list carried
  // 'last_active_at' from the day merge shipped (commit 36e49302) and
  // public.contacts has never had that column — the string appears in no
  // migration in the repo, and information_schema confirmed its absence on
  // 2026-08-12. PostgREST rejects an UPDATE naming an unknown column
  // (PGRST204), so the survivor stamp 400d on EVERY merge — landing after the
  // dedupe deletes and FK re-points, i.e. in exactly the half-merged state
  // migration 532 had to repair. Removing it merges nothing that was merging
  // before, because it never merged anything.
  //
  // Deliberately NOT substituted with a neighbour: last_attended_at,
  // last_booked_at and last_marketing_touch_at all exist and all mean something
  // different, so picking one would be inventing behaviour rather than fixing a
  // bug. If "last active" is wanted on a merge, that's an operator decision.
  const FIELDS = [
    'name', 'first_name', 'last_name',
    'email', 'phone', 'label',
    'glofox_member_id', 'trial_credits_remaining',
    'lead_source', 'lead_created_at',
    'last_emailed_at',
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
 * MERGE-TX.1 — this is now a thin wrapper over the Postgres function
 * public.merge_contacts() (migration 533). It:
 *   1. loads both rows and re-checks the guards, so a bad request is
 *      refused before the database is asked to do anything;
 *   2. computes the merged scalars + union tags with pickMergedFields /
 *      mergeTagArrays, which stay HERE — see below;
 *   3. hands the whole destructive sequence to the RPC, which runs it in
 *      one implicit transaction: dedupe, re-point every referencing FK,
 *      stamp the survivor, delete the loser.
 *
 * WHY A WRAPPER AND NOT A FALLBACK. The obvious alternative was to keep
 * the old statement-by-statement path as a fallback if the RPC is
 * missing. That fallback would BE the bug: it is the non-transactional
 * merge, it would fire exactly when something is already wrong, and
 * keeping it means keeping the hand-maintained FK table list this change
 * exists to retire — two implementations of the same destructive
 * operation, the stale one running unattended. If the function is not
 * deployed the merge must fail loudly, which is what the RPC error does.
 *
 * WHY THE FIELD MERGE STAYS IN JS. pickMergedFields ("survivor wins
 * unless empty", where empty excludes 0 and false) and mergeTagArrays
 * (survivor-first, trimmed, case-sensitive union) are subtle and already
 * carry 15 tests. Porting them to SQL would have made a THIRD copy of the
 * rule — ContactMergeModal.jsx already keeps a preview copy — so the
 * values are computed here and passed in. The function whitelists them
 * and raises on an unknown key, so adding a field here without adding it
 * there fails loudly instead of silently not merging.
 *
 * The read-then-stamp window this leaves (someone edits the survivor
 * between step 1 and step 3) is exactly the window the old code had, and
 * is unchanged.
 *
 * Returns { survivor, folded: { "<table>.<column>": count, ... } } — the
 * same contract the route passes through and the UI reads.
 *
 * Throws on validation failure or DB error. Nothing is ever partially
 * applied: the RPC either commits the whole merge or rolls all of it back.
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
  // Re-checked inside the transaction too — this copy just gives the caller a
  // clean refusal without opening one.
  if (survivor.location_id !== loser.location_id) {
    throw new Error('mergeContacts: contacts must be at the same location')
  }

  const mergedFields = pickMergedFields(survivor, loser)
  const mergedTags = mergeTagArrays(survivor.tags, loser.tags)

  // supabase-js builders are thenables with no .catch — try/catch, never
  // .catch() (CLAUDE.md). A throw here is a transport failure; an { error } is
  // the database refusing. Both mean the merge did not happen.
  let data, error
  try {
    ({ data, error } = await db.rpc('merge_contacts', {
      p_survivor_id: survivorId,
      p_loser_id: loserId,
      p_merged_fields: mergedFields,
      p_merged_tags: mergedTags,
    }))
  } catch (e) {
    error = { message: e?.message || String(e) }
  }
  if (error) {
    throw new Error(
      `mergeContacts: merge of ${loserId} into ${survivorId} failed: ${error.message}. ` +
      'The whole merge was ROLLED BACK — both contacts still exist and nothing has changed, ' +
      'so there is no half-merge to clean up and the merge can simply be retried.',
    )
  }
  if (!data || !data.survivor) {
    // A success with no payload is not a success. Treated the same way the old
    // zero-row stamp check treated a silent no-op.
    throw new Error(
      `mergeContacts: merge of ${loserId} into ${survivorId} returned no survivor row. ` +
      'Nothing has changed; the merge was rolled back or never ran.',
    )
  }

  return { survivor: data.survivor, folded: data.folded || {} }
}
