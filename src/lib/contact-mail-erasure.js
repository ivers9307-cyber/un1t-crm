// MAIL-GDPR.1 — GDPR right-to-erasure scrub for the mail tables.
//
// ══ WHY THIS EXISTS ═══════════════════════════════════════════════════
// Contact erasure (DELETE /api/contacts/[id], bulk-delete) scrubbed WhatsApp
// and InBody, then deleted the contact row. The mail FKs are ON DELETE SET
// NULL — email_tickets.contact_id (mig 482) and email_inbox_messages.contact_id
// (mig 394) — so every ticket kept the person's name and address, every
// message kept its body, and every attachment kept its bytes, with the one
// column that could find them again nulled. Orphaned PII, unfindable by design.
//
// ══ THE DOCTRINE — the SAME one redactWhatsAppForContact() follows ═══
// The operator's requirement is consistency with the existing erasure, so this
// module invents no policy of its own:
//
//   • ANONYMISE IN PLACE, keep the skeleton. WhatsApp keeps the conversation
//     and message rows (direction, status, timestamps — operator-side audit)
//     and nulls the identifying columns. Tickets and messages get exactly that:
//     the row stays, addresses/names/subject/body/preview become NULL or a
//     '[redacted…]' marker. Threading ids (rfc_message_id, in_reply_to,
//     references_header) are kept the way wa_message_id is: they identify the
//     MESSAGE, not the person.
//   • RAW-CONTENT ROWS ARE HARD-DELETED. InBody hard-deletes the scan rows
//     because the payload IS the personal data. An attachment row is the same
//     shape — filename + bytes are the content — and it cannot be anonymised
//     under mig 496's CHECK (a stored row must have a storage_path; a skipped
//     row must carry one of five reasons, none of which is "erased"), so the
//     object is removed from the bucket and then the row is deleted. Object
//     FIRST, row SECOND: a row whose object is gone is a chip that 404s
//     silently months later; an object whose row is gone is an orphan nothing
//     can ever find. If the storage delete fails the row is KEPT so the bytes
//     stay findable by the next attempt or by the prune.
//   • BEST-EFFORT, EVERY TABLE ATTEMPTED. One failing table does not stop the
//     others, and the caller still deletes the contact — the posture both
//     existing scrubs have on both routes. What this module adds is that the
//     failures are RETURNED (and logged via logError, structurally) instead of
//     being lost: the WhatsApp scrub's try/catch never fires, because a
//     supabase builder RESOLVES with { error } rather than throwing (CLAUDE.md,
//     BAREWRITE), so a failed UPDATE there is silently a success. Here every
//     write destructures `error`; the routes surface `failures` to the
//     operator as `scrub_warnings`.
//
// ══ HOW THE ROWS ARE FOUND ════════════════════════════════════════════
// Tickets by contact_id. Messages by contact_id (denormalised — stamped by the
// inbound webhook and backfilled by link-contact) AND by ticket_id ∈ the
// contact's tickets, because an outbound reply filed before link-contact ran
// carries contact_id NULL, and a message stamped with the contact can sit on a
// ticket since re-linked to someone else. Attachments by message_id — they have
// no contact column at all. Every read .range()-paginates with an explicit
// .order(): a chatty member's thread exceeds the 1,000-row cap.
//
// Idempotent: a second run finds the sentinels already in place, no
// attachments, and reports no failures.

import { logError } from './log'
import { EMAIL_ATTACHMENT_BUCKET } from './email-attachment-quota'
import { addStorageBytes } from './email-attachments-server'

const MODULE = 'contact-mail-erasure'
const PAGE = 1000
// PostgREST `in` filters go on the URL; 200 uuids is well inside every limit.
const IN_CHUNK = 200
const STORAGE_CHUNK = 100

/** requester_email is NOT NULL (mig 482); `.invalid` is the RFC 2606 reserved TLD, so nothing can ever deliver to it. */
export const MAIL_REDACTED_EMAIL = 'redacted@erased.invalid'
export const MAIL_REDACTED_BODY = '[redacted at user request]'
export const MAIL_REDACTED_PREVIEW = '[redacted]'

/** The columns on email_tickets that identify the person. Everything else is operator-side audit and stays. */
export const MAIL_TICKET_REDACTION = Object.freeze({
  requester_email: MAIL_REDACTED_EMAIL,
  requester_name: null,
  subject: MAIL_REDACTED_BODY,
  last_message_preview: MAIL_REDACTED_PREVIEW,
  // Addresses staff excluded from reply-all — the member's other addresses are
  // the usual content. text[] NOT NULL, so empty rather than null.
  excluded_participants: [],
})

/**
 * The columns on email_inbox_messages that identify the person or carry what
 * they wrote. from_email/to_email are nulled regardless of direction — the
 * WhatsApp scrub strips every identifying field on every row rather than
 * judging direction, and a staff address on the outbound side is not worth a
 * rule that could leave the member's address behind on a mis-labelled row.
 * delivery_detail can quote a bounce reason naming the address (mig 498).
 * search_tsv is GENERATED from subject/from_email/text_body (mig 577) and
 * re-derives itself from this UPDATE — nothing to write.
 */
export const MAIL_MESSAGE_REDACTION = Object.freeze({
  from_email: null,
  to_email: null,
  to_emails: [],
  cc_emails: [],
  bcc_emails: [],
  subject: MAIL_REDACTED_BODY,
  text_body: MAIL_REDACTED_BODY,
  html_body: null,
  delivery_detail: null,
})

function chunks(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Read every row a builder matches, one PostgREST page at a time. `build`
 * receives the client and returns the filtered builder (before order/range).
 * Throws on a PostgREST error — the caller records it as a failure for that
 * table; a scrub must never read "the query failed" as "no rows".
 */
async function readAll(db, build, orderCol = 'id') {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(db).order(orderCol, { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw new Error(error.message || String(error))
    rows.push(...(data || []))
    if (!data || data.length < PAGE) return rows
  }
}

/** A storage error that means "there is nothing at that key" is the outcome we wanted. */
function objectAlreadyGone(error) {
  return /not.?found|does not exist|no such/i.test(error?.message || '')
}

/**
 * Anonymise every mail row that belongs to a contact and remove their
 * attachments. Never throws for a database or storage failure — those are
 * collected in `failures` and logged. Throws only on a missing contactId,
 * which would otherwise be an unfiltered UPDATE across the whole table.
 *
 * Must run BEFORE `DELETE FROM contacts`: both mail FKs are SET NULL, so once
 * the parent is gone nothing can find these rows again.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   failures: Array<{ table: string, op: string, message: string }>,
 *   tickets: number, messages: number, attachments: number,
 *   attachments_deleted: number, bytes_freed: number,
 * }>}
 */
export async function redactMailForContact(db, contactId) {
  if (!contactId) throw new Error('redactMailForContact: contactId required')

  const failures = []
  const fail = (table, op, message, meta = {}) => {
    failures.push({ table, op, message })
    logError(MODULE, `${op} on ${table} failed during contact erasure`, { contactId, table, op, message, ...meta })
  }

  // ── 1. Find the rows while the FK still points at the contact ──────
  // A read that SUCCEEDED and found nothing lets the matching by-contact_id
  // UPDATE be skipped — a contact with no mail issues no writes. A read that
  // FAILED does not: the UPDATE is still attempted, because it may well land
  // and the FK is about to be nulled.
  let ticketIds = []
  let ticketsKnownEmpty = false
  try {
    const tickets = await readAll(db, d => d.from('email_tickets').select('id').eq('contact_id', contactId))
    ticketIds = tickets.map(t => t.id)
    ticketsKnownEmpty = ticketIds.length === 0
  } catch (e) {
    fail('email_tickets', 'select', e.message)
  }

  const messageIds = new Set()
  let stampedKnownEmpty = false
  try {
    const stamped = await readAll(db, d => d.from('email_inbox_messages').select('id').eq('contact_id', contactId))
    for (const m of stamped) messageIds.add(m.id)
    stampedKnownEmpty = stamped.length === 0
  } catch (e) {
    fail('email_inbox_messages', 'select', e.message)
  }
  for (const chunk of chunks(ticketIds, IN_CHUNK)) {
    try {
      const onTickets = await readAll(db, d => d.from('email_inbox_messages').select('id').in('ticket_id', chunk))
      for (const m of onTickets) messageIds.add(m.id)
    } catch (e) {
      fail('email_inbox_messages', 'select', e.message, { by: 'ticket_id' })
    }
  }
  const messageIdList = [...messageIds]

  const attachments = []
  for (const chunk of chunks(messageIdList, IN_CHUNK)) {
    try {
      attachments.push(...await readAll(db, d => d
        .from('email_ticket_attachments')
        .select('id, message_id, storage_path, size_bytes, location_id, mailbox_id, forwarded_from_id')
        .in('message_id', chunk)))
    } catch (e) {
      fail('email_ticket_attachments', 'select', e.message)
    }
  }

  // ── 2. Attachments: object → forwards → row → counter ──────────────
  const attach = await eraseAttachments(db, attachments, fail)

  // ── 3. Messages: anonymise in place, by contact AND by ticket ──────
  // Zero-row UPDATEs are not errors in PostgREST (a re-run finds nothing), and
  // the two passes overlap on purpose — the patch is idempotent.
  if (!stampedKnownEmpty) {
    const { error } = await db.from('email_inbox_messages').update(MAIL_MESSAGE_REDACTION).eq('contact_id', contactId)
    if (error) fail('email_inbox_messages', 'update', error.message, { by: 'contact_id' })
  }
  for (const chunk of chunks(ticketIds, IN_CHUNK)) {
    const { error } = await db.from('email_inbox_messages').update(MAIL_MESSAGE_REDACTION).in('ticket_id', chunk)
    if (error) fail('email_inbox_messages', 'update', error.message, { by: 'ticket_id' })
  }

  // ── 4. Tickets ─────────────────────────────────────────────────────
  if (!ticketsKnownEmpty) {
    const { error } = await db.from('email_tickets').update(MAIL_TICKET_REDACTION).eq('contact_id', contactId)
    if (error) fail('email_tickets', 'update', error.message)
  }

  return {
    ok: failures.length === 0,
    failures,
    tickets: ticketIds.length,
    messages: messageIdList.length,
    attachments: attachments.length,
    attachments_deleted: attach.deleted,
    bytes_freed: attach.bytesFreed,
  }
}

/**
 * Remove the attachments' bytes, then their rows, then give the bytes back to
 * the mailbox counter — in that order, for the reasons in the header.
 *
 * Three kinds of row (mig 496 + 501):
 *   owner    storage_path set, forwarded_from_id NULL — holds bytes and was
 *            charged for them. Object removed; row deleted; counter decremented.
 *   forward  forwarded_from_id set — shares its OWNER's object and was never
 *            charged. Row deleted, nothing removed, nothing decremented: the
 *            owner (on the same ticket, so in this set) frees the bytes.
 *   skipped  storage_path NULL — never stored (quota/too_large/pruned). Row
 *            deleted, nothing else: the filename is still the member's.
 *
 * A forward OUTSIDE the set that points at one of our owners would be left
 * addressing bytes that no longer exist, so it is marked `pruned` before the
 * object goes — the same cascade pruneMailboxAttachments runs, for the same
 * reason. Its chip then reads "Removed to free space", which is the honest
 * half of the truth the CHECK constraint lets us tell without a migration.
 */
async function eraseAttachments(db, attachments, fail) {
  const result = { deleted: 0, bytesFreed: 0 }
  if (attachments.length === 0) return result

  const owners = attachments.filter(a => a.storage_path && !a.forwarded_from_id)
  const others = attachments.filter(a => !(a.storage_path && !a.forwarded_from_id))

  // Owners whose object is confirmed gone (removed now, or already absent).
  const freedOwners = []
  for (const batch of chunks(owners, STORAGE_CHUNK)) {
    const paths = [...new Set(batch.map(a => a.storage_path))]
    let removed = false
    try {
      const { error } = await db.storage.from(EMAIL_ATTACHMENT_BUCKET).remove(paths)
      if (!error || objectAlreadyGone(error)) removed = true
      else fail(`storage.${EMAIL_ATTACHMENT_BUCKET}`, 'remove', error.message, { paths: paths.length })
    } catch (e) {
      fail(`storage.${EMAIL_ATTACHMENT_BUCKET}`, 'remove', e?.message || String(e), { paths: paths.length })
    }
    if (removed) freedOwners.push(...batch)
  }

  // Forwards outside this set that share a freed owner's bytes.
  const freedOwnerIds = freedOwners.map(a => a.id)
  const inSet = new Set(attachments.map(a => a.id))
  for (const chunk of chunks(freedOwnerIds, IN_CHUNK)) {
    const { error } = await db.from('email_ticket_attachments')
      .update({ storage_path: null, skipped_reason: 'pruned' })
      .in('forwarded_from_id', chunk)
      .not('storage_path', 'is', null)
    if (error) fail('email_ticket_attachments', 'update', error.message, { step: 'mark_forwards' })
  }

  // Rows: freed owners + every forward/skipped row. An owner whose object
  // could not be removed is deliberately NOT here.
  const deletable = [...freedOwners, ...others.filter(a => inSet.has(a.id))]
  const deletedIds = new Set()
  for (const chunk of chunks(deletable.map(a => a.id), IN_CHUNK)) {
    const { data, error } = await db.from('email_ticket_attachments').delete().in('id', chunk).select('id')
    if (error) { fail('email_ticket_attachments', 'delete', error.message); continue }
    for (const r of data || []) deletedIds.add(r.id)
  }
  result.deleted = deletedIds.size

  // Counter: only for owners whose object went AND whose row went, grouped the
  // way email_storage_usage is keyed (location, mailbox).
  const byBucket = new Map()
  for (const a of freedOwners) {
    if (!deletedIds.has(a.id)) continue
    const key = `${a.location_id}|${a.mailbox_id ?? ''}`
    const cur = byBucket.get(key) || { locationId: a.location_id, mailboxId: a.mailbox_id ?? null, bytes: 0 }
    cur.bytes += Number(a.size_bytes) || 0
    byBucket.set(key, cur)
  }
  for (const { locationId, mailboxId, bytes } of byBucket.values()) {
    if (bytes <= 0) continue
    const released = await addStorageBytes(db, { locationId, mailboxId, delta: -bytes })
    if (!released.ok) {
      fail('email_storage_usage', 'rpc', `add_email_storage_bytes(-${bytes}) failed — mailbox will read as ${bytes} bytes fuller than it is; run Recalculate`, { locationId, mailboxId })
      continue
    }
    result.bytesFreed += bytes
  }

  return result
}
