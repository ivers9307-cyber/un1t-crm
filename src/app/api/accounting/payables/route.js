// src/app/api/accounting/payables/route.js
//
// Aged payables for the active location — who we owe and how overdue.
// Live pull from Xero (unpaid supplier bills), always fresh, no cached
// table. Guards: session -> accounting_hub -> active location -> that
// location's Xero connection. Scope accounting.invoices (already held).
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { withFreshToken, XeroError } from '@/lib/xero/client'
import { mapPayableInvoices, agePayables } from '@/lib/xero/aged-payables'
import { dublinTodayStr } from '@/lib/dublin-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_PAGES = 30 // × 100/page — 3,000 open bills is far beyond expectation

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'accounting_hub')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  try {
    const { xfetch } = await withFreshToken(locationId)
    // Unpaid, approved supplier bills. Server-side `where` keeps the
    // payload small; pagination at Xero's 100/page. NO `order` (Xero's
    // order field is the raw name e.g. `DueDate`, NOT `DueDateString` —
    // an invalid order field 400s) and NO `summaryOnly` (keep the full,
    // reliable payload) — agePayables sorts client-side anyway.
    const where = encodeURIComponent('Type=="ACCPAY" AND Status=="AUTHORISED"')
    const rows = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await xfetch(`/Invoices?where=${where}&page=${page}`)
      const mapped = mapPayableInvoices(res)
      rows.push(...mapped)
      const rawCount = Array.isArray(res?.Invoices) ? res.Invoices.length : 0
      if (rawCount < 100) break
      if (page === MAX_PAGES) {
        console.error(`[accounting/payables] ${locationId}: hit MAX_PAGES — list truncated`)
      }
    }

    const aged = agePayables(rows, dublinTodayStr())
    return NextResponse.json({ success: true, data: { ...aged, asOf: dublinTodayStr() } })
  } catch (e) {
    // Surface the REAL cause — never blanket-label an API error as
    // "not connected" (that masked a bad `order` field as a missing
    // connection). Branch on the machine-readable .status / the
    // withFreshToken no-connection message.
    if (e instanceof XeroError) {
      const status = e.status
      if (/No Xero connection/i.test(String(e.message))) {
        return NextResponse.json(
          { success: false, error: 'Xero is not connected for this location — connect it in Settings first.' },
          { status: 409 }
        )
      }
      if (status === 401) {
        return NextResponse.json(
          { success: false, error: 'Xero session expired — reconnect Xero in Settings.' },
          { status: 409 }
        )
      }
      if (status === 403) {
        return NextResponse.json(
          { success: false, error: 'Xero connection is missing the invoices permission — reconnect Xero in Settings to grant it.' },
          { status: 409 }
        )
      }
      // Any other Xero API failure: report it as an upstream error with
      // the actual message so it's diagnosable, not disguised.
      console.error('[accounting/payables] Xero error:', status, e.message)
      return NextResponse.json(
        { success: false, error: `Xero error${status ? ` (${status})` : ''}: ${e.message}` },
        { status: 502 }
      )
    }
    throw e
  }
}
