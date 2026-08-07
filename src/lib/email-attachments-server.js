// EMAIL-ATTACH.1 — server-side IO for inbound email attachments and the
// per-mailbox storage quota. Mig 496.
//
// Pure rules (paths, filename sanitising, thresholds) live in
// ./email-attachment-quota.js; this module is the part that touches Storage and
// the database.
//
// ══ THE GOVERNING RULE ══════════════════════════════════════════════
// THE MESSAGE IS FILED NO MATTER WHAT. The inbound webhook's whole hardening
// history is about mail that vanished silently, so nothing here may fail an
// email. An attachment that cannot be stored — oversized, over quota, upload
// error, insert error — produces a ROW with a skipped_reason, so staff see
// "invoice.pdf — not stored, mailbox was full" and can ask for a resend.
// storeInboundAttachments() never throws and never returns a failure the
// webhook is expected to act on.
//
// ══ WHY THE COUNTER IS RESERVED BEFORE THE UPLOAD ═══════════════════
// Reserve → check → (roll back on refusal). The alternative, read-then-check-
// then-write, is the lost-update race mig 314 exists to remove: two 3 GB
// attachments arriving together would both read 0 bytes used, both conclude
// there is room, and land 6 GB in a 5 GB mailbox. Reserving first means each
// writer judges the quota from a total that already includes its own bytes, so
// exactly one of the two is refused.
//
// The reservation is given back on every path that does not end in a stored
// row, including the "someone else already recorded this" path — see below.
//
// ══ WHY THE ACCOUNTING IS IDEMPOTENT ════════════════════════════════
// The webhook releases its dedupe claim on any 5xx so Postmark's retry genuinely
// re-processes the message (EMAIL-DEDUPE-RELEASE.1). Re-processing is therefore
// designed behaviour, and bytes counted twice would silently shrink a mailbox's
// quota with nothing on any screen to explain it.
//
// Two layers stop that:
//   • attachment_index — the file's position in Postmark's own Attachments
//     array — is identical on every retry, and mig 496 puts a UNIQUE index on
//     (message_id, attachment_index). A pre-check skips the work; a 23505 is
//     the race-safe backstop, and it releases the reservation.
//   • the object path is derived from those same ids, so a retry that does get
//     as far as uploading overwrites the identical key rather than leaving a
//     second copy nothing is accounting for. That is why the 23505 path leaves
//     the object alone: it is the FIRST run's object, at the same key.

import {
  EMAIL_ATTACHMENT_BUCKET,
  EMAIL_MAILBOX_QUOTA_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentObjectPath,
  exceedsQuota,
  safeAttachmentFilename,
  safeMimeType,
} from './email-attachment-quota'

const UNIQUE_VIOLATION = '23505'

/**
 * Postmark's base64 `Content` → bytes, or null when there is nothing usable.
 *
 * BASE64 LENGTH IS NOT BYTE LENGTH, and neither is the payload's own
 * `ContentLength` — both come from the sender. Only the decoded buffer's length
 * is trusted anywhere in this module.
 *
 * Buffer.from(…, 'base64') never throws; it silently ignores characters outside
 * the alphabet, so an empty result is the only signal that the input was junk.
 */
export function decodeAttachmentContent(content) {
  if (typeof content !== 'string' || content.length === 0) return null
  let bytes
  try {
    bytes = Buffer.from(content, 'base64')
  } catch {
    return null
  }
  if (!bytes || bytes.length === 0) return null
  return bytes
}

/**
 * Move a mailbox's counter by `delta` bytes, atomically, and hand back the new
 * total. `mailboxId` null addresses the location's unfiled bucket.
 *
 * Never throws: supabase-js builders are thenables with no `.catch`, so this is
 * a real try/catch, and a counter failure must not take an email with it.
 *
 * @returns {Promise<{ok: boolean, total: number|null}>}
 */
export async function addStorageBytes(db, { locationId, mailboxId = null, delta }) {
  try {
    const { data, error } = await db.rpc('add_email_storage_bytes', {
      p_location_id: locationId,
      p_mailbox_id: mailboxId ?? null,
      p_delta: delta,
    })
    if (error) {
      console.error('[email-attachments] storage counter rpc failed:', error.message)
      return { ok: false, total: null }
    }
    // PostgREST returns a scalar-returning function as the bare value; be
    // tolerant of the single-row-array shape too.
    const raw = Array.isArray(data) ? data[0] : data
    const total = Number(raw?.add_email_storage_bytes ?? raw)
    return { ok: true, total: Number.isFinite(total) ? total : null }
  } catch (err) {
    console.error('[email-attachments] storage counter rpc threw:', err?.message)
    return { ok: false, total: null }
  }
}

/**
 * The mailbox's ceiling and current fill, for the callers that need to decide
 * before they write. Returns the default quota when no counter row exists yet —
 * the row is created by the first reservation, not ahead of it.
 */
export async function getMailboxQuota(db, { locationId, mailboxId = null }) {
  try {
    let q = db.from('email_storage_usage')
      .select('bytes_used, quota_bytes')
      .eq('location_id', locationId)
    q = mailboxId ? q.eq('mailbox_id', mailboxId) : q.is('mailbox_id', null)
    const { data, error } = await q.maybeSingle()
    if (error || !data) return { bytesUsed: 0, quotaBytes: EMAIL_MAILBOX_QUOTA_BYTES }
    return {
      bytesUsed: Number(data.bytes_used) || 0,
      quotaBytes: Number(data.quota_bytes) || EMAIL_MAILBOX_QUOTA_BYTES,
    }
  } catch {
    return { bytesUsed: 0, quotaBytes: EMAIL_MAILBOX_QUOTA_BYTES }
  }
}

/** Has this (message, index) already been accounted for by an earlier run? */
async function alreadyRecorded(db, messageId, index) {
  try {
    const { data, error } = await db.from('email_ticket_attachments')
      .select('id')
      .eq('message_id', messageId)
      .eq('attachment_index', index)
      .maybeSingle()
    if (error) return false
    return !!data
  } catch {
    return false
  }
}

/**
 * Store one message's inbound attachments and meter the bytes.
 *
 * NEVER THROWS. NEVER FAILS THE MESSAGE. Every outcome — stored, skipped,
 * already-recorded — is a row or an explicit no-op, and the return value is a
 * summary for logging, not something the webhook branches on.
 *
 * @param {object} db service-role client
 * @param {object} args
 * @param {Array}  args.attachments Postmark's `Attachments` array (may be anything)
 * @param {string} args.messageId   email_inbox_messages.id (NOT Postmark's MessageID)
 * @param {string} args.locationId
 * @param {string|null} args.mailboxId
 * @returns {Promise<{stored: number, skipped: number, deduped: number, bytesStored: number, reasons: object}>}
 */
export async function storeInboundAttachments(db, {
  attachments, messageId, locationId, mailboxId = null,
} = {}) {
  const summary = { stored: 0, skipped: 0, deduped: 0, bytesStored: 0, reasons: {} }
  const note = (reason) => {
    summary.skipped += 1
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1
  }

  if (!Array.isArray(attachments) || attachments.length === 0) return summary
  if (!messageId || !locationId) {
    console.error('[email-attachments] refusing to store without messageId + locationId')
    return summary
  }

  const { quotaBytes } = await getMailboxQuota(db, { locationId, mailboxId })

  for (let index = 0; index < attachments.length; index += 1) {
    try {
      // Past the cap the file is still RECORDED, just not stored. An operator
      // seeing "12 files not stored" can go and ask for them; a silently
      // truncated list looks like the member never sent them.
      if (index >= MAX_ATTACHMENTS_PER_MESSAGE) {
        const recorded = await recordAttachment(db, {
          messageId, locationId, mailboxId, index,
          attachment: attachments[index],
          sizeBytes: attachmentSizeHint(attachments[index]),
          skippedReason: 'too_many',
        })
        if (recorded === 'duplicate') summary.deduped += 1
        else note('too_many')
        continue
      }

      const outcome = await storeOne(db, {
        attachment: attachments[index],
        index, messageId, locationId, mailboxId, quotaBytes,
      })
      if (outcome.kind === 'stored') {
        summary.stored += 1
        summary.bytesStored += outcome.sizeBytes
      } else if (outcome.kind === 'duplicate') {
        summary.deduped += 1
      } else if (outcome.kind === 'skipped') {
        note(outcome.reason)
      }
      // kind === 'empty' — nothing to record: size_bytes > 0 is a CHECK, so a
      // zero-byte attachment has no legal row. Logged inside storeOne.
    } catch (err) {
      // Belt and braces on top of storeOne's own guards. An attachment loop is
      // never allowed to take the email with it.
      console.error('[email-attachments] attachment', index, 'threw:', err?.message)
    }
  }

  return summary
}

/**
 * A last-resort size for an attachment we are not going to decode (the
 * over-the-count case). `ContentLength` is sender-supplied and therefore
 * untrusted — it is used ONLY here, where the alternative is no row at all, and
 * never to decide whether something fits the quota.
 */
function attachmentSizeHint(attachment) {
  const n = Number(attachment?.ContentLength)
  if (Number.isFinite(n) && n > 0) return Math.min(Math.round(n), MAX_ATTACHMENT_BYTES)
  return 1 // size_bytes > 0 is a CHECK; "unknown" still has to be a legal row
}

/**
 * One attachment, end to end.
 *
 * @returns {Promise<{kind: 'stored'|'skipped'|'duplicate'|'empty', reason?: string, sizeBytes?: number}>}
 */
async function storeOne(db, { attachment, index, messageId, locationId, mailboxId, quotaBytes }) {
  const bytes = decodeAttachmentContent(attachment?.Content)
  if (!bytes) {
    console.warn('[email-attachments] undecodable or empty attachment', { messageId, index })
    return { kind: 'empty' }
  }
  const sizeBytes = bytes.length // the ONLY size this module trusts

  // Fast path for a re-processed delivery: don't upload bytes we are about to
  // discard. The 23505 handling below is what makes it correct under a race;
  // this only makes it cheap.
  if (await alreadyRecorded(db, messageId, index)) return { kind: 'duplicate' }

  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    const recorded = await recordAttachment(db, {
      messageId, locationId, mailboxId, index, attachment, sizeBytes: MAX_ATTACHMENT_BYTES,
      skippedReason: 'too_large',
    })
    return recorded === 'duplicate'
      ? { kind: 'duplicate' }
      : { kind: 'skipped', reason: 'too_large' }
  }

  // ── Reserve ───────────────────────────────────────────────────────
  const reserved = await addStorageBytes(db, { locationId, mailboxId, delta: sizeBytes })
  if (!reserved.ok) {
    // The counter is the thing that says whether there is room. With it
    // unavailable, storing would be storing unmetered — record and move on.
    const recorded = await recordAttachment(db, {
      messageId, locationId, mailboxId, index, attachment, sizeBytes,
      skippedReason: 'rehost_failed',
    })
    return recorded === 'duplicate'
      ? { kind: 'duplicate' }
      : { kind: 'skipped', reason: 'rehost_failed' }
  }

  const release = () => addStorageBytes(db, { locationId, mailboxId, delta: -sizeBytes })

  if (exceedsQuota(reserved.total, quotaBytes)) {
    await release()
    const recorded = await recordAttachment(db, {
      messageId, locationId, mailboxId, index, attachment, sizeBytes,
      skippedReason: 'quota',
    })
    return recorded === 'duplicate'
      ? { kind: 'duplicate' }
      : { kind: 'skipped', reason: 'quota' }
  }

  // ── Upload ────────────────────────────────────────────────────────
  const mime = safeMimeType(attachment?.ContentType)
  let path
  try {
    path = attachmentObjectPath({ locationId, messageId, index, mime })
  } catch (err) {
    await release()
    console.error('[email-attachments] refusing to build a storage path:', err?.message)
    const recorded = await recordAttachment(db, {
      messageId, locationId, mailboxId, index, attachment, sizeBytes,
      skippedReason: 'rehost_failed',
    })
    return recorded === 'duplicate'
      ? { kind: 'duplicate' }
      : { kind: 'skipped', reason: 'rehost_failed' }
  }

  // upsert:true because the key is deterministic — a retry rewrites the same
  // object with the same bytes rather than erroring on an existing key.
  const { error: upErr } = await db.storage
    .from(EMAIL_ATTACHMENT_BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: true })
  if (upErr) {
    await release()
    console.error('[email-attachments] upload failed:', upErr.message)
    const recorded = await recordAttachment(db, {
      messageId, locationId, mailboxId, index, attachment, sizeBytes,
      skippedReason: 'rehost_failed',
    })
    return recorded === 'duplicate'
      ? { kind: 'duplicate' }
      : { kind: 'skipped', reason: 'rehost_failed' }
  }

  // ── Record ────────────────────────────────────────────────────────
  const recorded = await recordAttachment(db, {
    messageId, locationId, mailboxId, index, attachment, sizeBytes, storagePath: path,
  })
  if (recorded === 'duplicate') {
    // Another run already accounted for this (message, index). Give the
    // reservation back — but LEAVE THE OBJECT: the path is deterministic, so
    // what we just wrote is byte-identical to what the winning row points at.
    // Deleting it here would break their row.
    await release()
    return { kind: 'duplicate' }
  }
  if (recorded === 'failed') {
    await release()
    // No row means nothing will ever find these bytes, so take them back out.
    try { await db.storage.from(EMAIL_ATTACHMENT_BUCKET).remove([path]) } catch { /* logged below */ }
    console.error('[email-attachments] row insert failed after upload; object removed', { messageId, index })
    return { kind: 'skipped', reason: 'rehost_failed' }
  }
  return { kind: 'stored', sizeBytes }
}

/**
 * Write the attachment row.
 *
 * Exactly one of storagePath / skippedReason must be set — mig 482's
 * email_attach_stored_xor_skipped CHECK enforces it, and a row that set both or
 * neither would 23514 and lose the record of the file entirely.
 *
 * @returns {Promise<'ok'|'duplicate'|'failed'>}
 */
async function recordAttachment(db, {
  messageId, locationId, mailboxId, index, attachment, sizeBytes,
  storagePath = null, skippedReason = null,
}) {
  try {
    const { error } = await db.from('email_ticket_attachments').insert({
      message_id: messageId,
      location_id: locationId,
      mailbox_id: mailboxId ?? null,
      attachment_index: index,
      // The stranger's filename, kept as DATA. It never addressed the object.
      filename: safeAttachmentFilename(attachment?.Name),
      mime_type: safeMimeType(attachment?.ContentType),
      size_bytes: Math.max(1, Math.round(sizeBytes)),
      storage_path: storagePath,
      skipped_reason: skippedReason,
    })
    if (!error) return 'ok'
    if (error.code === UNIQUE_VIOLATION) return 'duplicate'
    console.error('[email-attachments] attachment insert failed:', error.message)
    return 'failed'
  } catch (err) {
    console.error('[email-attachments] attachment insert threw:', err?.message)
    return 'failed'
  }
}

/**
 * A short-lived signed URL for one stored attachment. The bucket is private, so
 * this is the only way any browser sees the bytes, and it expires.
 *
 * `filename` becomes the download name — it is the sanitised value off the row,
 * never the raw header.
 */
export async function signedAttachmentUrl(db, storagePath, { filename, ttlSeconds = 300 } = {}) {
  if (!storagePath) return null
  try {
    const { data, error } = await db.storage
      .from(EMAIL_ATTACHMENT_BUCKET)
      .createSignedUrl(storagePath, ttlSeconds, filename ? { download: filename } : undefined)
    if (error || !data?.signedUrl) {
      if (error) console.error('[email-attachments] signed url failed:', error.message)
      return null
    }
    return data.signedUrl
  } catch (err) {
    console.error('[email-attachments] signed url threw:', err?.message)
    return null
  }
}

// A prune is a destructive operator action, so it is bounded: one call clears at
// most this many attachments and reports what is left, rather than doing an
// unbounded amount of work inside one request.
export const PRUNE_BATCH_LIMIT = 200

// Tickets someone is still working are never pruned, whatever age is chosen.
// The spec's rule ("attachments on closed tickets older than a chosen age")
// with `solved` included — a solved ticket is finished correspondence.
const PRUNABLE_TICKET_STATUSES = ['solved', 'closed']

/**
 * Reclaim space: drop the bytes, keep the record, and MOVE THE COUNTER.
 *
 * The counter half is the whole point. A delete path that removes rows and
 * objects but leaves bytes_used high converts a full mailbox into a permanently
 * full one — every future attachment is refused for space that was freed months
 * ago, and nothing on any screen explains it.
 *
 * ORDER: mark the rows first, then remove the objects, then decrement.
 *   • marking first means nothing ever points at bytes that are already gone
 *   • the UPDATE filters on `storage_path IS NOT NULL` and returns what it
 *     actually changed, so two operators pruning at once cannot both count the
 *     same rows and double-decrement
 *   • a failed object removal is logged loudly and still decremented: rows and
 *     counter agree (which is what recalc would conclude anyway), and the leak
 *     is a cost line, not a correctness one
 *
 * @returns {Promise<{ok: boolean, error?: string, pruned: number, bytesFreed: number, remaining: number}>}
 */
export async function pruneMailboxAttachments(db, {
  locationId, mailboxId = null, olderThanDays = 365, limit = PRUNE_BATCH_LIMIT,
}) {
  const empty = { ok: true, pruned: 0, bytesFreed: 0, remaining: 0 }
  if (!locationId) return { ...empty, ok: false, error: 'locationId is required' }

  const days = Math.max(0, Math.floor(Number(olderThanDays) || 0))
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const batch = Math.min(Math.max(1, Math.floor(Number(limit) || PRUNE_BATCH_LIMIT)), PRUNE_BATCH_LIMIT)

  // Candidates: stored, in this bucket, old enough. Over-fetch by one so the
  // caller can be told there is more without a second count query.
  let q = db.from('email_ticket_attachments')
    .select('id, message_id, size_bytes, storage_path')
    .eq('location_id', locationId)
    .not('storage_path', 'is', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(batch + 1)
  q = mailboxId ? q.eq('mailbox_id', mailboxId) : q.is('mailbox_id', null)

  const { data: candidates, error: candErr } = await q
  if (candErr) return { ...empty, ok: false, error: candErr.message }
  if (!candidates || candidates.length === 0) return empty

  const eligible = await filterToFinishedTickets(db, candidates)
  if (eligible.error) return { ...empty, ok: false, error: eligible.error }

  const rows = eligible.rows.slice(0, batch)
  const remaining = Math.max(0, eligible.rows.length - rows.length)
  if (rows.length === 0) return { ...empty, remaining }

  // Snapshot the object keys BEFORE the UPDATE nulls storage_path. Reading
  // them afterwards would be reading the column we are about to blank, which
  // silently leaves every pruned object in the bucket.
  const pathById = new Map(rows.map(r => [r.id, r.storage_path]))

  // ── Mark ──────────────────────────────────────────────────────────
  const { data: updated, error: updErr } = await db.from('email_ticket_attachments')
    .update({ storage_path: null, skipped_reason: 'pruned' })
    .in('id', rows.map(r => r.id))
    .not('storage_path', 'is', null)
    .select('id, size_bytes')
  if (updErr) return { ...empty, ok: false, error: updErr.message, remaining }

  const changed = updated || []
  if (changed.length === 0) return { ...empty, remaining }

  const bytesFreed = changed.reduce((sum, r) => sum + (Number(r.size_bytes) || 0), 0)

  // ── Remove the bytes ──────────────────────────────────────────────
  const paths = changed.map(r => pathById.get(r.id)).filter(Boolean)
  try {
    const { error: rmErr } = await db.storage.from(EMAIL_ATTACHMENT_BUCKET).remove(paths)
    if (rmErr) {
      console.error(
        '[email-attachments] PRUNE LEFT OBJECTS BEHIND — the rows are marked pruned and the ' +
        'counter is being decremented, so the quota is correct, but these objects are still ' +
        `billable and now unreferenced: ${paths.join(', ')} —`, rmErr.message,
      )
    }
  } catch (err) {
    console.error('[email-attachments] prune object removal threw:', err?.message)
  }

  // ── Decrement ─────────────────────────────────────────────────────
  const released = await addStorageBytes(db, { locationId, mailboxId, delta: -bytesFreed })
  if (!released.ok) {
    console.error(
      '[email-attachments] PRUNE DID NOT DECREMENT THE COUNTER — the mailbox will read as ' +
      `full for ${bytesFreed} bytes it no longer holds. Run the Recalculate action.`,
    )
  }

  return { ok: true, pruned: changed.length, bytesFreed, remaining }
}

/**
 * Keep only the attachments whose ticket is finished.
 *
 * Two hops (attachment → message → ticket) rather than a nested PostgREST
 * embed filter, which this repo has been bitten by (embedded-resource filters
 * silently return the wrong thing under some select shapes). The candidate set
 * is already bounded by the prune batch, so two `.in()` queries is cheap.
 */
async function filterToFinishedTickets(db, candidates) {
  const messageIds = [...new Set(candidates.map(c => c.message_id).filter(Boolean))]
  if (messageIds.length === 0) return { rows: [] }

  const { data: messages, error: msgErr } = await db.from('email_inbox_messages')
    .select('id, ticket_id')
    .in('id', messageIds)
    .limit(messageIds.length)
  if (msgErr) return { error: msgErr.message, rows: [] }

  const ticketByMessage = new Map((messages || []).map(m => [m.id, m.ticket_id]))
  const ticketIds = [...new Set([...ticketByMessage.values()].filter(Boolean))]
  if (ticketIds.length === 0) return { rows: [] }

  const { data: tickets, error: tErr } = await db.from('email_tickets')
    .select('id, status')
    .in('id', ticketIds)
    .limit(ticketIds.length)
  if (tErr) return { error: tErr.message, rows: [] }

  const finished = new Set(
    (tickets || []).filter(t => PRUNABLE_TICKET_STATUSES.includes(t.status)).map(t => t.id)
  )
  return {
    rows: candidates.filter(c => finished.has(ticketByMessage.get(c.message_id))),
  }
}

/**
 * Re-derive every counter at a location from the attachment rows. The repair
 * for the drift the reservation dance can leave behind (a process killed
 * between reserve and insert, a prune whose decrement failed) and for a mailbox
 * hard-deleted in SQL, which CASCADEs its counter away while its attachments
 * survive with mailbox_id NULL.
 */
export async function recalcStorageUsage(db, locationId) {
  try {
    const { error } = await db.rpc('recalc_email_storage_usage', { p_location_id: locationId })
    if (error) {
      console.error('[email-attachments] recalc failed:', error.message)
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (err) {
    console.error('[email-attachments] recalc threw:', err?.message)
    return { ok: false, error: err?.message || 'recalc failed' }
  }
}
