// SALEALERT.1 — a new in-app purchase at Hatch (un1t.online) rings the "sale"
// push.
//
// un1t.online has no webhook, so the 15-minute sync is the detector: after it
// mirrors un1t_transactions, runUn1tSync calls alertUn1tSales for the studio.
// The dedup key is `sale:un1t:<un1t transaction id>` (un1t_transactions.un1t_id,
// the same id offer_purchases.un1t_transaction_id, a trial's payment_provider_ref
// and a pay link's paid_transaction_id hold), so a purchase that also settled a
// CRM row rings once, whichever path saw it first.
//
// Allow-list, from the production data read on 23 Nov 2026: only type
// 'one_time' (a product: packs, class credits) and 'sub_initial' (a first
// membership payment) ring. Renewals, staff manual charges (what the CRM's
// chargeClassFee, un1t.online's "Charge custom amount", is expected to land
// as), refunds, EUR 0 free trials and any type not seen yet never ring.

import { notifyNewSale } from './sale-alert'
import { logError, logWarn } from './log'

// Set to the release time in the PR: rows paid before it never ring, so
// deploying cannot replay a day of old purchases.
export const UN1T_SALE_ALERT_FROM = '2026-11-24T00:00:00Z'
export const UN1T_SALE_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000

const SALE_TYPES = Object.freeze(['one_time', 'sub_initial'])
const CANDIDATE_CAP = 200
const FALLBACK_ITEM_NAME = 'Purchase'
const TX_COLS = 'un1t_id, contact_id, product_title, type, amount_cents, refunded, remote_created_at'

/** @returns {boolean} true when this un1t_transactions row is a new sale to ring for. */
export function un1tTransactionIsNewSale(tx, nowMs) {
  if (!SALE_TYPES.includes(tx?.type)) return false
  if (tx.refunded === true) return false
  if (!(Number(tx.amount_cents) > 0)) return false
  const paidMs = Date.parse(tx.remote_created_at)
  if (!Number.isFinite(paidMs)) return false
  if (paidMs < Date.parse(UN1T_SALE_ALERT_FROM)) return false
  return paidMs <= nowMs && nowMs - paidMs <= UN1T_SALE_ALERT_WINDOW_MS
}

async function firstNamesFor(db, ids) {
  if (ids.length === 0) return new Map()
  const { data, error } = await db.from('contacts').select('id, first_name').in('id', ids)
  if (error) {
    logError('un1t-sale-alert', 'could not read buyer first names; ringing without them', { code: error.code ?? null })
    return new Map()
  }
  return new Map((data || []).map((c) => [c.id, typeof c.first_name === 'string' ? c.first_name.trim() : '']))
}

/**
 * Ring for every un1t.online purchase at this studio in the last day that has
 * not rung yet (push_event_sends absorbs repeats). Never throws; one failed
 * alert or read is logged and counted, never the sync's problem.
 * @returns {Promise<{ rung: number }>}
 */
export async function alertUn1tSales(db, { locationId, locationName, nowMs = Date.now() } = {}) {
  let rung = 0
  try {
    if (!locationId) return { rung }
    const fromMs = Math.max(Date.parse(UN1T_SALE_ALERT_FROM), nowMs - UN1T_SALE_ALERT_WINDOW_MS)
    const { data, error } = await db.from('un1t_transactions').select(TX_COLS)
      .eq('location_id', locationId)
      .gte('remote_created_at', new Date(fromMs).toISOString())
      .in('type', SALE_TYPES)
      .gt('amount_cents', 0)
      .order('remote_created_at', { ascending: false })
      .order('un1t_id', { ascending: false })
      .range(0, CANDIDATE_CAP - 1)
    if (error) {
      logError('un1t-sale-alert', 'could not read recent transactions', { locationId, code: error.code ?? null })
      return { rung }
    }
    const rows = data || []
    if (rows.length >= CANDIDATE_CAP) {
      logWarn('un1t-sale-alert', 'candidate cap hit; the oldest purchases in the window were not read this run', { locationId, cap: CANDIDATE_CAP })
    }
    const sales = rows.filter((t) => t?.un1t_id && un1tTransactionIsNewSale(t, nowMs))
    if (sales.length === 0) return { rung }
    const names = await firstNamesFor(db, [...new Set(sales.map((t) => t.contact_id).filter(Boolean))])
    for (const t of sales) {
      try {
        const res = await notifyNewSale(db, {
          source: 'un1t',
          saleId: String(t.un1t_id),
          locationId,
          locationName,
          itemName: t.product_title || FALLBACK_ITEM_NAME,
          amountCents: Number(t.amount_cents),
          buyerFirstName: (t.contact_id && names.get(t.contact_id)) || undefined,
          contactId: t.contact_id || undefined,
        })
        if (res?.sent) rung += 1
      } catch (err) {
        logError('un1t-sale-alert', 'sale alert failed', { locationId, error: err?.message })
      }
    }
  } catch (err) {
    logError('un1t-sale-alert', 'sale alert pass failed', { locationId, error: err?.message })
  }
  return { rung }
}
