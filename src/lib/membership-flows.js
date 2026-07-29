// Membership flows — TREND-FLOWS.1 (monthly since TREND-FLOWS.2).
//
// Monthly membership SALES vs CANCELLATIONS for the business-board
// chart (Richard 2026-07-29: the chart's job is membership sales and
// membership cancellations over time, bucketed by month).
//
// Sales — PAID glofox_invoices whose line_item_subtypes contains
// SUBSCRIPTION_PAYMENT (a NEW subscription starting; renewals arrive
// as SUBSCRIPTION_RENEWAL and are excluded). Webhook-sourced rows
// exist from 2026-05-12; older rows use the legacy document_type
// taxonomy that can't split new-vs-renewal, so the series starts with
// May 2026 (itself a partial month). Deduped to each contact's first
// sale in the window (Glofox re-mints invoices per payment attempt).
//
// Cancellations — membership_transitions rows with
// kind='recurring_cancel' (mig 456 trigger on contacts: a member+time
// contact stopping being one). The trigger went live 2026-07-29, so
// months before July 2026 have no data and return null (not 0) so the
// chart can render the gap honestly.
//
// Months are Dublin calendar months keyed 'YYYY-MM'.

import { dublinDayStr } from '@/lib/dublin-time'

// Earliest day with reliable new-vs-renewal invoice data (webhook
// INVOICE_UPDATED log starts 2026-05-12).
export const SALES_DATA_START = '2026-05-12'

// Day mig 456's transition trigger went live in prod.
export const CANCEL_TRACKING_START = '2026-07-29'

/**
 * The last `months` 'YYYY-MM' keys, oldest → newest, ending with the
 * month containing `todayStr`. Pure string math.
 */
export function monthKeys(months, todayStr) {
  const y = Number(todayStr.slice(0, 4))
  const m = Number(todayStr.slice(5, 7))
  const total = y * 12 + (m - 1)
  const keys = []
  for (let i = months - 1; i >= 0; i--) {
    const t = total - i
    keys.push(`${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`)
  }
  return keys
}

/**
 * Assemble the monthly sales/cancellations series for one location.
 * Returns { months: [{ month: 'YYYY-MM', sales, cancellations }],
 * cancelTrackingStart } — a series is null for months that predate its
 * data source. `nowMs` injectable for tests.
 */
export async function fetchMembershipFlows(db, locationId, months = 12, nowMs = Date.now()) {
  const todayStr = dublinDayStr(nowMs)
  const keys = monthKeys(months, todayStr)

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
    const month = dublinDayStr(row.invoice_date).slice(0, 7)
    if (month in sales) sales[month] += 1
  }

  const cancels = Object.fromEntries(keys.map((k) => [k, 0]))
  for (const row of cancelRes.data || []) {
    const month = dublinDayStr(row.occurred_at).slice(0, 7)
    if (month in cancels) cancels[month] += 1
  }

  const salesStartMonth = SALES_DATA_START.slice(0, 7)
  const cancelStartMonth = CANCEL_TRACKING_START.slice(0, 7)
  return {
    months: keys.map((month) => ({
      month,
      sales: month >= salesStartMonth ? sales[month] : null,
      cancellations: month >= cancelStartMonth ? cancels[month] : null,
    })),
    cancelTrackingStart: CANCEL_TRACKING_START,
  }
}
