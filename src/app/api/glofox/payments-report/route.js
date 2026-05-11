// /api/glofox/payments-report — pull studio transactions for revenue
// reconciliation (GLOFOX2.1.19 — Tier 3 #9).
//
// Master-only. Wraps POST /Analytics/report with TransactionsList
// model. Returns raw Glofox response so the operator can inspect
// the data shape — particularly the ReportByMembers=true variant,
// which the public spec doesn't document. Once we know the
// per-member shape we can design proper LTV aggregates as a
// follow-up commit.
//
// Query params:
//   location_id  optional   defaults to user.activeLocation
//   start        optional   Unix seconds — defaults to 30 days ago
//   end          optional   Unix seconds — defaults to now
//   by_members   optional   'true' or 'false' (default false)
//   payment_methods  optional   comma-separated list (e.g. 'card,direct_debit')

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { glofoxCredentialsForLocation, fetchPaymentsReport } from '@/lib/glofox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id || null
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({
      ok: false,
      error: 'Provide ?location_id=<uuid> or set an active location',
    }, { status: 400 })
  }

  const start = url.searchParams.get('start')
  const end = url.searchParams.get('end')
  const byMembers = url.searchParams.get('by_members') === 'true'
  const paymentMethodsRaw = url.searchParams.get('payment_methods')
  const paymentMethods = paymentMethodsRaw
    ? paymentMethodsRaw.split(',').map(id => ({ id: id.trim() })).filter(p => p.id)
    : null

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json({
      ok: false,
      error: 'Glofox credentials not configured for this location.',
    }, { status: 400 })
  }

  const result = await fetchPaymentsReport(creds, {
    start: start ? Number(start) : undefined,
    end:   end   ? Number(end)   : undefined,
    byMembers,
    paymentMethods,
  })

  // Lightweight summary computed from TransactionsList shape (default
  // when by_members=false). When by_members=true the shape is
  // unknown — operator inspects the raw body.
  let summary = null
  const txs = result.body?.TransactionsList?.details
  if (Array.isArray(txs)) {
    let totalAmount = 0
    let totalPaid = 0
    let totalRefunded = 0
    const byStatus = {}
    const byMethod = {}
    for (const t of txs) {
      const amt = Number(t.amount) || 0
      totalAmount += amt
      if (t.paid === true) totalPaid += amt
      if (t.transaction_status === 'REFUNDED' || t.transaction_status === 'PARTIAL_REFUNDED') {
        totalRefunded += amt
      }
      byStatus[t.transaction_status || 'unknown'] = (byStatus[t.transaction_status || 'unknown'] || 0) + 1
      const method = t.metadata?.payment_method || 'unknown'
      byMethod[method] = (byMethod[method] || 0) + amt
    }
    summary = {
      transaction_count: txs.length,
      total_amount: totalAmount,
      total_paid: totalPaid,
      total_refunded: totalRefunded,
      currency: txs[0]?.currency || null,
      by_status: byStatus,
      by_method: byMethod,
    }
  }

  return NextResponse.json({
    ok: result.ok,
    glofox_status: result.status,
    location_id: locationId,
    branch_id: creds.branchId,
    request_body: result.request_body,
    summary,
    response_body: result.body,
  })
}
