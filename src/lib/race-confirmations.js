// race-confirmations — race-registration receipts (mig 084).
//
// DELIBERATELY SEPARATE from booking-confirmations.js and the
// cars deposit flow. UN1T races have their own copy, branding,
// and merge fields; mixing them with the gym-booking confirmations
// or the cars deposit receipts would force compromise on all three.
//
// Channel: Postmark email. The SMS leg (mig 552 opt-in) was retired
// with Twilio (TWILIO-RETIRE.1); race_events.confirmation_sms_enabled
// and race_payments.confirmation_sms_sent_at stay on disk as history.
// Best-effort — never throws up to the webhook caller (a comms hiccup
// must not undo the payment state change).
//
// Send-once guard: race_payments.confirmation_email_sent_at. The
// webhook can fire repeatedly (Revolut retries on non-2xx) without
// duplicate messages.

import { sendTransactionalEmail } from './postmark'
import { formatWeekdayLongDateInTZ } from './dates'
import { getAppUrl } from './app-url'
import { signCheckinToken } from './event-checkin-tokens'
import { buildEventEmailShell, resolveEventEmail } from './event-email'
import { resolveEventCommsLocation, pickAudienceVenueName } from './event-comms-location'
import { checkTransactionalConsent } from './transactional-consent'
import { logError } from './log'
import { timeRowLabel } from './event-time-slots'

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
      id, contact_id, contact_email, contact_phone, contact_name,
      amount_cents, currency, member_count, non_member_count,
      member_fee_cents, non_member_fee_cents, status,
      confirmation_email_sent_at,
      race_event_id, race_registration_id,
      race:race_event_id (
        id, name, slug, kind, race_date, location_id, host_id, sending_location_id,
        venue_name, venue_address,
        accent_hex, hero_image_url,
        confirmation_email_subject, confirmation_email_intro, confirmation_email_template_id,
        locations:location_id ( id, name, is_host_anchor, organization_id )
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

  // EVENT-COMMS-LOC — the real location whose email identity this event's
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
  // removed it entirely, because the brand it protected cannot currently
  // differ: email identity is resolved per ORGANISATION (structural). The
  // other half of the argument — SMS alpha senders, which DID differ between
  // two locations of one org — went away with the SMS leg itself
  // (TWILIO-RETIRE.1). The history is in event-comms-location.js.
  //
  // The resolver now never throws; it logs and returns null. This try/catch is
  // belt-and-braces for a future hop that forgets, and it CONTINUES rather than
  // returning — the fallback on the next line is the event's own location,
  // which is exactly what main used and what the email sender resolves to
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
    // EVENT-MULTITIME.1 — "Wave" for races, "Time" for a class/workshop.
    waveRowLabel: timeRowLabel(race?.kind),
    // EVENT-COPY.1 — this value reaches the customer three times: the "Where"
    // row, the `UN1T · <loc>` email footer, and the `{{location}}` merge tag
    // operators write copy against. All three are claims about WHERE THE EVENT
    // IS, so this is the VENUE helper, not the sign-off one: venue_name → the
    // event's OWN location (anchors skipped) → ''.
    //
    // It used to be `venue_name || location.name`, which is right whenever a
    // venue is set but falls straight onto the anchor's internal label ("<host>
    // (host events)") when it is not — and `venue_name` is only mandatory for
    // HOST-submitted events, never for a staff-created one.
    //
    // `commsLocation` is deliberately NOT consulted here even though it is in
    // scope: it is a SENDER identity (mig 553), and letting it answer a venue
    // question prints a real gym the event is not held at. See
    // pickAudienceVenueName's header.
    locationName: pickAudienceVenueName({
      venueName: race?.venue_name,
      eventLocation: location,
    }),
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
    ${ctx.waveLabel ? `<tr><td style="padding:8px 0;color:#666">${ctx.waveRowLabel || 'Wave'}</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.waveLabel)}</td></tr>` : ''}
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

  // EVENT-CONSENT.1 — the check this path never had. Same gate the sibling
  // TRANSACTIONAL senders apply (booking-confirmations.js, event-attendee-
  // reminders.js), now shared rather than copied: hard signals
  // (bounced/complained) plus the ADMINISTRATIVE opt-out.
  //
  // ADMINISTRATIVE, NOT MARKETING, and the difference is not academic: of the
  // 193 completed race payments in prod, 47 belong to contacts who have opted
  // out of MARKETING email and 0 to contacts who have opted out of
  // administrative. Gating a paid-registration receipt — which carries the
  // per-person check-in QR — on the marketing flag would silently delete a
  // quarter of them. See transactional-consent.js for the query.
  //
  // An UNREADABLE consent row sends anyway and logs (checkTransactionalConsent
  // owns that). This function is invoked only on a FRESH payment transition, so
  // a suppression that fires by accident is permanent and takes the attendee's
  // check-in QR with it; a receipt sent to a hard-bounced address is dropped by
  // Postmark's own suppression list at no cost to anyone.
  //
  // `unrecoverable: true` is doing real work here and is not decoration —
  // `markRacePaymentStatus` returns `applied: null` once the payment is already
  // 'completed', so no webhook redelivery, no cron and no operator screen ever
  // re-runs this. It buys two things: EVERY suppression is logged at error
  // level (an operator can then post the QR by hand), and the mig-151 ClassPass
  // blanket — which is what `email_administrative = false` means for 1626 of
  // the 1627 contacts that carry it, with zero human opt-outs on record — stops
  // being able to delete a receipt for money we took. Hard signals and genuine
  // person-set opt-outs still suppress. Read transactional-consent.js's header
  // before narrowing or widening this.
  const gate = await checkTransactionalConsent({
    db, contactId: payment.contact_id, channel: 'email',
    module: 'race-confirmations', meta: { paymentId: payment.id },
    unrecoverable: true,
  })
  if (!gate.allowed) return { status: 'skipped', reason: gate.reason }

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

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
