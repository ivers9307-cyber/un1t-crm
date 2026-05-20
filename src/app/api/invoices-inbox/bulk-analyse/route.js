// INVOICES-QUEUE.1 PR 2 — bulk Claude Vision analyse.
//
// Bookkeeper-gated. Accepts an array of queue row ids; for each:
//   • Skip if not in 'quality_approved' or 'extracted' (the legal
//     states for OCR re-run from the original single-row /extract
//     route).
//   • Skip if no attachment_path.
//   • Skip if no attachment_bucket (defensive — mig 185 NOT NULL).
//   • Download bytes from the row's bucket.
//   • Run extractInvoiceFieldsFromBytes.
//   • On success: row → 'extracted', extracted_fields populated,
//     confidence stamped.
//   • On failure: row stays where it is, extraction_error populated
//     so the UI surfaces a retry.
//
// We run extractions SEQUENTIALLY rather than parallel — Claude
// Vision is rate-limited; bursting 50 concurrent requests against
// the Anthropic API courts 429s. Per-row time is ~5-15s, so a
// 20-row batch takes 2-5 minutes. The route's Vercel function has
// maxDuration 300s (5 min) which is enough for the realistic
// batch sizes (operators won't analyse 100 rows in one click).

import { NextResponse } from 'next/server'
import { extractInvoiceFieldsFromBytes } from '@/lib/invoice-extraction'
import {
  BulkIdsSchema,
  loadBookkeeper,
  loadAndScopeBulkRows,
} from '../_bulk-helpers'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ANALYSABLE_STATUSES = ['quality_approved', 'extracted']

export async function POST(request) {
  const ctx = await loadBookkeeper()
  if (ctx.response) return ctx.response
  const { user, db } = ctx

  const validation = await validateBody(request, BulkIdsSchema)
  if (!validation.ok) return validation.response
  const { ids } = validation.data

  let scoped
  try {
    scoped = await loadAndScopeBulkRows({
      db, user, ids,
      select: 'id, location_id, status, source_type, attachment_bucket, attachment_path, attachment_mime_type',
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
  const { rowsById, missingIds, forbiddenIds } = scoped

  const results = []

  // Pre-record skip reasons for ids we can't act on.
  for (const id of missingIds) results.push({ id, outcome: 'skipped', reason: 'not_found' })
  for (const id of forbiddenIds) results.push({ id, outcome: 'skipped', reason: 'forbidden' })

  // Sequential analysis. See module header for rationale.
  for (const id of ids) {
    const row = rowsById[id]
    if (!row) continue
    if (!ANALYSABLE_STATUSES.includes(row.status)) {
      results.push({ id, outcome: 'skipped', reason: `wrong_status:${row.status}` })
      continue
    }
    if (!row.attachment_path || !row.attachment_bucket) {
      results.push({ id, outcome: 'skipped', reason: 'no_attachment' })
      continue
    }

    // Download bytes.
    const { data: blob, error: dlErr } = await db.storage
      .from(row.attachment_bucket)
      .download(row.attachment_path)
    if (dlErr || !blob) {
      results.push({ id, outcome: 'failed', error: `download: ${dlErr?.message || 'unknown'}` })
      continue
    }
    const ab = await blob.arrayBuffer()
    const bytes = Buffer.from(ab)

    const result = await extractInvoiceFieldsFromBytes(bytes, row.attachment_mime_type)
    if (!result.ok) {
      // Persist the error; row stays at its current state so the UI
      // can surface a retry.
      await db
        .from('invoices_queue')
        .update({
          extraction_error: result.error,
          extracted_at: new Date().toISOString(),
        })
        .eq('id', id)
      results.push({ id, outcome: 'failed', error: result.error })
      continue
    }

    // Confidence heuristic — same as the single-row /extract route.
    const f = result.fields
    const reconciles = Math.abs((Number(f.subtotal) + Number(f.tax_amount)) - Number(f.total)) <= 0.01
    const allRequired = f.supplier_name && f.invoice_number && f.invoice_date && Number.isFinite(Number(f.total))
    const confidence = allRequired && reconciles ? 'high' : 'medium'

    const { error: updErr } = await db
      .from('invoices_queue')
      .update({
        status: 'extracted',
        extracted_at: new Date().toISOString(),
        extracted_fields: result.fields,
        extraction_confidence: confidence,
        extraction_error: null,
      })
      .eq('id', id)
      .in('status', ANALYSABLE_STATUSES)

    if (updErr) {
      results.push({ id, outcome: 'failed', error: updErr.message })
      continue
    }
    results.push({ id, outcome: 'ok', confidence })
  }

  const counts = results.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1
    return acc
  }, {})

  return NextResponse.json({ success: true, data: { results, counts } })
}
