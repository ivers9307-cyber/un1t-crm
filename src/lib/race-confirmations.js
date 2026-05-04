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

function fmtRaceDate(dateStr) {
  if (!dateStr) return ''
  try {
    const d = new Date(`${dateStr}T00:00:00Z`)
    return d.toLocaleDateString('en-IE', {
      timeZone: 'Europe/Dublin',
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    })
  } catch {
    return dateStr
  }
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
      id, contact_email, contact_phone, contact_name,
      amount_cents, currency, member_count, non_member_count,
      member_fee_cents, non_member_fee_cents, status,
      confirmation_email_sent_at, confirmation_sms_sent_at,
      race_event_id, race_registration_id,
      race:race_event_id (
        id, name, slug, race_date, location_id,
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

  const race = payment.race
  const reg = payment.registration
  const team = reg?.teams
  const wave = reg?.wave
  const location = race?.locations
  const teamMembers = (team?.team_members || []).slice().sort((a, b) =>
    (a.role === 'captain' ? 0 : 1) - (b.role === 'captain' ? 0 : 1) ||
    (a.name || '').localeCompare(b.name || '')
  )

  const ctx = {
    raceName: race?.name || 'UN1T Race',
    raceDateLabel: fmtRaceDate(race?.race_date),
    waveLabel: wave
      ? (wave.label ? `${wave.label} · ${fmtWaveTime(wave.start_time)}` : fmtWaveTime(wave.start_time))
      : '',
    locationName: location?.name || '',
    teamName: team?.name || '',
    teamSize: team?.size || 0,
    teamMembers,
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
      const r = await sendEmail({ payment, ctx })
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

  // SMS — only if not already sent and we have a phone + location.
  if (!payment.confirmation_sms_sent_at) {
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
    result.skipped.push('sms:already_sent')
  }

  return result
}

async function sendEmail({ payment, ctx }) {
  if (!payment.contact_email) return { status: 'skipped', reason: 'no_email' }

  const subject = `${ctx.raceName} — you're in!`

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

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#fff;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T</div>
  <h1 style="font-size:24px;margin:24px 0 8px">You're registered, ${escapeHtml(ctx.captainFirstName || 'team captain')}.</h1>
  <p style="margin:0 0 16px;color:#444;font-size:15px">Team <strong>${escapeHtml(ctx.teamName)}</strong> is locked in for <strong>${escapeHtml(ctx.raceName)}</strong>.</p>

  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:24px 0;font-size:14px">
    <tr><td style="padding:8px 0;color:#666;width:120px">Date</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.raceDateLabel)}</td></tr>
    ${ctx.waveLabel ? `<tr><td style="padding:8px 0;color:#666">Wave</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.waveLabel)}</td></tr>` : ''}
    ${ctx.locationName ? `<tr><td style="padding:8px 0;color:#666">Where</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.locationName)}</td></tr>` : ''}
    <tr><td style="padding:8px 0;color:#666">Team size</td><td style="padding:8px 0;font-weight:600">${ctx.teamSize}-person</td></tr>
    <tr><td style="padding:8px 0;color:#666;vertical-align:top">Total paid</td><td style="padding:8px 0;font-weight:600">${escapeHtml(ctx.amountLabel)}${breakdownLine}</td></tr>
  </table>

  <h3 style="font-size:16px;margin:24px 0 8px">Your team</h3>
  <ul style="padding-left:20px;margin:0 0 24px;font-size:14px;line-height:1.7">${memberLineup}</ul>

  <div style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:13px;color:#333;line-height:1.5">
    <strong>What's next:</strong> arrive 30 minutes before your wave. Bring water, a towel, and your race-day energy. We'll send a reminder the day before with parking + check-in details.
  </div>

  <p style="color:#999;font-size:12px;margin-top:24px;text-align:center">UN1T · ${escapeHtml(ctx.locationName || '')}</p>
</div>`.trim()

  await sendTransactionalEmail({
    to: payment.contact_email,
    subject,
    htmlBody: html,
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
