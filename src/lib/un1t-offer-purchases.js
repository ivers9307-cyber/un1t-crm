// BLACKFRIDAY.5 — record the Hatch Street (un1t.online) Black Friday offer
// purchases off the un1t_transactions mirror. un1t.online takes the money on
// its hosted checkout (offer-checkout-un1t.js asked for it); the CRM only
// learns of it when the un1t-online-sync mirrors the transaction. This sweep
// is what turns that transaction into a paid offer_purchases row, so staff
// are told and add the bonus. A missed purchase is a paying customer with no
// bonus; a double-recorded one is a duplicate staff task.
//
// Per location, each run:
//   1. the studio's sale_offers that carry a un1t_product_id (none: done);
//   2. the mirror's transactions for those products since the earliest
//      offer start (paginated), keeping only money taken: amount above zero,
//      not a renewal, not refunded;
//   3. the transactions already recorded on offer_purchases here, plus the
//      open page rows (state created, provider un1t_online, origin page).
//      A transaction already recorded is skipped, and within a run each is
//      used once.
//   4. a transaction counts for an offer of its product when it is dated
//      inside [starts_at, ends_at], or later than ends_at when the buyer had
//      opened a page checkout for that offer before it closed (a late
//      payment of an order placed in time);
//   5. the buyer's open page row (same un1t.online user and offer, created
//      at or before the payment, oldest first) is settled by a CAS on state
//      'created', then the contact link + tag, the staff notice and the
//      set-password step (page rows only: the CRM made that account);
//   6. otherwise an off_page row is inserted, paid, under the contact
//      un1t_clients links the user to, then the tag and the staff notice.
//      The unique (location_id, un1t_transaction_id) key makes a second
//      record impossible: a 23505 there is "already recorded", never failed;
//   7. page rows still open after UN1T_TRIAL_EXPIRY_MS (the hosted
//      checkout's 24h plus the sync's lag) are cancelled (CAS) with
//      last_error EXPIRED_ERROR. The expiry is reversible: an expired row is
//      read back in step 3 and a payment the sync mirrors late still settles
//      it (CAS on the state as read), so a slow sync never loses a buyer. A
//      row cancelled for any other reason is never re-opened.
//
// Offers are deliberately NOT filtered by `active`: an in-window buyer is
// owed the bonus even if the offer is switched off later. The window end is
// inclusive to the end of its second (ends_at 23:59:59 covers 23:59:59.999).
//
// `passwordPending`: a settled page buyer whose set-password step did not
// finish (anything but done / skipped_*, or a throw); stamped on the row as
// last_error 'set_password:<verdict>' for staff. It is not a failure: the
// heartbeat judges only `ok`.
//
// Never throws. `ok` is false only when a read in steps 1-3 failed, and then
// nothing is written. A failed side effect counts in `failed`, is logged with
// ids and codes only (never an email, phone or raw PostgREST error, whose
// details can name them), and never stops the rest of the run.
import { linkOrCreateContactForPurchase, notifyStaffOfPaidPurchase, OFFER_SALE_TAG } from '@/lib/sale-offers'
import { writeContactTag } from '@/lib/contact-tags'
import { runSetPasswordStep } from '@/lib/un1t-online-account'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { sendUn1tAccountEmail } from '@/lib/un1t-online-funnel-emails'
import { UN1T_TRIAL_EXPIRY_MS } from '@/lib/trial-purchase-un1t-settle'
import { logError, logWarn } from '@/lib/log'

const LOG = 'un1t-offer-purchases'
// The ledger origin of the offer page (UN1T_OFFER_ORIGIN in offer-checkout-un1t.js).
const ORIGIN = 'web_offer'
const PAGE = 500
const UNIQUE_VIOLATION = '23505'
const FALLBACK_BUYER_NAME = 'un1t.online client'
// The last_error of a page row the sweep cancelled as abandoned (step 7): the
// one cancelled state step 3 reads back, so a late-mirrored payment settles it.
export const EXPIRED_ERROR = 'un1t_checkout_expired'

export const OFFER_SET_PASSWORD_SUBJECT = 'Your UN1T Hatch Street account'
export const OFFER_SET_PASSWORD_BODY = "Thanks for your Black Friday purchase at UN1T Hatch Street. We've set up your un1t.online account. Check your inbox for a code to set your password, then book your first class in the app."

const OFFER_COLS = 'id, location_id, name, bonus_headline, un1t_product_id, starts_at, ends_at'
const TX_COLS = 'un1t_id, un1t_user_id, contact_id, product_id, type, amount_cents, currency, refunded, remote_created_at'
const PAGE_ROW_COLS = 'id, offer_id, location_id, contact_id, buyer_name, buyer_email, buyer_phone, amount_cents, currency, un1t_user_id, un1t_product_id, state, last_error, created_at'

class ReadFailed extends Error {
  constructor(what, code) {
    super(`${what} unreadable`)
    this.name = 'ReadFailed'
    this.what = what
    this.code = code ?? null
  }
}

/** Every page of a read: `build()` must return a fresh, ordered builder. */
async function readAll(build, what) {
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw new ReadFailed(what, error.code)
    const rows = Array.isArray(data) ? data : []
    all.push(...rows)
    if (rows.length < PAGE) return all
  }
}

const ms = (v) => Date.parse(v)

/**
 * @param {object} db service-role client
 * @param {string} locationId
 * @param {{ now?: () => number }} [opts]
 * @returns {Promise<{ ok: boolean, checked: number, recorded: number, matchedPage: number, expired: number, failed: number, passwordPending: number }>}
 */
export async function sweepUn1tOfferPurchases(db, locationId, { now = () => Date.now() } = {}) {
  const out = { ok: true, checked: 0, recorded: 0, matchedPage: 0, expired: 0, failed: 0, passwordPending: 0 }
  try {
    return await sweep(db, locationId, now(), out)
  } catch (err) {
    if (err instanceof ReadFailed) {
      logError(LOG, `${err.what} unreadable; nothing recorded or expired`, { locationId, code: err.code })
    } else {
      logError(LOG, 'offer purchase sweep threw', { locationId, code: err?.code ?? null, errClass: err?.name })
    }
    return { ...out, ok: false }
  }
}

async function sweep(db, locationId, nowMs, out) {
  // ── 1. The offers sold on un1t.online ──
  const offers = (await readAll(() => db.from('sale_offers').select(OFFER_COLS)
    .eq('location_id', locationId)
    .not('un1t_product_id', 'is', null)
    .order('id', { ascending: true }), 'sale offers'))
    .filter((o) => o?.un1t_product_id && o.starts_at && o.ends_at)
  if (offers.length === 0) return out
  const byProduct = new Map()
  for (const o of offers) {
    const key = String(o.un1t_product_id)
    if (!byProduct.has(key)) byProduct.set(key, [])
    byProduct.get(key).push(o)
  }
  const windowStart = offers.map((o) => o.starts_at).sort((a, b) => ms(a) - ms(b))[0]

  // ── 2. Money taken for those products since the first offer opened ──
  const txs = (await readAll(() => db.from('un1t_transactions').select(TX_COLS)
    .eq('location_id', locationId)
    .in('product_id', [...byProduct.keys()])
    .gte('remote_created_at', windowStart)
    .order('remote_created_at', { ascending: true })
    .order('un1t_id', { ascending: true }), 'un1t transactions'))
    .filter((t) => t?.un1t_id && Number(t.amount_cents) > 0 && t.type !== 'sub_renewal' && t.refunded !== true)
  out.checked = txs.length

  // ── 3. What is already recorded, and the open page rows ──
  const used = new Set((await readAll(() => db.from('offer_purchases').select('id, un1t_transaction_id')
    .eq('location_id', locationId)
    .not('un1t_transaction_id', 'is', null)
    .order('id', { ascending: true }), 'recorded offer transactions'))
    .map((r) => String(r.un1t_transaction_id)))
  // Open rows, and rows this sweep expired (a payment mirrored late still settles them).
  const pageRowsRead = (extra) => readAll(() => extra(db.from('offer_purchases').select(PAGE_ROW_COLS)
    .eq('location_id', locationId)
    .eq('payment_provider', 'un1t_online')
    .eq('origin', 'page'))
    .order('created_at', { ascending: true })
    .order('id', { ascending: true }), 'offer page rows')
  const openRows = await pageRowsRead((q) => q.eq('state', 'created'))
  const expiredRows = await pageRowsRead((q) => q.eq('state', 'cancelled').eq('last_error', EXPIRED_ERROR))
  const pageRows = [...openRows, ...expiredRows]
    .sort((a, b) => (ms(a.created_at) - ms(b.created_at)) || String(a.id).localeCompare(String(b.id)))

  // ── 4-6. Each transaction, once ──
  const taken = new Set() // page row ids matched this run: never matched twice, never expired
  for (const t of txs) {
    const txId = String(t.un1t_id)
    if (used.has(txId)) continue
    const paidMs = ms(t.remote_created_at)
    if (!Number.isFinite(paidMs)) continue

    let match = null
    let windowOffer = null
    for (const offer of byProduct.get(String(t.product_id)) || []) {
      const startMs = ms(offer.starts_at)
      const endMs = ms(offer.ends_at)
      // Inclusive to the end of ends_at's second.
      const inWindow = paidMs >= startMs && paidMs < endMs + 1000
      if (inWindow && !windowOffer) windowOffer = offer
      if (t.un1t_user_id == null) continue
      const row = pageRows.find((r) => !taken.has(r.id)
        && r.offer_id === offer.id
        && r.un1t_user_id != null && String(r.un1t_user_id) === String(t.un1t_user_id)
        && ms(r.created_at) <= paidMs
        && (inWindow || (paidMs >= endMs + 1000 && ms(r.created_at) < endMs + 1000)))
      if (row) { match = { offer, row }; break }
    }
    if (!match && !windowOffer) continue

    used.add(txId)
    if (match) {
      taken.add(match.row.id)
      await settlePageRow(db, match.row, match.offer, t, nowMs, out)
    } else {
      await recordOffPage(db, locationId, windowOffer, t, out)
    }
  }

  // ── 7. Abandoned page checkouts ──
  for (const r of openRows) {
    if (taken.has(r.id)) continue
    if (ms(r.created_at) + UN1T_TRIAL_EXPIRY_MS >= nowMs) continue
    let data, error
    try {
      ({ data, error } = await db.from('offer_purchases')
        .update({ state: 'cancelled', last_error: EXPIRED_ERROR, updated_at: new Date(nowMs).toISOString() })
        .eq('id', r.id).eq('state', 'created').select('id'))
    } catch (err) {
      error = err
    }
    if (error) {
      out.failed++
      logError(LOG, 'stale offer page row not cancelled', { locationId, purchaseId: r.id, code: error.code ?? null })
    } else if (Array.isArray(data) && data.length === 1) out.expired++
  }
  return out
}

/** The CAS settle of a page row, then its side effects when this run settled it. */
async function settlePageRow(db, row, offer, t, nowMs, out) {
  const ids = { locationId: row.location_id, purchaseId: row.id, offerId: offer.id, transaction: String(t.un1t_id) }
  const patch = {
    state: 'paid', paid_at: t.remote_created_at, un1t_transaction_id: String(t.un1t_id),
    amount_cents: Number(t.amount_cents), last_error: null, updated_at: new Date(nowMs).toISOString(),
  }
  let data, error
  try {
    ({ data, error } = await db.from('offer_purchases').update(patch)
      // The state as read: 'created', or 'cancelled' by this sweep's expiry.
      .eq('id', row.id).eq('state', row.state).select('id'))
  } catch (err) {
    error = err
  }
  if (error?.code === UNIQUE_VIOLATION) {
    logWarn(LOG, 'offer transaction already recorded by another run; page row left open', ids)
    return
  }
  if (error) {
    out.failed++
    logError(LOG, 'offer page row not settled; the next run tries again', { ...ids, code: error.code ?? null })
    return
  }
  if (!Array.isArray(data) || data.length !== 1) {
    logWarn(LOG, 'offer page row no longer open; nothing sent', ids)
    return
  }
  out.matchedPage++
  const purchase = { ...row, ...patch }

  let contactId = row.contact_id ?? null
  try {
    const linked = await linkOrCreateContactForPurchase(db, purchase)
    if (linked?.contactId) contactId = linked.contactId
  } catch (err) {
    out.failed++
    logError(LOG, 'offer buyer not linked or tagged', { ...ids, code: err?.code ?? null, errClass: err?.name })
  }

  try {
    await notifyStaffOfPaidPurchase(db, { ...purchase, contact_id: contactId }, offer)
  } catch (err) {
    out.failed++
    logError(LOG, 'staff not told of a paid offer purchase', { ...ids, code: err?.code ?? null, errClass: err?.name })
  }

  // The set-password step reads the ledger itself: an account the CRM did
  // not create answers skipped_not_created.
  let verdict
  try {
    if (!contactId) throw Object.assign(new Error('no contact on the row'), { code: 'no_contact' })
    if (row.un1t_user_id == null) throw Object.assign(new Error('no un1t user on the row'), { code: 'no_un1t_user' })
    const { settings } = await readUn1tWriteSettings(db, row.location_id)
    const { data: contact, error: contactErr } = await db.from('contacts')
      .select('id, email, first_name, last_name, name').eq('id', contactId).maybeSingle()
    if (contactErr) throw Object.assign(new Error('contact unreadable'), { code: contactErr.code ?? null })
    if (!contact) throw Object.assign(new Error('contact missing'), { code: 'contact_missing' })
    const res = await runSetPasswordStep(db, {
      locationId: row.location_id, contact, un1tUserId: String(row.un1t_user_id), request: null,
      settings, origin: ORIGIN,
      emailArgs: { kind: 'trial_purchase', productName: offer.name, copy: { subject: OFFER_SET_PASSWORD_SUBJECT, body: OFFER_SET_PASSWORD_BODY } },
      writer: null,
    // The step takes its sender only from deps (no default): without it the
    // explanation email throws inside the step and is never sent.
    }, { sendUn1tAccountEmail })
    verdict = res?.forgotPassword ?? 'unknown'
    if (verdict !== 'done' && !String(verdict).startsWith('skipped_')) {
      logWarn(LOG, 'set-password step did not complete', { ...ids, forgotPassword: verdict, explanation: res?.explanation ?? null, code: res?.code ?? null })
    }
  } catch (err) {
    verdict = 'error'
    logError(LOG, 'set-password step failed after settling', { ...ids, code: err?.code ?? null, errClass: err?.name })
  }
  if (verdict !== 'done' && !String(verdict).startsWith('skipped_')) {
    out.passwordPending++
    // Best-effort, for staff: the row is already paid.
    try {
      const { error: noteErr } = await db.from('offer_purchases')
        .update({ last_error: `set_password:${verdict}` }).eq('id', row.id)
      if (noteErr) logWarn(LOG, 'set-password verdict not recorded on the row', { ...ids, code: noteErr.code ?? null })
    } catch (err) {
      logWarn(LOG, 'set-password verdict not recorded on the row', { ...ids, errClass: err?.name })
    }
  }
}

/** A purchase made on un1t.online without our page: recorded paid, origin off_page. */
async function recordOffPage(db, locationId, offer, t, out) {
  const ids = { locationId, offerId: offer.id, transaction: String(t.un1t_id) }

  // The buyer: the contact the sync linked to this un1t.online user.
  let contact = null
  try {
    let contactId = null
    if (t.un1t_user_id != null) {
      const { data, error } = await db.from('un1t_clients').select('contact_id')
        .eq('location_id', locationId).eq('un1t_user_id', String(t.un1t_user_id))
        .order('id', { ascending: true }).limit(1)
      if (error) throw Object.assign(new Error('un1t client unreadable'), { code: error.code ?? null })
      contactId = (Array.isArray(data) && data[0]?.contact_id) || null
    }
    contactId = contactId || t.contact_id || null
    if (contactId) {
      const { data, error } = await db.from('contacts')
        .select('id, name, first_name, last_name, email, phone').eq('id', contactId).maybeSingle()
      if (error) throw Object.assign(new Error('contact unreadable'), { code: error.code ?? null })
      contact = data || null
    }
  } catch (err) {
    out.failed++
    logError(LOG, 'off-page offer buyer unreadable; the next run tries again', { ...ids, code: err?.code ?? null })
    return
  }

  const fullName = [contact?.first_name, contact?.last_name].filter((s) => typeof s === 'string' && s.trim()).join(' ').trim()
  const purchase = {
    offer_id: offer.id,
    location_id: locationId,
    contact_id: contact?.id ?? null,
    buyer_name: (typeof contact?.name === 'string' && contact.name.trim()) || fullName || FALLBACK_BUYER_NAME,
    buyer_email: (typeof contact?.email === 'string' && contact.email.trim()) || '',
    buyer_phone: (typeof contact?.phone === 'string' && contact.phone.trim()) || '',
    amount_cents: Number(t.amount_cents),
    currency: t.currency || 'EUR',
    payment_provider: 'un1t_online',
    origin: 'off_page',
    state: 'paid',
    paid_at: t.remote_created_at,
    un1t_user_id: t.un1t_user_id != null ? String(t.un1t_user_id) : null,
    un1t_product_id: String(offer.un1t_product_id),
    un1t_transaction_id: String(t.un1t_id),
  }

  let data, error
  try {
    ({ data, error } = await db.from('offer_purchases').insert(purchase).select('id'))
  } catch (err) {
    error = err
  }
  if (error?.code === UNIQUE_VIOLATION) {
    logWarn(LOG, 'off-page offer transaction already recorded', ids)
    return
  }
  if (error || !Array.isArray(data) || data.length !== 1) {
    out.failed++
    logError(LOG, 'off-page offer purchase not recorded; the next run tries again', { ...ids, code: error?.code ?? null })
    return
  }
  out.recorded++
  const recorded = { ...purchase, id: data[0].id }
  const rowIds = { ...ids, purchaseId: recorded.id }

  if (recorded.contact_id) {
    try {
      const res = await writeContactTag(db, { contactId: recorded.contact_id, locationId, tag: OFFER_SALE_TAG })
      if (res?.error) {
        out.failed++
        logWarn(LOG, 'off-page offer buyer not tagged', rowIds)
      }
    } catch (err) {
      out.failed++
      logWarn(LOG, 'off-page offer buyer not tagged', { ...rowIds, errClass: err?.name })
    }
  }

  try {
    await notifyStaffOfPaidPurchase(db, recorded, offer)
  } catch (err) {
    out.failed++
    logError(LOG, 'staff not told of an off-page offer purchase', { ...rowIds, code: err?.code ?? null, errClass: err?.name })
  }
}
