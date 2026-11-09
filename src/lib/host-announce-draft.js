// HOSTPORTAL.4 — the draft behind "Write an email about this event".
//
// FORMAT: body_html is three plain HTML paragraphs (<p>…</p>) with one <a href>.
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

/** "10:00", "10:00 and 12:30", "10:00, 12:30 and 15:00". */
function joinTimes(times) {
  if (times.length <= 1) return times.join('')
  return `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}`
}

/**
 * Why the draft shortcut is unavailable for this event, or null when it is
 * available. `today` is the host's own calendar day ("YYYY-MM-DD"). One source
 * for both the route (its 409 message) and the Promote page (the button's
 * `blockedReason` prop).
 */
export function announceBlockedReason(event, today) {
  if (event?.race_date && today && String(event.race_date).slice(0, 10) < today) return 'This event has already taken place.'
  const status = event?.status
  if (status === 'pending_review') return 'This event is waiting for approval. You can email your list once it is on sale.'
  if (status === 'published') {
    return event?.active === true ? null : 'This event is off sale. Put it back on sale before emailing your list about it.'
  }
  return 'Publish this event before emailing your list about it.'
}

/**
 * Three short paragraphs, one per line: the name; the date, session times and
 * venue joined with " · "; the booking link. No inline tags besides the link.
 * @param {{ event: { name?: string, race_date?: string|null, venue_name?: string|null },
 *           sessions?: Array<{ time: string }>, eventUrl: string }} args
 *   (the date is date-only, so no zone is needed)
 * @returns {{ subject: string, body_html: string }}
 */
export function announceDraft({ event, sessions = [], eventUrl }) {
  const name = String(event?.name || '')
  const times = (sessions || []).filter((s) => s && s.time).map((s) => String(s.time))
  const middle = [dateInWords(event?.race_date), times.length ? joinTimes(times) : '', event?.venue_name ? String(event.venue_name) : '']
    .filter(Boolean)
    .map(esc)
    .join(' · ')
  const paras = [`<p>${esc(name)}</p>`]
  if (middle) paras.push(`<p>${middle}</p>`)
  paras.push(`<p><a href="${esc(eventUrl)}">Book your place</a></p>`)
  return { subject: name.slice(0, 200), body_html: paras.join('\n') }
}
