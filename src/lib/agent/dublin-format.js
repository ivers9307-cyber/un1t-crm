// MIA-REVIEW.3 — the agent's ONE class-time formatter.
//
// Lived in booking-tools.js, which statically imports @/lib/glofox — so
// account-tools.js (deliberately test-loadable without the Next runtime)
// could not reuse it and kept handing the model a raw UTC ISO string. That
// is the documented mis-hour bug: a 7am summer class relayed as "6am"
// (live test 2026-06-12). Both files now import from here; booking-tools
// re-exports it so its public surface is unchanged.

const DUBLIN_TIME_FMT = new Intl.DateTimeFormat('en-IE', {
  timeZone: 'Europe/Dublin',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * Format a unix-seconds instant as a Dublin wall-clock label the model can
 * relay verbatim, e.g. "Sat 13 Jun, 07:00". Glofox time_start is an absolute
 * instant; the model must never do timezone math. The formatter pins
 * timeZone: 'Europe/Dublin', so the machine's TZ is irrelevant. Pure.
 */
export function formatDublinClassTime(unixSec) {
  const parts = {}
  for (const p of DUBLIN_TIME_FMT.formatToParts(new Date(unixSec * 1000))) {
    parts[p.type] = p.value
  }
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`
}
