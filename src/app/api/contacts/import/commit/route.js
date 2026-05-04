// POST /api/contacts/import/commit
//
// Mig 095. Master-only contact CSV import. Same body as /preview;
// re-runs validation server-side (defence-in-depth — never trust
// the wizard's submitted plan) and writes:
//
//   1. INSERT contact_imports row (the batch envelope)
//   2. INSERT or UPDATE one contacts row per CSV row
//   3. INSERT contact_import_rows row per CSV row, capturing
//      before_snapshot for updates so rollback can reverse them
//   4. UPDATE contact_imports row totals when done
//
// Best-effort per-row: a single failed write becomes an `errored`
// row in contact_import_rows but doesn't fail the batch. Operator
// gets a summary back + can download the error CSV later.
//
// Body matches /preview: { mapping, rows, batch_tag, source_filename }

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { validateRow, deriveName, fieldsTouchedByMapping } from '@/lib/contact-import'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_ROWS = 5000

const Body = z.object({
  mapping: z.record(z.string().nullable()),
  rows: z.array(z.record(z.unknown())).min(1).max(MAX_ROWS),
  batch_tag: z.string().max(200).optional(),
  source_filename: z.string().max(500).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!user.isMaster && user.role !== 'master') {
    return NextResponse.json({
      success: false,
      error: 'Only a master account can import contacts.',
    }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location.' }, { status: 400 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { mapping, rows, batch_tag, source_filename } = validation.data
  const batchTags = (batch_tag || '').split(',').map(s => s.trim()).filter(Boolean)
  const touchedFields = fieldsTouchedByMapping(mapping)
  // tags is touched if either the mapping has it OR there's a batch tag
  if (batchTags.length > 0 && !touchedFields.includes('tags')) touchedFields.push('tags')

  const db = createServerClient()

  // 1. Open the batch envelope. Totals are stamped at the end.
  const { data: batch, error: batchErr } = await db
    .from('contact_imports')
    .insert({
      location_id: locationId,
      actor_user_id: user.id,
      source_filename: source_filename || null,
      mapping,
      batch_tag: batch_tag || null,
      total_rows: rows.length,
    })
    .select()
    .single()
  if (batchErr) {
    return NextResponse.json({ success: false, error: `Could not start import: ${batchErr.message}` }, { status: 500 })
  }

  // 2. Validate every row + look up existing emails in one bulk
  // query (mirrors /preview exactly).
  const plans = []
  const seenInFile = new Set()
  const emailsToLookup = new Set()
  for (let i = 0; i < rows.length; i++) {
    const r = validateRow(rows[i], mapping, { batchTags })
    const rowNumber = i + 2
    if (!r.ok) {
      plans.push({ rowNumber, action: 'errored', rawRow: rows[i], error: r.error })
      continue
    }
    if (seenInFile.has(r.payload.email)) {
      plans.push({
        rowNumber,
        action: 'skipped',
        rawRow: rows[i],
        error: 'Duplicate email earlier in this file — first occurrence wins.',
        payload: r.payload,
      })
      continue
    }
    seenInFile.add(r.payload.email)
    emailsToLookup.add(r.payload.email)
    plans.push({ rowNumber, action: 'pending', rawRow: rows[i], payload: r.payload })
  }

  // Bulk lookup existing contacts. Pull all the touched fields so
  // we can build the before_snapshot for updates.
  const lookupCols = ['id', 'email', ...touchedFields].filter(Boolean)
  const { data: existing } = emailsToLookup.size > 0
    ? await db
        .from('contacts')
        .select([...new Set(lookupCols)].join(', '))
        .eq('location_id', locationId)
        .in('email', [...emailsToLookup])
    : { data: [] }
  const existingByEmail = new Map((existing || []).map(c => [String(c.email).toLowerCase(), c]))

  // 3. Apply each row. Per-row try/catch so one bad row doesn't
  // blow up the batch.
  const counts = { created: 0, updated: 0, skipped: 0, errored: 0 }
  const importRowInserts = []

  for (const p of plans) {
    if (p.action === 'errored' || p.action === 'skipped') {
      counts[p.action] += 1
      importRowInserts.push({
        import_id: batch.id,
        row_number: p.rowNumber,
        action: p.action,
        contact_id: null,
        raw_row: p.rawRow,
        before_snapshot: null,
        error_message: p.error || null,
      })
      continue
    }

    const existingRow = existingByEmail.get(p.payload.email)
    try {
      if (existingRow) {
        // Build before_snapshot — only the columns this import is
        // about to write. Avoids the rollback restoring fields the
        // operator never touched.
        const before = {}
        for (const f of touchedFields) {
          if (f in existingRow) before[f] = existingRow[f] ?? null
        }
        // Build the update payload — merge tags rather than replace
        // so the operator's batch tag adds to existing tags instead
        // of nuking them.
        const update = { ...p.payload }
        if (update.tags) {
          const prior = Array.isArray(existingRow.tags) ? existingRow.tags : []
          const merged = [...new Set([...prior, ...update.tags])]
          update.tags = merged
        }
        const { error: upErr } = await db
          .from('contacts')
          .update(update)
          .eq('id', existingRow.id)
        if (upErr) throw new Error(upErr.message)
        counts.updated += 1
        importRowInserts.push({
          import_id: batch.id,
          row_number: p.rowNumber,
          action: 'updated',
          contact_id: existingRow.id,
          raw_row: p.rawRow,
          before_snapshot: before,
        })
      } else {
        const insertPayload = {
          ...p.payload,
          name: deriveName(p.payload.first_name, p.payload.last_name, p.payload.email),
          location_id: locationId,
          lead_status: p.payload.lead_status || 'active_trial',
          created_via_import_id: batch.id,
        }
        const { data: created, error: insErr } = await db
          .from('contacts')
          .insert(insertPayload)
          .select('id')
          .single()
        if (insErr) throw new Error(insErr.message)
        counts.created += 1
        importRowInserts.push({
          import_id: batch.id,
          row_number: p.rowNumber,
          action: 'created',
          contact_id: created.id,
          raw_row: p.rawRow,
          before_snapshot: null,
        })
      }
    } catch (e) {
      counts.errored += 1
      importRowInserts.push({
        import_id: batch.id,
        row_number: p.rowNumber,
        action: 'errored',
        contact_id: null,
        raw_row: p.rawRow,
        before_snapshot: null,
        error_message: e?.message || String(e),
      })
    }
  }

  // 4. Persist per-row outcomes + stamp the batch totals. Chunked
  // insert because Supabase rejects very large single inserts.
  const CHUNK = 500
  for (let i = 0; i < importRowInserts.length; i += CHUNK) {
    const slice = importRowInserts.slice(i, i + CHUNK)
    const { error } = await db.from('contact_import_rows').insert(slice)
    if (error) {
      console.warn(`[contact-import] row insert chunk ${i} failed: ${error.message}`)
    }
  }

  await db
    .from('contact_imports')
    .update({
      created_count: counts.created,
      updated_count: counts.updated,
      skipped_count: counts.skipped,
      errored_count: counts.errored,
    })
    .eq('id', batch.id)

  return NextResponse.json({
    success: true,
    data: {
      import_id: batch.id,
      summary: {
        total: rows.length,
        created: counts.created,
        updated: counts.updated,
        skipped: counts.skipped,
        errored: counts.errored,
      },
    },
  })
}
