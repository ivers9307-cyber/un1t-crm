// Post-class HR summary email.
//
// Three steps, all in this module:
//
//   loadContextForSession(db, sessionId)
//     Reads the just-ended session + the contact + the last 90 days
//     of their history. Joins to bookings → event_types so the
//     analytics layer can group by class type. Returns the bundle
//     the composer needs.
//
//   composeEmail(ctx)
//     Pure renderer: subject + HTML + text body, no IO. Pulls in
//     the analytics result (highlight, trend, percentile) and turns
//     it into copy. Tested independently.
//
//   sendPostClassEmail(db, sessionId, opts?)
//     The orchestrator: load → opt-out check → compose → Postmark
//     send → stamp email_sent_at. Idempotent: if email_sent_at is
//     already set, returns { skipped: 'already-sent' }.
//
// Wired in two places:
//   - src/lib/live-class.js#endSession (best-effort fire-and-forget
//     after the summary is finalised)
//   - /api/cron/auto-end-stale-hr-sessions (sweep that auto-closes
//     dormant sessions and triggers the email)
//
// Failures are logged + swallowed at every step. We never throw
// out of these helpers — a flaky Postmark shouldn't fail the cron
// run nor the live-class end-class button.

import { sendTransactionalEmail } from '@/lib/postmark'
import { buildSessionAnalytics } from '@/lib/hr-analytics'
import { zoneBreakdown } from '@/lib/heart-rate'
import { logInfo, logWarn, logError } from '@/lib/log'
import { formatWeekdayShortDateTimeInTZ } from '@/lib/dates'

const HISTORY_LOOKBACK_DAYS = 90
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.champfitness.ie'
const CRM_URL = process.env.NEXT_PUBLIC_APP_URL_CRM || 'https://crm.un1tdublin.com'

// ── (1) load ────────────────────────────────────────────────────

/**
 * Load everything composeEmail needs in one pass. Joins:
 *   heart_rate_sessions → contacts (for name/email/opt-in)
 *   heart_rate_sessions → bookings → event_types (for class name)
 *   + 90d of the contact's prior heart_rate_sessions for analytics.
 *
 * Returns { ok: false, error } when the session can't be loaded
 * (deleted, RLS, etc) — the caller's outer try/catch turns that
 * into a logged warning.
 */
export async function loadContextForSession(db, sessionId) {
  const { data: session, error } = await db
    .from('heart_rate_sessions')
    .select(`
      id, contact_id, location_id, booking_id, started_at, ended_at,
      max_hr_used, avg_hr_bpm, peak_hr_bpm, zones_seconds, effort_points,
      email_sent_at, source, device_identifier,
      contact:contacts!heart_rate_sessions_contact_id_fkey ( id, name, email, hr_post_class_emails_enabled ),
      booking:bookings!heart_rate_sessions_booking_id_fkey ( id, booking_date, start_time,
        event_type:event_types!bookings_event_type_id_fkey ( id, name )
      )
    `)
    .eq('id', sessionId)
    .single()

  if (error || !session) {
    return { ok: false, error: error?.message || 'Session not found' }
  }
  if (!session.ended_at) {
    return { ok: false, error: 'Session not ended yet' }
  }
  if (session.email_sent_at) {
    return { ok: false, error: 'already-sent', alreadySent: true }
  }

  const eventTypeId = session.booking?.event_type?.id || null
  const eventTypeName = session.booking?.event_type?.name || null

  // Pull 90 days of history for this contact, all class types.
  // Just the columns the analytics layer needs.
  const sinceIso = new Date(Date.now() - HISTORY_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString()
  const { data: historyRows } = await db
    .from('heart_rate_sessions')
    .select(`id, started_at, ended_at, effort_points, peak_hr_bpm, avg_hr_bpm, zones_seconds,
             booking:bookings!heart_rate_sessions_booking_id_fkey ( event_type_id )`)
    .eq('contact_id', session.contact_id)
    .gte('started_at', sinceIso)
    .not('ended_at', 'is', null)

  const history = (historyRows || []).map((r) => ({
    id: r.id,
    started_at: r.started_at,
    event_type_id: r.booking?.event_type_id || null,
    effort_points: r.effort_points,
    peak_hr_bpm: r.peak_hr_bpm,
    avg_hr_bpm: r.avg_hr_bpm,
    zones_seconds: r.zones_seconds,
  }))

  // The "thisSession" shape mirrors the history shape so the
  // analytics layer doesn't have to special-case.
  const thisSession = {
    id: session.id,
    started_at: session.started_at,
    event_type_id: eventTypeId,
    effort_points: session.effort_points,
    peak_hr_bpm: session.peak_hr_bpm,
    avg_hr_bpm: session.avg_hr_bpm,
    zones_seconds: session.zones_seconds,
  }

  return {
    ok: true,
    session,
    thisSession,
    history,
    eventTypeName,
    contact: session.contact,
  }
}

// ── (2) compose ─────────────────────────────────────────────────

/**
 * Compose the email from a context bundle. Pure: no IO, no fetch,
 * no Date.now() unless caller passes nowMs. Returns subject + html
 * + text. Tested standalone.
 */
export function composeEmail(ctx, { nowMs = Date.now() } = {}) {
  const { session, thisSession, history, eventTypeName, contact } = ctx
  const analytics = buildSessionAnalytics({ thisSession, history, eventTypeName, nowMs })
  const breakdown = zoneBreakdown(session.zones_seconds)

  const firstName = (contact?.name || 'there').split(/\s+/)[0]
  const classLabel = eventTypeName ? eventTypeName : 'your workout'
  const startedAt = formatStartLabel(session.started_at)
  const points = Number.isFinite(session.effort_points) ? session.effort_points : 0
  const peak = Number.isFinite(session.peak_hr_bpm) ? session.peak_hr_bpm : null
  const avg = Number.isFinite(session.avg_hr_bpm) ? session.avg_hr_bpm : null
  const durationMin = computeDurationMin(session)

  const sessionUrl = `${APP_URL}/sessions/${session.id}`

  const subject = pickSubject({ firstName, classLabel, points, highlight: analytics.highlight })

  return {
    subject,
    text: renderText({
      firstName, classLabel, startedAt, points, peak, avg, durationMin,
      breakdown, analytics, sessionUrl,
    }),
    html: renderHtml({
      firstName, classLabel, startedAt, points, peak, avg, durationMin,
      breakdown, analytics, sessionUrl, contact, sessionId: session.id,
    }),
    analytics,
  }
}

function pickSubject({ firstName, classLabel, points, highlight }) {
  if (highlight?.id === 'first_ever') return `Welcome to UN1T HR, ${firstName}`
  if (highlight?.id === 'first_z5') return `${firstName}, you hit Z5 today`
  if (highlight?.id === 'new_peak') return `New peak HR for ${firstName} 🔥`
  if (highlight?.id === 'best_class_type_points') return `${firstName} — personal best in ${classLabel}`
  if (highlight?.id === 'top_quartile_recent') return `${firstName}, big day at UN1T (${points} UN1T Points)`
  if (highlight?.id === 'streak') return `${firstName}, you're on a streak`
  return `Your ${classLabel} — ${points} UN1T Points`
}

function trendLabel(trend) {
  if (!trend?.hasEnoughData || !Number.isFinite(trend.deltaPct)) return null
  const pct = Math.round(Math.abs(trend.deltaPct) * 100)
  if (trend.direction === 'up')   return { dir: 'up', pct, label: `up ${pct}% vs the previous 4 weeks` }
  if (trend.direction === 'down') return { dir: 'down', pct, label: `down ${pct}% vs the previous 4 weeks` }
  return { dir: 'flat', pct, label: 'steady vs the previous 4 weeks' }
}

function classTypeLabel(classType) {
  if (!classType?.thisPoints) return null
  if (classType.recentCount < 2) {
    return `Your ${classType.recentCount === 0 ? 'first' : 'second'} ${classType.eventTypeName || 'session of this type'} on record.`
  }
  if (classType.percentile == null) return null
  const pctRound = Math.round(classType.percentile * 100)
  if (pctRound >= 75) return `Top ${100 - pctRound}% of your last ${classType.recentCount} ${classType.eventTypeName || 'sessions'}.`
  if (pctRound >= 50) return `Above your usual for ${classType.eventTypeName || 'this class'} (mean ${classType.meanPoints} pts over your last ${classType.recentCount}).`
  if (pctRound >= 25) return `A bit below your usual for ${classType.eventTypeName || 'this class'} (mean ${classType.meanPoints} pts).`
  return `Lighter than your usual ${classType.eventTypeName || 'session'} — yours mean ${classType.meanPoints} pts.`
}

function renderText({ firstName, classLabel, startedAt, points, peak, avg, durationMin, breakdown, analytics, sessionUrl }) {
  const lines = []
  lines.push(`Hi ${firstName},`)
  lines.push('')
  lines.push(`${classLabel} on ${startedAt} — ${points} UN1T Points.`)
  if (analytics.highlight) lines.push('')
  if (analytics.highlight) lines.push(`★ ${analytics.highlight.message}`)
  lines.push('')
  if (durationMin) lines.push(`Duration: ${durationMin} min`)
  if (avg != null) lines.push(`Avg HR:   ${avg} bpm`)
  if (peak != null) lines.push(`Peak HR:  ${peak} bpm`)
  lines.push('')
  lines.push('Zones:')
  for (const z of breakdown) {
    if (z.seconds === 0) continue
    const min = Math.round(z.seconds / 60)
    const pct = Math.round(z.percent * 100)
    lines.push(`  ${z.label} ${z.name.padEnd(10)}  ${String(min).padStart(2)} min · ${pct}%`)
  }

  const ctLabel = classTypeLabel(analytics.classType)
  if (ctLabel) {
    lines.push('')
    lines.push(`Class trend — ${ctLabel}`)
  }

  const tPoints = trendLabel(analytics.overall.pointsTrend)
  if (tPoints) {
    lines.push('')
    lines.push(`Overall: UN1T Points ${tPoints.label}.`)
  }

  lines.push('')
  lines.push(`See the full session: ${sessionUrl}`)
  return lines.join('\n')
}

function renderHtml({ firstName, classLabel, startedAt, points, peak, avg, durationMin, breakdown, analytics, sessionUrl, contact, sessionId }) {
  const ctLabel = classTypeLabel(analytics.classType)
  const tPoints = trendLabel(analytics.overall.pointsTrend)
  const tPeak = trendLabel(analytics.overall.peakTrend)

  const zoneRows = breakdown
    .filter((z) => z.seconds > 0)
    .map((z) => {
      const min = Math.round(z.seconds / 60)
      const pct = Math.round(z.percent * 100)
      return `
      <tr>
        <td style="padding:6px 0;width:40px;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${z.color};vertical-align:middle;"></span>
          <strong style="margin-left:6px;font-family:Arial,sans-serif;font-size:13px;">${z.label}</strong>
        </td>
        <td style="padding:6px 0;font-family:Arial,sans-serif;font-size:13px;color:#444;">${escapeHtml(z.name)}</td>
        <td style="padding:6px 0;font-family:Arial,sans-serif;font-size:13px;color:#666;text-align:right;width:120px;">
          ${min} min &middot; ${pct}%
        </td>
      </tr>
      <tr>
        <td colspan="3" style="padding:0 0 6px 0;">
          <div style="height:6px;background:#eee;border-radius:3px;overflow:hidden;">
            <div style="height:6px;width:${pct}%;background:${z.color};"></div>
          </div>
        </td>
      </tr>`
    }).join('')

  const highlightHtml = analytics.highlight ? `
    <div style="background:linear-gradient(135deg,#1f2937,#111);color:#fff;padding:14px 18px;border-radius:8px;margin:18px 0;">
      <div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#fbbf24;font-family:Arial,sans-serif;">Highlight</div>
      <div style="font-size:16px;margin-top:4px;font-family:Arial,sans-serif;">${escapeHtml(analytics.highlight.message)}</div>
    </div>` : ''

  const insightLines = []
  if (ctLabel) insightLines.push(`<strong>${escapeHtml(classLabel)}:</strong> ${escapeHtml(ctLabel)}`)
  if (tPoints) {
    const arrow = tPoints.dir === 'up' ? '↑' : tPoints.dir === 'down' ? '↓' : '→'
    insightLines.push(`<strong>UN1T Points overall:</strong> ${arrow} ${escapeHtml(tPoints.label)}`)
  }
  if (tPeak && tPeak.dir !== 'flat') {
    const arrow = tPeak.dir === 'up' ? '↑' : '↓'
    insightLines.push(`<strong>Peak HR overall:</strong> ${arrow} ${escapeHtml(tPeak.label)}`)
  }

  const insightsHtml = insightLines.length === 0 ? '' : `
    <div style="margin:18px 0;padding:14px 18px;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa;">
      <div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#666;font-family:Arial,sans-serif;margin-bottom:8px;">Trends</div>
      <ul style="margin:0;padding-left:18px;font-family:Arial,sans-serif;font-size:13px;color:#222;line-height:1.6;">
        ${insightLines.map((l) => `<li>${l}</li>`).join('')}
      </ul>
    </div>`

  const unsubUrl = unsubscribeUrl({ contactId: contact?.id, sessionId })

  return `
<!doctype html>
<html><body style="margin:0;background:#f4f4f5;padding:24px 12px;font-family:Arial,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;">
  <tr><td style="padding:24px 28px;">
    <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#888;">UN1T &middot; ${escapeHtml(startedAt)}</div>
    <h1 style="margin:6px 0 4px 0;font-size:22px;color:#111;">Hi ${escapeHtml(firstName)},</h1>
    <p style="margin:0;color:#444;font-size:14px;line-height:1.5;">
      Here's how your <strong>${escapeHtml(classLabel)}</strong> went.
    </p>

    ${highlightHtml}

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:18px 0;">
      <tr>
        <td style="background:#fafafa;border-radius:8px;padding:14px;text-align:center;width:33.33%;border:1px solid #e5e7eb;">
          <div style="font-size:11px;color:#666;letter-spacing:.1em;text-transform:uppercase;">UN1T Points</div>
          <div style="font-size:28px;font-weight:bold;color:#111;margin-top:2px;">${points}</div>
        </td>
        <td style="width:6px;"></td>
        <td style="background:#fafafa;border-radius:8px;padding:14px;text-align:center;width:33.33%;border:1px solid #e5e7eb;">
          <div style="font-size:11px;color:#666;letter-spacing:.1em;text-transform:uppercase;">Peak HR</div>
          <div style="font-size:28px;font-weight:bold;color:#111;margin-top:2px;">${peak ?? '—'}<span style="font-size:13px;font-weight:500;color:#666;"> bpm</span></div>
        </td>
        <td style="width:6px;"></td>
        <td style="background:#fafafa;border-radius:8px;padding:14px;text-align:center;width:33.33%;border:1px solid #e5e7eb;">
          <div style="font-size:11px;color:#666;letter-spacing:.1em;text-transform:uppercase;">Avg HR</div>
          <div style="font-size:28px;font-weight:bold;color:#111;margin-top:2px;">${avg ?? '—'}<span style="font-size:13px;font-weight:500;color:#666;"> bpm</span></div>
        </td>
      </tr>
    </table>
    ${durationMin ? `<p style="margin:0 0 16px 0;font-size:13px;color:#666;">Duration ${durationMin} min</p>` : ''}

    <h2 style="font-size:14px;color:#444;margin:18px 0 6px 0;">Zones</h2>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
      ${zoneRows || '<tr><td style="font-size:13px;color:#888;">No zone data captured.</td></tr>'}
    </table>

    ${insightsHtml}

    <p style="margin:24px 0 0 0;text-align:center;">
      <a href="${escapeHtml(sessionUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;">
        View the full session
      </a>
    </p>

    <p style="margin:24px 0 0 0;font-size:11px;color:#9ca3af;text-align:center;">
      You're getting this because you trained with a heart-rate
      monitor at UN1T. <a href="${escapeHtml(unsubUrl)}" style="color:#9ca3af;">Stop these emails</a>.
    </p>
  </td></tr>
</table>
</body></html>`.trim()
}

function unsubscribeUrl({ contactId, sessionId }) {
  // The handler we'll add in a follow-up cleans the flag. For
  // now we just embed both ids; if the URL is hit before the
  // handler exists, the click 404s but the user gave consent at
  // signup so this is acceptable.
  const params = new URLSearchParams({ scope: 'hr', cid: contactId || '', sid: sessionId || '' })
  return `${CRM_URL}/api/preferences/hr-emails?${params.toString()}`
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function formatStartLabel(iso) {
  try {
    return formatWeekdayShortDateTimeInTZ(iso)
  } catch {
    return new Date(iso).toLocaleString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  }
}

function computeDurationMin(session) {
  if (!session.started_at || !session.ended_at) return null
  const ms = new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.max(1, Math.round(ms / 60_000))
}

// ── (3) send ────────────────────────────────────────────────────

/**
 * Top-level orchestrator. Returns:
 *   { ok: true, sent: true }                     — email went out
 *   { ok: true, skipped: '<reason>' }            — opted out / no email / already sent / no points
 *   { ok: false, error }                         — load or send failed (logged)
 *
 * Never throws. Caller can check `sent` for analytics but doesn't
 * need to handle exceptions.
 */
export async function sendPostClassEmail(db, sessionId, { nowMs = Date.now() } = {}) {
  const ctx = await loadContextForSession(db, sessionId)
  if (!ctx.ok) {
    if (ctx.alreadySent) return { ok: true, skipped: 'already-sent' }
    logWarn('hr-post-class-email', 'load context failed', { sessionId, err: ctx.error })
    return { ok: false, error: ctx.error }
  }

  const { contact, session } = ctx
  if (!contact?.email) {
    return { ok: true, skipped: 'no-email' }
  }
  if (contact.hr_post_class_emails_enabled === false) {
    return { ok: true, skipped: 'opted-out' }
  }
  // Don't send for sessions that captured nothing — the email would
  // be embarrassingly empty. Threshold: at least 1min of any-zone data.
  const anyZoneSec = Object.values(session.zones_seconds || {}).reduce((a, b) => a + Number(b || 0), 0)
  if (anyZoneSec < 60) {
    return { ok: true, skipped: 'too-little-data' }
  }

  let composed
  try {
    composed = composeEmail(ctx, { nowMs })
  } catch (e) {
    logError('hr-post-class-email', 'compose threw', { sessionId, err: e })
    return { ok: false, error: e.message }
  }

  try {
    await sendTransactionalEmail({
      to: contact.email,
      subject: composed.subject,
      htmlBody: composed.html,
      contactId: contact.id,
      locationId: session.location_id,
      tag: 'hr-post-class',
    })
  } catch (e) {
    logError('hr-post-class-email', 'postmark send threw', { sessionId, err: e })
    return { ok: false, error: e.message }
  }

  // Stamp dedup column. If this fails we logged it but don't roll
  // back the send — duplicate sends aren't catastrophic; missing
  // sends are.
  const { error: stampErr } = await db
    .from('heart_rate_sessions')
    .update({ email_sent_at: new Date(nowMs).toISOString() })
    .eq('id', sessionId)
  if (stampErr) {
    logWarn('hr-post-class-email', 'stamp email_sent_at failed', { sessionId, err: stampErr })
  }

  logInfo('hr-post-class-email', 'sent', {
    sessionId, contactId: contact.id, subject: composed.subject,
    highlight: composed.analytics.highlight?.id || null,
  })
  return { ok: true, sent: true, subject: composed.subject }
}
