// CHARITY.3 — the donor's receipt for a paid donation (donations row).
//
// buildDonationReceiptDefaults() is the shell slots in the shape
// buildGapDefaults (race-confirmations.js) returns, so resolveEventEmail can
// brand it and drop the operator's subject/intro (race_events.charity
// receipt_subject / receipt_intro, riding the 'donation_receipt' kind) in.
//
// WHERE THE REQUIRED STATEMENTS LIVE. resolveEventEmail replaces footerHtml
// with the operator's intro when one is set, so nothing the donor is owed may
// sit in the footer. The match line and the pass-on sentence ride introHtml,
// "This is not a charity tax receipt." rides afterInfoHtml: both always
// render. The footer is only a thank-you the operator's own intro may replace.
//
// sendDonationReceipt() is send-once on receipt_email_sent_at, stamped AFTER
// the send (see stampSendOnce in race-confirmations.js for why). A suppression
// stamps both columns 'suppressed' (nothing will retry it); a Postmark failure
// stamps only receipt_email_status = 'failed' so the next observation of the
// paid donation retries. Never throws.
//
// The donation row passed in must be the PAID row: match_multiplier is the
// snapshot markDonationPaymentStatus wrote, and a stale awaiting_payment row
// still carries the column default of 1.

import { resolveEventEmail } from '@/lib/event-email'
import { resolveEventCommsLocation } from '@/lib/event-comms-location'
import { checkTransactionalConsent } from '@/lib/transactional-consent'
import { sendTransactionalEmail } from '@/lib/postmark'
import { getLocationBranding } from '@/lib/location-branding'
import { resolveCharitySettings, renderCharityCopy, formatCents } from '@/lib/charity-donations'
import { logError } from '@/lib/log'

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Default shell slots for the donation receipt.
 * @param {{ firstName, brand, charity, raceName, locationName, amountLabel,
 *   matchedLabel, multiplier, subject }} ctx  plain strings, escaped here
 * @returns {{ subject, intro, introHtml, heading, infoRows, afterInfoHtml,
 *   footerHtml, memberQrs, locationName }}
 */
export function buildDonationReceiptDefaults(ctx) {
  const who = escapeHtml(ctx.firstName || 'there')
  const charity = escapeHtml(ctx.charity || 'the charity')
  const brand = escapeHtml(ctx.brand || '')
  const matched = Number(ctx.multiplier) > 1
  const amount = escapeHtml(ctx.amountLabel)
  const row = (label, value) => `    <tr><td style="padding:8px 0;color:#666;width:120px">${label}</td><td style="padding:8px 0;font-weight:600">${escapeHtml(value)}</td></tr>`
  const infoRows = [
    ctx.raceName ? row('Event', ctx.raceName) : '',
    row('Donation', ctx.amountLabel),
    matched ? row('Matched', ctx.matchedLabel) : '',
    row('Charity', ctx.charity || ''),
  ].filter(Boolean).join('\n')

  const matchLine = matched
    ? `Your <strong>${amount}</strong> becomes <strong>${escapeHtml(ctx.matchedLabel)}</strong> for ${charity}. `
    : `Thank you for your <strong>${amount}</strong> donation to ${charity}. `
  // With no configured brand there is no subject for "passes", so the
  // sentence takes the passive form rather than a made-up one.
  const passOn = brand
    ? (matched
      ? `${brand} passes every donation, matched, to ${charity} after the event.`
      : `${brand} passes every donation to ${charity} after the event.`)
    : (matched
      ? `Every donation, matched, is passed to ${charity} after the event.`
      : `Every donation is passed to ${charity} after the event.`)
  const introHtml = `${matchLine}${passOn}`

  return {
    subject: ctx.subject || `Thank you for your donation to ${ctx.charity || 'the charity'}`,
    heading: `Thank you, ${who}.`,
    intro: introHtml,
    introHtml,
    infoRows,
    afterInfoHtml: `\n  <p style="margin:0 0 16px;color:#666;font-size:13px">This is not a charity tax receipt.</p>`,
    footerHtml: `<strong>Thank you for giving.</strong> Keep this email as your record of the donation.`,
    memberQrs: [],
    locationName: ctx.locationName || '',
  }
}

async function stampReceipt(db, donation, fields, { onlyIfUnsent }) {
  let q = db.from('donations').update(fields).eq('id', donation.id)
  if (onlyIfUnsent) q = q.is('receipt_email_sent_at', null)
  const { data, error } = await q.select('id')
  if (error) {
    logError('donation-receipt', 'receipt stamp NOT written; a later observation of this paid donation may send the receipt again', {
      err: error, donationId: donation.id, fields: Object.keys(fields),
    })
    return false
  }
  if (onlyIfUnsent && 'receipt_email_sent_at' in fields && Array.isArray(data) && data.length === 0) {
    logError('donation-receipt', 'a concurrent observation had already stamped this receipt; the donor received a DUPLICATE', { donationId: donation.id })
  }
  return true
}

/**
 * Email the donor their receipt. Send-once on receipt_email_sent_at.
 * @param {{ db: object, donation: object, race: object, contact?: object|null,
 *   now?: () => string }} args
 * @returns {Promise<{ status: 'sent'|'suppressed'|'failed'|'skipped', reason?: string }>}
 */
export async function sendDonationReceipt({ db, donation, race, contact = null, now = () => new Date().toISOString() }) {
  try {
    const to = String(donation?.donor_email || '').trim()
    if (!to) return { status: 'skipped', reason: 'no_email' }
    const contactId = donation.contact_id || contact?.id || null

    const gate = await checkTransactionalConsent({
      db, contactId, channel: 'email', module: 'donation-receipt', meta: { donationId: donation.id }, unrecoverable: true,
    })
    if (!gate.allowed) {
      logError('donation-receipt', 'donation receipt SUPPRESSED by consent state and nothing will retry it', {
        donationId: donation.id, reason: gate.reason,
      })
      await stampReceipt(db, donation, { receipt_email_sent_at: now(), receipt_email_status: 'suppressed' }, { onlyIfUnsent: true })
      return { status: 'suppressed', reason: gate.reason || undefined }
    }

    // A resolver failure never costs the receipt: send from the event location.
    let commsLocation = null
    try {
      commsLocation = await resolveEventCommsLocation(db, {
        location_id: race.location_id, host_id: race.host_id, sending_location_id: race.sending_location_id,
      })
    } catch (e) {
      logError('donation-receipt', 'comms location resolver threw; sending from the event location', { err: e, donationId: donation.id })
    }
    const locationId = commsLocation?.id || race.location_id || null

    const settings = resolveCharitySettings(race)
    const { companyName } = await getLocationBranding(db, locationId)
    const multiplier = Number(donation.match_multiplier) > 1 ? Number(donation.match_multiplier) : 1
    const firstName = String(contact?.first_name || donation.donor_name || '').trim().split(/\s+/)[0] || ''
    const amountLabel = formatCents(donation.amount_cents, donation.currency)
    const matchedLabel = formatCents(Math.round(donation.amount_cents * multiplier), donation.currency)
    const vars = { charity: settings.name, brand: companyName || '', first_name: firstName, amount: amountLabel, matched: matchedLabel }

    const subjectCopy = renderCharityCopy(settings.receipt_subject, vars)
    const ctx = {
      firstName,
      brand: companyName || '',
      charity: settings.name,
      raceName: race.name,
      locationName: commsLocation?.name || '',
      amountLabel,
      matchedLabel,
      multiplier,
      subject: subjectCopy,
    }
    const mergeContact = contact || { first_name: firstName, name: donation.donor_name, email: to }
    const extras = { event_name: race.name, team_name: '', when: '', location: ctx.locationName }
    const receiptRace = {
      ...race,
      donation_receipt_email_subject: subjectCopy,
      donation_receipt_email_intro: renderCharityCopy(settings.receipt_intro, vars),
    }

    let subject
    let htmlBody
    try {
      ;({ subject, htmlBody } = await resolveEventEmail({
        db, kind: 'donation_receipt', race: receiptRace, contact: mergeContact, extras,
        defaults: buildDonationReceiptDefaults(ctx), brandLocationId: locationId,
      }))
      await sendTransactionalEmail({ to, subject, htmlBody, contactId, locationId, tag: 'donation-receipt' })
    } catch (e) {
      logError('donation-receipt', 'donation receipt failed to send', { err: e, donationId: donation.id })
      await stampReceipt(db, donation, { receipt_email_status: 'failed' }, { onlyIfUnsent: true })
      return { status: 'failed', reason: e?.message || 'failed' }
    }
    await stampReceipt(db, donation, { receipt_email_sent_at: now(), receipt_email_status: 'sent' }, { onlyIfUnsent: true })
    return { status: 'sent' }
  } catch (e) {
    logError('donation-receipt', 'donation receipt crashed before sending', { err: e, donationId: donation?.id })
    return { status: 'failed', reason: e?.message || 'failed' }
  }
}
