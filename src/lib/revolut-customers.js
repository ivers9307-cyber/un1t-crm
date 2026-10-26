// REVPAY.13 — reuse one Revolut Merchant customer per email instead of minting
// one per order.
//
// Facts this rests on (merchant-2026-03-12, the version revolut.js pins):
//   - Order `customer` (Customer-v2): "If `id` was provided, we ignore other
//     customer details and associate the customer with the order." Without an
//     id, "we always create a new customer, irrespective of another, existing
//     customer object having the same details." And "If `id` of a
//     non-existent customer was provided, we return a `404` error,
//     irrespective of other details provided."
//   - POST /api/customers: `email` required; "The API does not prevent
//     creating multiple customers with the same email address", and no
//     Idempotency-Key is documented for it.
//   - GET /api/customers filters only by `from`/`to` (dates): there is no
//     lookup by email, so the mapping lives here, in `revolut_customers`
//     (mig 778, service role only), keyed on (merchant account, email_norm).
//
// Every step is a NICETY: a payment must never be blocked by it. Any failure
// (no key, a DB error, Revolut refusing or timing out) returns null and the
// order goes out exactly as it did before REVPAY.13 (email + name, no id). The
// only Revolut call added to a checkout is one createCustomer, the first time
// an email is seen, bounded by CUSTOMER_CREATE_TIMEOUT_MS.

import { logWarn } from './log'
import { createCustomer, createOrder, revolutMerchantKey, RevolutError } from './revolut'
import { buildCustomer } from './revolut-order-fields'
import { createHash } from 'node:crypto'

export const CUSTOMER_CREATE_TIMEOUT_MS = 5_000
const TABLE = 'revolut_customers'
const UNIQUE_VIOLATION = '23505'

/** lower(trim(email)), or '' when there is nothing usable. */
export function normaliseCustomerEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

async function readMapping(db, merchant, emailNorm) {
  const { data, error } = await db
    .from(TABLE)
    .select('revolut_customer_id')
    .eq('merchant', merchant)
    .eq('email_norm', emailNorm)
    // (merchant, email_norm) is UNIQUE (mig 778), so at most one row.
    .maybeSingle()
  return { id: data?.revolut_customer_id || null, error }
}

/**
 * The Revolut customer id to put on an order for this email, creating the
 * customer (and remembering it) the first time. Null on ANY failure: the
 * caller then sends the details without an id, as before.
 *
 * @param {object} db  service-role supabase client
 * @param {{ email: string, fullName?: string }} details
 * @returns {Promise<string|null>}
 */
export async function resolveRevolutCustomerId(db, { email, fullName } = {}) {
  // buildCustomer is the order path's own validation: an email it would drop
  // from the order is not one we create a customer for either.
  const valid = buildCustomer({ email, fullName })
  const emailNorm = normaliseCustomerEmail(valid?.email)
  if (!emailNorm || !db) return null

  let merchant
  try {
    merchant = revolutMerchantKey()
  } catch (e) {
    logWarn('revolut-customers', 'no merchant key; order goes without a customer id', { error: e?.message })
    return null
  }

  try {
    const hit = await readMapping(db, merchant, emailNorm)
    if (hit.error) {
      // Unknown, not "absent": creating here could mint the duplicate this
      // module exists to stop, so fall back instead.
      logWarn('revolut-customers', 'mapping read failed; order goes without a customer id', { error: hit.error.message })
      return null
    }
    if (hit.id) {
      const { error: touchError } = await db
        .from(TABLE)
        .update({ last_used_at: new Date().toISOString() })
        .eq('merchant', merchant)
        .eq('email_norm', emailNorm)
      if (touchError) logWarn('revolut-customers', 'last_used_at touch failed', { error: touchError.message })
      return hit.id
    }

    let created
    try {
      created = await createCustomer(
        { email: valid.email, fullName: valid.full_name },
        { timeoutMs: CUSTOMER_CREATE_TIMEOUT_MS },
      )
    } catch (e) {
      // A refusal, a 5xx or a timeout. A timeout may have created the customer
      // anyway; it is then an orphan, the same duplicate as before REVPAY.13,
      // and the next order for this email tries again.
      logWarn('revolut-customers', 'createCustomer failed; order goes without a customer id', {
        status: e?.status, code: e?.code, error: e?.message,
      })
      return null
    }
    const newId = typeof created?.id === 'string' && created.id.trim() ? created.id.trim() : null
    if (!newId) {
      logWarn('revolut-customers', 'createCustomer answered without an id; order goes without a customer id')
      return null
    }

    const { error: insertError } = await db
      .from(TABLE)
      .insert({ merchant, email_norm: emailNorm, revolut_customer_id: newId })
    if (!insertError) return newId

    if (insertError.code === UNIQUE_VIOLATION) {
      // Another checkout for the same email won the race. Use ITS customer so
      // every later order lands on one record; ours is left as an orphan.
      const winner = await readMapping(db, merchant, emailNorm)
      if (!winner.error && winner.id) {
        logWarn('revolut-customers', 'lost the mapping race; using the winner and orphaning ours', { orphan: newId })
        return winner.id
      }
      logWarn('revolut-customers', 'mapping race re-read failed; using our own customer', {
        error: winner.error?.message,
      })
      return newId
    }
    // The customer exists at Revolut: still link THIS order to it, it just is
    // not remembered for the next one.
    logWarn('revolut-customers', 'mapping insert failed; customer used for this order only', { error: insertError.message })
    return newId
  } catch (e) {
    logWarn('revolut-customers', 'resolve threw; order goes without a customer id', { error: e?.message })
    return null
  }
}

/**
 * Forget a customer id Revolut no longer knows (deleted in the dashboard).
 * Best effort: a failure only means the next order tries it once more.
 */
export async function dropRevolutCustomer(db, revolutCustomerId) {
  try {
    const merchant = revolutMerchantKey()
    const { error } = await db
      .from(TABLE)
      .delete()
      .eq('merchant', merchant)
      .eq('revolut_customer_id', revolutCustomerId)
    if (error) logWarn('revolut-customers', 'stale mapping delete failed', { error: error.message })
  } catch (e) {
    logWarn('revolut-customers', 'stale mapping delete threw', { error: e?.message })
  }
}

/**
 * Did Revolut REFUSE the order because of the customer id we sent? Only an
 * HTTP answer counts (a RevolutError with no `code`; timeouts and network
 * failures carry 'timeout'/'network' and are outcome-unknown). The spec's own
 * answer for an unknown id is 404 (the order body carries no other id); a
 * 400/422 counts only when its message names the customer.
 */
export function isStaleCustomerRefusal(e) {
  if (!(e instanceof RevolutError) || e.code) return false
  if (e.status === 404) return true
  if (e.status === 400 || e.status === 422) return /customer/i.test(String(e.message || ''))
  return false
}

// The retry carries a DIFFERENT Idempotency-Key. Revolut documents no
// Idempotency-Key semantics for POST /api/orders (only for refunds and
// subscriptions), so we cannot know whether it replays a stored 404 for the
// same key; a derived key guarantees the retry is judged on its own body.
// Hashed so it stays inside the header's 50-character limit.
function retryIdempotencyKey(key) {
  if (!key) return undefined
  return `nocust-${createHash('sha256').update(String(key)).digest('hex').slice(0, 32)}`
}

/**
 * createOrder, linked to a reused Revolut customer. Called by createOrder when
 * it is given `db`; `order` is createOrder's own argument object without db.
 */
export async function createOrderReusingCustomer(db, order) {
  const { customer, ...rest } = order
  const details = buildCustomer(customer)
  const customerId = details?.email
    ? await resolveRevolutCustomerId(db, { email: details.email, fullName: details.full_name })
    : null
  if (!customerId) return createOrder({ ...rest, customer })

  try {
    return await createOrder({ ...rest, customerId })
  } catch (e) {
    // Re-POSTing an order is safe ONLY because Revolut answered this one with
    // a refusal (an HTTP 4xx about the customer): nothing was created. A 5xx,
    // a timeout or no reply is outcome-unknown (the order may exist), so it is
    // thrown exactly as before and never retried here (REVPAY.1).
    if (!isStaleCustomerRefusal(e)) throw e
    logWarn('revolut-customers', 'stored customer id refused; dropping it and retrying once without it', {
      status: e.status, error: e.message,
    })
    await dropRevolutCustomer(db, customerId)
    return createOrder({ ...rest, customer, idempotencyKey: retryIdempotencyKey(rest.idempotencyKey) })
  }
}

/**
 * Contact erasure: forget the email → Revolut customer mapping for a deleted
 * contact (every merchant). The row holds the email in clear and is not keyed
 * to the contact, so the contact delete would otherwise leave it behind.
 * Dropping it is always safe: the next order for that email creates one new
 * Revolut customer. The customer record AT Revolut is Revolut's to hold.
 * Best-effort, never throws: an erasure is never refused over this.
 * @returns {Promise<boolean>} true when nothing is left behind
 */
export async function forgetRevolutCustomerForContact(db, contactId) {
  try {
    const { data: contact, error: readErr } = await db.from('contacts').select('email').eq('id', contactId).maybeSingle()
    if (readErr) {
      logWarn('revolut-customers', 'erasure: contact unreadable; Revolut customer mapping not checked', { contactId, err: readErr })
      return false
    }
    const email = normaliseCustomerEmail(contact?.email)
    if (!email) return true
    const { error } = await db.from('revolut_customers').delete().eq('email_norm', email)
    if (error) {
      logWarn('revolut-customers', 'erasure: Revolut customer mapping not deleted', { contactId, err: error })
      return false
    }
    return true
  } catch (e) {
    logWarn('revolut-customers', 'erasure: Revolut customer mapping step threw', { contactId, err: e })
    return false
  }
}
