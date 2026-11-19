// GET /api/orders/summary — ORDERSVIEW.1 (Orders PR 5 of the step 4 design).
//
// Totals by kind of order and studio (orders taken, gross, refunded, kept)
// and the most recent refunds, for the Orders page. Same gate as the list
// (GET /api/orders): Manager+ with the `orders` permission, scoped to the
// active studio; a master with no active studio sees every studio.
//
// Query: from / to (ISO), filter on created_at.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { loadOrdersSummary } from '@/lib/orders-summary'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const isoOrNull = (v) => (v && !Number.isNaN(Date.parse(v)) ? v : null)

export const GET = withAuth(
  { permission: 'orders', location: false, roles: MANAGER_ROLES },
  async ({ user, db, request }) => {
    const locationId = user.activeLocation?.id || null
    if (!locationId && user.role !== 'master') {
      return NextResponse.json({ success: true, data: { totals: [], studios: [], refunds: [], truncated: false } })
    }
    const url = new URL(request.url)
    try {
      const data = await loadOrdersSummary(db, {
        locationId,
        from: isoOrNull(url.searchParams.get('from')),
        to: isoOrNull(url.searchParams.get('to')),
      })
      return NextResponse.json({ success: true, data })
    } catch (err) {
      logError('orders-summary', 'summary unreadable', { err, locationId })
      return NextResponse.json({ success: false, error: 'Could not load the totals. Try again.' }, { status: 503 })
    }
  },
)
