// /api/glofox/reconcile-arrears — backfill historical PAST_DUE invoices that
// predate the INVOICE_UPDATED webhook coverage (~12 May 2026), so the
// invoice-driven Overdue feature reflects true balances. (ARREARS-RECONCILE.1)
//
// Master-only. DRY-RUN BY DEFAULT — returns exactly what it WOULD insert and
// writes nothing. Pass ?commit=true to actually upsert the candidate rows.
//
// Flow: pull the Glofox /Analytics/report (TransactionsList) back to `start`,
// group transactions by invoice_id, drop any invoice with a settled/forgiven
// txn, value the rest from amount/failed_amount, diff against the invoice ids
// already in glofox_invoices, and (on commit) upsert the missing ones as
// PAST_DUE keyed on invoice_id so a later webhook dedupes cleanly.
//
// Query params:
//   location_id  optional  defaults to user.activeLocation
//   start        optional  Unix seconds — defaults to 1 Jan 2026
//   end          optional  Unix seconds — defaults to now
//   before       optional  ISO date (YYYY-MM-DD) — only backfill invoices first
//                          seen strictly before this (e.g. 2026-05-12 to limit
//                          to pre-webhook arrears). Omit to include all missing.
//   commit       optional  'true' to write; anything else = dry run
//   limit        optional  cap candidates written on commit (safety valve)

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { glofoxCredentialsForLocation, fetchPaymentsReport } from '@/lib/glofox'
import { computeArrears } from '@/lib/glofox-arrears'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const JAN_1_2026 = 1767225600 // Unix seconds, 2026-01-01T00:00:00Z

async function fetchAllInvoiceIds(db) {
  // Global dedup: glofox_invoices.id is the PK, so an id present under ANY
  // location must not be re-inserted. Paginate (PostgREST caps at 1000).
  const ids = new Set()
  const PAGE = 1000
  const HARD = 50000
  let pageStart = 0
  while (true) {
    const { data, error } = await db
      .from('glofox_invoices')
      .select('id')
      .order('id', { ascending: true })
      .range(pageStart, pageStart + PAGE - 1)
    if (error) throw new Error(`glofox_invoices read failed: ${error.message}`)
    if (!Array.isArray(data) || data.length === 0) break
    for (const r of data) ids.add(r.id)
    if (data.length < PAGE || ids.size >= HARD) break
    pageStart += PAGE
  }
  return ids
}

async function resolveContactIds(db, locationId, glofoxUserIds) {
  const map = new Map()
  const unique = [...new Set(glofoxUserIds.filter(Boolean))]
  const CHUNK = 300
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK)
    const { data, error } = await db
      .from('contacts')
      .select('id, glofox_member_id')
      .eq('location_id', locationId)
      .in('glofox_member_id', chunk)
    if (error) throw new Error(`contacts read failed: ${error.message}`)
    for (const r of data || []) if (r.glofox_member_id) map.set(r.glofox_member_id, r.id)
  }
  return map
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id || null
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json(
      { ok: false, error: 'Provide ?location_id=<uuid> or set an active location' },
      { status: 400 },
    )
  }

  const startRaw = url.searchParams.get('start')
  const endRaw = url.searchParams.get('end')
  const beforeDate = url.searchParams.get('before') || undefined
  const commit = url.searchParams.get('commit') === 'true'
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw ? Math.max(0, Number(limitRaw) || 0) : null

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json(
      { ok: false, error: 'Glofox credentials not configured for this location.' },
      { status: 400 },
    )
  }

  const report = await fetchPaymentsReport(creds, {
    start: startRaw ? Number(startRaw) : JAN_1_2026,
    end: endRaw ? Number(endRaw) : undefined,
  })
  if (!report.ok) {
    return NextResponse.json(
      { ok: false, error: 'Glofox report fetch failed', glofox_status: report.status },
      { status: 502 },
    )
  }

  const details = report.body?.TransactionsList?.details
  if (!Array.isArray(details)) {
    return NextResponse.json(
      { ok: false, error: 'Report returned no TransactionsList.details array', glofox_status: report.status },
      { status: 502 },
    )
  }

  let existingInvoiceIds
  try {
    existingInvoiceIds = await fetchAllInvoiceIds(db)
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 })
  }

  const analysis = computeArrears(details, { existingInvoiceIds, beforeDate })

  // Resolve candidate members → contact_id so the dry-run shows match rate and
  // commit can link the rows.
  let contactByUser
  try {
    contactByUser = await resolveContactIds(
      db,
      locationId,
      analysis.candidates.map((c) => c.glofoxUserId),
    )
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 })
  }
  const matchedCandidates = analysis.candidates.filter((c) => contactByUser.has(c.glofoxUserId)).length

  const base = {
    ok: true,
    location_id: locationId,
    branch_id: creds.branchId,
    glofox_status: report.status,
    params: {
      start: startRaw ? Number(startRaw) : JAN_1_2026,
      end: endRaw ? Number(endRaw) : null,
      before: beforeDate || null,
      limit,
    },
    totals: analysis.totals,
    taxonomy: analysis.taxonomy,
    candidates_by_event: analysis.candidatesByEvent,
    candidate_arrears_cents: analysis.candidateArrearsCents,
    contact_match: {
      candidates: analysis.candidates.length,
      matched: matchedCandidates,
      unmatched: analysis.candidates.length - matchedCandidates,
    },
    by_member: analysis.byMember,
    warnings: analysis.warnings,
  }

  if (!commit) {
    return NextResponse.json({
      ...base,
      dry_run: true,
      candidates: analysis.candidates,
    })
  }

  // ── Commit path ──────────────────────────────────────────────────────────
  const toWrite = limit != null ? analysis.candidates.slice(0, limit) : analysis.candidates
  const backfilledAt = new Date().toISOString()
  const rows = toWrite.map((c) => ({
    id: c.invoiceId,
    contact_id: contactByUser.get(c.glofoxUserId) || null,
    location_id: locationId,
    glofox_user_id: c.glofoxUserId,
    amount_cents: c.amountCents,
    currency: (c.currency || 'eur').toLowerCase(),
    status: 'PAST_DUE',
    payment_method: c.paymentMethod,
    document_type: null,
    line_item_subtypes: null,
    invoice_date: c.invoiceDate,
    raw_payload: { source: 'reconcile-arrears', backfilled_at: backfilledAt, candidate: c },
    updated_at: backfilledAt,
  }))

  let inserted = 0
  const errors = []
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    // ignoreDuplicates: never clobber a webhook-written row that appeared
    // between the dedup read and this write.
    const { data, error } = await db
      .from('glofox_invoices')
      .upsert(chunk, { onConflict: 'id', ignoreDuplicates: true })
      .select('id')
    if (error) {
      errors.push(error.message)
      continue
    }
    inserted += Array.isArray(data) ? data.length : 0
  }

  return NextResponse.json({
    ...base,
    dry_run: false,
    committed: true,
    attempted: rows.length,
    inserted,
    errors,
  })
}
