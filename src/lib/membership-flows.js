// Membership flows — TREND-FLOWS.1.
//
// Weekly membership SALES vs CANCELLATIONS for the business-board
// chart (Richard 2026-07-29: the trend chart's job is "week by week
// membership sales and week by week membership cancellations", not
// the member-count level the snapshots show).
//
// Sales — PAID glofox_invoices whose line_item_subtypes contains
// SUBSCRIPTION_PAYMENT (a NEW subscription starting; renewals arrive
// as SUBSCRIPTION_RENEWAL and are excluded). Webhook-sourced rows
// exist from 2026-05-12; older rows use the legacy document_type
// taxonomy that can't split new-vs-renewal, so the series starts
// there. Deduped to each contact's first sale in the window (Glofox
// re-mints invoices per payment attempt).
//
// Cancellations — membership_transitions rows with
// kind='recurring_cancel' (mig 456 trigger on contacts: a
// member+time contact stopping being one). The trigger went live
// 2026-07-29; weeks before CANCEL_TRACKING_START have no data and
// return null (not 0) so the chart can render the gap honestly.
//
// Weeks are Monday-start Dublin calendar weeks keyed 'YYYY-MM-DD'.

import { dublinDayStr } from '@/lib/dublin-time'

// Earliest week with reliable new-vs-renewal invoice data (webhook
// INVOICE_UPDATED log starts 2026-05-12).
export const SALES_DATA_START = '2026-05-12'

// Day mig 456's transition trigger went live in prod.
export const CANCEL_TRACKING_START = '2026-07-29'

/**
 * Monday of the week containing a 'YYYY-MM-DD' day. Date.UTC on the
 * split parts is pure calendar math — no local-time parsing.
 */
export function weekStartStr(dayStr) {
  const y = Number(dayStr.slice(0, 4))
  const m = Number(dayStr.slice(5, 7))
  const d = Number(dayStr.slice(8, 10))
  const ms = Date.UTC(y, m - 1, d)
  const dow = new Date(ms).getUTCDay() // 0=Sun … 6=Sat
  const monday = new Date(ms - ((dow + 6) % 7) * 86400000)
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`
}

/**
 * The last `weeks` Monday keys, oldest → newest, ending with the week
 * containing `todayStr`.
 */
export function weekKeys(weeks, todayStr) {
  const start = weekStartStr(todayStr)
  const y = Number(start.slice(0, 4))
  const m = Number(start.slice(5, 7))
  const d = Number(start.slice(8, 10))
  const ms = Date.UTC(y, m - 1, d)
  const keys = []
  for (let i = weeks - 1; i >= 0; i--) {
    const dt = new Date(ms - i * 7 * 86400000)
    keys.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`)
  }
  return keys
}

/**
 * Assemble the weekly sales/cancellations series for one location.
 * Returns { weeks: [{ week: 'YYYY-MM-DD', sales, cancellations }],
 * cancelTrackingStart } — `cancellations` is null for weeks that ended
 * before tracking existed. `nowMs` injectable for tests.
 */
export async function fetchMembershipFlows(db, locationId, weeks = 12, nowMs = Date.now()) {
  const todayStr = dublinDayStr(nowMs)
  const keys = weekKeys(weeks, todayStr)

  // Fetch the full sale history (not just the window) so first-sale
  // dedupe sees a contact's earlier purchase; row count is tiny
  // (~2/week) so the 1k select cap is years away — revisit if the
  // volume ever approaches it.
  const [salesRes, cancelRes] = await Promise.all([
    db
      .from('glofox_invoices')
      .select('contact_id, invoice_date')
      .eq('location_id', locationId)
      .eq('status', 'PAID')
      .like('line_item_subtypes', '%SUBSCRIPTION_PAYMENT%')
      .gte('invoice_date', SALES_DATA_START)
      .order('invoice_date', { ascending: true })
      .limit(999),
    db
      .from('membership_transitions')
      .select('occurred_at')
      .eq('location_id', locationId)
      .eq('kind', 'recurring_cancel')
      .order('occurred_at', { ascending: true })
      .limit(999),
  ])
  if (salesRes.error) throw new Error(`fetchMembershipFlows(sales): ${salesRes.error.message}`)
  if (cancelRes.error) throw new Error(`fetchMembershipFlows(cancels): ${cancelRes.error.message}`)

  const sales = Object.fromEntries(keys.map((k) => [k, 0]))
  const seen = new Set()
  for (const row of salesRes.data || []) {
    const cid = row.contact_id || 'unknown'
    if (seen.has(cid)) continue
    seen.add(cid)
    const week = weekStartStr(dublinDayStr(row.invoice_date))
    if (week in sales) sales[week] += 1
  }

  const cancels = Object.fromEntries(keys.map((k) => [k, 0]))
  for (const row of cancelRes.data || []) {
    const week = weekStartStr(dublinDayStr(row.occurred_at))
    if (week in cancels) cancels[week] += 1
  }

  const cancelStartWeek = weekStartStr(CANCEL_TRACKING_START)
  return {
    weeks: keys.map((week) => ({
      week,
      sales: week >= weekStartStr(SALES_DATA_START) ? sales[week] : null,
      cancellations: week >= cancelStartWeek ? cancels[week] : null,
    })),
    cancelTrackingStart: CANCEL_TRACKING_START,
  }
}
