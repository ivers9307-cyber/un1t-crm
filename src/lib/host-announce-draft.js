// HOSTPORTAL.4 — the draft behind "Write an email about this event".
//
// FORMAT: body_html is plain HTML paragraphs (<p>…</p>) with one <a href>.
// That is exactly what the composer stores for a host who types the same in
// its "Plain text" mode (a draft with no design_json): the textarea's value
// goes to body_html untouched, renderHostCampaignHtml sanitizes it and drops
// it inside the server shell's content cell, and the preview route renders
// the same way. A bare newline would collapse in the sent email, so paragraphs
// are explicit. The link is a plain <a href> to the public event URL, which
// tagHostCampaignLinks tags with hc=<campaign id> at send time.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** "Saturday 14 November 2026" from a date-only "YYYY-MM-DD"; '' if unreadable. No time zone is involved. */
export function dateInWords(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''))
  if (!m) return ''
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return ''
  // Day of week from the calendar date itself (UTC arithmetic on a date-only value).
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]
  return `${weekday} ${d} ${MONTHS[mo - 1]} ${y}`
}

/**
 * @param {{ event: { name?: string, race_date?: string|null, venue_name?: string|null },
 *           sessions?: Array<{ time: string, label?: string }>, eventUrl: string }} args
 *   (the date is date-only, so no zone is needed)
 * @returns {{ subject: string, body_html: string }}
 */
export function announceDraft({ event, sessions = [], eventUrl }) {
  const name = String(event?.name || '')
  const paras = [`<p><strong>${esc(name)}</strong></p>`]
  const when = dateInWords(event?.race_date)
  if (when) paras.push(`<p>${esc(when)}</p>`)
  const times = (sessions || [])
    .filter((s) => s && s.time)
    .map((s) => (s.label ? `${esc(s.time)} (${esc(s.label)})` : esc(s.time)))
  if (times.length) paras.push(`<p>${times.length > 1 ? 'Session times' : 'Session time'}: ${times.join(', ')}</p>`)
  if (event?.venue_name) paras.push(`<p>${esc(event.venue_name)}</p>`)
  paras.push(`<p><a href="${esc(eventUrl)}">Book your place</a></p>`)
  return { subject: name.slice(0, 200), body_html: paras.join('\n') }
}
