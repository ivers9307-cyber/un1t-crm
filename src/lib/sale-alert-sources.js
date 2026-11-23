// SALEALERT.1 — adapters from a settled-payment row to notifyNewSale, so each
// payment path stays one line. Each takes the row its caller already holds
// (plus, optionally, the amount the provider reported, which beats a stale
// row), never throws, and returns notifyNewSale's promise. Callers do not
// await it: `ringSaleAfterResponse(() => alertTrialSale(db, row))`.

import { notifyNewSale } from './sale-alert'

const SWALLOWED = Object.freeze({ sent: false, reason: 'error' })

function firstName(row) {
  const first = typeof row?.first_name === 'string' ? row.first_name.trim() : ''
  if (first) return first
  const full = typeof row?.customer_name === 'string' ? row.customer_name.trim() : ''
  return full.split(/\s+/)[0] || ''
}

function amountOf(...candidates) {
  for (const c of candidates) if (Number.isFinite(c)) return c
  return null
}

async function ring(db, build) {
  try {
    const args = build()
    if (!args) return { sent: false, reason: 'missing_key' }
    if (args.skip) return { sent: false, reason: args.skip }
    return await notifyNewSale(db, args)
  } catch {
    return SWALLOWED
  }
}

/**
 * A paid trial_purchases row. A Revolut or Stripe Connect trial is keyed on
 * the row; a un1t.online trial on its transaction id (payment_provider_ref),
 * with no safe key (so no ring) until that is on the row.
 */
export function alertTrialSale(db, row, { paidAmountCents } = {}) {
  return ring(db, () => {
    const onUn1t = row.payment_provider === 'un1t_online'
    const saleId = onUn1t ? row.payment_provider_ref : row.id
    if (!saleId) return null
    return {
      source: onUn1t ? 'un1t' : 'trial',
      saleId: String(saleId),
      locationId: row.location_id,
      itemName: row.product_name,
      amountCents: amountOf(paidAmountCents, row.amount_cents) ?? undefined,
      buyerFirstName: firstName(row),
      contactId: row.contact_id,
    }
  })
}

/**
 * A paid class_booking_requests row. Never rings on an unknown amount: a
 * booking funded by a trial or credits is not a sale, and null is not "paid".
 */
export function alertClassBookingSale(db, row, { paidAmountCents } = {}) {
  return ring(db, () => {
    const amountCents = amountOf(paidAmountCents, row.amount_cents)
    if (amountCents === null) return { skip: 'unknown_amount' }
    return {
      source: 'class_booking',
      saleId: String(row.id),
      locationId: row.location_id,
      itemName: row.class_name,
      amountCents,
      buyerFirstName: firstName(row),
      contactId: row.contact_id,
    }
  })
}

/** A staff payment link settled by a un1t.online transaction (paid_transaction_id). */
export function alertPayLinkSale(db, row, { paidAmountCents } = {}) {
  return ring(db, () => {
    if (!row.paid_transaction_id) return null
    return {
      source: 'un1t',
      saleId: String(row.paid_transaction_id),
      locationId: row.location_id,
      itemName: row.product_title,
      amountCents: amountOf(paidAmountCents, row.price_cents) ?? undefined,
      buyerFirstName: firstName(row),
      contactId: row.contact_id,
    }
  })
}

/**
 * A completed race_payments entry (`event` is its race_events row). Rings only
 * for money that settled to the studio: a payment carrying a host's Stripe
 * connected account (connected_account_id, provider stripe_connect, as
 * createRacePayment writes them) belongs to the host, and a move_gap price
 * difference is not a new sale. An event with no studio has nobody to tell.
 */
export function alertRaceSale(db, payment, event) {
  return ring(db, () => {
    if (!payment?.id || (payment.kind || 'entry') !== 'entry') return { skip: 'not_an_entry' }
    if (payment.connected_account_id || payment.payment_provider === 'stripe_connect') return { skip: 'host_account' }
    if (!event?.location_id) return { skip: 'no_location' }
    const amountCents = amountOf(payment.amount_cents)
    if (amountCents === null || amountCents <= 0) return { skip: 'unknown_amount' }
    return {
      source: 'race',
      saleId: String(payment.id),
      locationId: event.location_id,
      itemName: event.name,
      amountCents,
      buyerFirstName: firstName({ customer_name: payment.contact_name }),
      contactId: payment.contact_id,
    }
  })
}
