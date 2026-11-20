// Contact import runner (mig 096).
//
// Runs the actual write phase of an import — looking up existing
// contacts, applying create / update / skip per row, capturing
// before_snapshot for rollback, and stamping the batch totals.
//
// Called from two places:
//
//   1. POST /api/contacts/import/commit — for small batches that
//      fit safely inside one HTTP request (≤ 1000 rows). The route
//      pre-creates the batch row, writes its payload field, then
//      calls runImportCommit() inline.
//
//   2. /api/cron/process-contact-imports — for large async batches.
//      The cron worker grabs the next pending row, marks it
//      processing, then calls runImportCommit() with the same
//      arguments shape.
//
// Returns { counts: { created, updated, skipped, errored }, ledgerFailed }.
// Side-effect: every row outcome is written to contact_import_rows.
// On unexpected error throws — caller is responsible for marking
// the batch as failed.
//
// IMPORTLEDGER.1 (audit A08) — contact_import_rows is the rollback
// history: an 'updated' row's before_snapshot is the ONLY copy of the
// contact's pre-import values. A ledger chunk that fails to save is
// retried once; if it still fails, its row count is returned as
// `ledgerFailed` (never swallowed) so the caller can mark the batch with
// ledgerIncompleteMessage() — a rollback of that batch then warns that it
// cannot restore everything instead of claiming a full restore.

import { validateRow, deriveName, fieldsTouchedByMapping } from './contact-import.js'
import { logWarn, logError } from './log.js'
import { selectAllByKeys } from './select-all.js'
import { emailStatusResetForAddressChange } from './email-reputation.js'

// IMPORTLEDGER.1 — the marker a batch carries in contact_imports.error_message
// when some of its row outcomes (and so possibly some before_snapshots) were
// never saved. Uses the existing column and status values: the batch is still
// 'completed' (its contacts really were written), but this message tells the
// detail page and the rollback route that its rollback history is incomplete.
export const LEDGER_INCOMPLETE_PREFIX = 'Rollback history incomplete:'

export function ledgerIncompleteMessage(lostRows) {
  return `${LEDGER_INCOMPLETE_PREFIX} ${lostRows} row outcome${lostRows === 1 ? '' : 's'} could not be saved. `
    + 'A rollback will delete the contacts this import created, but cannot restore every contact it updated.'
}

export function isLedgerIncomplete(batch) {
  return typeof batch?.error_message === 'string' && batch.error_message.startsWith(LEDGER_INCOMPLETE_PREFIX)
}

export async function runImportCommit(db, {
  importId,
  locationId,
  mapping,
  rows,
  batchTag,
  resolutions,
}) {
  const batchTags = (batchTag || '').split(',').map(s => s.trim()).filter(Boolean)
  const touchedFields = fieldsTouchedByMapping(mapping)
  if (batchTags.length > 0 && !touchedFields.includes('tags')) touchedFields.push('tags')
  const resolutionMap = resolutions || {}

  // Validate + collect lookup keys.
  const plans = []
  const seenEmails = new Set()
  const seenGlofox = new Set()
  const emailsToLookup = new Set()
  const glofoxToLookup = new Set()
  for (let i = 0; i < rows.length; i++) {
    const r = validateRow(rows[i], mapping, { batchTags })
    const rowNumber = i + 2
    if (!r.ok) {
      plans.push({ rowNumber, action: 'errored', rawRow: rows[i], error: r.error })
      continue
    }
    const email = r.payload.email
    const glofoxId = r.payload.glofox_member_id || null
    if (seenEmails.has(email)) {
      plans.push({ rowNumber, action: 'skipped', rawRow: rows[i],
        error: 'Duplicate email earlier in this file — first occurrence wins.', payload: r.payload })
      continue
    }
    if (glofoxId && seenGlofox.has(glofoxId)) {
      plans.push({ rowNumber, action: 'skipped', rawRow: rows[i],
        error: `Duplicate Glofox ID '${glofoxId}' earlier in this file — first occurrence wins.`, payload: r.payload })
      continue
    }
    seenEmails.add(email)
    if (glofoxId) seenGlofox.add(glofoxId)
    emailsToLookup.add(email)
    if (glofoxId) glofoxToLookup.add(glofoxId)
    plans.push({ rowNumber, action: 'pending', rawRow: rows[i], payload: r.payload, glofoxId })
  }

  // Bulk lookup — both keys. CHUNKED + PAGED: an `.in(col, keys)` lookup has two
  // independent 1000-caps — the match set caps at db-max-rows AND the key list
  // overflows the URL. If either bites, a real match is MISSED and the row
  // wrongly takes the INSERT branch → a DUPLICATE contact (the exact failure
  // this PR fixes). selectAllByKeys chunks the keys (~300/query) and pages each
  // chunk's matches.
  // EMAILREP.1 — email_status is read (never imported) so an update that
  // replaces the address can clear the OLD address's bounce stamp.
  const lookupCols = ['id', 'email', 'email_status', 'glofox_member_id', ...touchedFields].filter(Boolean)
  const colExpr = [...new Set(lookupCols)].join(', ')
  const existingByEmail = new Map()
  const existingByGlofox = new Map()
  const [emailMatches, glofoxMatches] = await Promise.all([
    selectAllByKeys([...emailsToLookup], (keys, from, to) => db
      .from('contacts').select(colExpr)
      .eq('location_id', locationId).in('email', keys)
      .order('id', { ascending: true }).range(from, to)),
    selectAllByKeys([...glofoxToLookup], (keys, from, to) => db
      .from('contacts').select(colExpr)
      .eq('location_id', locationId).in('glofox_member_id', keys)
      .order('id', { ascending: true }).range(from, to)),
  ])
  for (const c of [...emailMatches, ...glofoxMatches]) {
    if (c.email) existingByEmail.set(String(c.email).toLowerCase(), c)
    if (c.glofox_member_id) existingByGlofox.set(c.glofox_member_id, c)
  }

  const counts = { created: 0, updated: 0, skipped: 0, errored: 0 }
  const importRowInserts = []

  for (const p of plans) {
    if (p.action === 'errored' || p.action === 'skipped') {
      counts[p.action] += 1
      importRowInserts.push({
        import_id: importId,
        row_number: p.rowNumber,
        action: p.action,
        contact_id: null,
        raw_row: p.rawRow,
        before_snapshot: null,
        error_message: p.error || null,
      })
      continue
    }

    const matched = (p.glofoxId && existingByGlofox.get(p.glofoxId))
                 || existingByEmail.get(p.payload.email)
    const resolution = resolutionMap[String(p.rowNumber)] || 'row_wins'

    try {
      if (matched) {
        if (resolution === 'skip') {
          counts.skipped += 1
          importRowInserts.push({
            import_id: importId, row_number: p.rowNumber, action: 'skipped',
            contact_id: matched.id, raw_row: p.rawRow, before_snapshot: null,
            error_message: 'Skipped per operator resolution (existing values preserved).',
          })
          continue
        }

        const before = {}
        for (const f of touchedFields) {
          if (f in matched) before[f] = matched[f] ?? null
        }

        let update
        if (resolution === 'preserve_existing') {
          update = {}
          for (const [k, v] of Object.entries(p.payload)) {
            const existing = matched[k]
            if (existing == null || existing === '') update[k] = v
          }
        } else {
          update = { ...p.payload }
        }

        if (p.payload.tags) {
          const prior = Array.isArray(matched.tags) ? matched.tags : []
          update.tags = [...new Set([...prior, ...p.payload.tags])]
        }

        // EMAILREP.1 — an import that supplies a corrected address must not
        // leave the OLD address's `bounced`/`complained` stamp behind: every
        // send path blocks on contacts.email_status, so the contact would
        // stay unmailable on an address that is now fine. Folded into the
        // same UPDATE as the address itself. Reputation only — marketing
        // consent is untouched, so a bounced contact still needs to re-opt-in.
        // Deliberately computed AFTER the preserve_existing / tag merging
        // above, so it reads the address this write actually sets.
        //
        // EMAILREP.3 — mig 528 enforces the same rule as a BEFORE UPDATE OF
        // email trigger, so this is now belt AND braces. Kept for the reason
        // spelled out in full at the /api/contacts/[id] call site: the trigger
        // is a migration, this is code, and the two ship independently. When
        // this fires it writes 'active' into the same UPDATE, which makes the
        // trigger's guard false and the trigger a no-op — the redundancy is
        // free, not doubled.
        const emailStatusReset = emailStatusResetForAddressChange({
          oldEmail: matched.email,
          newEmail: update.email,
          currentStatus: matched.email_status,
        })
        if (emailStatusReset) update.email_status = emailStatusReset

        const writableKeys = Object.keys(update).filter(k => update[k] !== undefined)
        if (writableKeys.length === 0) {
          counts.skipped += 1
          importRowInserts.push({
            import_id: importId, row_number: p.rowNumber, action: 'skipped',
            contact_id: matched.id, raw_row: p.rawRow, before_snapshot: null,
            error_message: 'No fields to write under preserve-existing — every targeted field already has a value.',
          })
          continue
        }

        const { error: upErr } = await db.from('contacts').update(update).eq('id', matched.id)
        if (upErr) throw new Error(upErr.message)
        counts.updated += 1
        importRowInserts.push({
          import_id: importId, row_number: p.rowNumber, action: 'updated',
          contact_id: matched.id, raw_row: p.rawRow, before_snapshot: before,
        })
      } else {
        const insertPayload = {
          ...p.payload,
          name: deriveName(p.payload.first_name, p.payload.last_name, p.payload.email),
          location_id: locationId,
          created_via_import_id: importId,
        }
        const { data: created, error: insErr } = await db
          .from('contacts').insert(insertPayload).select('id').single()
        if (insErr) throw new Error(insErr.message)
        counts.created += 1
        importRowInserts.push({
          import_id: importId, row_number: p.rowNumber, action: 'created',
          contact_id: created.id, raw_row: p.rawRow, before_snapshot: null,
        })
      }
    } catch (e) {
      counts.errored += 1
      importRowInserts.push({
        import_id: importId, row_number: p.rowNumber, action: 'errored',
        contact_id: null, raw_row: p.rawRow, before_snapshot: null,
        error_message: e?.message || String(e),
      })
    }
  }

  // Persist outcomes (chunked). IMPORTLEDGER.1 — a failed chunk is retried
  // once, then counted into ledgerFailed rather than discarded: losing it
  // loses the before_snapshots rollback needs. A retry after an ambiguous
  // failure can at worst duplicate ledger rows, which rollback tolerates
  // (the same snapshot restored twice, the same row stamped twice).
  const CHUNK = 500
  let ledgerFailed = 0
  for (let i = 0; i < importRowInserts.length; i += CHUNK) {
    const slice = importRowInserts.slice(i, i + CHUNK)
    let { error } = await db.from('contact_import_rows').insert(slice)
    if (error) {
      logWarn('contact-import-runner', 'row chunk failed — retrying once', {
        importId, chunkStart: i, rows: slice.length, code: error.code ?? null,
      })
      ;({ error } = await db.from('contact_import_rows').insert(slice))
    }
    if (error) {
      ledgerFailed += slice.length
      logError('contact-import-runner', 'row chunk lost after retry — rollback history incomplete', {
        importId,
        chunkStart: i,
        rows: slice.length,
        reversibleRows: slice.filter(r => r.action === 'created' || r.action === 'updated').length,
        code: error.code ?? null,
      })
    }
  }

  return { counts, ledgerFailed }
}
