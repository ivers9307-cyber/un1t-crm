// Org-wide event booking fees (HOST-PORTAL.8).
//
// A read-only rollup of the per-ticket booking fee UN1T earned across ALL of
// an organisation's event hosts — the org counterpart to the per-host view in
// src/lib/host-revenue.js. Reads race_payments.application_fee_cents (mig 381):
// UN1T's take per settled payment. Revolut/internal hosts have NULL fee
// (treated as 0), so their bookings count but contribute no fee.

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }

/**
 * Pure aggregation — no DB. Sums settled (completed | refunded) payments'
 * application fees into an org total, a per-host rollup (every host included,
 * zeros and all), and per-month buckets. Kept separate so it unit-tests
 * without a database.
 *
 * @param {Array<{race_event_id:string, application_fee_cents:number|null, status:string, created_at:string}>} payments
 * @param {Array<{id:string, host_id:string}>} events
 * @param {Array<{id:string, name:string}>} hosts
 * @returns {{ total_fee_cents:number, paidCount:number, perHost:Array<object>, perMonth:Array<object> }}
 */
export function aggregateOrgEventFees(payments, events, hosts) {
  const hostIdByEventId = new Map((events || []).map((e) => [e.id, e.host_id]))
  const perHost = new Map(
    (hosts || []).map((h) => [h.id, { host_id: h.id, name: h.name, fee_cents: 0, paidCount: 0 }]),
  )
  const perMonth = new Map()
  let total_fee_cents = 0
  let paidCount = 0

  for (const p of (payments || [])) {
    // Only settled money counts — pending/failed/abandoned/cancelled never
    // moved funds. Refunded rows keep their fee (UN1T's take was collected).
    if (p.status !== 'completed' && p.status !== 'refunded') continue
    const fee = num(p.application_fee_cents)

    total_fee_cents += fee
    paidCount += 1

    const hostId = hostIdByEventId.get(p.race_event_id)
    const hostRow = perHost.get(hostId)
    if (hostRow) {
      hostRow.fee_cents += fee
      hostRow.paidCount += 1
    }

    const month = String(p.created_at || '').slice(0, 7)
    if (month) perMonth.set(month, (perMonth.get(month) || 0) + fee)
  }

  const perHostArr = [...perHost.values()].sort(
    (a, b) => (b.fee_cents - a.fee_cents) || String(a.name || '').localeCompare(String(b.name || '')),
  )
  const perMonthArr = [...perMonth.entries()]
    .map(([month, fee_cents]) => ({ month, fee_cents }))
    .sort((a, b) => b.month.localeCompare(a.month))

  return { total_fee_cents, paidCount, perHost: perHostArr, perMonth: perMonthArr }
}

/**
 * Fetch + aggregate an org's event booking fees. Steps to sidestep the
 * embedded-filter gotcha and the 1000-row cap (pattern copied from
 * getHostRevenue): (1) the org's hosts, (2) their events, (3) their settled
 * payments, range-paginated. Service-role client.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string} orgId
 */
export async function getOrgEventFees(db, orgId) {
  const { data: hosts, error: hostErr } = await db
    .from('event_hosts')
    .select('id, name')
    .eq('organization_id', orgId)
  if (hostErr) throw new Error(`org event fees: hosts query failed: ${hostErr.message}`)
  const hostIds = (hosts || []).map((h) => h.id)
  if (hostIds.length === 0) return aggregateOrgEventFees([], [], hosts || [])

  const { data: events, error: evErr } = await db
    .from('race_events')
    .select('id, host_id')
    .in('host_id', hostIds)
  if (evErr) throw new Error(`org event fees: events query failed: ${evErr.message}`)
  const eventIds = (events || []).map((e) => e.id)
  if (eventIds.length === 0) return aggregateOrgEventFees([], [], hosts || [])

  const payments = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('race_payments')
      .select('race_event_id, application_fee_cents, status, created_at')
      .in('race_event_id', eventIds)
      .in('status', ['completed', 'refunded'])
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`org event fees: payments query failed: ${error.message}`)
    payments.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return aggregateOrgEventFees(payments, events, hosts)
}
