// POST /api/admin/glofox-invoice-csv-import  (PIPELINE5.5b)
//
// CSV fallback for the invoice backfill. Glofox's /Analytics/report
// returned 0 transactions even after webhooks were enabled — most
// likely the analytics scope is still permission-locked at Glofox's
// end. So the operator exports invoices from the Glofox UI as CSV
// and uploads them here.
//
// Flow:
//   1. Multipart upload — operator selects the Glofox CSV.
//   2. Parse with the inline csv-parse helper (zero-dep).
//   3. Defensively map columns by name (lots of variants seen in
//      Glofox exports).
//   4. Match each row to a CRM contact via email (preferred) or
//      glofox_member_id (if present in the export).
//   5. Upsert into glofox_invoices via the existing helpers.
//   6. Recompute lifetime_value + last_payment_at per affected
//      contact.
//
// Master only. Synchronous, 60s ceiling. A 5,000-row CSV typically
// finishes in ~30 seconds (per-row insert + the per-contact
// recompute is the slow bit).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { parseCsv } from '@/lib/csv-parse'
import {
  parseInvoicePayload,
  upsertGlofoxInvoice,
  recomputeContactLifetimeValue,
} from '@/lib/glofox-invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Header-name variants we've seen across different Glofox CSV
// exports. parseCsv normalises headers to lowercase + underscores,
// so all variants below are normalised before matching.
const COLUMN_ALIASES = {
  invoice_id:    ['invoice_id', 'id', 'invoice_number', 'invoice', 'receipt_number', 'document_number'],
  date:          ['date', 'invoice_date', 'paid_date', 'payment_date', 'created_at', 'created'],
  email:         ['email', 'member_email', 'user_email', 'customer_email'],
  member_id:     ['member_id', 'user_id', 'glofox_id', 'glofox_member_id'],
  amount:        ['amount', 'total', 'total_amount', 'gross', 'gross_amount', 'paid_amount'],
  currency:      ['currency', 'currency_code', 'ccy'],
  status:        ['status', 'invoice_status', 'payment_status'],
  payment_method:['payment_method', 'method', 'paid_via'],
  document_type: ['document_type', 'type', 'doc_type'],
  product:       ['product', 'item', 'item_name', 'description', 'membership_name'],
}

// First-match-wins lookup. Returns the value at the first matching
// alias, or '' when nothing matches.
function pick(row, key) {
  const aliases = COLUMN_ALIASES[key] || []
  for (const a of aliases) {
    if (row[a] !== undefined && row[a] !== '') return row[a]
  }
  return ''
}

// Glofox CSV exports occasionally use "€99.00" / "99.00 EUR" —
// pull out the numeric part and convert to integer cents. The
// invoice webhook helpers expect cents.
function toCents(raw) {
  if (raw == null || raw === '') return 0
  const s = String(raw).replace(/[^0-9.\-,]/g, '').replace(/,/g, '')
  const n = Number(s)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

// Tolerant date parsing — Glofox exports use multiple formats:
//   ISO   2026-05-12T14:36:09Z
//   slash 12/05/2026  or  05/12/2026 (ambiguous!)
//   word  May 12, 2026
// Returns ISO string or null. Slash-separated dates assume DD/MM/YYYY
// (UN1T is Ireland — that's the local convention).
function toIso(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  // ISO-ish — let Date constructor handle it.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  // DD/MM/YYYY (Ireland default).
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (slash) {
    let [, dd, mm, yy] = slash
    if (yy.length === 2) yy = '20' + yy
    const d = new Date(`${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  // Last-resort — let Date try.
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  // Read the multipart upload.
  let formData
  try { formData = await request.formData() } catch (e) {
    return NextResponse.json({ ok: false, error: `Bad upload: ${e.message}` }, { status: 400 })
  }
  const file = formData.get('file')
  if (!file || typeof file === 'string') {
    return NextResponse.json({ ok: false, error: 'No file in upload (expected multipart "file" field)' }, { status: 400 })
  }
  const csvText = await file.text()
  if (!csvText || !csvText.trim()) {
    return NextResponse.json({ ok: false, error: 'Uploaded file is empty' }, { status: 400 })
  }

  const locationId = formData.get('location_id') || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ ok: false, error: 'No active location' }, { status: 400 })
  }

  const { headers, rows } = parseCsv(csvText)
  if (rows.length === 0) {
    return NextResponse.json({
      ok: false,
      error: 'CSV had headers but no data rows',
      headers,
    }, { status: 400 })
  }

  const db = createServerClient()

  // Build email + glofox_member_id lookups for the location once.
  const { data: contactRows } = await db
    .from('contacts')
    .select('id, email, glofox_member_id')
    .eq('location_id', locationId)
  const contactByEmail = new Map(
    (contactRows || []).filter((r) => r.email).map((r) => [r.email.toLowerCase(), r.id]),
  )
  const contactByGlofoxId = new Map(
    (contactRows || []).filter((r) => r.glofox_member_id).map((r) => [String(r.glofox_member_id), r.id]),
  )

  let upserted = 0
  const failed = []
  const affectedContactIds = new Set()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const invoiceId = pick(row, 'invoice_id')
    const email     = pick(row, 'email').toLowerCase()
    const memberId  = pick(row, 'member_id')
    const amount    = pick(row, 'amount')
    const status    = pick(row, 'status') || 'PAID'
    const date      = pick(row, 'date')
    const currency  = pick(row, 'currency') || 'eur'
    const payMethod = pick(row, 'payment_method')
    const docType   = pick(row, 'document_type') || 'RECEIPT'

    if (!invoiceId) {
      failed.push({ row: i + 2, reason: 'no_invoice_id' })
      continue
    }
    const contactId = (memberId && contactByGlofoxId.get(String(memberId)))
      || (email && contactByEmail.get(email))
      || null
    if (!contactId) {
      failed.push({ row: i + 2, reason: 'no_matching_contact', invoice_id: invoiceId, email, member_id: memberId })
      continue
    }

    // Build the InvoiceEvent shape the existing parser expects.
    const normalised = {
      Payload: {
        id: String(invoiceId),
        user: { id: memberId || null, email: email || null },
        total: toCents(amount),
        currency: String(currency).toLowerCase(),
        status: String(status).toUpperCase(),
        payment_method: payMethod || null,
        document_type: docType || null,
        date: toIso(date),
        line_items: [],
      },
    }
    const parsed = parseInvoicePayload(normalised)
    if (!parsed) {
      failed.push({ row: i + 2, reason: 'unparseable', invoice_id: invoiceId })
      continue
    }
    // toCents already converted; the parser trusts Payload.total
    // directly so no double-conversion happens.
    parsed.amount_cents = toCents(amount)

    const upsert = await upsertGlofoxInvoice(db, locationId, contactId, parsed, normalised)
    if (!upsert.ok) {
      failed.push({ row: i + 2, reason: 'upsert_failed', error: upsert.error, invoice_id: invoiceId })
      continue
    }
    upserted++
    affectedContactIds.add(contactId)
  }

  // Recompute LTV per affected contact. ~50ms each — bounded by
  // the number of distinct contacts, not the number of rows.
  let aggsUpdated = 0
  for (const contactId of affectedContactIds) {
    const aggs = await recomputeContactLifetimeValue(db, contactId)
    if (aggs) aggsUpdated++
  }

  return NextResponse.json({
    ok: true,
    headers,
    fetched: rows.length,
    upserted,
    contacts_updated: aggsUpdated,
    skipped: failed.length,
    failed_sample: failed.slice(0, 30),
    detected_columns: detectColumnMapping(headers),
  })
}

// Returns a { canonical → matched_header_or_null } map so the
// operator can verify the parser found the columns it expected.
function detectColumnMapping(headers) {
  const normalised = headers.map((h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''))
  const out = {}
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    let found = null
    for (const a of aliases) {
      const idx = normalised.indexOf(a)
      if (idx !== -1) { found = headers[idx]; break }
    }
    out[canonical] = found
  }
  return out
}
