// POST /api/admin/glofox-invoice-backfill  (PIPELINE5.5)
//
// One-shot backfill that pulls Glofox payment transactions since
// a configurable cutoff and:
//   1. Parses each transaction into the same shape we'd get from
//      a webhook INVOICE_UPDATED payload.
//   2. Maps the transaction's user_id to a CRM contact via
//      contacts.glofox_member_id.
//   3. Upserts into glofox_invoices.
//   4. Recomputes contacts.lifetime_value_cents + last_payment_at
//      for every affected contact.
//
// Master-only. Runs synchronously inside a single Vercel request
// (60s ceiling). The operator-chosen Jan 2026 cutoff yields
// roughly 4-5 months of activity which should fit comfortably
// inside that window — if it doesn't, we'll add chunking in a
// follow-up.
//
// After this runs, the pipeline classifier (PIPELINE5.4) can
// finally use the "paid in last 60d" signal that keeps
// subscription-style members in active_member even when they
// rarely attend classes.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  glofoxCredentialsForLocation,
  fetchPaymentsReport,
} from '@/lib/glofox'
import {
  parseInvoicePayload,
  upsertGlofoxInvoice,
  recomputeContactLifetimeValue,
} from '@/lib/glofox-invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Default cutoff — the operator-requested "Jan 2026 onwards" boundary.
// Override via body.since_iso if you want a wider/narrower window.
const DEFAULT_SINCE = '2026-01-01T00:00:00Z'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  let body = {}
  try { body = await request.json() } catch { body = {} }
  const sinceIso = typeof body.since_iso === 'string' && body.since_iso
    ? body.since_iso
    : DEFAULT_SINCE
  const sinceMs = new Date(sinceIso).getTime()
  if (!Number.isFinite(sinceMs)) {
    return NextResponse.json({ ok: false, error: `Invalid since_iso: ${sinceIso}` }, { status: 400 })
  }
  const sinceSec = Math.floor(sinceMs / 1000)
  const nowSec = Math.floor(Date.now() / 1000)

  const locationId = body.location_id || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ ok: false, error: 'No active location' }, { status: 400 })
  }

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json({
      ok: false,
      error: 'Glofox credentials not configured for this location',
    }, { status: 400 })
  }

  // Pull the transactions report. Glofox's /Analytics/report can be
  // permission-gated; previous attempts under GLOFOX2.1.19 returned
  // an empty list, which is why we wired LTV via webhooks instead.
  // PIPELINE5.5d/e: now defaults to sending the full PaymentMethods
  // list per the spec example. If this STILL returns 0 we surface
  // the raw response below so we have evidence for a Glofox ticket.
  const report = await fetchPaymentsReport(creds, {
    start: sinceSec,
    end: nowSec,
    namespace: creds.namespace,
    byMembers: false,
  })

  // Always log the request + response shape to Vercel runtime logs
  // so we can validate without re-deploying with extra logging every
  // time. body keys + length only — never log the full body to keep
  // PII out of logs.
  const respBodyKeys = report.body && typeof report.body === 'object' ? Object.keys(report.body) : []
  const detailsLen = Array.isArray(report.body?.TransactionsList?.details)
    ? report.body.TransactionsList.details.length
    : null
  console.log('[glofox-invoice-backfill] /Analytics/report response', {
    ok: report.ok,
    status: report.status,
    body_keys: respBodyKeys,
    transactions_list_details_length: detailsLen,
    request_start: sinceSec,
    request_end: nowSec,
    request_window_days: Math.round((nowSec - sinceSec) / 86400),
  })

  if (!report.ok) {
    return NextResponse.json({
      ok: false,
      error: 'Glofox /Analytics/report rejected the request',
      glofox_status: report.status,
      glofox_body: report.body,
      glofox_request_body: report.request_body,
      hint: report.status === 403
        ? 'API permission scope likely still restricted. Either ask Glofox to unlock the analytics scope, or export the invoice report from the Glofox UI as CSV and import via a future CSV path.'
        : null,
    }, { status: 502 })
  }

  // The TransactionsList shape varies — be defensive about where
  // the actual transactions array sits.
  const transactions = (
    report.body?.TransactionsList?.details
    ?? report.body?.transactions
    ?? report.body?.data
    ?? []
  )
  if (!Array.isArray(transactions)) {
    return NextResponse.json({
      ok: false,
      error: 'Unexpected /Analytics/report shape — no transactions array',
      sample_keys: Object.keys(report.body || {}),
      sample_body: typeof report.body === 'object' ? JSON.stringify(report.body).slice(0, 500) : null,
      glofox_request_body: report.request_body,
    }, { status: 502 })
  }

  if (transactions.length === 0) {
    // Surface the raw Glofox response in the result so the operator
    // can see exactly what came back without grepping Vercel logs.
    // Truncate to 2KB to stay well under any payload limits.
    const rawBodyJson = (() => {
      try { return JSON.stringify(report.body) } catch { return null }
    })()
    return NextResponse.json({
      ok: true,
      since_iso: sinceIso,
      fetched: 0,
      upserted: 0,
      contacts_updated: 0,
      message: '/Analytics/report returned 0 transactions for this window. Either the studio truly had no paid invoices since the cutoff, OR the Glofox API permission scope is still restricted. The raw response + sent payload are below — share these with Glofox support if filing a ticket.',
      glofox_status: report.status,
      glofox_body_keys: respBodyKeys,
      glofox_response_raw: rawBodyJson ? rawBodyJson.slice(0, 2000) : null,
      glofox_request_body: report.request_body,
    })
  }

  // Build a glofox_user_id → contact_id lookup once. Avoids a
  // separate Supabase query for every transaction.
  const { data: contactRows } = await db
    .from('contacts')
    .select('id, glofox_member_id')
    .eq('location_id', locationId)
    .not('glofox_member_id', 'is', null)
  const contactByGlofoxId = new Map(
    (contactRows || []).map((r) => [String(r.glofox_member_id), r.id]),
  )

  // Walk every transaction, upsert + collect affected contact_ids
  // so we can batch the LTV recompute at the end.
  let upserted = 0
  const failed = []
  const affectedContactIds = new Set()
  for (const t of transactions) {
    // Glofox's TransactionsList items use a different shape from
    // the webhook InvoiceEvent. Normalise into the webhook shape
    // first so parseInvoicePayload + upsertGlofoxInvoice work.
    //
    // Best-guess mapping based on the InvoiceEvent spec — fields
    // that look reasonable: id, user{id,email}, total/amount,
    // currency, status, payment_method, document_type, date.
    const normalised = {
      Payload: {
        id: t.id || t.invoice_id || t.transaction_id || null,
        user: {
          id: t.user_id || t.user?.id || null,
          email: t.user_email || t.user?.email || null,
        },
        total: Number(t.total ?? t.amount ?? 0),
        currency: t.currency || 'eur',
        status: String(t.status || 'PAID').toUpperCase(),
        payment_method: t.payment_method || null,
        document_type: t.document_type || null,
        date: t.date || t.created || null,
        line_items: t.line_items || [],
      },
    }
    const parsed = parseInvoicePayload(normalised)
    if (!parsed) {
      failed.push({ id: t.id || null, reason: 'unparseable' })
      continue
    }
    const contactId = parsed.glofox_user_id
      ? contactByGlofoxId.get(String(parsed.glofox_user_id))
      : null
    if (!contactId) {
      failed.push({ id: parsed.id, reason: 'no_matching_contact', user_id: parsed.glofox_user_id })
      continue
    }
    const upsert = await upsertGlofoxInvoice(db, locationId, contactId, parsed, normalised)
    if (!upsert.ok) {
      failed.push({ id: parsed.id, reason: 'upsert_failed', error: upsert.error })
      continue
    }
    upserted++
    affectedContactIds.add(contactId)
  }

  // Recompute LTV per affected contact. Sequential — avoids
  // hammering the contacts table with parallel updates. ~50ms
  // each so 500 contacts is ~25 seconds, well under the 60s
  // ceiling for the operator's 5-month window.
  let aggsUpdated = 0
  for (const contactId of affectedContactIds) {
    const aggs = await recomputeContactLifetimeValue(db, contactId)
    if (aggs) aggsUpdated++
  }

  return NextResponse.json({
    ok: true,
    since_iso: sinceIso,
    fetched: transactions.length,
    upserted,
    contacts_updated: aggsUpdated,
    skipped: failed.length,
    failed_sample: failed.slice(0, 20),
  })
}
