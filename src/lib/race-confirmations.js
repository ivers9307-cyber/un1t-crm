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
import { sendLocationSms, TwilioError } from './twilio'
import { formatWeekdayLongDateInTZ } from './dates'
import { getAppUrl } from './app-url'
import { signCheckinToken } from './event-checkin-tokens'
import { buildEventEmailShell, resolveEventEmail } from './event-email'
import { overlayConnections } from '@/lib/connection-registry'

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
        id, name, slug, race_date, location_id,
        venue_name, venue_address,
        accent_hex, hero_image_url,
        confirmation_email_subject, confirmation_email_intro, confirmation_email_template_id,
        confirmation_sms_enabled,
        locations:location_id ( id, name, twilio_alpha_sender_id )
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
    try {
      const r = await sendEmail({ db, payment, ctx })
      if (r.status === 'sent') {
        await db.from('race_payments')
          .update({ confirmation_email_sent_at: new Date().toISOString() })
          .eq('id', payment.id)
        result.sent.push('email')
      } else {
        result.skipped.push(`email:${r.reason}`)
      }
    } catch (e) {
      result.failed.push(`email:${e.message || 'failed'}`)
    }
  } else {
    result.skipped.push('email:already_sent')
  }

  // SMS — opt-in per event (EVENTS-SMS-TOGGLE, mig 552). A disabled event
  // (or any legacy event with the flag unset) skips here; the email receipt
  // above is unaffected. Idempotent via confirmation_sms_sent_at.
  const smsGate = shouldSendSmsConfirmation(race, payment)
  if (smsGate.send) {
    try {
      const r = await sendSms({ db, payment, location, ctx })
      if (r.status === 'sent') {
        await db.from('race_payments')
          .update({ confirmation_sms_sent_at: new Date().toISOString() })
          .eq('id', payment.id)
        result.sent.push('sms')
      } else {
        result.skipped.push(`sms:${r.reason}`)
      }
    } catch (e) {
      result.failed.push(`sms:${e.message || 'failed'}`)
    }
  } else {
    result.skipped.push(`sms:${smsGate.reason}`)
  }

  return result
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

async function sendEmail({ db, payment, ctx }) {
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
    locationId: payment.race?.location_id || null,
    tag: 'race-registration-confirmation',
  })
  return { status: 'sent' }
}

async function sendSms({ db, payment, location, ctx }) {
  if (!payment.contact_phone) return { status: 'skipped', reason: 'no_phone' }
  if (!location) return { status: 'skipped', reason: 'no_location' }

  const lines = []
  lines.push(`UN1T: Team ${ctx.teamName} is in for ${ctx.raceName} on ${ctx.raceDateLabel}.`)
  if (ctx.waveLabel) lines.push(`Wave: ${ctx.waveLabel}.`)
  lines.push('Arrive 30min early. See you there!')
  const body = lines.join(' ')

  try {
    await sendLocationSms({ location, to: payment.contact_phone, body })
  } catch (e) {
    const msg = e instanceof TwilioError
      ? `Twilio ${e.code || e.status || ''}: ${e.message}`.trim()
      : (e?.message || 'SMS send failed')
    throw new Error(msg)
  }

  // Activity timeline mirror — best-effort.
  if (payment.contact_id) {
    try {
      await db.from('activities').insert({
        contact_id: payment.contact_id,
        location_id: payment.race?.location_id || null,
        type: 'sms_sent',
        kind: 'event',
        subject: `Race confirmation: ${ctx.raceName}`,
        note: body,
      })
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
