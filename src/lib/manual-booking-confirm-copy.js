// MANUALCONFIRM.1 — the operator-editable copy of the email a customer gets
// when staff approve a booking off a hand-written timetable, and the pure
// helpers around it. No server imports: the landing-page editor (a client
// component) reads the defaults from here; the sender lives in
// manual-booking-confirm.js.
//
// Placeholders use the same single-brace form as the cancellation-form copy:
// {first_name}, {class_name}, {class_time}, {studio_name}, {address}.
import { DEFAULT_TZ } from '@shared/zoned-time' // pure: safe in the client editor

export const DEFAULT_MANUAL_CONFIRM_EMAIL = Object.freeze({
  subject: 'You are booked in at {studio_name}',
  body: [
    'Hi {first_name},',
    '',
    'You are booked in for {class_name} on {class_time} at {studio_name}.',
    '',
    '{address}',
    '',
    'Arrive about 10 minutes early and a coach will meet you and show you around. Your first class is free.',
    '',
    'If you need to change the time, just reply to this email.',
    '',
    'See you then,',
    '{studio_name}',
  ].join('\n'),
})

// One formatter per zone, built on first use. Same options as before TZ.7, so
// a Dublin studio's text is byte-identical.
const labelFmts = new Map()
function labelFmt(zone) {
  let f = labelFmts.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-IE', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false })
    labelFmts.set(zone, f)
  }
  return f
}

/**
 * "Monday 5 October at 06:00", the studio's wall clock (`zone`: the booking's
 * location zone, TZ.7). '' for an unreadable time.
 */
export function formatClassTime(startsAt, zone = DEFAULT_TZ) {
  const d = startsAt ? new Date(startsAt) : null
  if (!d || isNaN(d.getTime())) return ''
  const parts = labelFmt(zone).formatToParts(d)
  const get = (t) => parts.find((p) => p.type === t)?.value || ''
  return `${get('weekday')} ${get('day')} ${get('month')} at ${get('hour')}:${get('minute')}`
}

/** The subject + body templates: the class_funnel block's own copy, or the defaults. */
export function manualConfirmEmailFromBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const cf = list.find((b) => b && typeof b === 'object' && b.type === 'class_funnel')
  const pick = (v, fallback) => (typeof v === 'string' && v.trim() ? v : fallback)
  return {
    subject: pick(cf?.confirm_email_subject, DEFAULT_MANUAL_CONFIRM_EMAIL.subject),
    body: pick(cf?.confirm_email_body, DEFAULT_MANUAL_CONFIRM_EMAIL.body),
  }
}

/** Plain text → the minimal HTML the other transactional confirmations use. */
export function confirmEmailHtml(text) {
  const safe = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>')
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111"><p style="margin:0">${safe}</p></div>`
}
