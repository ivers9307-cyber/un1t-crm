// OPENWEEK.1 — an open week's picked classes as people read them: in the
// confirmation email ({class_list}) and on the staff alert. Each line is
// "Tue 24 Nov, 07:00, <class name>" on the studio's clock, in start order.
import { formatInZone } from '@/lib/location-time'
import { escapeHtml } from '@/lib/html-escape'

const DAY = Object.freeze({ weekday: 'short', day: 'numeric', month: 'short' })
const TIME = Object.freeze({ hour: '2-digit', minute: '2-digit', hour12: false })

/** @returns {string[]} */
export function openWeekClassLines(picks, zone) {
  return (Array.isArray(picks) ? picks : [])
    .filter((p) => p && Number.isFinite(Date.parse(p.starts_at)))
    .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))
    .map((p) => {
      const d = new Date(p.starts_at)
      const day = formatInZone(d, zone, DAY, 'en-GB').replace(/,/g, '')
      return `${day}, ${formatInZone(d, zone, TIME, 'en-GB')}, ${p.name || 'Class'}`
    })
}

/** An escaped <ul>, or '' for no picks. */
export function openWeekClassListHtml(picks, zone) {
  const lines = openWeekClassLines(picks, zone)
  return lines.length ? `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''
}

/** One class per line, unescaped (plain text). */
export function openWeekClassListText(picks, zone) {
  return openWeekClassLines(picks, zone).join('\n')
}
