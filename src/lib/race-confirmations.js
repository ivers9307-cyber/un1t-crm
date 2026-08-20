// race-confirmations — race-registration receipts (mig 084).
//
// DELIBERATELY SEPARATE from booking-confirmations.js and
// deposit-receipts.js. UN1T races have their own copy, branding,
// and merge fields; mixing them with the gym-booking confirmations
// or the cars deposit SMS would force compromise on all three.
//
// Channels: Postmark email + Twilio SMS. Best-effort — never throws
// up to the webhook caller (a comms hiccup must not undo the
// payment state change).
//
// Send-once guard: race_payments.confirmation_email_sent_at +
// confirmation_sms_sent_at. The webhook can fire repeatedly (Revolut
// retries on non-2xx) without duplicate messages.

import { sendTransactionalEmail } from './postmark'
import { sendLocationSms, TwilioError, resolveSenderLocation } from './twilio'
import { formatWeekdayLongDateInTZ } from './dates'
import { getAppUrl } from './app-url'
import { signCheckinToken } from './event-checkin-tokens'
import { buildEventEmailShell, resolveEventEmail } from './event-email'
import { overlayConnections } from '@/lib/connection-registry'
import { resolveEventCommsLocation } from './event-comms-location'
import { logError } from './log'

function fmtRaceDate(dateStr) {
  if (!dateStr) return ''
  return formatWeekdayLongDateInTZ(dateStr) || dateStr
}

function fmtMoney(cents, currency = 'EUR') {
  if (!Number.isFinite(cents)) return ''
  const major = (cents / 100).toFixed(2)
  if (currency === 'EUR') return `€${major}`
  if (currency === 'GBP') return `£${major}`
  return `${major} ${currency}`
}

function fmtWaveTime(t) {
  if (!t || typeof t !== 'string') return ''
  return t.slice(0, 5) // "09:30:00" → "09:30"
}

/**
 * Decide whether to send the race-registration SMS confirmation.
 *
 * SMS is opt-in per event (race_events.confirmation_sms_enabled, mig 552,
 * default false) — so a legacy event with no flag set never texts. The
 * EMAIL receipt is a separate path above and is never gated by this. The
 * once-only guard (confirmation_sms_sent_at) still applies on top.
 *
 * @param {{ confirmation_sms_enabled?: boolean } | null | undefined} race
 * @param {{ confirmation_sms_sent_at?: string | null } | null | undefined} payment
 * @returns {{ send: boolean, reason?: 'disabled_for_event' | 'already_sent' }}
 */
export function shouldSendSmsConfirmation(race, payment) {
  if (!race?.confirmation_sms_enabled) return { send: false, reason: 'disabled_for_event' }
  if (payment?.confirmation_sms_sent_at) return { send: false, reason: 'already_sent' }
  return { send: true }
}

/**
 * Send the race-registration confirmation. Reads the parent race
 * + registration + team_members and composes UN1T-branded copy.
 * Stamps confirmation_*_sent_at on the payment row to enforce
 * once-only delivery across webhook retries.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db   service-role client
 * @param {string} args.paymentId    race_payments.id
 * @returns {Promise<{ sent: string[], skipped: string[], failed: string[] }>}
 */
export async function sendRaceConfirmations({ db, paymentId }) {
  const result = { sent: [], skipped: [], failed: [] }

  const { data: payment, error } = await db
    .from('race_payments')
    .select(`
      id, contact_email, contact_phone, contact_name,
      amount_cents, currency, member_count, non_member_count,
      member_fee_cents, non_member_fee_cents, status,
      confirmation_email_sent_at, confirmation_sms_sent_at,
      race_event_id, race_registration_id,
      race:race_event_id (
        id, name, slug, race_date, location_id, host_id, sending_location_id,
        venue_name, venue_address,
        accent_hex, hero_image_url,
        confirmation_email_subject, confirmation_email_intro, confirmation_email_template_id,
        confirmation_sms_enabled,
        locations:location_id ( id, name, twilio_alpha_sender_id, organization_id )
      ),
      registration:race_registration_id (
        id, wave_id,
        wave:wave_id ( id, start_time, label ),
        teams:team_id ( id, name, size,
          team_members ( id, name, role, is_member ) )
      )
    `)
    .eq('id', paymentId)
    .single()

  if (error || !payment) {
    result.failed.push(`load:${error?.message || 'payment_not_found'}`)
    return result
  }
  if (payment.status !== 'completed') {
    result.skipped.push(`status=${payment.status}`)
    return result
  }

  // INTEG-A2 dual-read: registry twilio_sender row first.
  if (payment.race?.locations) {
    payment.race.locations = await overlayConnections(db, payment.race.locations, ['twilio_sender'])
  }

  // EVENT-COMMS-LOC — the real location whose SMS + email identity this event's
  // comms use (host events resolve off their org master, not the sender-less
  // anchor). Falls back to the embedded location when unresolved.
  //
  // resolveEventCommsLocation THROWS when it cannot read the rows that decide
  // the sender, rather than falling through to a wrong-brand one. That throw
  // used to escape this whole function — past both send legs, out through all
  // four callers, every one of which answers 200 — so an unreadable location
  // meant a paid attendee silently got no receipt at all and nothing retried.
  // Catch it here and make it a first-class result instead: nothing has been
  // sent and no send-once stamp has been claimed at this point, so a later
  // invocation for the same payment still delivers both legs cleanly.
  //
  // BAREWRITE.3 — that catch was right, but the throw behind it was firing for
  // PLAIN events too, where the fallback below (`payment.race.location_id`)
  // resolves to the very location the failed read was looking up. The resolver
  // now fails open in exactly that case and returns null, so a transient blip
  // on an ordinary UN1T event no longer costs a paying attendee their receipt.
  // What still reaches this catch is the genuinely brand-crossing case: a host
  // event, or an explicit sending_location_id override, whose sender rows are
  // unreadable. There, no message is the right answer.
  //
  // WHY THIS DOES NOT BECOME A NON-2xx to the payment webhook. A provider retry
  // would be safe (nothing claimed, nothing sent) but INERT: the Revolut and
  // Stripe handlers only call this on a fresh state transition
  // (`markRacePaymentStatus(...).applied?.status === 'completed'`), and on
  // redelivery the payment is already 'completed', so `updates` is empty,
  // `applied` is null and we are never called again. A 5xx would therefore buy
  // retries that cannot deliver the receipt, while telling the provider we
  // failed to process a payment state we HAVE committed — and both providers
  // disable an endpoint that keeps failing. The two public register routes call
  // us inline during a customer's own POST, where a 5xx would show an error for
  // a registration that succeeded. So: answer 200, and make the failure a
  // structured, matchable signal instead of free text inside it.
  let commsLocation = null
  try {
    commsLocation = await resolveEventCommsLocation(db, {
      location_id: payment.race?.location_id,
      host_id: payment.race?.host_id,
      sending_location_id: payment.race?.sending_location_id,
    })
  } catch (e) {
    const msg = e?.message || String(e)
    logError('race-confirmations', 'comms location unresolved — NOTHING was sent (no receipt, no SMS); re-run once the read recovers', {
      err: e, paymentId, raceEventId: payment.race?.id || null,
    })
    result.failed.push(`comms_location:${msg}`)
    return result
  }
  const commsLocationId = commsLocation?.id || payment.race?.location_id || null

  const race = payment.race
  const reg = payment.registration
  const team = reg?.teams
  const wave = reg?.wave
  const location = race?.locations
  const teamMembers = (team?.team_members || []).slice().sort((a, b) =>
    (a.role === 'captain' ? 0 : 1) - (b.role === 'captain' ? 0 : 1) ||
    (a.name || '').localeCompare(b.name || '')
  )

  // EVENT-CHECKIN.B — give each member a per-person check-in QR. The image is
  // a public signed-token endpoint (renders reliably in email clients); the
  // QR opens a staff-only scan page, so it's safe to expose.
  const appOrigin = (() => { try { return new URL(getAppUrl()).origin } catch { return '' } })()
  const checkinSecret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  const checkinEventId = race?.id || null
  const checkinRegistrationId = reg?.id || null
  const teamMembersWithQr = teamMembers.map((m) => {
    if (!appOrigin || !checkinEventId || !checkinRegistrationId || !checkinSecret) return { ...m, qrSrc: '' }
    const token = signCheckinToken({ eventId: checkinEventId, registrationId: checkinRegistrationId, memberId: m.id }, checkinSecret)
    return { ...m, qrSrc: `${appOrigin}/api/public/events/checkin-qr?t=${encodeURIComponent(token)}` }
  })

  const ctx = {
    raceName: race?.name || 'UN1T Race',
    raceDateLabel: fmtRaceDate(race?.race_date),
    waveLabel: wave
      ? (wave.label ? `${wave.label} · ${fmtWaveTime(wave.start_time)}` : fmtWaveTime(wave.start_time))
      : '',
    // Host events hang off a hidden internal anchor location ("<host>
    // (host events)"); the real venue lives in race.venue_name. Prefer it
    // so the attendee's receipt shows the actual venue, not the ops string.
    // UN1T events have no venue_name → falls through to the location name.
    locationName: race?.venue_name || location?.name || '',
    teamName: team?.name || '',
    teamSize: team?.size || 0,
    teamMembers: teamMembersWithQr,
    captainFirstName: (payment.contact_name || '').split(' ')[0] || '',
    amountLabel: payment.amount_cents > 0 ? fmtMoney(payment.amount_cents, payment.currency) : 'Free entry',
    memberCount: payment.member_count || 0,
    nonMemberCount: payment.non_member_count || 0,
    memberFeeLabel: payment.member_fee_cents != null ? fmtMoney(payment.member_fee_cents, payment.currency) : null,
    nonMemberFeeLabel: payment.non_member_fee_cents != null ? fmtMoney(payment.non_member_fee_cents, payment.currency) : null,
  }

  // Email — only if not already sent.
  if (!payment.confirmation_email_sent_at) {
    const claim = await claimSendOnce(db, payment.id, 'confirmation_email_sent_at')
    if (!claim.claimed) {
      if (claim.reason === 'already_claimed') {
        result.skipped.push('email:already_sent')
      } else {
        result.failed.push(`email:claim_failed:${claim.reason}`)
        console.error('[race-confirmations] could not claim the email send-once stamp — NOT sending (a send without the stamp duplicates on the next webhook retry):', payment.id, claim.reason)
      }
    } else {
      let outcome = null
      try {
        outcome = await sendEmail({ db, payment, ctx, commsLocationId })
      } catch (e) {
        outcome = { status: 'threw', reason: e?.message || 'failed' }
      }
      if (outcome.status === 'sent') {
        result.sent.push('email')
      } else {
        // Nothing went out, so hand the claim back — otherwise a transient
        // send failure would permanently suppress the attendee's receipt.
        const released = await releaseSendOnce(db, payment.id, 'confirmation_email_sent_at')
        if (outcome.status === 'threw') result.failed.push(`email:${outcome.reason}`)
        else result.skipped.push(`email:${outcome.reason}`)
        if (!released) {
          result.failed.push('email:claim_stuck')
          console.error('[race-confirmations] email did not send AND the send-once claim could not be released — this attendee will never get a receipt without an operator clearing confirmation_email_sent_at:', payment.id)
        }
      }
    }
  } else {
    result.skipped.push('email:already_sent')
  }

  // SMS — opt-in per event (EVENTS-SMS-TOGGLE, mig 552). A disabled event
  // (or any legacy event with the flag unset) skips here; the email receipt
  // above is unaffected. Idempotent via confirmation_sms_sent_at.
  const smsGate = shouldSendSmsConfirmation(race, payment)
  if (smsGate.send) {
    // Same claim-first shape as the email leg above.
    const claim = await claimSendOnce(db, payment.id, 'confirmation_sms_sent_at')
    if (!claim.claimed) {
      if (claim.reason === 'already_claimed') {
        result.skipped.push('sms:already_sent')
      } else {
        result.failed.push(`sms:claim_failed:${claim.reason}`)
        console.error('[race-confirmations] could not claim the SMS send-once stamp — NOT sending:', payment.id, claim.reason)
      }
    } else {
      let outcome = null
      try {
        outcome = await sendSms({ db, payment, location, ctx, commsLocation })
      } catch (e) {
        outcome = { status: 'threw', reason: e?.message || 'failed' }
      }
      if (outcome.status === 'sent') {
        result.sent.push('sms')
      } else {
        const released = await releaseSendOnce(db, payment.id, 'confirmation_sms_sent_at')
        if (outcome.status === 'threw') result.failed.push(`sms:${outcome.reason}`)
        else result.skipped.push(`sms:${outcome.reason}`)
        if (!released) {
          result.failed.push('sms:claim_stuck')
          console.error('[race-confirmations] SMS did not send AND the send-once claim could not be released — an operator must clear confirmation_sms_sent_at:', payment.id)
        }
      }
    }
  } else {
    result.skipped.push(`sms:${smsGate.reason}`)
  }

  return result
}

/**
 * CLAIM one of the send-once stamps BEFORE the message goes out.
 *
 * BAREWRITE.1 stamped AFTER sending with a bare `await`, so a lost stamp meant
 * the next payment-webhook retry sent the attendee a duplicate — the exact
 * thing the stamp exists to prevent. Detecting the loss (the first cut) did not
 * change that: nothing retried the stamp and every caller still answers 200.
 *
 * Claim-first makes the write the mutex instead of a receipt, the same shape
 * `sendWhatsAppBroadcast` uses for its recipient rows ("a DB hiccup here can't
 * re-send"). `.is(col, null)` is the CAS, and `.select('id')` returns the rows
 * that actually matched — a row count verifiable by construction rather than
 * by a Content-Range header. Zero rows means somebody else claimed it (a
 * concurrent webhook delivery), which the old read-then-check could not see.
 *
 * The failure direction flips with it: a lost claim now means NO message rather
 * than a DUPLICATE message, and the send path hands the claim straight back
 * (`releaseSendOnce`) whenever nothing went out.
 *
 * @returns {Promise<{claimed: boolean, reason?: 'already_claimed'|string}>}
 */
async function claimSendOnce(db, paymentId, column) {
  const { data, error } = await db.from('race_payments')
    .update({ [column]: new Date().toISOString() })
    .eq('id', paymentId)
    .is(column, null)
    .select('id')
  if (error) return { claimed: false, reason: error.message }
  if (!Array.isArray(data) || data.length === 0) return { claimed: false, reason: 'already_claimed' }
  return { claimed: true }
}

/** Hand a claimed stamp back when the send did not happen. */
async function releaseSendOnce(db, paymentId, column) {
  const { error } = await db.from('race_payments')
    .update({ [column]: null })
    .eq('id', paymentId)
  return !error
}

/**
 * Compose the DEFAULT (unconfigured) shell slots for the confirmation email
 * from the `ctx` sendRaceConfirmations builds. Each *Html slot is the exact raw
 * fragment the old inline template produced, so buildEventEmailShell reproduces
 * today's email byte-for-byte. resolveEventEmail layers per-event config on top.
 *
 * @param {object} ctx
 * @returns {{ subject:string, heading:string, introHtml:string, infoRows:string,
 *   afterInfoHtml:string, memberQrs:Array, footerHtml:string, locationName:string }}
 */
export function buildConfirmationDefaults(ctx) {
  const memberLineup = ctx.teamMembers
    .map((m) => `<li>${escapeHtml(m.name)}${m.role === 'captain' ? ' <em>(captain)</em>' : ''}${m.is_member ? ' <span style="color:#7a5a00;font-size:11px;background:#fff4cc;padding:1px 6px;border-radius:9999px;margin-left:6px">UN1T member</span>' : ''}</li>`)
    .join('')

  const breakdown = []
  if (ctx.memberCount > 0 && ctx.memberFeeLabel) {
    breakdown.push(`${ctx.memberCount} × member ${ctx.memberFeeLabel}`)
  }
  if (ctx.nonMemberCount > 0 && ctx.nonMemberFeeLabel) {
    breakdown.push(`${ctx.nonMemberCount} × non-member ${ctx.nonMemberFeeLabel}`)
  }
  const breakdownLine = breakdown.length > 0
    ? `<p style="color:#666;font-size:13px;margin:4px 0 0">${breakdown.join(' &nbsp;·&nbsp; ')}</p>`
    : ''

  const infoRows = `    <tr><td style="padding:8px 0;color:#666;width:120px">Date</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.raceDateLabel)}</td></tr>
    ${ctx.waveLabel ? `<tr><td style="padding:8px 0;color:#666">Wave</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.waveLabel)}</td></tr>` : ''}
    ${ctx.locationName ? `<tr><td style="padding:8px 0;color:#666">Where</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.locationName)}</td></tr>` : ''}
    <tr><td style="padding:8px 0;color:#666">Team size</td><td style="padding:8px 0;font-weight:600">${ctx.teamSize}-person</td></tr>
    <tr><td style="padding:8px 0;color:#666;vertical-align:top">Total paid</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.amountLabel)}${breakdownLine}</td></tr>`

  const afterInfoHtml = `

  <h3 style="font-size:16px;margin:24px 0 8px">Your team</h3>
  <ul style="padding-left:20px;margin:0 0 24px;font-size:14px;line-height:1.7">${memberLineup}</ul>`

  const memberQrs = (ctx.teamMembers || []).map((m) => ({
    name: m.name,
    qrSrc: m.qrSrc,
    captain: m.role === 'captain',
  }))

  return {
    subject: `${ctx.raceName} — you're in!`,
    heading: `You're registered, ${escapeHtml(ctx.captainFirstName || 'team captain')}.`,
    introHtml: `Team <strong>${escapeHtml(ctx.teamName)}</strong> is locked in for <strong>${escapeHtml(ctx.raceName)}</strong>.`,
    infoRows,
    afterInfoHtml,
    memberQrs,
    footerHtml: `<strong>What's next:</strong> arrive 30 minutes before your wave. Bring water, a towel, and your race-day energy. We'll send a reminder the day before with parking + check-in details.`,
    locationName: ctx.locationName || '',
  }
}

/**
 * Pure builder for the DEFAULT (unconfigured) confirmation email body — the
 * shared shell with no per-event tint. Characterization-tested byte-for-byte
 * (event-email.test.js); resolveEventEmail reproduces this when the race has no
 * per-event config.
 *
 * @param {object} ctx
 * @returns {string} HTML body
 */
export function buildConfirmationEmailHtml(ctx) {
  const d = buildConfirmationDefaults(ctx)
  return buildEventEmailShell({
    heading: d.heading,
    introHtml: d.introHtml,
    accentHex: null,
    headerImageUrl: null,
    infoRows: d.infoRows,
    memberQrs: d.memberQrs,
    afterInfoHtml: d.afterInfoHtml,
    footerHtml: d.footerHtml,
    locationName: d.locationName,
  })
}

async function sendEmail({ db, payment, ctx, commsLocationId }) {
  if (!payment.contact_email) return { status: 'skipped', reason: 'no_email' }

  const race = payment.race || {}
  const mergeContact = {
    first_name: (payment.contact_name || '').split(' ')[0] || '',
    name: payment.contact_name || '',
    email: payment.contact_email || '',
    phone: payment.contact_phone || '',
  }
  const extras = {
    event_name: ctx.raceName,
    team_name: ctx.teamName,
    when: ctx.waveLabel || ctx.raceDateLabel,
    location: ctx.locationName,
  }

  const { subject, htmlBody } = await resolveEventEmail({
    db,
    kind: 'confirmation',
    race,
    contact: mergeContact,
    extras,
    defaults: buildConfirmationDefaults(ctx),
  })

  await sendTransactionalEmail({
    to: payment.contact_email,
    subject,
    htmlBody,
    contactId: payment.contact_id || null,
    locationId: commsLocationId,
    tag: 'race-registration-confirmation',
  })
  return { status: 'sent' }
}

async function sendSms({ db, payment, location, ctx, commsLocation }) {
  if (!payment.contact_phone) return { status: 'skipped', reason: 'no_phone' }
  if (!location) return { status: 'skipped', reason: 'no_location' }

  // SENDER-ORG-FALLBACK — a hosted event sits on a per-host ANCHOR location
  // with no Twilio sender; resolveSenderLocation swaps in the org's own sender
  // so it never falls through to the global CCF Autos default.
  const senderLocation = await resolveSenderLocation(db, commsLocation || location)

  const lines = []
  lines.push(`UN1T: Team ${ctx.teamName} is in for ${ctx.raceName} on ${ctx.raceDateLabel}.`)
  if (ctx.waveLabel) lines.push(`Wave: ${ctx.waveLabel}.`)
  lines.push('Arrive 30min early. See you there!')
  const body = lines.join(' ')

  try {
    await sendLocationSms({ location: senderLocation, to: payment.contact_phone, body })
  } catch (e) {
    const msg = e instanceof TwilioError
      ? `Twilio ${e.code || e.status || ''}: ${e.message}`.trim()
      : (e?.message || 'SMS send failed')
    throw new Error(msg)
  }

  // Activity timeline mirror — best-effort.
  if (payment.contact_id) {
    try {
      // Genuinely best-effort: a lost timeline line costs an audit row, never
      // a customer message. The error is still READ (not discarded) so a
      // systematic failure shows up in logs instead of nowhere.
      const { error: logErr } = await db.from('activities').insert({
        contact_id: payment.contact_id,
        location_id: payment.race?.location_id || null,
        type: 'sms_sent',
        kind: 'event',
        subject: `Race confirmation: ${ctx.raceName}`,
        note: body,
      })
      if (logErr) console.error('[race-confirmations] activity log insert failed (non-fatal):', logErr.message)
    } catch {
      // Don't fail the comms because the activity insert blew up.
    }
  }

  return { status: 'sent' }
}

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
