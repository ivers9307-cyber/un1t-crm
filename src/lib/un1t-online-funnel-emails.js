// UN1TWRITE.21 — the un1t.online funnel's two customer emails (spec D 6.5):
//   sendUn1tAccountEmail    the CRM made a un1t.online account for them and
//                           booked the class; a set-password code follows
//                           from un1t.online.
//   sendUn1tTrialUsedEmail  they have had the free trial, so nothing was
//                           booked: the options, and "reply to this email".
// Copy is the class_funnel block's (un1tFunnelEmailCopyFromBlocks), rendered
// by renderCopy (which strips em-dashes). Both go through the same
// transactional consent gate and sender as sendManualBookingConfirmEmail, with
// the studio inbox as Reply-To. No payment link is ever put in an email:
// hosted sessions expire, so staff (or Mia) send one on reply.
import { renderCopy } from '@/lib/cancellation-form/copy'
import { formatClassTime, confirmEmailHtml } from './manual-booking-confirm-copy.js'
import { sendTransactionalEmail, getLocationInboxReplyTo } from '@/lib/postmark'
import { transactionalEmailSuppression, loadTransactionalConsent } from '@/lib/transactional-consent'
import { getLocationZone, DEFAULT_TZ } from '@/lib/location-time'
import { logWarn } from '@/lib/log'
import { un1tFunnelEmailCopyFromBlocks, DEFAULT_FUNNEL_EMAIL_COPY, DEFAULT_TRIAL_USED_OPTIONS } from './un1t-online-funnel-copy.js'

async function send(db, { kind, locationId, contact, className, startsAt, blocks, studioName, address = null, zone = null, options = null }) {
  const email = typeof contact?.email === 'string' ? contact.email.trim() : ''
  if (!email) return { sent: false, channel: 'email', reason: 'no_email' }
  const { contact: consent, unreadable } = await loadTransactionalConsent(db, contact.id)
  if (unreadable) return { sent: false, channel: 'email', reason: 'consent_unreadable' }
  if (transactionalEmailSuppression(consent || contact)) return { sent: false, channel: 'email', reason: 'email_blocked' }

  const copy = un1tFunnelEmailCopyFromBlocks(blocks)
  const tz = zone || await getLocationZone(db, locationId).catch(() => DEFAULT_TZ)
  const optionsText = typeof options === 'string' && options.trim() ? options.trim() : DEFAULT_TRIAL_USED_OPTIONS
  const vars = {
    first_name: contact.first_name || (contact.name ? String(contact.name).split(' ')[0] : ''),
    class_name: className || 'your class',
    class_time: formatClassTime(startsAt, tz),
    studio_name: typeof studioName === 'string' ? studioName.trim() : '',
    address: address || '',
    options: optionsText,
  }
  const subjectKey = `${kind}_email_subject`
  const bodyKey = `${kind}_email_body`
  const subject = renderCopy(copy[subjectKey], vars) || renderCopy(DEFAULT_FUNNEL_EMAIL_COPY[subjectKey], vars)
  const body = renderCopy(copy[bodyKey], vars)
  try {
    const replyTo = await getLocationInboxReplyTo(locationId)
    await sendTransactionalEmail({
      to: email,
      subject,
      htmlBody: confirmEmailHtml(body),
      contactId: contact.id,
      locationId,
      tag: kind === 'account' ? 'class_booking_confirmation' : 'class_trial_used',
      replyTo: replyTo || undefined,
    })
    return { sent: true, channel: 'email' }
  } catch (e) {
    logWarn('un1t-funnel-email', `${kind} email failed`, { locationId, err: e })
    return { sent: false, channel: 'email', reason: 'send_error' }
  }
}

/** @returns {Promise<{ sent: boolean, channel: 'email', reason?: string }>} */
export function sendUn1tAccountEmail(db, args) {
  return send(db, { ...args, kind: 'account' })
}

/** @returns {Promise<{ sent: boolean, channel: 'email', reason?: string }>} */
export function sendUn1tTrialUsedEmail(db, args) {
  return send(db, { ...args, kind: 'trial_used' })
}
