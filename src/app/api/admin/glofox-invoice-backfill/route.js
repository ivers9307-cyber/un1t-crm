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
  //
  // PIPELINE5.5j fix: PostgREST caps any single response at the
  // project's db-max-rows (1000 for our project). Loading 8,129
  // contacts via a single .select() silently truncated to 1000 —
  // and without an .order() the slice was non-deterministic, so
  // run-to-run upsert counts varied (605, 320, ...) for the same
  // 2042 transactions. Page through with .range() up to a 20k
  // hard ceiling, ordered by id for deterministic chunks.
  const PAGE_SIZE = 1000
  const HARD_LIMIT = 20_000
  const contactByGlofoxId = new Map()
  let pageStart = 0
   
  while (true) {
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('contacts')
      .select('id, glofox_member_id')
      .eq('location_id', locationId)
      .not('glofox_member_id', 'is', null)
      .order('id', { ascending: true })
      .range(pageStart, pageEnd)
    if (error) {
      console.warn('[glofox-invoice-backfill] contact-page load failed', { err: error.message, page_start: pageStart })
      break
    }
    if (!Array.isArray(page) || page.length === 0) break
    for (const r of page) {
      contactByGlofoxId.set(String(r.glofox_member_id), r.id)
    }
    if (page.length < PAGE_SIZE) break
    if (contactByGlofoxId.size >= HARD_LIMIT) break
    pageStart += PAGE_SIZE
  }
  console.log('[glofox-invoice-backfill] contact lookup map built', {
    entries: contactByGlofoxId.size,
  })

  // PIPELINE5.5g: log the first transaction's shape so we can see
  // which fields actually carry the member/customer ID. The spec's
  // documented Transaction schema has only `sold_by_user_id`
  // (staff) and no customer ID at all — but the actual API
  // response often includes more fields. Surface them once.
  const firstSampleKeys = transactions[0] && typeof transactions[0] === 'object'
    ? Object.keys(transactions[0])
    : []
  const firstSampleJson = transactions[0]
    ? JSON.stringify(transactions[0]).slice(0, 1500)
    : null
  console.log('[glofox-invoice-backfill] first transaction shape', {
    keys: firstSampleKeys,
    sample: firstSampleJson,
  })

  // Walk every transaction, upsert + collect affected contact_ids
  // so we can batch the LTV recompute at the end.
  let upserted = 0
  const failed = []
  const affectedContactIds = new Set()
  for (const t of transactions) {
    // PIPELINE5.5h: real /Analytics/report TransactionsList shape
    // (sample we saw on 2026-05-12):
    //
    //   {"StripeCharge": {
    //     "_id": "...", "id": "164025531",
    //     "transaction_status": "PAID", "status": "paid",
    //     "amount": 199, "currency": "eur",
    //     "invoice_id": "cc6174c1-...-2f2e2fd003",
    //     "customer": "10674006",
    //     "created": "2026-05-12 20:20:22",      <- space, not T
    //     "modified": "2026-05-12 20:20:27",
    //     "metadata": {
    //       "user_id": "61ae263ed166e80fbf1a75fe",  <- THIS is the member id
    //       "user_name": "Rebecca Kerr",
    //       "payment_method": "credit_card",
    //       "namespace": "untstillorgan",
    //       "branch_id": "...",
    //       "glofox_event": "subscription_payment",
    //       ...
    //     },
    //     "amount_refunded": 0,
    //     "description": "The Monthly Membership (€99 first month)"
    //   }}
    //
    // Other envelopes likely exist for other payment methods
    // (CashCharge / RevolutCharge / DirectDebitCharge etc) — unwrap
    // any single-key wrapper whose inner value has metadata.
    let txn = t
    if (t && typeof t === 'object') {
      const keys = Object.keys(t)
      if (keys.length === 1) {
        const inner = t[keys[0]]
        if (inner && typeof inner === 'object' && inner.metadata) {
          txn = inner
        }
      }
    }
    const meta = (txn && typeof txn.metadata === 'object') ? txn.metadata : {}

    // Prefer invoice_id (UUID, stable) over the incremental int id —
    // re-runs of the backfill upsert by id, so a stable PK matters.
    const invoiceId = txn.invoice_id || txn._id || txn.id || null

    // Customer/member id: metadata.user_id is the canonical Glofox
    // member id (matches contacts.glofox_member_id). The top-level
    // `customer` field is a Stripe customer id, not useful for us.
    const memberId = meta.user_id || null

    // Amount: based on a sample with description "Monthly Membership
    // (€99 first month)" + amount=199 + plausible UN1T pricing, the
    // value is in MAJOR units (euros), not Stripe-style cents.
    // Multiply by 100 to match parseInvoicePayload's cents convention.
    // If a future audit shows amounts are 100× too high, drop the
    // *100. Currently safer to over-count than under-count — under-
    // count would silently suppress the "paid in last 60d"
    // engagement signal.
    const amountMajor = Number.isFinite(txn.amount) ? Number(txn.amount) : 0
    const amountAsCents = Math.round(amountMajor * 100)

    // Status: prefer transaction_status (uppercase per spec). Fall
    // back to the lowercase status. parseInvoicePayload uppercases.
    const status = String(txn.transaction_status || txn.status || 'PAID')

    // Dates arrive as "YYYY-MM-DD HH:mm:ss" without ISO T separator.
    // new Date() parses this OK in V8 but to be safe convert to ISO.
    const isoise = (s) => {
      if (!s || typeof s !== 'string') return null
      // Already has T? leave alone.
      if (s.includes('T')) return s
      return s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z')
    }

    const normalised = {
      Payload: {
        id: invoiceId,
        user: {
          id: memberId,
          email: null, // not present per-transaction; map via member_id
        },
        total: amountAsCents,
        currency: txn.currency || 'eur',
        status,
        payment_method: meta.payment_method || null,
        document_type: meta.glofox_event || null,
        date: isoise(txn.created) || isoise(txn.modified) || null,
        line_items: [],
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

  // PIPELINE5.5i: aggregate stats on what we missed. Operator
  // pushed back on the 1437 skipped count — 8,130 contacts were
  // imported, supposedly every member ever, so a 70% miss rate
  // means either the import skipped some members or transactions
  // exist for IDs we don't have. Surface enough to diagnose.
  const missedReasons = {}
  const missedUserIds = new Set()
  for (const f of failed) {
    missedReasons[f.reason] = (missedReasons[f.reason] || 0) + 1
    if (f.user_id) missedUserIds.add(String(f.user_id))
  }

  return NextResponse.json({
    ok: true,
    since_iso: sinceIso,
    fetched: transactions.length,
    upserted,
    contacts_updated: aggsUpdated,
    skipped: failed.length,
    skipped_reasons: missedReasons,
    distinct_missed_user_ids: missedUserIds.size,
    missed_user_id_sample: Array.from(missedUserIds).slice(0, 50),
    failed_sample: failed.slice(0, 20),
    // PIPELINE5.5g: surface the first transaction's shape so the
    // operator can see exactly what fields the API returned and we
    // can update the normaliser if Glofox uses unexpected names.
    first_transaction_keys: firstSampleKeys,
    first_transaction_sample: firstSampleJson,
  })
}
