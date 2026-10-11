// MANUALCONFIRM.1 — the email a customer gets when staff approve a booking
// made off a hand-written timetable (MANUALFUNNEL.1: a studio with no
// Glofox, Hatch Street). Until now approving recorded the booking and told
// the customer nothing; the studio has no WhatsApp number, so email is the
// one channel it has.
//
// Customer copy is operator-editable (CLAUDE.md): the class_funnel block's
// `confirm_email_subject` / `confirm_email_body`, edited in the landing-page
// editor beside the timetable, defaults in manual-booking-confirm-copy.js
// (that module has no server imports so the editor can read them).
// Placeholders are rendered by the cancellation form's renderCopy, which
// also strips em-dashes.
//
// Sent through sendTransactionalEmail (Postmark transactional stream, the
// location's own sender, an email_sends row) and gated like every other
// transactional send (transactionalEmailSuppression: bounced/complained
// addresses and administrative opt-outs). Best-effort: the caller records
// the result on the card and never fails the approval over it.
import { renderCopy } from '@/lib/cancellation-form/copy'
import { DEFAULT_MANUAL_CONFIRM_EMAIL, formatClassTime, manualConfirmEmailFromBlocks, confirmEmailHtml } from './manual-booking-confirm-copy.js'
import { sendTransactionalEmail, getLocationInboxReplyTo } from '@/lib/postmark'
import { transactionalEmailSuppression, loadTransactionalConsent } from '@/lib/transactional-consent'
import { logWarn } from '@/lib/log'
import { getLocationBranding } from '@/lib/location-branding'

/**
 * Email the customer that staff have booked them in.
 * @returns {Promise<{ sent: boolean, channel: 'email', reason?: string }>}
 *   reasons: no_email, email_blocked, consent_unreadable, send_error
 */
export async function sendManualBookingConfirmEmail(db, { locationId, contact, className, startsAt, blocks, studioName, address, requestId = null }) {
  const email = typeof contact?.email === 'string' ? contact.email.trim() : ''
  if (!email) return { sent: false, channel: 'email', reason: 'no_email' }
  // The gate reads preferences the caller's select may not carry; load them.
  const { contact: consent, unreadable } = await loadTransactionalConsent(db, contact.id)
  if (unreadable) return { sent: false, channel: 'email', reason: 'consent_unreadable' }
  const suppression = transactionalEmailSuppression(consent || contact)
  if (suppression) return { sent: false, channel: 'email', reason: 'email_blocked' }

  const tpl = manualConfirmEmailFromBlocks(blocks)
  // W1.S1a — {studio_name} is the studio's own name (the caller passes
  // locations.name). Only when it is missing does this resolve the location's
  // name, then its brand: never a fixed gym's name. The resolver never throws.
  let studio = typeof studioName === 'string' ? studioName.trim() : ''
  if (!studio) {
    const branding = await getLocationBranding(db, locationId)
    studio = branding.locationName || branding.companyName || ''
  }
  const vars = {
    first_name: contact.first_name || (contact.name ? String(contact.name).split(' ')[0] : ''),
    class_name: className || 'your class',
    class_time: formatClassTime(startsAt),
    studio_name: studio,
    address: address || '',
  }
  const subject = renderCopy(tpl.subject, vars) || renderCopy(DEFAULT_MANUAL_CONFIRM_EMAIL.subject, vars)
  const body = renderCopy(tpl.body, vars)
  try {
    // The default copy says "reply to this email": without a Reply-To the
    // reply would go to the global From mailbox, which nobody at the studio
    // reads. The studio's inbox address routes it into the unified inbox.
    // Best-effort (null on any miss → Postmark sets no Reply-To).
    const replyTo = await getLocationInboxReplyTo(locationId)
    await sendTransactionalEmail({
      to: email,
      subject,
      htmlBody: confirmEmailHtml(body),
      contactId: contact.id,
      locationId,
      tag: 'class_booking_confirmation',
      replyTo: replyTo || undefined,
    })
    return { sent: true, channel: 'email' }
  } catch (e) {
    logWarn('manual-booking-confirm', 'confirmation email failed', { requestId, err: e })
    return { sent: false, channel: 'email', reason: 'send_error' }
  }
}

export { DEFAULT_MANUAL_CONFIRM_EMAIL, formatClassTime, manualConfirmEmailFromBlocks, confirmEmailHtml }
