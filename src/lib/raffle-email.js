// RAFFLE.1 — the buyer's email listing their raffle ticket numbers.
//
// Modelled on sendDonationReceipt (src/lib/donation-receipt.js). The email is
// administrative (the buyer just paid for these tickets), so the gate is
// checkTransactionalConsent: bounced/complained stop it, leaving a marketing
// list does not. A guest has no contact_id, so there is no consent row to
// read; Postmark's own suppression list still applies at send time.
//
// Stamps raffle_sales.email_status ('sent' | 'suppressed' | 'failed') and
// email_sent_at. Never throws: a failed email must never fail the sale, which
// is already recorded by the time this runs.

import { resolveEventEmail } from '@/lib/event-email'
import { resolveEventCommsLocation } from '@/lib/event-comms-location'
import { checkTransactionalConsent } from '@/lib/transactional-consent'
import { sendTransactionalEmail } from '@/lib/postmark'
import { formatTicketRange, formatEuros } from '@/lib/raffle-format'
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
 * Default shell slots for the ticket email.
 * @param {{ firstName: string, raceName: string, raffleName: string,
 *   rangeLabel: string, quantity: number, paidLabel: string, locationName: string }} ctx
 */
export function buildRaffleTicketsDefaults(ctx) {
  const row = (label, value) => `    <tr><td style="padding:8px 0;color:#666;width:120px">${label}</td><td style="padding:8px 0;font-weight:600">${escapeHtml(value)}</td></tr>`
  const count = Number(ctx.quantity) === 1 ? '1 ticket' : `${ctx.quantity} tickets`
  const infoRows = [
    ctx.raceName ? row('Event', ctx.raceName) : '',
    row('Raffle', ctx.raffleName),
    row('Your numbers', `${ctx.rangeLabel} (${count})`),
    row('Paid', ctx.paidLabel),
  ].filter(Boolean).join('\n')
  const introHtml = `Thanks for buying ${escapeHtml(count)} in the ${escapeHtml(ctx.raffleName)}. Your numbers are <strong>${escapeHtml(ctx.rangeLabel)}</strong>.`
  return {
    subject: `Your raffle tickets for ${ctx.raceName || ctx.raffleName}`,
    heading: `Good luck, ${escapeHtml(ctx.firstName || 'there')}!`,
    intro: introHtml,
    introHtml,
    infoRows,
    afterInfoHtml: '',
    footerHtml: "<strong>Keep this email.</strong> You'll need your numbers if you win.",
    memberQrs: [],
    locationName: ctx.locationName || '',
  }
}

async function stamp(db, sale, fields) {
  const { error } = await db.from('raffle_sales').update(fields).eq('id', sale.id).eq('raffle_id', sale.raffle_id)
  if (error) logError('raffle-email', 'email stamp NOT written', { err: error, saleId: sale.id, fields: Object.keys(fields) })
}

/**
 * Email the buyer their ticket numbers.
 * @param {{ db: object, sale: object, raffle: object, race: object, now?: () => string }} args
 * @returns {Promise<{ status: 'sent'|'suppressed'|'failed'|'skipped', reason?: string }>}
 */
export async function sendRaffleTicketsEmail({ db, sale, raffle, race, now = () => new Date().toISOString() }) {
  try {
    const to = String(sale?.buyer_email || '').trim()
    if (!to) return { status: 'skipped', reason: 'no_email' }
    const contactId = sale.contact_id || null

    const gate = await checkTransactionalConsent({
      db, contactId, channel: 'email', module: 'raffle-email', meta: { saleId: sale.id },
    })
    if (!gate.allowed) {
      logError('raffle-email', 'raffle ticket email SUPPRESSED by consent state; tell the buyer their numbers in person', {
        saleId: sale.id, reason: gate.reason,
      })
      await stamp(db, sale, { email_status: 'suppressed' })
      return { status: 'suppressed', reason: gate.reason || undefined }
    }

    let commsLocation = null
    try {
      commsLocation = await resolveEventCommsLocation(db, {
        location_id: race.location_id, host_id: race.host_id, sending_location_id: race.sending_location_id,
      })
    } catch (e) {
      logError('raffle-email', 'comms location resolver threw; sending from the event location', { err: e, saleId: sale.id })
    }
    const locationId = commsLocation?.id || race.location_id || null

    const firstName = String(sale.buyer_name || '').trim().split(/\s+/)[0] || ''
    const ctx = {
      firstName,
      raceName: race.name,
      raffleName: raffle.name,
      rangeLabel: formatTicketRange(sale.first_ticket, sale.last_ticket),
      quantity: sale.quantity,
      paidLabel: formatEuros(sale.total_cents, raffle.currency),
      locationName: commsLocation?.name || '',
    }
    const contact = { first_name: firstName, name: sale.buyer_name, email: to }
    const extras = { event_name: race.name, team_name: '', when: '', location: ctx.locationName }
    const emailRace = {
      ...race,
      raffle_tickets_email_subject: raffle.email_subject || '',
      raffle_tickets_email_intro: raffle.email_intro || '',
    }

    try {
      const { subject, htmlBody } = await resolveEventEmail({
        db, kind: 'raffle_tickets', race: emailRace, contact, extras,
        defaults: buildRaffleTicketsDefaults(ctx), brandLocationId: locationId,
      })
      await sendTransactionalEmail({ to, subject, htmlBody, contactId, locationId, tag: 'raffle-tickets' })
    } catch (e) {
      logError('raffle-email', 'raffle ticket email failed to send', { err: e, saleId: sale.id })
      await stamp(db, sale, { email_status: 'failed' })
      return { status: 'failed', reason: e?.message || 'failed' }
    }
    await stamp(db, sale, { email_status: 'sent', email_sent_at: now() })
    return { status: 'sent' }
  } catch (e) {
    logError('raffle-email', 'raffle ticket email crashed before sending', { err: e, saleId: sale?.id })
    return { status: 'failed', reason: e?.message || 'failed' }
  }
}
