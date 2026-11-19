// ORDERSVIEW.1 — Orders PR 5 of the step 4 design: one owner view across every
// kind of order. Totals by kind and studio, and the refunds behind them.
//
// Pure where it can be: summariseOrders turns order rows into totals, and the
// loader only reads, paginated under PostgREST's 1,000-row cap.

export const SUMMARY_PAGE = 1000
export const SUMMARY_MAX_ROWS = 20_000
export const RECENT_REFUNDS = 25

/**
 * Totals per studio and kind. Only completed and refunded orders count as
 * money taken; `refunded_cents` is what has gone back, `net_cents` what is
 * kept. Currencies are kept apart, never added together.
 * @param {Array<{ location_id: string, source_type: string, status: string, amount_cents: number, refunded_amount_cents: number|null, currency: string|null }>} rows
 */
export function summariseOrders(rows) {
  const groups = new Map()
  for (const r of rows || []) {
    if (r.status !== 'completed' && r.status !== 'refunded') continue
    const currency = r.currency || 'EUR'
    const key = `${r.location_id}|${r.source_type}|${currency}`
    let g = groups.get(key)
    if (!g) {
      g = { location_id: r.location_id, source_type: r.source_type, currency, orders: 0, gross_cents: 0, refunded_cents: 0, net_cents: 0 }
      groups.set(key, g)
    }
    const amount = Number(r.amount_cents) || 0
    const refunded = Math.min(amount, Number(r.refunded_amount_cents) || (r.status === 'refunded' ? amount : 0))
    g.orders += 1
    g.gross_cents += amount
    g.refunded_cents += refunded
    g.net_cents += amount - refunded
  }
  return [...groups.values()].sort((a, b) => b.gross_cents - a.gross_cents)
}

/**
 * @param {object} db  service-role client
 * @param {{ locationId: string|null, from?: string|null, to?: string|null }} scope
 *   locationId null = every studio (masters only; the route decides)
 */
export async function loadOrdersSummary(db, { locationId, from = null, to = null }) {
  const rows = []
  let truncated = false
  for (let start = 0; ; start += SUMMARY_PAGE) {
    let q = db.from('orders')
      .select('id, location_id, source_type, status, amount_cents, refunded_amount_cents, currency')
      .in('status', ['completed', 'refunded'])
    if (locationId) q = q.eq('location_id', locationId)
    if (from) q = q.gte('created_at', from)
    if (to) q = q.lte('created_at', to)
    const { data, error } = await q.order('created_at', { ascending: false }).order('id', { ascending: true }).range(start, start + SUMMARY_PAGE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < SUMMARY_PAGE) break
    if (rows.length >= SUMMARY_MAX_ROWS) { truncated = true; break }
  }

  let rq = db.from('order_refunds')
    .select('id, order_id, location_id, amount_cents, currency, reason, status, provider, is_full, error, created_at, finished_at, order:orders!order_id ( id, source_type, contact_name, contact_email )')
  if (locationId) rq = rq.eq('location_id', locationId)
  if (from) rq = rq.gte('created_at', from)
  if (to) rq = rq.lte('created_at', to)
  const { data: refunds, error: refundErr } = await rq.order('created_at', { ascending: false }).limit(RECENT_REFUNDS)
  if (refundErr) throw refundErr

  const locationIds = [...new Set(rows.map((r) => r.location_id))]
  let studios = []
  if (locationIds.length) {
    const { data, error } = await db.from('locations').select('id, name').in('id', locationIds)
    if (error) throw error
    studios = data || []
  }

  return {
    totals: summariseOrders(rows),
    studios,
    refunds: (refunds || []).map((r) => ({
      ...r,
      // A refund Revolut declined after it was recorded (REFUNDCONFIRM.1).
      declined: typeof r.error === 'string' && r.error.startsWith('revolut_declined'),
    })),
    truncated,
  }
}
