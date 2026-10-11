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
import { buildEventEmailShell, resolveEventEmail, resolveEventBrand } from './event-email'
import { resolveEventCommsLocation, pickAudienceVenueName } from './event-comms-location'
import { checkTransactionalConsent } from './transactional-consent'
import { logError } from './log'
import { timeRowLabel } from './event-time-slots'
import { isRaceKind } from '@shared/events'
import { entryLeadEmail, GAP_PAYMENT_KIND } from './registration-entry'
import { entryManageUrl } from './entry-manage-tokens'
import { resolveCustomerBaseUrl } from './tenant-host'

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
 * EVENT-MOVE.6 — the "Change your date" line closing the default "what's
 * next" copy of the confirmation and moved emails: a signed link to the
 * entry's own page (/event/entry/<token>). '' when no link could be built,
 * so the default copy is then exactly as before. Operator copy that replaces
 * the box can carry the same link with {{manage_url}}.
 */
function manageLineHtml(manageUrl) {
  if (!manageUrl) return ''
  return `<br><br>Need a different date? <a href="${escapeHtml(manageUrl)}" style="color:#111;font-weight:600">Change it here</a>.`
}

/** "Heat A · 09:30", "09:30", or '' with no wave. */
function waveText(wave) {
  if (!wave) return ''
  return wave.label ? `${wave.label} · ${fmtWaveTime(wave.start_time)}` : fmtWaveTime(wave.start_time)
}

/**
 * EVENT-CHECKIN.B — give each member a per-person check-in QR. The image is a
 * public signed-token endpoint (renders reliably in email clients); the QR
 * opens a staff-only scan page, so it's safe to expose. The token carries
 * `eventId`, so it scans only at that event. Without an app origin, event,
 * registration or secret every member gets qrSrc '' (no QR block renders).
 */
function mintMemberQrs({ eventId, registrationId, members }) {
  const appOrigin = (() => { try { return new URL(getAppUrl()).origin } catch { return '' } })()
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  return (members || []).map((m) => {
    if (!appOrigin || !eventId || !registrationId || !secret) return { ...m, qrSrc: '' }
    const token = signCheckinToken({ eventId, registrationId, memberId: m.id }, secret)
    return { ...m, qrSrc: `${appOrigin}/api/public/events/checkin-qr?t=${encodeURIComponent(token)}` }
  })
}

/**
 * Send the race-registration confirmation. Reads the parent race
 * + registration + team_members and composes copy in the sending
 * location's brand (W1.S1a).
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
      member_fee_cents, non_member_fee_cents, status, kind,
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
  // EVENT-MOVE.5 — a price-difference payment is not an entry: no "you're
  // in" email, no fresh QR codes. Its receipt is sendGapPaidEmail.
  if (payment.kind && payment.kind !== 'entry') {
    result.skipped.push(`kind=${payment.kind}`)
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

  const teamMembersWithQr = mintMemberQrs({ eventId: race?.id || null, registrationId: reg?.id || null, members: teamMembers })

  const ctx = {
    raceName: race?.name || 'Your event',
    raceDateLabel: fmtRaceDate(race?.race_date),
    waveLabel: waveText(wave),
    // EVENT-MULTITIME.1 — "Wave" for races, "Time" for a class/workshop.
    waveRowLabel: timeRowLabel(race?.kind),
    // EVENT-COPY.1 — this value reaches the customer three times: the "Where"
    // row, the `brand · <loc>` email footer, and the `{{location}}` merge tag
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
    // EVENT-MOVE.6 — the entry's own page, where the booker can change the date.
    // W1.L3b — minted on the EVENT LOCATION's tenant host (the resolver floors
    // to the CRM host and never throws past it). The check-in QR image URLs
    // above stay on the CRM host on purpose: the mail client fetches them, the
    // customer never reads them.
    manageUrl: entryManageUrl(reg?.id || payment.race_registration_id || null, {
      baseUrl: await resolveCustomerBaseUrl(db, race?.location_id || null),
    }),
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
 * The info table's rows. The confirmation always shows "Team size"; the moved
 * email drops it for a solo entry. With teamSizeRow true the output is the
 * confirmation's historic markup byte-for-byte (event-email.test.js).
 */
function buildInfoRows(ctx, breakdownLine, { teamSizeRow }) {
  const teamSize = teamSizeRow
    ? `<tr><td style="padding:8px 0;color:#666">Team size</td><td style="padding:8px 0;font-weight:600">${ctx.teamSize}-person</td></tr>
    `
    : ''
  return `    <tr><td style="padding:8px 0;color:#666;width:120px">Date</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.raceDateLabel)}</td></tr>
    ${ctx.waveLabel ? `<tr><td style="padding:8px 0;color:#666">${ctx.waveRowLabel || 'Wave'}</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.waveLabel)}</td></tr>` : ''}
    ${ctx.locationName ? `<tr><td style="padding:8px 0;color:#666">Where</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.locationName)}</td></tr>` : ''}
    ${teamSize}<tr><td style="padding:8px 0;color:#666;vertical-align:top">Total paid</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.amountLabel)}${breakdownLine}</td></tr>`
}

/** "1 × member €20.00 · 1 × non-member €30.00" under Total paid, or ''. */
function buildBreakdownLine(ctx) {
  const breakdown = []
  if (ctx.memberCount > 0 && ctx.memberFeeLabel) {
    breakdown.push(`${ctx.memberCount} × member ${ctx.memberFeeLabel}`)
  }
  if (ctx.nonMemberCount > 0 && ctx.nonMemberFeeLabel) {
    breakdown.push(`${ctx.nonMemberCount} × non-member ${ctx.nonMemberFeeLabel}`)
  }
  return breakdown.length > 0
    ? `<p style="color:#666;font-size:13px;margin:4px 0 0">${breakdown.join(' &nbsp;·&nbsp; ')}</p>`
    : ''
}

/**
 * Compose the DEFAULT (unconfigured) shell slots for the confirmation email
 * from the `ctx` sendRaceConfirmations builds. Each *Html slot is the exact raw
 * fragment the old inline template produced, so buildEventEmailShell reproduces
 * today's email byte-for-byte. resolveEventEmail layers per-event config on top.
 *
 * @param {object} ctx
 * @returns {{ subject:string, heading:string, introHtml:string, infoRows:string,
 *   afterInfoHtml:string, memberQrs:Array, footerHtml:string, locationName:string,
 *   brand:string }}
 */
export function buildConfirmationDefaults(ctx) {
  // W1.S1a — the member badge names the sending location's brand
  // (ctx.brand, resolved by the sender); "Member" alone when unknown.
  const brand = String(ctx.brand || '').trim()
  const memberBadge = escapeHtml(brand ? `${brand} member` : 'Member')
  const memberLineup = ctx.teamMembers
    .map((m) => `<li>${escapeHtml(m.name)}${m.role === 'captain' ? ' <em>(captain)</em>' : ''}${m.is_member ? ` <span style="color:#7a5a00;font-size:11px;background:#fff4cc;padding:1px 6px;border-radius:9999px;margin-left:6px">${memberBadge}</span>` : ''}</li>`)
    .join('')

  const breakdownLine = buildBreakdownLine(ctx)
  const infoRows = buildInfoRows(ctx, breakdownLine, { teamSizeRow: true })

  const afterInfoHtml = `

  <h3 style="font-size:16px;margin:24px 0 8px">Your team</h3>
  <ul style="padding-left:20px;margin:0 0 24px;font-size:14px;line-height:1.7">${memberLineup}</ul>`

  const memberQrs = (ctx.teamMembers || []).map((m) => ({
    name: m.name,
    qrSrc: m.qrSrc,
    captain: m.role === 'captain',
  }))

  return {
    subject: `${ctx.raceName}: you're in!`,
    heading: `You're registered, ${escapeHtml(ctx.captainFirstName || 'team captain')}.`,
    introHtml: `Team <strong>${escapeHtml(ctx.teamName)}</strong> is locked in for <strong>${escapeHtml(ctx.raceName)}</strong>.`,
    infoRows,
    afterInfoHtml,
    memberQrs,
    footerHtml: `<strong>What's next:</strong> arrive 30 minutes before your wave. Bring water, a towel, and your race-day energy. We'll send a reminder the day before with parking + check-in details.${manageLineHtml(ctx.manageUrl)}`,
    locationName: ctx.locationName || '',
    brand,
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
    brand: d.brand,
  })
}

async function sendEmail({ db, payment, ctx: baseCtx, commsLocationId }) {
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
  // W1.S1a — the email carries the SENDING location's brand (header wordmark,
  // member badge, signature line), the same location the From identity uses.
  const ctx = { ...baseCtx, brand: await resolveEventBrand(db, {}, commsLocationId) }
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
    manage_url: ctx.manageUrl || '',
  }

  const { subject, htmlBody } = await resolveEventEmail({
    db,
    kind: 'confirmation',
    race,
    contact: mergeContact,
    extras,
    defaults: buildConfirmationDefaults(ctx),
    brandLocationId: commsLocationId,
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

// ─── EVENT-MOVE.1 — "your entry has moved" ───────────────────────────────
//
// Same shell, consent gate, QR minting and Postmark path as the confirmation,
// with kind:'moved' copy (race_events.moved_email_subject/intro, mig 708).
// The send-once guard is registration_moves.notified_at, stamped AFTER the
// send for the reasons stampSendOnce spells out. Not gated by the payment's
// confirmation stamp: this is a different message. Email only; no SMS.
//
// moveRegistration ignores the result, so every failure here is logged with
// logError: a lost "your entry has moved" email must never be silent.

/**
 * Default shell slots for the moved email. Mirrors buildConfirmationDefaults so
 * resolveEventEmail({ kind: 'moved' }) can layer operator copy on top.
 * @param {object} ctx  buildConfirmationDefaults' ctx plus { oldEventName, oldWhen, isRace }
 */
export function buildMovedDefaults(ctx) {
  const base = buildConfirmationDefaults(ctx)
  const solo = (ctx.teamMembers || []).length <= 1
  const who = escapeHtml(ctx.captainFirstName || 'there')
  const from = `<strong>${escapeHtml(ctx.oldEventName || '')}</strong>${ctx.oldWhen ? ` (${escapeHtml(ctx.oldWhen)})` : ''}`
  const to = `<strong>${escapeHtml(ctx.raceName)}</strong>`
  const footerHtml = (ctx.isRace
    ? `<strong>What's next:</strong> arrive 30 minutes before your wave. Bring water, a towel, and your race-day energy. We'll send a reminder the day before.`
    : `<strong>What's next:</strong> arrive 30 minutes before your start. Bring water and a towel. We'll send a reminder the day before.`) + manageLineHtml(ctx.manageUrl)
  return {
    ...base,
    subject: `Your entry has moved to ${ctx.raceName}`,
    heading: solo ? `Your entry has moved, ${who}.` : `Your team's entry has moved, ${who}.`,
    introHtml: solo
      ? `Your entry for ${from} is now on ${to}. Your new ticket is below; the old one no longer works.`
      : `Your team's entry for ${from} is now on ${to}. Your new tickets are below; the old ones no longer work.`,
    // Solo: no one-line "Your team" list and no "Team size" row; the QR block
    // still shows the one person.
    infoRows: solo ? buildInfoRows(ctx, buildBreakdownLine(ctx), { teamSizeRow: false }) : base.infoRows,
    afterInfoHtml: solo ? '' : base.afterInfoHtml,
    footerHtml,
  }
}

/**
 * Email the lead contact their new tickets after a move. Best-effort: never
 * throws for an expected failure; reports it on the result and logs it.
 * @param {object} db  service-role client
 * @param {{ registrationId: string, moveId: string }} args
 * @returns {Promise<{ sent: string[], skipped: string[], failed: string[] }>}
 */
export async function sendRegistrationMovedEmail(db, { registrationId, moveId }) {
  const result = { sent: [], skipped: [], failed: [] }

  const { data: move, error: moveErr } = await db
    .from('registration_moves')
    .select(`
      id, registration_id, notified_at,
      from_event:from_event_id ( id, name, race_date ),
      from_wave:from_wave_id ( start_time, label )
    `)
    .eq('id', moveId)
    .maybeSingle()
  if (moveErr || !move || move.registration_id !== registrationId) {
    result.failed.push(`load:${moveErr?.message || 'move_not_found'}`)
    logError('race-confirmations', 'moved email: move row unreadable or not this entry\'s; nothing sent', { err: moveErr, registrationId, moveId })
    return result
  }
  if (move.notified_at) {
    result.skipped.push('email:already_sent')
    return result
  }

  const { data: reg, error: regErr } = await db
    .from('race_registrations')
    .select(`
      id, status, contact_id, race_event_id,
      contact:contact_id ( id, first_name, last_name, email, phone ),
      wave:wave_id ( id, start_time, label ),
      teams:team_id ( id, name, size, team_members ( id, name, role, is_member, email ) ),
      race:race_event_id (
        id, name, slug, kind, race_date, location_id, host_id, sending_location_id,
        venue_name, accent_hex, hero_image_url,
        moved_email_subject, moved_email_intro,
        locations:location_id ( id, name, is_host_anchor, organization_id )
      )
    `)
    .eq('id', registrationId)
    .maybeSingle()
  if (regErr || !reg) {
    result.failed.push(`load:${regErr?.message || 'registration_not_found'}`)
    logError('race-confirmations', 'moved email: registration unreadable; nothing sent', { err: regErr, registrationId, moveId })
    return result
  }
  const { data: payments, error: payErr } = await db
    .from('race_payments')
    .select('id, kind, amount_cents, currency, status, contact_email, member_count, non_member_count, member_fee_cents, non_member_fee_cents, created_at')
    .eq('race_registration_id', registrationId)
    .order('created_at', { ascending: false })
    .limit(10)
  if (payErr) logError('race-confirmations', 'moved email: payment read failed; Total paid says "See your original receipt"', { err: payErr, registrationId, moveId })
  // EVENT-MOVE.5 — "Total paid" is the ENTRY's payment: a paid price
  // difference from an earlier move is not the ticket.
  const entryPayments = (payments || []).filter((p) => (p.kind || 'entry') === 'entry')
  const payment = entryPayments.find((p) => p.status === 'completed') || null

  const race = reg.race || {}
  const contact = reg.contact || {}
  const toEmail = entryLeadEmail({ registration: reg, payment: payment || entryPayments[0] || null })
  if (!toEmail) {
    logError('race-confirmations', 'moved email: no address for the lead contact', { registrationId, moveId })
    result.skipped.push('email:no_email')
    return result
  }

  // Same fallback as sendRaceConfirmations: a resolver failure never costs the email.
  let commsLocation = null
  try {
    commsLocation = await resolveEventCommsLocation(db, { location_id: race.location_id, host_id: race.host_id, sending_location_id: race.sending_location_id })
  } catch (e) {
    logError('race-confirmations', 'moved email: comms location resolver threw; sending from the event location', { err: e, registrationId, moveId })
  }
  const commsLocationId = commsLocation?.id || race.location_id || null

  // ADMINISTRATIVE + unrecoverable, as for the confirmation (see sendEmail):
  // nothing re-runs this after the move, so every suppression logs at error.
  const gate = await checkTransactionalConsent({
    db, contactId: reg.contact_id, channel: 'email', module: 'race-confirmations', meta: { moveId }, unrecoverable: true,
  })
  if (!gate.allowed) { result.skipped.push(`email:${gate.reason}`); return result }

  const team = reg.teams
  const wave = reg.wave
  const teamMembers = (team?.team_members || []).slice().sort((a, b) =>
    (a.role === 'captain' ? 0 : 1) - (b.role === 'captain' ? 0 : 1) || (a.name || '').localeCompare(b.name || ''))
  // Minted against the TARGET event (the entry's event now): the new tickets
  // scan at the new event and the old ones are refused at the old one.
  const teamMembersWithQr = mintMemberQrs({ eventId: race.id || null, registrationId: reg.id, members: teamMembers })
  const oldWhen = [fmtRaceDate(move.from_event?.race_date), waveText(move.from_wave)].filter(Boolean).join(' · ')
  const captainFirstName = contact.first_name || (teamMembers[0]?.name || '').split(' ')[0] || ''
  const currency = payment?.currency || 'EUR'
  // A free entry has a completed €0 payment (race-payments.js), so no completed
  // payment on a pending_payment entry means it is unpaid, not free. An
  // unreadable payment proves nothing either way.
  let amountLabel
  if (payErr) amountLabel = 'See your original receipt'
  else if (payment) amountLabel = payment.amount_cents > 0 ? fmtMoney(payment.amount_cents, currency) : 'Free entry'
  else amountLabel = reg.status === 'pending_payment' ? 'Payment pending' : 'Free entry'

  const ctx = {
    raceName: race.name || 'Your event',
    raceDateLabel: fmtRaceDate(race.race_date),
    waveLabel: waveText(wave),
    waveRowLabel: timeRowLabel(race.kind),
    isRace: isRaceKind(race.kind),
    locationName: pickAudienceVenueName({ venueName: race.venue_name, eventLocation: race.locations }),
    teamName: team?.name || '',
    teamSize: team?.size || teamMembers.length || 1,
    teamMembers: teamMembersWithQr,
    captainFirstName,
    amountLabel,
    memberCount: payment?.member_count || 0,
    nonMemberCount: payment?.non_member_count || 0,
    memberFeeLabel: payment?.member_fee_cents != null ? fmtMoney(payment.member_fee_cents, currency) : null,
    nonMemberFeeLabel: payment?.non_member_fee_cents != null ? fmtMoney(payment.non_member_fee_cents, currency) : null,
    oldEventName: move.from_event?.name || '',
    oldWhen,
    // EVENT-MOVE.6 — the same entry, so the same page; a fresh 90-day link.
    // W1.L3b — on the event location's tenant host, as the confirmation's is.
    manageUrl: entryManageUrl(reg.id, { baseUrl: await resolveCustomerBaseUrl(db, race.location_id || null) }),
    // W1.S1a — the sending location's brand (header, member badge, signature).
    brand: await resolveEventBrand(db, {}, commsLocationId),
  }
  const mergeContact = { first_name: contact.first_name || '', name: [contact.first_name, contact.last_name].filter(Boolean).join(' '), email: toEmail, phone: contact.phone || '' }
  const extras = { event_name: ctx.raceName, team_name: ctx.teamName, when: ctx.waveLabel || ctx.raceDateLabel, location: ctx.locationName, old_event_name: ctx.oldEventName, old_when: ctx.oldWhen, manage_url: ctx.manageUrl || '' }

  try {
    const { subject, htmlBody } = await resolveEventEmail({ db, kind: 'moved', race, contact: mergeContact, extras, defaults: buildMovedDefaults(ctx), brandLocationId: commsLocationId })
    await sendTransactionalEmail({ to: toEmail, subject, htmlBody, contactId: reg.contact_id || null, locationId: commsLocationId, tag: 'event-moved' })
  } catch (e) {
    result.failed.push(`email:${e?.message || 'failed'}`)
    logError('race-confirmations', 'moved email failed to send; the entrant has no new tickets', { err: e, registrationId, moveId })
    return result
  }
  result.sent.push('email')

  // Stamp after the send (see stampSendOnce). Zero rows = a concurrent send already stamped it.
  const { data: stamped, error: stampErr } = await db
    .from('registration_moves')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', moveId)
    .is('notified_at', null)
    .select('id')
  if (stampErr) {
    result.failed.push(`email:stamp_failed:${stampErr.message}`)
    logError('race-confirmations', 'moved email sent but notified_at was NOT written', { err: stampErr, registrationId, moveId })
  } else if (!Array.isArray(stamped) || stamped.length === 0) {
    result.failed.push('email:duplicate_send')
    logError('race-confirmations', 'a concurrent invocation had already stamped this move; the entrant received a DUPLICATE moved email', { registrationId, moveId })
  }
  return result
}

// ─── EVENT-MOVE.5 — the price difference: the link, and the receipt ──────
//
// Two emails about a move_gap payment (race_payments.kind, mig 710), both
// from the payment row: the LINK staff send (sendGapLinkEmail, every click
// sends: staff may resend it) and the RECEIPT when it is paid
// (sendGapPaidEmail, send-once on confirmation_email_sent_at, stamped after
// the send as stampSendOnce explains). The operator copy, kind 'gap'
// (race_events.gap_email_subject/intro), is the LINK email's; the receipt
// uses fixed wording with the event's styling.
// Neither carries QR codes: the tickets from the moved email still stand.

const GAP_PAYMENT_COLUMNS = `
  id, kind, status, contact_id, contact_email, contact_name,
  amount_cents, currency, confirmation_email_sent_at, metadata,
  race_event_id, race_registration_id, registration_move_id,
  race:race_event_id (
    id, name, slug, kind, race_date, location_id, host_id, sending_location_id,
    venue_name, accent_hex, hero_image_url,
    gap_email_subject, gap_email_intro,
    locations:location_id ( id, name, is_host_anchor, organization_id )
  ),
  registration:race_registration_id ( id, wave:wave_id ( id, start_time, label ) ),
  move:registration_move_id ( id, from_event:from_event_id ( id, name ) )
`

/**
 * Default shell slots for the two price-difference emails.
 * @param {{ raceName, raceDateLabel, waveLabel, waveRowLabel, locationName,
 *   firstName, differenceLabel, oldEventName, payUrl }} ctx
 * @param {'link'|'paid'|'paid_unmoved'} stage  'paid_unmoved' (EVENT-MOVE.6):
 *   a customer paid for their own date change and the move was then refused
 */
export function buildGapDefaults(ctx, stage) {
  const who = escapeHtml(ctx.firstName || 'there')
  const from = `<strong>${escapeHtml(ctx.oldEventName || 'your old event')}</strong>`
  const to = `<strong>${escapeHtml(ctx.raceName)}</strong>`
  const diff = `<strong>${escapeHtml(ctx.differenceLabel)}</strong>`
  const row = (label, value) => `<tr><td style="padding:8px 0;color:#666;width:120px">${label}</td><td style="padding:8px 0;font-weight:600">${escapeHtml(value)}</td></tr>`
  const infoRows = [
    `    ${row('Event', ctx.raceName)}`,
    ctx.raceDateLabel ? `    ${row('Date', ctx.raceDateLabel)}` : '',
    ctx.waveLabel ? `    ${row(ctx.waveRowLabel || 'Wave', ctx.waveLabel)}` : '',
    ctx.locationName ? `    ${row('Where', ctx.locationName)}` : '',
    `    ${row(stage === 'link' ? 'To pay' : 'Paid', ctx.differenceLabel)}`,
  ].filter(Boolean).join('\n')
  const base = { infoRows, memberQrs: [], locationName: ctx.locationName || '' }

  if (stage === 'paid_unmoved') {
    // The entry is still on the event it was booked on (ctx.raceName): say
    // what happened, plainly, and that a person will follow up. Never that
    // it moved, never a refund promise (that is staff's call).
    return {
      ...base,
      subject: `Your date change for ${ctx.raceName}`,
      heading: `Thanks, ${who}.`,
      introHtml: `We received your ${diff} payment to change the date of your entry for ${to}, but we could not move your entry.`,
      afterInfoHtml: '',
      footerHtml: `<strong>We will be in touch.</strong> Someone from the team will contact you about your date change and your payment. Your entry for ${to} is unchanged in the meantime.`,
    }
  }
  if (stage === 'paid') {
    return {
      ...base,
      subject: `Difference paid for ${ctx.raceName}`,
      heading: `Thanks, ${who}.`,
      introHtml: `The ${diff} difference for your move from ${from} to ${to} is paid.`,
      afterInfoHtml: '',
      footerHtml: `<strong>Nothing more to do.</strong> The tickets in your "entry has moved" email still work.`,
    }
  }
  const href = escapeHtml(ctx.payUrl || '')
  return {
    ...base,
    subject: `Pay the difference for ${ctx.raceName}`,
    heading: `One thing left, ${who}.`,
    introHtml: `Your entry moved from ${from} to ${to}, which costs ${diff} more. Pay it here:`,
    afterInfoHtml: `

  <p style="margin:0 0 12px;text-align:center"><a href="${href}" style="display:inline-block;background:#111;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Pay ${escapeHtml(ctx.differenceLabel)}</a></p>
  <p style="margin:0 0 4px;text-align:center;color:#666;font-size:12px">This link is valid for 24 hours. If it has expired, reply and we'll send a new one.</p>
  <p style="margin:0 0 24px;text-align:center;color:#666;font-size:12px;word-break:break-all">Or open this link: ${href}</p>`,
    footerHtml: `<strong>Your entry is safe either way.</strong> The tickets in your "entry has moved" email still work; this only settles the price difference.`,
  }
}

async function loadGapPayment(db, paymentId, result, what) {
  const { data: payment, error } = await db
    .from('race_payments')
    .select(GAP_PAYMENT_COLUMNS)
    .eq('id', paymentId)
    .maybeSingle()
  if (error || !payment) {
    result.failed.push(`load:${error?.message || 'payment_not_found'}`)
    logError('race-confirmations', `${what}: payment unreadable; nothing sent`, { err: error, paymentId })
    return null
  }
  return payment
}

/** The ctx + merge extras both gap emails render from. */
function gapContext(payment, payUrl) {
  const race = payment.race || {}
  const differenceLabel = fmtMoney(Number(payment.amount_cents) || 0, payment.currency || 'EUR')
  const ctx = {
    raceName: race.name || 'Your event',
    raceDateLabel: fmtRaceDate(race.race_date),
    waveLabel: waveText(payment.registration?.wave),
    waveRowLabel: timeRowLabel(race.kind),
    locationName: pickAudienceVenueName({ venueName: race.venue_name, eventLocation: race.locations }),
    firstName: (payment.contact_name || '').split(' ')[0] || '',
    differenceLabel,
    oldEventName: payment.move?.from_event?.name || '',
    payUrl: payUrl || '',
  }
  const contact = {
    first_name: ctx.firstName,
    name: payment.contact_name || '',
    email: payment.contact_email || '',
    phone: '',
  }
  const extras = {
    event_name: ctx.raceName,
    when: ctx.waveLabel || ctx.raceDateLabel,
    location: ctx.locationName,
    old_event_name: ctx.oldEventName,
    difference: differenceLabel,
    pay_url: ctx.payUrl,
  }
  return { race, ctx, contact, extras }
}

async function gapCommsLocationId(db, race, paymentId) {
  // Same fallback as sendRaceConfirmations: a resolver failure never costs the email.
  let commsLocation = null
  try {
    commsLocation = await resolveEventCommsLocation(db, { location_id: race.location_id, host_id: race.host_id, sending_location_id: race.sending_location_id })
  } catch (e) {
    logError('race-confirmations', 'gap email: comms location resolver threw; sending from the event location', { err: e, paymentId })
  }
  return commsLocation?.id || race.location_id || null
}

/**
 * Email the payer the link to pay a move's price difference. Not send-once:
 * staff may send it again (the route reuses the pending payment). Best-effort:
 * reports, logs, never throws.
 * @param {{ db: object, paymentId: string, payUrl: string }} args
 * @returns {Promise<{ sent: string[], skipped: string[], failed: string[] }>}
 */
export async function sendGapLinkEmail({ db, paymentId, payUrl }) {
  const result = { sent: [], skipped: [], failed: [] }
  const payment = await loadGapPayment(db, paymentId, result, 'gap link email')
  if (!payment) return result
  if (payment.kind !== GAP_PAYMENT_KIND) { result.skipped.push(`kind=${payment.kind || 'entry'}`); return result }
  if (payment.status !== 'pending') { result.skipped.push(`status=${payment.status}`); return result }
  if (!payment.contact_email) { result.skipped.push('email:no_email'); return result }

  // Staff are told at once when this does not go (and hold the link), so a
  // suppression here is recoverable: no unrecoverable flag.
  const gate = await checkTransactionalConsent({
    db, contactId: payment.contact_id, channel: 'email', module: 'race-confirmations', meta: { paymentId },
  })
  if (!gate.allowed) { result.skipped.push(`email:${gate.reason}`); return result }

  const { race, ctx, contact, extras } = gapContext(payment, payUrl)
  const locationId = await gapCommsLocationId(db, race, paymentId)
  try {
    const { subject, htmlBody } = await resolveEventEmail({ db, kind: 'gap', race, contact, extras, defaults: buildGapDefaults(ctx, 'link'), brandLocationId: locationId })
    await sendTransactionalEmail({ to: payment.contact_email, subject, htmlBody, contactId: payment.contact_id || null, locationId, tag: 'event-gap-link' })
  } catch (e) {
    result.failed.push(`email:${e?.message || 'failed'}`)
    logError('race-confirmations', 'gap link email failed to send', { err: e, paymentId })
    return result
  }
  result.sent.push('email')
  return result
}

/**
 * The receipt for a paid price difference. Send-once on the payment row's
 * confirmation_email_sent_at (the customer-facing email for THIS row went),
 * stamped after the send. Called by the payment webhooks on a FRESH
 * completion of a move_gap payment, instead of sendRaceConfirmations.
 * @param {{ db: object, paymentId: string }} args
 * @returns {Promise<{ sent: string[], skipped: string[], failed: string[] }>}
 */
export async function sendGapPaidEmail({ db, paymentId }) {
  const result = { sent: [], skipped: [], failed: [] }
  const payment = await loadGapPayment(db, paymentId, result, 'gap receipt')
  if (!payment) return result
  if (payment.kind !== GAP_PAYMENT_KIND) { result.skipped.push(`kind=${payment.kind || 'entry'}`); return result }
  if (payment.status !== 'completed') { result.skipped.push(`status=${payment.status}`); return result }
  if (payment.confirmation_email_sent_at) { result.skipped.push('email:already_sent'); return result }
  if (!payment.contact_email) { result.skipped.push('email:no_email'); return result }

  // ADMINISTRATIVE + unrecoverable, as for the confirmation (see sendEmail):
  // the webhook calls this once, on the fresh transition, and nothing re-runs it.
  const gate = await checkTransactionalConsent({
    db, contactId: payment.contact_id, channel: 'email', module: 'race-confirmations', meta: { paymentId }, unrecoverable: true,
  })
  if (!gate.allowed) { result.skipped.push(`email:${gate.reason}`); return result }

  const { race, ctx, contact, extras } = gapContext(payment, '')
  const locationId = await gapCommsLocationId(db, race, paymentId)
  // EVENT-MOVE.6 — a customer's own date change that was refused after they
  // paid (completeGapPayment records metadata.pending_move_failed). Keyed on
  // that record alone: a change that landed but lost its link write must not
  // be told it did not move.
  const unmoved = !!payment.metadata?.pending_move_failed
  // Fixed wording: race_events.gap_email_subject/intro are the LINK email's
  // copy ("pay here"), which would read wrong on a receipt. The event's
  // header styling still applies.
  const receiptRace = { ...race, gap_email_subject: null, gap_email_intro: null }
  try {
    const { subject, htmlBody } = await resolveEventEmail({ db, kind: 'gap', race: receiptRace, contact, extras, defaults: buildGapDefaults(ctx, unmoved ? 'paid_unmoved' : 'paid'), brandLocationId: locationId })
    await sendTransactionalEmail({ to: payment.contact_email, subject, htmlBody, contactId: payment.contact_id || null, locationId, tag: 'event-gap-paid' })
  } catch (e) {
    result.failed.push(`email:${e?.message || 'failed'}`)
    logError('race-confirmations', 'gap receipt failed to send', { err: e, paymentId })
    return result
  }
  result.sent.push('email')
  await stampSendOnce(db, payment.id, 'confirmation_email_sent_at', result, 'email')
  return result
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
