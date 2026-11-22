// INVOICES-QUEUE.1 PR 2 + XERO-API.3 — bulk send-to-Xero.
//
// Bookkeeper-gated. A row whose review_reasons is non-empty ("Needs a
// look") is skipped untouched (INVOICEPREP.3). For each other row in
// 'extracted' state, this route:
//   1. Flips status to 'data_approved' (audit checkpoint).
//   2. Calls pushQueueRowToXero — direct /Invoices API push that
//      reads the bookkeeper-picked xero_account_id + supplier ref
//      from extracted_fields (XERO-API.2) and creates a structured
//      ACCPAY draft bill in Xero.
//   3. On success: row → 'forwarded' with xero_bill_id +
//      xero_deep_link_url + xero_synced_at stamped.
//   4. On failure: row stays at 'data_approved' with xero_error
//      populated so the UI can retry.
//
// The bookkeeper is acknowledging the extracted_fields by clicking
// Send — same semantics as the single-row /data-approve route's
// two-step pattern.
//
// Sequential per-row send rather than parallel — keeps the
// inbox's "row-by-row going green" feel that the bookkeeper
// already relies on. Realistic batch sizes (5-20 rows) make this
// well within Xero's 60 calls/min budget.

import { NextResponse } from 'next/server'
// XERO-API.3 — swapped from forwardQueueRowToXero (Postmark email
// → Hubdoc OCR) to pushQueueRowToXero (direct /Invoices API push).
// See src/lib/invoices-queue/push-xero.js header for why.
import { pushQueueRowToXero } from '@/lib/invoices-queue/push-xero'
import { hasResolvedVatRate } from '@/lib/invoices-queue/vat'
import { XeroError } from '@/lib/xero/client'
import {
  BulkIdsSchema,
  loadBookkeeper,
  loadAndScopeBulkRows,
} from '../_bulk-helpers'
import { validateBody } from '@/lib/validate'
import { recordPushOutcome, rememberSupplierCoding } from '@/lib/invoices-queue/push-outcome'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const SENDABLE_STATUSES = ['extracted', 'data_approved']

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
      select: 'id, location_id, status, source_type, extracted_fields, review_reasons',
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
  const { rowsById, missingIds, forbiddenIds } = scoped

  const results = []
  for (const id of missingIds) results.push({ id, outcome: 'skipped', reason: 'not_found' })
  for (const id of forbiddenIds) results.push({ id, outcome: 'skipped', reason: 'forbidden' })

  for (const id of ids) {
    const row = rowsById[id]
    if (!row) continue
    if (!SENDABLE_STATUSES.includes(row.status)) {
      results.push({ id, outcome: 'skipped', reason: `wrong_status:${row.status}` })
      continue
    }
    // INVOICEPREP.3 — a row preparation flagged ("Needs a look") is never
    // sent in bulk; a person opens it first. Checked before any status change
    // or push. null is a row from before preparation, sent as before.
    if (Array.isArray(row.review_reasons) && row.review_reasons.length > 0) {
      results.push({ id, outcome: 'skipped', reason: 'needs_a_look' })
      continue
    }
    if (!row.extracted_fields) {
      results.push({ id, outcome: 'skipped', reason: 'no_extracted_fields' })
      continue
    }
    // INVOICEPREP.3 — a credit note is never sent as a bill. Prepared rows
    // already carry the credit_note reason; this also stops a row from before
    // preparation (no reasons recorded) and a data_approved retry.
    if (row.extracted_fields.document_type === 'credit_note') {
      results.push({ id, outcome: 'skipped', reason: 'credit_note' })
      continue
    }
    // XERO-BILL-VAT.2 — never send a bill whose VAT rate is undetermined.
    // Skip it while still 'extracted' (don't flip to data_approved) so the
    // bookkeeper can pick a rate and retry. A genuine 0%-VAT bill resolves
    // to 'NONE' and passes. Mirrors the single-row data-approve gate — the
    // bulk path is the one bookkeepers actually use, so it must gate too.
    if (!hasResolvedVatRate(row.extracted_fields)) {
      results.push({ id, outcome: 'skipped', reason: 'no_vat_rate' })
      continue
    }

    // Step 1: flip extracted → data_approved (audit checkpoint).
    if (row.status === 'extracted') {
      const { data: stepped, error: stepErr } = await db
        .from('invoices_queue')
        .update({
          status: 'data_approved',
          data_reviewed_at: new Date().toISOString(),
          data_reviewed_by: user.id,
          xero_error: null,
        })
        .eq('id', id)
        .eq('status', 'extracted')
        .select('id')
        .maybeSingle()
      if (stepErr || !stepped) {
        results.push({ id, outcome: 'failed', error: stepErr?.message || 'concurrent_modification' })
        continue
      }
      // XEROBULK.1 — supplier memory, as the single-row approve records it.
      try { await rememberSupplierCoding(db, row) } catch (e) {
        console.warn(`[bulk-send ${id}] recordSupplierDefault failed: ${e?.message || e}`)
      }
    }

    // Step 2: push directly to Xero /Invoices (XERO-API.3).
    // Throws if xero_account_id / xero_contact_ref are missing —
    // server-side enforcement of the PR 2 UI gate.
    let pushResult
    try {
      pushResult = await pushQueueRowToXero(id)
    } catch (e) {
      const msg = e instanceof XeroError ? e.message : (e?.message || String(e))
      await db.from('invoices_queue').update({ xero_error: msg }).eq('id', id)
      // A bill that already exists in Xero isn't a failure — it's a
      // duplicate we deliberately skipped. Surface it as its own outcome
      // so the bulk summary doesn't alarm the operator with a big
      // 'failed' count, and they can clear these with 'Mark as in Xero'.
      if (e instanceof XeroError && e.code === 'already_in_xero') {
        results.push({ id, outcome: 'already_in_xero', note: msg })
        continue
      }
      results.push({ id, outcome: 'failed', error: msg, retry_state: 'data_approved' })
      continue
    }

    // Step 3 (XEROBULK.1, October audit A16) — the shared outcome: a bill
    // whose source file did not attach stays retryable with its bill id,
    // never 'forwarded'.
    const recorded = await recordPushOutcome(db, id, pushResult)
    if (recorded.outcome === 'attachment_failed') {
      results.push({ id, outcome: 'attachment_failed', error: recorded.message, bill_id: pushResult.billId, retry_state: 'data_approved' })
      continue
    }
    if (recorded.outcome === 'conflict') {
      results.push({ id, outcome: 'failed', error: 'concurrent_modification' })
      continue
    }
    if (recorded.outcome === 'error') {
      results.push({ id, outcome: 'failed', error: recorded.message })
      continue
    }
    results.push({
      id,
      outcome: 'ok',
      bill_id: pushResult.billId,
      bill_number: pushResult.billNumber,
      deep_link_url: pushResult.deepLinkUrl,
      sent_to: pushResult.sentTo,
    })
  }

  const counts = results.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1
    return acc
  }, {})

  return NextResponse.json({ success: true, data: { results, counts } })
}
