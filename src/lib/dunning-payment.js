// PAYLINK.2 — the `payment` object an overdue-payment reminder run carries on
// sequence_enrollments.metadata. Fetched ONCE when the run starts (both the
// invoice webhook's auto-enrol and the manual "Send payment reminder" go
// through capturePaymentForRun) and read back by the WhatsApp and email step
// senders, which never call Glofox themselves. One Glofox call per run.
//
// Shape (jsonb, snake_case like the rest of metadata):
//   { invoice_id, link, link_suffix, amount, currency, retriable, fetched_at, error }
// `link` is null unless Glofox said the invoice is payable by link; the
// senders then fall back to the card-update wording (email) or a recorded
// skip (WhatsApp, whose approved template needs the button suffix).
//
// PAYLINK.4 — refreshActiveRunPayment() writes a fresh `payment` onto an
// already-ACTIVE run's enrolment when a new failed invoice arrives while an
// earlier reminder run is still live, so the remaining steps chase the
// newest invoice, not a stale one.

import { glofoxCredentialsForLocation, getGlofoxInvoicePaymentLink, getGlofoxOverdueInvoices } from '@/lib/glofox'
import { isTransactionalEnrolment } from '@/lib/sequences/steps'
import { setEnrollmentStatus } from '@/lib/sequences/scheduler'
import { formatMoneyMinor } from '@/lib/money-format'
import { logWarn } from '@/lib/log'

const CARD_UPDATE_WORDING = 'update your card in the Glofox app'

function lastPathSegment(url) {
  const idx = url.lastIndexOf('/')
  return idx === -1 ? url : url.slice(idx + 1)
}

/** Pure: helper result → the metadata object. */
export function paymentRunMetadata(result, { invoiceId, now = new Date() } = {}) {
  const payable = Boolean(result?.ok && result?.retriable && result?.link)
  const retriable = result?.retriable === true
  let error
  if (payable) error = null
  else if (result?.ok && retriable) error = 'no_payment_link'
  else if (result?.ok && !retriable) error = 'not_retriable'
  else error = result?.error || 'unknown'
  return {
    invoice_id: invoiceId || result?.invoiceId || null,
    link: payable ? result.link : null,
    link_suffix: payable ? lastPathSegment(result.link) : null,
    amount: payable ? formatMoneyMinor(result.amountCents, result.currency || 'EUR') : '',
    currency: payable ? (result.currency || null) : null,
    retriable,
    fetched_at: now.toISOString(),
    error,
  }
}

/**
 * IO: resolve creds + member id, ask Glofox, return { payment }. Never
 * throws — a run must start even when the link cannot be fetched.
 */
export async function capturePaymentForRun(db, { locationId, contactId, invoiceId, glofoxUserId } = {}) {
  const failed = (error) => ({ payment: paymentRunMetadata({ ok: false, error }, { invoiceId: invoiceId || null }) })
  try {
    if (!invoiceId) return failed('no_invoice_id')
    const creds = await glofoxCredentialsForLocation(db, locationId)
    if (!creds?.branchId || !creds?.apiKey || !creds?.apiToken) return failed('no_glofox_credentials')
    let memberId = glofoxUserId || null
    if (!memberId && contactId) {
      const { data, error } = await db.from('contacts').select('glofox_member_id').eq('id', contactId).maybeSingle()
      if (error) {
        logWarn('dunning-payment', 'contact lookup failed', { contactId, invoiceId, err: error?.message })
        return failed('contact_lookup_failed')
      }
      memberId = data?.glofox_member_id || null
    }
    if (!memberId) return failed('no_glofox_member_id')
    const result = await getGlofoxInvoicePaymentLink(creds, { memberId, invoiceId })
    if (!result.ok) logWarn('dunning-payment', 'payment link not fetched', { contactId, invoiceId, error: result.error })
    const payment = paymentRunMetadata(result, { invoiceId })
    if (payment.link_suffix && payment.link_suffix !== payment.invoice_id) {
      logWarn('dunning-payment', 'pay link suffix differs from invoice id', { invoiceId, suffix: payment.link_suffix })
    }
    return { payment }
  } catch (e) {
    logWarn('dunning-payment', 'capturePaymentForRun threw', { contactId, invoiceId, err: e?.message })
    return failed(e?.message || 'threw')
  }
}

/** Pure: the payment object off an enrolment row, or null. */
export function paymentFromEnrollment(enrollment) {
  const p = enrollment?.metadata?.payment
  return p && typeof p === 'object' && !Array.isArray(p) ? p : null
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Pure: the `{{payment_cta}}` fragment. */
export function paymentCtaHtml(payment) {
  const link = payment?.link
  if (typeof link !== 'string' || !link.startsWith('https://')) return CARD_UPDATE_WORDING
  return `<a href="${escapeHtml(link)}">pay it now</a>, it takes a few seconds, or ${CARD_UPDATE_WORDING}`
}

/** Pure: the `{{pay_amount_phrase}}` fragment — ' of €209' or ''. */
export function payAmountPhrase(payment) {
  const amount = payment?.amount
  return amount ? ` of ${amount}` : ''
}

/**
 * PAYLINK.4 — write a fresh `payment` onto the contact's ACTIVE enrolment on
 * this sequence (read-merge-write; guarded on status='active'). Used when a
 * new failed invoice arrives while an earlier reminder run is still live, so
 * the remaining steps chase the newest invoice, not a stale one. Returns
 * { refreshed: 0|1 }. Never throws.
 */
export async function refreshActiveRunPayment(db, { sequenceId, contactId, payment } = {}) {
  try {
    if (!sequenceId || !contactId || !payment) return { refreshed: 0 }
    const { data: row, error } = await db
      .from('sequence_enrollments')
      .select('id, metadata')
      .eq('sequence_id', sequenceId).eq('contact_id', contactId).eq('status', 'active')
      .order('enrolled_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error || !row) return { refreshed: 0 }
    const prev = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}
    // PAYLINK.4b — never downgrade a live link: if the newly-captured
    // payment has no link but the run is already holding one FOR THE SAME
    // INVOICE, keep the existing one rather than blanking it (a transient
    // Glofox failure on the refresh call must not cost a member their pay
    // link). A genuinely newer invoice always overwrites, link or not.
    // PAYLINK.5b — a payment with NO invoice id at all (e.g. a manual
    // "Send payment reminder" click on a payment-slipping member with no
    // PAST_DUE invoice) is not "a different invoice" either — it is "we
    // have nothing to point this run at" — so it must keep the existing
    // link too, not just the same-invoice case. Widen the comparison: keep
    // whenever the new payment carries no invoice id, OR the invoice ids
    // match.
    const prevPayment = prev.payment && typeof prev.payment === 'object' ? prev.payment : null
    if (!payment.link && prevPayment?.link && (!payment.invoice_id || prevPayment?.invoice_id === payment.invoice_id)) {
      return { refreshed: 0, reason: 'kept_existing_link' }
    }
    const { data: updated, error: updErr } = await db
      .from('sequence_enrollments')
      .update({ metadata: { ...prev, payment } })
      .eq('id', row.id).eq('status', 'active')
      .select('id')
    if (updErr) { logWarn('dunning-payment', 'refreshActiveRunPayment update failed', { contactId, err: updErr.message }); return { refreshed: 0 } }
    return { refreshed: (updated || []).length }
  } catch (e) {
    logWarn('dunning-payment', 'refreshActiveRunPayment threw', { contactId, err: e?.message })
    return { refreshed: 0 }
  }
}


// ── PRESEND.1 — do not chase an invoice that is already settled ──────
//
// An overdue-payment run is exited today by exactly one thing: the Glofox
// INVOICE_UPDATED webhook (PAID / FORGIVEN -> exitDunningForContact, scoped
// to the invoice). That is a single point of failure with a member-visible
// blast radius. If the webhook is delayed, dropped, or the receiver is down,
// somebody who paid on day 2 still gets the day-3 email and the day-7
// WhatsApp chasing money they no longer owe.
//
// So immediately before each dunning send we re-ask Glofox whether THIS
// invoice is still on the member's overdue list. Two rules hold it in place:
//
//   1. It only ever ADDS a stop. Every "we cannot tell" — not a dunning run,
//      no invoice on the run, no Glofox member id on the contact, no
//      credentials at the location — proceeds. The gate never blocks a run
//      for missing data.
//   2. It FAILS OPEN. A timeout, a 403, a 500, an unreadable body: proceed
//      and log. Silencing a legitimate reminder because Glofox blipped is a
//      worse failure than the one we are fixing, and the webhook remains the
//      primary exit either way.
//
// Note the asymmetry with the helper it calls: getGlofoxOverdueInvoices
// treats a 200-with-success:false as a FAILURE rather than an empty list,
// precisely because "empty list" here means "exit this run".
export const PRESEND_EXIT_REASON = 'invoice_settled_presend'

const PROCEED = Object.freeze({ proceed: true })

/**
 * @param db supabase client (reads the location's Glofox credentials)
 * @param {{ enrollment, contact, sequence }} ctx
 * @returns {Promise<{proceed:true}|{proceed:false, reason:string}>}  never throws
 */
export async function dunningPresendGate(db, { enrollment, contact, sequence } = {}) {
  try {
    const invoiceId = (() => {
      const v = paymentFromEnrollment(enrollment)?.invoice_id
      return typeof v === 'string' ? v.trim() : ''
    })()
    if (!invoiceId) return PROCEED
    const memberId = contact?.glofox_member_id
    if (!memberId) return PROCEED
    if (!isTransactionalEnrolment(enrollment)) return PROCEED

    const creds = await glofoxCredentialsForLocation(db, sequence?.location_id || contact?.location_id)
    if (!creds?.branchId || !creds?.apiKey || !creds?.apiToken) return PROCEED

    const res = await getGlofoxOverdueInvoices(creds, { memberId })
    if (!res.ok) {
      logWarn('dunning-payment', 'pre-send overdue check failed, sending anyway', {
        contactId: contact?.id, invoiceId, status: res.status, error: res.error,
      })
      return PROCEED
    }
    if (res.invoiceIds.includes(invoiceId)) return PROCEED

    // Settled (or no longer chaseable). Exit the run through the same helper
    // the webhook path uses, so an operator sees one exit reason either way.
    try {
      await setEnrollmentStatus({ enrollmentId: enrollment.id, status: 'exited', reason: PRESEND_EXIT_REASON })
    } catch (e) {
      // The write failed, so the run is still live and the next tick will
      // reach this step again. Do NOT report a stop we could not record —
      // claiming one would skip this send and then send the next step
      // anyway, which is the worst of both.
      logWarn('dunning-payment', 'pre-send exit failed, sending anyway', {
        contactId: contact?.id, invoiceId, err: e?.message,
      })
      return PROCEED
    }
    return { proceed: false, reason: 'invoice no longer overdue' }
  } catch (e) {
    logWarn('dunning-payment', 'dunningPresendGate threw', { contactId: contact?.id, err: e?.message })
    return PROCEED
  }
}
