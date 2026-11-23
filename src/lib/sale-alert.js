// SALEALERT.1 — "new sale" push to the studio's owners and managers.
//
// One function every settled-payment path calls, fire-and-forget. Dedup is
// the sender's job (push_event_sends via sendPushToRolesAtLocationOnce), keyed
// `sale:<source>:<saleId>`, so a replayed webhook or a second path seeing the
// same payment rings once. Never throws and never blocks a payment path.
// Deliberately does not check staff push hours: it rings at any hour.

import { sendPushToRolesAtLocationOnce } from './push-dedup'
import { logError } from './log'
import { after } from 'next/server'

export const SALE_ALERT_ROLES = Object.freeze(['owner', 'manager'])

// Local copies of sale-offers.js's oneLine/formatEuro: sale-offers.js will
// import this module, so importing it back would be a cycle.
function oneLine(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
}

function formatEuro(cents) {
  const whole = cents % 100 === 0
  return '€' + (cents / 100).toLocaleString('en-IE', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })
}

export function saleAlertKey(source, saleId) {
  return `sale:${source}:${saleId}`
}

export function buildSaleAlertPayload({ itemName, amountCents, buyerFirstName, locationName, contactId }) {
  const item = oneLine(itemName) || 'Purchase'
  const hasAmount = Number.isFinite(amountCents)
  const title = `New sale: ${item}${hasAmount ? ` (${formatEuro(amountCents)})` : ''}`
  const body = [oneLine(buyerFirstName), oneLine(locationName)].filter(Boolean).join(' · ')
  const data = { type: 'sale_new' }
  if (contactId) data.contact_id = contactId
  return { title, body, category: 'sale', data }
}

export async function notifyNewSale(db, { source, saleId, locationId, itemName, amountCents, buyerFirstName, locationName, contactId }) {
  if (!source || !saleId || !locationId) return { sent: false, reason: 'missing_key' }
  if (typeof amountCents === 'number' && amountCents <= 0) return { sent: false, reason: 'zero_amount' }
  try {
    const payload = buildSaleAlertPayload({ itemName, amountCents, buyerFirstName, locationName, contactId })
    const result = await sendPushToRolesAtLocationOnce(
      db,
      saleAlertKey(source, saleId),
      locationId,
      SALE_ALERT_ROLES,
      payload,
      { locationScoped: true },
    )
    if (result?.recipients_failed) return { sent: false, reason: 'recipients_failed' }
    if ((result?.sent || 0) > 0) return { sent: true }
    if ((result?.deduped || 0) > 0) return { sent: false, reason: 'duplicate' }
    return { sent: false, reason: 'not_delivered' }
  } catch (err) {
    logError('sale-alert', 'sale alert failed', { source, sale_id: saleId, error: err?.message })
    return { sent: false, reason: 'error' }
  }
}

/**
 * Run a sale alert once the response is sent. On serverless the function can
 * freeze after the response, so a floating promise may never finish; after()
 * keeps it alive. Outside a request scope (a cron, a test) after() throws and
 * the work runs inline instead. Never throws; the returned promise (inline
 * case only) never rejects.
 */
export function ringSaleAfterResponse(fn) {
  const run = async () => {
    try {
      await fn()
    } catch (err) {
      logError('sale-alert', 'sale alert task failed', { error: err?.message })
    }
  }
  try {
    after(run)
    return undefined
  } catch {
    return run()
  }
}
