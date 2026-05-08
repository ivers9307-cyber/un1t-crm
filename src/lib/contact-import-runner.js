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
// Returns { counts: { created, updated, skipped, errored } }.
// Side-effect: every row insert is written to contact_import_rows.
// On unexpected error throws — caller is responsible for marking
// the batch as failed.

import { validateRow, deriveName, fieldsTouchedByMapping } from './contact-import.js'
import { logWarn } from './log.js'

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

  // Bulk lookup — both keys.
  const lookupCols = ['id', 'email', 'glofox_member_id', ...touchedFields].filter(Boolean)
  const colExpr = [...new Set(lookupCols)].join(', ')
  const existingByEmail = new Map()
  const existingByGlofox = new Map()
  const queries = []
  if (emailsToLookup.size > 0) {
    queries.push(db.from('contacts').select(colExpr)
      .eq('location_id', locationId).in('email', [...emailsToLookup]))
  }
  if (glofoxToLookup.size > 0) {
    queries.push(db.from('contacts').select(colExpr)
      .eq('location_id', locationId).in('glofox_member_id', [...glofoxToLookup]))
  }
  const lookupResults = await Promise.all(queries)
  for (const { data } of lookupResults) {
    for (const c of (data || [])) {
      if (c.email) existingByEmail.set(String(c.email).toLowerCase(), c)
      if (c.glofox_member_id) existingByGlofox.set(c.glofox_member_id, c)
    }
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
          lead_status: p.payload.lead_status || 'active_trial',
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

  // Persist outcomes (chunked).
  const CHUNK = 500
  for (let i = 0; i < importRowInserts.length; i += CHUNK) {
    const slice = importRowInserts.slice(i, i + CHUNK)
    const { error } = await db.from('contact_import_rows').insert(slice)
    if (error) {
      logWarn('contact-import-runner', 'row chunk failed', { chunkIndex: i, err: error })
    }
  }

  return { counts }
}
