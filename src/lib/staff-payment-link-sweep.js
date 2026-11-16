// PAYLINK.1 — mark staff payment links paid off the un1t_transactions mirror.
// The customer pays on un1t.online's hosted checkout; the CRM only learns of it
// when the un1t-online-sync mirrors the transaction. Per studio, each run:
//   1. reads the links that can still be settled: live rows (sent, opened,
//      checkout_started) and `expired` rows less than 3 days past expiry (a
//      payment mirrored late still settles them). `revoked` rows are never
//      settled (a newer link replaced them); a `checkout_free` row moved no
//      money (Ruling H) and is skipped;
//   2. reads the mirror's transactions for those users since the earliest link;
//   3. oldest link first, matches each to a transaction by isPaymentForLink
//      (each transaction pays at most one link) and settles it with a CAS on
//      the status as read, judging the rows touched (0 rows = raced);
//   4. a settled link whose account the CRM created (terms_accepted_at set)
//      gets the set-password step, a failure counted in passwordPending and
//      noted on the row as last_error 'set_password:<verdict>';
//   5. a live link past expires_at with no payment becomes `expired` (CAS).
// Never throws. `ok` is false only when a read failed; then nothing is written.
// Logs carry ids and codes only.
import { LIVE_STATUSES, isPaymentForLink } from '@/lib/staff-payment-links'
import { runSetPasswordStep } from '@/lib/un1t-online-account'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { sendUn1tAccountEmail } from '@/lib/un1t-online-funnel-emails'
import { clockMs } from '@/lib/un1t-offer-purchases'
import { logError, logWarn } from '@/lib/log'

const LOG = 'paylink-sweep'
const ORIGIN = 'staff_payment_link'
const PAGE = 500
const LATE_PAYMENT_GRACE_MS = 3 * 24 * 60 * 60_000
const FREE_CHECKOUT = 'checkout_free'

export const PAYLINK_SET_PASSWORD_SUBJECT = 'Your UN1T Hatch Street account'
export const PAYLINK_SET_PASSWORD_BODY = "Thanks for your purchase at UN1T Hatch Street. We've set up your un1t.online account. Check your inbox for a code to set your password, then book your first class in the app."

const LINK_COLS = 'id, location_id, contact_id, status, un1t_user_id, un1t_product_id, product_title, created_at, expires_at, terms_accepted_at, last_error'
const TX_COLS = 'un1t_id, un1t_user_id, product_id, type, amount_cents, refunded, remote_created_at'

class ReadFailed extends Error {
  constructor(what, code) {
    super(`${what} unreadable`)
    this.name = 'ReadFailed'
    this.what = what
    this.code = code ?? null
  }
}

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
 * @returns {Promise<{ ok: boolean, checked: number, paid: number, expired: number, raced: number, failed: number, passwordPending: number }>}
 */
export async function sweepStaffPaymentLinks(db, locationId, { now } = {}) {
  const out = { ok: true, checked: 0, paid: 0, expired: 0, raced: 0, failed: 0, passwordPending: 0 }
  try {
    return await sweep(db, locationId, clockMs(now), out)
  } catch (err) {
    if (err instanceof ReadFailed) {
      logError(LOG, `${err.what} unreadable; nothing settled or expired`, { locationId, code: err.code })
    } else {
      logError(LOG, 'payment link sweep threw', { locationId, code: err?.code ?? null, errClass: err?.name })
    }
    return { ...out, ok: false }
  }
}

async function sweep(db, locationId, nowMs, out) {
  const links = (await readAll(() => db.from('staff_payment_links').select(LINK_COLS)
    .eq('location_id', locationId)
    .not('un1t_user_id', 'is', null)
    .in('status', [...LIVE_STATUSES, 'expired'])
    .order('id', { ascending: true }), 'payment links'))
    .filter((l) => l.last_error !== FREE_CHECKOUT
      && (l.status !== 'expired' || ms(l.expires_at) + LATE_PAYMENT_GRACE_MS >= nowMs))
    .sort((a, b) => (ms(a.created_at) - ms(b.created_at)) || String(a.id).localeCompare(String(b.id)))
  out.checked = links.length
  if (links.length === 0) return out

  const users = [...new Set(links.map((l) => String(l.un1t_user_id)))]
  const since = iso(Math.min(...links.map((l) => ms(l.created_at)).filter(Number.isFinite)))
  const txs = await readAll(() => db.from('un1t_transactions').select(TX_COLS)
    .eq('location_id', locationId)
    .in('un1t_user_id', users)
    .gte('remote_created_at', since)
    .order('remote_created_at', { ascending: true })
    .order('un1t_id', { ascending: true }), 'un1t transactions')

  const usedTx = new Set()
  const settled = new Set()
  for (const link of links) {
    const t = txs.find((x) => !usedTx.has(String(x.un1t_id)) && isPaymentForLink(link, x))
    if (!t) continue
    usedTx.add(String(t.un1t_id))
    settled.add(link.id)
    await settleLink(db, link, t, nowMs, out)
  }

  for (const link of links) {
    if (settled.has(link.id) || link.status === 'expired') continue
    if (!(ms(link.expires_at) <= nowMs)) continue
    const { data, error } = await casUpdate(db, link, { status: 'expired', updated_at: iso(nowMs) })
    if (error) {
      out.failed++
      logError(LOG, 'link not expired', { locationId, linkId: link.id, code: error.code ?? null })
    } else if (data.length === 1) out.expired++
    else out.raced++
  }
  return out
}

function iso(v) { return new Date(v).toISOString() }

async function casUpdate(db, link, patch) {
  try {
    const { data, error } = await db.from('staff_payment_links').update(patch)
      .eq('id', link.id).eq('status', link.status).select('id')
    if (error) return { data: [], error }
    return { data: Array.isArray(data) ? data : [], error: null }
  } catch (err) {
    return { data: [], error: err }
  }
}

async function settleLink(db, link, t, nowMs, out) {
  const ids = { locationId: link.location_id, linkId: link.id, transaction: String(t.un1t_id) }
  const { data, error } = await casUpdate(db, link, {
    status: 'paid', paid_transaction_id: String(t.un1t_id), paid_at: t.remote_created_at,
    last_error: null, updated_at: iso(nowMs),
  })
  if (error) {
    out.failed++
    logError(LOG, 'link not marked paid; the next run tries again', { ...ids, code: error.code ?? null })
    return
  }
  if (data.length !== 1) {
    out.raced++
    logWarn(LOG, 'link no longer in the status read; nothing sent', ids)
    return
  }
  out.paid++
  if (!link.terms_accepted_at) return // an account the CRM did not create: nothing to set up

  let verdict
  try {
    if (!link.contact_id) throw Object.assign(new Error('no contact on the link'), { code: 'no_contact' })
    const { settings } = await readUn1tWriteSettings(db, link.location_id)
    const { data: contact, error: contactErr } = await db.from('contacts')
      .select('id, email, first_name, last_name, name').eq('id', link.contact_id).maybeSingle()
    if (contactErr) throw Object.assign(new Error('contact unreadable'), { code: contactErr.code ?? null })
    if (!contact) throw Object.assign(new Error('contact missing'), { code: 'contact_missing' })
    const res = await runSetPasswordStep(db, {
      locationId: link.location_id, contact, un1tUserId: String(link.un1t_user_id), request: null,
      settings, origin: ORIGIN,
      emailArgs: { kind: 'trial_purchase', productName: link.product_title, copy: { subject: PAYLINK_SET_PASSWORD_SUBJECT, body: PAYLINK_SET_PASSWORD_BODY } },
      writer: null,
    }, { sendUn1tAccountEmail })
    verdict = res?.forgotPassword ?? 'unknown'
    if (verdict !== 'done' && !String(verdict).startsWith('skipped_')) {
      logWarn(LOG, 'set-password step did not complete', { ...ids, forgotPassword: verdict, code: res?.code ?? null })
    }
  } catch (err) {
    verdict = 'error'
    logError(LOG, 'set-password step failed after settling', { ...ids, code: err?.code ?? null, errClass: err?.name })
  }
  if (verdict !== 'done' && !String(verdict).startsWith('skipped_')) {
    out.passwordPending++
    try {
      const { error: noteErr } = await db.from('staff_payment_links')
        .update({ last_error: `set_password:${verdict}` }).eq('id', link.id)
      if (noteErr) logWarn(LOG, 'set-password verdict not recorded on the link', { ...ids, code: noteErr.code ?? null })
    } catch (err) {
      logWarn(LOG, 'set-password verdict not recorded on the link', { ...ids, errClass: err?.name })
    }
  }
}
