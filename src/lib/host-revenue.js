// Host revenue reporting (EVENTS-HOST.8).
//
// A read-only rollup of what an event host has earned through UN1T: gross
// collected from ticket buyers, the per-ticket booking fee UN1T kept, the net
// that settles to the host, and refunds. Reads the marketplace columns written
// by createRacePayment (mig 381): amount_cents = gross (ticket + fee),
// application_fee_cents = UN1T's take, net_to_host_cents = the host's ticket
// portion — so gross = fee + net per row. Revolut/internal hosts have NULL
// fee/net (treated as 0), so their card shows gross only.

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }

/**
 * Pure aggregation — no DB. Sums settled (completed | refunded) payments into
 * grand totals + a per-event breakdown. Kept separate so it unit-tests without
 * a database.
 *
 * @param {Array<{race_event_id:string, amount_cents:number, application_fee_cents:number|null, net_to_host_cents:number|null, refunded_amount_cents:number|null, status:string, currency?:string}>} payments
 * @param {Array<{id:string, name:string, race_date:string|null}>} [events]
 * @returns {{ currency:string, totals:object, perEvent:Array<object> }}
 */
export function aggregateHostRevenue(payments, events = []) {
  const eventById = new Map((events || []).map((e) => [e.id, e]))
  const perEvent = new Map()
  const totals = { paidCount: 0, gross_cents: 0, fee_cents: 0, net_to_host_cents: 0, refunded_cents: 0 }
  let currency = null

  for (const p of (payments || [])) {
    // Only settled money counts — pending/failed/abandoned/cancelled never
    // moved funds. A partially-refunded row stays 'completed'; a fully-refunded
    // one is 'refunded'. Both count toward gross, with refunds tracked apart.
    if (p.status !== 'completed' && p.status !== 'refunded') continue
    if (!currency && p.currency) currency = p.currency
    const gross = num(p.amount_cents)
    const fee = num(p.application_fee_cents)
    const net = num(p.net_to_host_cents)
    const refunded = num(p.refunded_amount_cents)

    totals.paidCount += 1
    totals.gross_cents += gross
    totals.fee_cents += fee
    totals.net_to_host_cents += net
    totals.refunded_cents += refunded

    const key = p.race_event_id || 'unknown'
    if (!perEvent.has(key)) {
      const ev = eventById.get(key)
      perEvent.set(key, {
        event_id: key,
        name: ev?.name || 'Unknown event',
        race_date: ev?.race_date || null,
        paidCount: 0, gross_cents: 0, fee_cents: 0, net_to_host_cents: 0, refunded_cents: 0,
      })
    }
    const row = perEvent.get(key)
    row.paidCount += 1
    row.gross_cents += gross
    row.fee_cents += fee
    row.net_to_host_cents += net
    row.refunded_cents += refunded
  }

  // Net actually collected after refunds — the honest "money that stayed".
  totals.net_collected_cents = totals.gross_cents - totals.refunded_cents
  const perEventArr = [...perEvent.values()].sort(
    (a, b) => String(b.race_date || '').localeCompare(String(a.race_date || '')),
  )
  return { currency: currency || 'EUR', totals, perEvent: perEventArr }
}

/**
 * Fetch + aggregate a host's revenue. Two steps to sidestep the embedded-filter
 * gotcha and the 1000-row cap: (1) the host's events (few per host), (2) their
 * settled payments, range-paginated. Service-role client.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string} hostId
 */
export async function getHostRevenue(db, hostId) {
  const { data: events, error: evErr } = await db
    .from('race_events')
    .select('id, name, race_date')
    .eq('host_id', hostId)
  if (evErr) throw new Error(`host revenue: events query failed: ${evErr.message}`)
  const eventIds = (events || []).map((e) => e.id)
  if (eventIds.length === 0) return aggregateHostRevenue([], [])

  const payments = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('race_payments')
      .select('race_event_id, amount_cents, application_fee_cents, net_to_host_cents, refunded_amount_cents, status, currency')
      .in('race_event_id', eventIds)
      .in('status', ['completed', 'refunded'])
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`host revenue: payments query failed: ${error.message}`)
    payments.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return aggregateHostRevenue(payments, events)
}
