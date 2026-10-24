// TRIALSTUDIO.7 — settle and expire the Hatch Street (un1t.online) trial rows.
// un1t.online takes the money on its hosted checkout; the CRM only learns of
// it when the un1t-online-sync mirrors the transaction into un1t_transactions.
// The 2-minute process-trial-purchases cron runs this sweep over the open rows
// (payment_provider 'un1t_online', status 'awaiting_payment', oldest first).
//
// Matching (the purchasesSince rule of agent/purchase-settle.js, copied): a
// transaction of the row's un1t.online user at the row's location, dated at or
// after the row, with an amount above zero, not a renewal, AND for the row's
// product: its product_id is the row's un1t_product_id. A transaction with no
// product_id (the mirror recorded none; prod's Hatch transactions all carry
// one) may settle a row as the fallback; a transaction for a DIFFERENT known
// product never does (a class pack bought the same day is not the trial).
//
// ONE PURCHASE SETTLES AT MOST ONE ROW. A buyer who cancelled the checkout and
// tried again has two open rows for one un1t.online user (see the comment
// above the terminal stamps in trial-purchase-un1t-checkout.js), so:
//   - a settled row carries the transaction as payment_provider_ref, and a
//     transaction already referenced by a row at that location is never used
//     again (one read per sweep);
//   - within a sweep a transaction is used once (tracked in memory);
//   - a user's rows are paired with their transactions product match first,
//     then (a product-less transaction only) the NEWEST row; the row left
//     over stays open and later expires.
// The settle stamp is a CAS on status 'awaiting_payment': the Purchase and
// the set-password step run only when it matched, so a raced row, or a re-run
// after a crash between the stamp and the side effects, never sends twice.
//
// Expiry: an open row older than UN1T_TRIAL_EXPIRY_MS (the un1t.online
// checkout's 24h plus the sync's lag) with no purchase becomes 'expired'. A
// row whose transactions could not be read is neither settled nor expired.
//
// Never throws: every failure is counted in `errors` and logged with ids only.
// `readFailed` says the sweep could not read its own work list (the cron then
// skips its heartbeat); a failed side effect is an error, not a read failure.
// `raceLost`: the settle stamp hit uniq_trial_purchases_un1t_ref (23505), so
// an overlapping sweep settled another row off the same payment; nothing is
// sent and the next sweep's used-refs read leaves this row the transaction.
// The set-password step's explanation email is the trial buyer's own
// (kind 'trial_purchase', the studio's paid_trial account_email_* copy and
// the row's product name), never the class funnel's booking copy.
// `passwordPending`: a settled buyer whose set-password step did not finish
// (anything but done / skipped_*, or a throw); the verdict is logged and kept
// on the row as grant.set_password for staff.
import { sendWebsiteConversion } from '@/lib/meta-capi'
import { runSetPasswordStep } from '@/lib/un1t-online-account'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { readPaidTrialAccountEmailCopy } from '@/lib/trial-studios'
import { logError, logWarn } from '@/lib/log'

const LOG = 'trial-purchase-un1t'
// The ledger origin of the /trial page (UN1T_TRIAL_ORIGIN in trial-purchase-un1t-checkout.js).
const ORIGIN = 'web_trial'

export const UN1T_TRIAL_EXPIRY_MS = 24 * 60 * 60_000 + 45 * 60_000

const ROW_COLS = 'id, location_id, contact_id, created_at, un1t_user_id, un1t_product_id, product_name, amount_cents, currency, customer_email, customer_phone, first_name, last_name, attribution'
const TX_COLS = 'un1t_id, product_id, type, amount_cents, remote_created_at'
const TX_PAGE = 100
const UNIQUE_VIOLATION = '23505'

/**
 * @param {object} db service-role client
 * @param {{ now?: () => number, pageSize?: number }} [opts]
 * @returns {Promise<{ settled: number, expired: number, errors: number, raceLost: number,
 *   passwordPending: number, readFailed: boolean }>}
 */
export async function settleUn1tTrialPurchases(db, { now = () => Date.now(), pageSize = 200 } = {}) {
  const out = { settled: 0, expired: 0, errors: 0, raceLost: 0, passwordPending: 0, readFailed: false }
  const nowMs = now()

  let rows
  try {
    const { data, error } = await db.from('trial_purchases').select(ROW_COLS)
      .eq('payment_provider', 'un1t_online').eq('status', 'awaiting_payment')
      .order('created_at', { ascending: true }).range(0, pageSize - 1)
    if (error) throw Object.assign(new Error('open rows unreadable'), { code: error.code ?? null })
    rows = Array.isArray(data) ? data : []
  } catch (err) {
    logError(LOG, 'open un1t trial rows unreadable; nothing settled or expired', { code: err?.code ?? null, errClass: err?.name })
    return { ...out, errors: 1, readFailed: true }
  }
  if (rows.length === 0) return out

  // The transactions a row already took, at these locations (one read).
  const withUser = rows.filter((r) => r.un1t_user_id)
  const used = new Set()
  if (withUser.length > 0) {
    // A transaction an open row could take is dated at or after that row, and
    // a settled row's granted_at is its transaction's date: rows granted
    // before the oldest open row (rows are oldest first) cannot hold one.
    const oldest = withUser[0].created_at
    try {
      const { data, error } = await db.from('trial_purchases').select('location_id, payment_provider_ref')
        .eq('payment_provider', 'un1t_online')
        .in('location_id', [...new Set(withUser.map((r) => r.location_id))])
        .not('payment_provider_ref', 'is', null)
        .gte('granted_at', oldest)
      if (error) throw Object.assign(new Error('used refs unreadable'), { code: error.code ?? null })
      for (const r of data || []) used.add(`${r.location_id}:${r.payment_provider_ref}`)
    } catch (err) {
      logError(LOG, 'used un1t transaction refs unreadable; nothing settled or expired', { code: err?.code ?? null, errClass: err?.name })
      return { ...out, errors: 1, readFailed: true }
    }
  }

  // Pair each user's rows with their transactions.
  const settledIds = new Set()
  const unreadable = new Set()
  const groups = new Map()
  for (const r of withUser) {
    const key = `${r.location_id}:${r.un1t_user_id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  for (const group of groups.values()) {
    const { location_id: locationId, un1t_user_id: un1tUserId } = group[0]
    const since = group[0].created_at // rows are oldest first
    let txs
    try {
      const { data, error } = await db.from('un1t_transactions').select(TX_COLS)
        .eq('location_id', locationId)
        .eq('un1t_user_id', String(un1tUserId))
        .gte('remote_created_at', since)
        .order('remote_created_at', { ascending: true })
        .order('un1t_id', { ascending: true })
        .range(0, TX_PAGE - 1)
      if (error) throw Object.assign(new Error('transactions unreadable'), { code: error.code ?? null })
      txs = (Array.isArray(data) ? data : []).filter((t) => Number(t?.amount_cents) > 0 && t?.type !== 'sub_renewal' && t?.un1t_id)
    } catch (err) {
      out.errors++
      for (const r of group) unreadable.add(r.id)
      logWarn(LOG, 'un1t transactions unreadable; rows left open', { locationId, purchaseIds: group.map((r) => r.id), code: err?.code ?? null, errClass: err?.name })
      continue
    }

    const newestFirst = [...group].reverse()
    // Pass 1: the row's own product. Pass 2 (fallback): a transaction with no
    // product_id at all; a known different product is never a match.
    const take = (r, productOnly) => txs.find((t) => !used.has(`${locationId}:${t.un1t_id}`)
      && Date.parse(t.remote_created_at) >= Date.parse(r.created_at)
      && (productOnly
        ? (r.un1t_product_id && t.product_id === r.un1t_product_id)
        : t.product_id == null))
    for (const productOnly of [true, false]) {
      for (const r of newestFirst) {
        if (settledIds.has(r.id)) continue
        const t = take(r, productOnly)
        if (!t) continue
        used.add(`${locationId}:${t.un1t_id}`)
        settledIds.add(r.id) // matched: never expired this sweep, whatever the stamp did
        if (await settleRow(db, r, t, nowMs, out)) out.settled++
      }
    }
  }

  for (const r of rows) {
    if (settledIds.has(r.id) || unreadable.has(r.id)) continue
    if (Date.parse(r.created_at) + UN1T_TRIAL_EXPIRY_MS >= nowMs) continue
    let data, error
    try {
      ({ data, error } = await db.from('trial_purchases').update({ status: 'expired' })
        .eq('id', r.id).eq('status', 'awaiting_payment').select('id'))
    } catch (err) {
      error = err
    }
    if (error) {
      out.errors++
      logWarn(LOG, 'un1t trial row not expired', { purchaseId: r.id, locationId: r.location_id, code: error.code ?? null })
    } else if (Array.isArray(data) && data.length === 1) out.expired++
  }
  return out
}

/** The CAS stamp, then the side effects when it matched. true when this run settled the row. */
async function settleRow(db, row, tx, nowMs, out) {
  const ids = { purchaseId: row.id, locationId: row.location_id, transaction: tx.un1t_id }
  const grant = { ok: true, method: 'un1t_checkout', transaction: tx.un1t_id, at: new Date(nowMs).toISOString() }
  let data, error
  try {
    ({ data, error } = await db.from('trial_purchases').update({
      status: 'granted', granted_at: tx.remote_created_at,
      payment_status: 'paid', paid_at: tx.remote_created_at,
      payment_provider_ref: tx.un1t_id, grant,
    }).eq('id', row.id).eq('status', 'awaiting_payment').select('id'))
  } catch (err) {
    error = err
  }
  if (error?.code === UNIQUE_VIOLATION) {
    out.raceLost++
    logWarn(LOG, 'another sweep settled a row off this payment; this row left open', { ...ids, code: error.code })
    return false
  }
  if (error) {
    out.errors++
    logError(LOG, 'un1t trial row not settled; the next sweep tries again', { ...ids, code: error.code ?? null })
    return false
  }
  if (!Array.isArray(data) || data.length !== 1) {
    logWarn(LOG, 'un1t trial row no longer open; nothing sent', ids)
    return false
  }

  try {
    await sendWebsiteConversion(db, {
      locationId: row.location_id,
      eventName: 'Purchase',
      email: row.customer_email, phone: row.customer_phone,
      firstName: row.first_name, lastName: row.last_name,
      externalId: row.contact_id,
      eventSourceUrl: row.attribution?.event_source_url || undefined,
      eventId: `trialpurchase-${row.id}`,
      contentName: row.product_name,
      value: (row.amount_cents || 0) / 100, currency: row.currency || 'EUR',
      orderId: row.id, contentType: 'product',
      fbc: row.attribution?.fbc, fbp: row.attribution?.fbp,
    })
  } catch (err) {
    out.errors++
    logWarn(LOG, 'capi purchase failed', { ...ids, errClass: err?.name })
  }

  // The step reads the ledger itself: an account the CRM did not create
  // answers skipped_not_created.
  let verdict = null
  try {
    if (!row.contact_id) throw Object.assign(new Error('no contact on the row'), { code: 'no_contact' })
    const { settings } = await readUn1tWriteSettings(db, row.location_id)
    const { data: contact, error: contactErr } = await db.from('contacts')
      .select('id, email, first_name, last_name, name').eq('id', row.contact_id).maybeSingle()
    if (contactErr) throw Object.assign(new Error('contact unreadable'), { code: contactErr.code ?? null })
    if (!contact) throw Object.assign(new Error('contact missing'), { code: 'contact_missing' })
    // The explanation email is the trial buyer's (the studio's paid_trial
    // copy, product name), never the class funnel's "you are booked in".
    const copy = await readPaidTrialAccountEmailCopy(db, row.location_id)
    const res = await runSetPasswordStep(db, {
      locationId: row.location_id, contact, un1tUserId: row.un1t_user_id, request: null,
      settings, origin: ORIGIN, emailArgs: { kind: 'trial_purchase', productName: row.product_name, copy }, writer: null,
    })
    verdict = res?.forgotPassword ?? 'unknown'
    if (verdict !== 'done' && !String(verdict).startsWith('skipped_')) {
      logWarn(LOG, 'set-password step did not complete', {
        purchaseId: row.id, locationId: row.location_id, un1tUserId: row.un1t_user_id,
        forgotPassword: verdict, explanation: res?.explanation ?? null, code: res?.code ?? null,
      })
    }
  } catch (err) {
    out.errors++
    verdict = 'error'
    logWarn(LOG, 'set-password step failed after settling', { ...ids, code: err?.code ?? null, errClass: err?.name })
  }
  if (verdict !== 'done' && !String(verdict).startsWith('skipped_')) {
    out.passwordPending++
    // Best-effort, for the Approvals card: the row is already granted.
    try {
      const { error: noteErr } = await db.from('trial_purchases').update({ grant: { ...grant, set_password: verdict } }).eq('id', row.id)
      if (noteErr) logWarn(LOG, 'set-password verdict not recorded on the row', { ...ids, code: noteErr.code ?? null })
    } catch (err) {
      logWarn(LOG, 'set-password verdict not recorded on the row', { ...ids, errClass: err?.name })
    }
  }
  return true
}
