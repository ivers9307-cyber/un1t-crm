// PAYLINK.1 — the `payment` object an overdue-payment reminder run carries on
// sequence_enrollments.metadata. Fetched ONCE when the run starts (both the
// invoice webhook's auto-enrol and the manual "Send payment reminder" go
// through capturePaymentForRun) and read back by the WhatsApp and email step
// senders, which never call Glofox themselves. One Glofox call per run.
//
// Shape (jsonb, snake_case like the rest of metadata):
//   { invoice_id, link, amount, currency, retriable, fetched_at, error }
// `link` is null unless Glofox said the invoice is payable by link; the
// senders then fall back to the card-update wording (email) or a recorded
// skip (WhatsApp, whose approved template needs the button suffix).

import { glofoxCredentialsForLocation, getGlofoxInvoicePaymentLink } from '@/lib/glofox'
import { formatMoneyMinor } from '@/lib/money-format'
import { logWarn } from '@/lib/log'

const CARD_UPDATE_WORDING = 'update your card in the Glofox app'

/** Pure: helper result → the metadata object. */
export function paymentRunMetadata(result, { invoiceId, now = new Date() } = {}) {
  const payable = Boolean(result?.ok && result?.retriable && result?.link)
  return {
    invoice_id: invoiceId || result?.invoiceId || null,
    link: payable ? result.link : null,
    amount: payable ? formatMoneyMinor(result.amountCents, result.currency || 'EUR') : '',
    currency: payable ? (result.currency || null) : null,
    retriable: payable,
    fetched_at: now.toISOString(),
    error: result?.ok ? (payable ? null : 'not_retriable') : (result?.error || 'unknown'),
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
      const { data } = await db.from('contacts').select('glofox_member_id').eq('id', contactId).maybeSingle()
      memberId = data?.glofox_member_id || null
    }
    if (!memberId) return failed('no_glofox_member_id')
    const result = await getGlofoxInvoicePaymentLink(creds, { memberId, invoiceId })
    if (!result.ok) logWarn('dunning-payment', 'payment link not fetched', { contactId, invoiceId, error: result.error })
    return { payment: paymentRunMetadata(result, { invoiceId }) }
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
  if (!link) return CARD_UPDATE_WORDING
  return `<a href="${escapeHtml(link)}">pay it now here</a>, it takes a few seconds, or ${CARD_UPDATE_WORDING}`
}

/** Pure: the `{{pay_amount_phrase}}` fragment — ' of €209' or ''. */
export function payAmountPhrase(payment) {
  const amount = payment?.amount
  return amount ? ` of ${amount}` : ''
}
