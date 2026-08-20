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
  // BAREWRITE.4 — A READ FAILURE HERE MUST NEVER COST THE RECEIPT.
  //
  // BAREWRITE.1 made resolveEventCommsLocation THROW when it could not read the
  // rows that decide the sender, and this function turned that throw into an
  // early return: nothing sent, `comms_location:…` on `failed`, and every one
  // of the four callers answering 200. Since the payment webhooks only invoke
  // us on a FRESH transition (`markRacePaymentStatus` returns `applied: null`
  // once the payment is already 'completed'), a redelivery cannot re-run us —
  // so a transient DB blip permanently cost a PAYING attendee their receipt and
  // their per-person check-in QR, and the only trace was a log line inside a
  // 200. BAREWRITE.3 narrowed the throw to brand-crossing events; BAREWRITE.4
  // removed it entirely, because the brand it protected cannot differ (email
  // identity is resolved per ORGANISATION, and no prod location pair differs on
  // the SMS alpha sender — the reasoning and the prod measurement are in
  // event-comms-location.js).
  //
  // The resolver now never throws; it logs and returns null. This try/catch is
  // belt-and-braces for a future hop that forgets, and it CONTINUES rather than
  // returning — the fallback on the next line is the event's own location,
  // which is exactly what main used and what the SMS/email senders resolve to
  // anyway.
  let commsLocation = null
  try {
    commsLocation = await resolveEventCommsLocation(db, {
      location_id: payment.race?.location_id,
      host_id: payment.race?.host_id,
      sending_location_id: payment.race?.sending_location_id,
    })
  } catch (e) {
    logError('race-confirmations', 'comms location resolver threw; sending from the event location instead (the receipt still goes out)', {
      err: e, paymentId, raceEventId: payment.race?.id || null,
    })
    commsLocation = null
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
    let outcome = null
    try {
      outcome = await sendEmail({ db, payment, ctx, commsLocationId })
    } catch (e) {
      outcome = { status: 'threw', reason: e?.message || 'failed' }
    }
    if (outcome.status === 'sent') {
      result.sent.push('email')
      await stampSendOnce(db, payment.id, 'confirmation_email_sent_at', result, 'email')
    } else if (outcome.status === 'threw') {
      result.failed.push(`email:${outcome.reason}`)
    } else {
      result.skipped.push(`email:${outcome.reason}`)
    }
  } else {
    result.skipped.push('email:already_sent')
  }

  // SMS — opt-in per event (EVENTS-SMS-TOGGLE, mig 552). A disabled event
  // (or any legacy event with the flag unset) skips here; the email receipt
  // above is unaffected. Idempotent via confirmation_sms_sent_at.
  const smsGate = shouldSendSmsConfirmation(race, payment)
  if (smsGate.send) {
    // Same send-then-stamp shape as the email leg above.
    let outcome = null
    try {
      outcome = await sendSms({ db, payment, location, ctx, commsLocation })
    } catch (e) {
      outcome = { status: 'threw', reason: e?.message || 'failed' }
    }
    if (outcome.status === 'sent') {
      result.sent.push('sms')
      await stampSendOnce(db, payment.id, 'confirmation_sms_sent_at', result, 'sms')
    } else if (outcome.status === 'threw') {
      result.failed.push(`sms:${outcome.reason}`)
    } else {
      result.skipped.push(`sms:${outcome.reason}`)
    }
  } else {
    result.skipped.push(`sms:${smsGate.reason}`)
  }

  return result
}

/**
 * Stamp one of the send-once columns AFTER the message has actually gone out.
 *
 * THE ORDER IS THE WHOLE DESIGN, and it has now been wrong in both directions,
 * so the trade-off is written down rather than re-derived:
 *
 *   • BAREWRITE.1 found this as a BARE `await` — the error was invisible, so a
 *     lost stamp was completely silent. That part was a real defect.
 *   • BAREWRITE.2/.3 "fixed" it by CLAIMING the stamp before sending, making
 *     the write a mutex. That removed a duplicate risk and created a permanent
 *     loss: a process kill between the claim and the send (a Vercel timeout, an
 *     OOM, a deploy mid-request) leaves the column stamped with nothing sent,
 *     and NOTHING retries — `markRacePaymentStatus` returns `applied: null`
 *     once the payment is 'completed', so the payment webhook never calls us
 *     again. It also produced a two-delivery case where NEITHER leg sent: the
 *     loser skipped as `already_claimed` while the winner's send failed and
 *     released the claim.
 *   • BAREWRITE.4 goes back to send-then-stamp, with the error READ and logged.
 *
 * What each order actually costs, on this path:
 *   claim-first  → a rare process kill silently and permanently destroys a
 *                  paying attendee's receipt AND their check-in QR.
 *   send-first   → two genuinely concurrent invocations for the same payment
 *                  can both send, i.e. a DUPLICATE receipt.
 * A duplicate receipt is an annoyance the customer can see and ignore. A
 * missing one means they cannot check in on race day. Losing a customer-facing
 * message is worse than sending it twice, so this fails toward the duplicate.
 *
 * How narrow the duplicate window really is: the pre-read
 * (`if (!payment.confirmation_email_sent_at)`) closes the sequential case, so a
 * duplicate needs two invocations overlapping inside one send. There are only
 * two ways to get two: a payment provider delivering the same event twice
 * concurrently before either marks the payment 'completed', or the return-page
 * poll racing the webhook. Both are rare, and neither is made more likely by
 * this change.
 *
 * `.is(col, null)` is kept as a CAS so the stamp cannot clobber a concurrent
 * winner's timestamp, and `.select('id')` returns the rows actually touched —
 * a count verifiable by construction rather than by a Content-Range header.
 * Zero rows here means the other invocation stamped first, which is a duplicate
 * we have already sent: record it as such rather than as a success.
 */
async function stampSendOnce(db, paymentId, column, result, leg) {
  const { data, error } = await db.from('race_payments')
    .update({ [column]: new Date().toISOString() })
    .eq('id', paymentId)
    .is(column, null)
    .select('id')
  if (error) {
    // The message IS out. The stamp is not. Nothing here can un-send it, and
    // no caller may fail over it — but it must not be silent, because the row
    // now under-reports and a later invocation (if one ever happens) would
    // send again.
    result.failed.push(`${leg}:stamp_failed:${error.message}`)
    logError('race-confirmations', 'confirmation sent but the send-once stamp was NOT written — a later re-run would send it again', {
      err: error, paymentId, column, leg,
    })
    return
  }
  if (!Array.isArray(data) || data.length === 0) {
    // The CAS matched nothing: a concurrent invocation stamped it between our
    // pre-read and now, which means it also sent. This is the duplicate this
    // ordering deliberately accepts; say so, don't hide it.
    result.failed.push(`${leg}:duplicate_send`)
    logError('race-confirmations', 'a concurrent invocation had already stamped this leg — the attendee received a DUPLICATE', {
      paymentId, column, leg,
    })
  }
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
