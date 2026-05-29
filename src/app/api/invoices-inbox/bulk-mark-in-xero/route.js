// INV-RECONCILE.1 — "Mark as already in Xero" (bulk reconcile).
//
// Bookkeeper-gated. For supplier invoices that already exist in Xero
// (e.g. loaded by Dext during the migration, or a prior manual entry),
// the send path correctly REFUSES to create a duplicate and flags them
// 'already_in_xero'. This endpoint clears them from the active queue by
// linking each row to its real Xero bill: it looks the bill up by
// invoice number and, if found, marks the row 'forwarded' with the
// actual InvoiceID + deep link. Rows with no match in Xero are left
// untouched (skipped) — we never mark something done we can't confirm.
//
// Sequential, grouped by location so we mint one Xero token per
// location. Returns per-id outcomes + counts, same shape as the other
// bulk routes.

import { NextResponse } from 'next/server'
import { withFreshToken } from '@/lib/xero/client'
import { findXeroBillByNumber, xeroBillDeepLink } from '@/lib/invoices-queue/push-xero'
import {
  BulkIdsSchema,
  loadBookkeeper,
  loadAndScopeBulkRows,
} from '../_bulk-helpers'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ELIGIBLE = new Set(['extracted', 'data_approved'])

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
      select: 'id, location_id, status, extracted_fields, xero_bill_id',
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
  const { rowsById, missingIds, forbiddenIds } = scoped

  const results = []
  for (const id of missingIds) results.push({ id, outcome: 'skipped', reason: 'not_found' })
  for (const id of forbiddenIds) results.push({ id, outcome: 'skipped', reason: 'forbidden' })

  // Group eligible rows by location so we fetch one Xero token each.
  const byLocation = new Map()
  for (const id of ids) {
    const row = rowsById[id]
    if (!row) continue
    if (!ELIGIBLE.has(row.status)) {
      results.push({ id, outcome: 'skipped', reason: `wrong_status:${row.status}` })
      continue
    }
    const num = row.extracted_fields?.invoice_number
    if (!num) {
      results.push({ id, outcome: 'skipped', reason: 'no_invoice_number' })
      continue
    }
    if (!byLocation.has(row.location_id)) byLocation.set(row.location_id, [])
    byLocation.get(row.location_id).push(row)
  }

  for (const [locationId, rows] of byLocation) {
    let xfetch
    try {
      ({ xfetch } = await withFreshToken(locationId))
    } catch (e) {
      for (const row of rows) results.push({ id: row.id, outcome: 'failed', error: `xero auth: ${e?.message || e}` })
      continue
    }
    for (const row of rows) {
      try {
        const match = row.xero_bill_id
          ? { InvoiceID: row.xero_bill_id, InvoiceNumber: row.extracted_fields.invoice_number }
          : await findXeroBillByNumber(xfetch, row.extracted_fields.invoice_number)
        if (!match) {
          results.push({ id: row.id, outcome: 'skipped', reason: 'not_found_in_xero' })
          continue
        }
        const { error: updErr } = await db
          .from('invoices_queue')
          .update({
            status: 'forwarded',
            forwarded_at: new Date().toISOString(),
            xero_bill_id: match.InvoiceID,
            xero_bill_number: match.InvoiceNumber || row.extracted_fields.invoice_number,
            xero_deep_link_url: xeroBillDeepLink(match.InvoiceID),
            xero_synced_at: new Date().toISOString(),
            xero_error: null,
            data_reviewed_at: new Date().toISOString(),
            data_reviewed_by: user.id,
          })
          .eq('id', row.id)
          .in('status', ['extracted', 'data_approved'])
        if (updErr) {
          results.push({ id: row.id, outcome: 'failed', error: updErr.message })
          continue
        }
        results.push({ id: row.id, outcome: 'linked', bill_id: match.InvoiceID })
      } catch (e) {
        results.push({ id: row.id, outcome: 'failed', error: e?.message || String(e) })
      }
    }
  }

  const counts = results.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1
    return acc
  }, {})

  return NextResponse.json({ success: true, data: { results, counts } })
}
