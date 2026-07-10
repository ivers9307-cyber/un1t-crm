// GET /api/host/statements — monthly statements for the logged-in host
// (HOST-PORTAL.13).
//
// Two modes on one route:
//   - no ?month        → JSON { months: ['2026-07', ...] } — the months with
//                        settled activity across the host's events (drives the
//                        portal's Statements list).
//   - ?month=YYYY-MM   → the statement CSV download for that month (BOM +
//                        attachment headers, mirroring attendeeCsvResponse).
//
// Tenancy: getCurrentHost() → the host's OWN events only (.eq host_id); the
// month window is [month-01, next-month-01) on created_at, matching the UTC
// string-slice month bucketing in monthsWithActivity. Settled = completed |
// refunded — same ledger semantics as host-revenue.js. Both payment fetches
// .range()-paginate past the 1000-row select cap.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { monthsWithActivity, buildStatementCsv } from '@/lib/host-statements'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PAGE = 1000
// UTF-8 BOM so Excel renders accented names correctly (same as attendee-export).
const BOM = '﻿'
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// Exclusive upper bound of the month window: '2026-07' → '2026-08-01',
// '2026-12' → '2027-01-01'. Pure string/number math — no Date, no TZ.
function nextMonthStart(month) {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

/** Fetch ALL settled payments for the host's events, range-paginated. */
async function fetchSettledPayments(db, eventIds, cols, month) {
  const payments = []
  for (let from = 0; ; from += PAGE) {
    let query = db
      .from('race_payments')
      .select(cols)
      .in('race_event_id', eventIds)
      .in('status', ['completed', 'refunded'])
    if (month) {
      query = query.gte('created_at', `${month}-01`).lt('created_at', nextMonthStart(month))
    }
    const { data, error } = await query
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`host statements: payments query failed: ${error.message}`)
    payments.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return payments
}

export async function GET(request) {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const month = new URL(request.url).searchParams.get('month')
  if (month && !MONTH_RE.test(month)) {
    return NextResponse.json(
      { success: false, error: 'Invalid month — expected YYYY-MM' },
      { status: 400 },
    )
  }

  const db = createServerClient()
  const { data: events, error: evErr } = await db
    .from('race_events')
    .select('id, name')
    .eq('host_id', session.host.id)
  if (evErr) {
    return NextResponse.json({ success: false, error: 'Failed to load events' }, { status: 500 })
  }
  const eventIds = (events || []).map((e) => e.id)

  try {
    // Months-list mode: created_at only — monthsWithActivity does the bucketing.
    if (!month) {
      const payments = eventIds.length === 0
        ? []
        : await fetchSettledPayments(db, eventIds, 'created_at', null)
      return NextResponse.json({ success: true, data: { months: monthsWithActivity(payments) } })
    }

    // CSV mode: the requested month's settled rows. A month with no activity
    // (or a host with no events) still downloads a valid zero-totals statement.
    const payments = eventIds.length === 0
      ? []
      : await fetchSettledPayments(
          db,
          eventIds,
          'race_event_id, amount_cents, application_fee_cents, net_to_host_cents, refunded_amount_cents, status, created_at',
          month,
        )
    const eventNameById = Object.fromEntries((events || []).map((e) => [e.id, e.name]))
    const csv = buildStatementCsv({ hostName: session.host.name, month, payments, eventNameById })

    return new Response(BOM + csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="statement-${month}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
