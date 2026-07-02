// NOTIF.1 — helpers for the send-push-reminders cron.
//
// Extracted so the timezone math is testable without spinning up
// the full route handler (Supabase + push.js are awkward to mock,
// and the time math is the only bit that's genuinely tricky).

/**
 * Treat (dateStr, timeStr) as wall-clock time in `tz`, return the
 * equivalent UTC Date.
 *
 * dateStr: 'YYYY-MM-DD'
 * timeStr: 'HH:MM' | 'HH:MM:SS'
 * tz:      IANA tz, e.g. 'Europe/Dublin'
 *
 * Strategy: build a candidate UTC Date assuming the supplied time IS
 * UTC, format it back in tz, compute the offset between what we got
 * and what we wanted. Subtract the offset to get the true UTC. One
 * pass is enough — tz offsets don't have sub-second drift around
 * DST transitions.
 *
 * Handles DST correctly: a Dublin task at 14:00 on 2026-03-29 (DST
 * transition day, no clock issue at 14:00) → 13:00 UTC. A Dublin
 * task at 14:00 on 2026-12-15 (no DST) → 14:00 UTC.
 */
export function localToUtc(dateStr, timeStr, tz) {
  try {
    const [y, m, d] = dateStr.split('-').map(Number)
    const [hh, mm, ss = '0'] = String(timeStr).split(':')
    const candidate = new Date(Date.UTC(y, m - 1, d, Number(hh), Number(mm), Number(ss)))
    if (Number.isNaN(candidate.getTime())) return null

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(candidate).reduce((a, p) => (a[p.type] = p.value, a), {})

    const actualMs = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      // 'en-US' returns hour='24' for midnight; coerce.
      parts.hour === '24' ? 0 : Number(parts.hour),
      Number(parts.minute), Number(parts.second)
    )
    const offsetMs = actualMs - candidate.getTime()
    return new Date(candidate.getTime() - offsetMs)
  } catch {
    return null
  }
}

/**
 * Format a 'HH:MM' or 'HH:MM:SS' time string as a friendly 12-hour
 * label for push notification bodies: '14:30:00' → '2:30pm'.
 */
export function formatLocalTime(timeStr) {
  if (!timeStr) return ''
  const [hh, mm] = String(timeStr).split(':')
  const h = Number(hh) % 12 || 12
  const ampm = Number(hh) < 12 ? 'am' : 'pm'
  return `${h}:${mm}${ampm}`
}

/**
 * Returns true if `dueUtcIso` falls inside the fire window around
 * (nowMs + leadMinutes). Pure: makes the cron's window-membership
 * decision testable without faking dates.
 *
 * The window is ASYMMETRIC: up to `windowMin` minutes early, but up to
 * `lateWindowMin` minutes late. A symmetric ±5 window with a 5-minute
 * cron meant two consecutive missed Vercel ticks silently dropped the
 * reminder forever (by the next tick it was outside the window and had
 * never reached the dedup ledger). The wider late side gives missed
 * ticks a catch-up runway; the ledger's UNIQUE constraint still
 * guarantees at-most-once on normal operation. Omitting lateWindowMin
 * keeps the old symmetric behaviour.
 */
export function inLeadWindow(dueUtcIso, nowMs, leadMinutes, windowMin = 5, lateWindowMin = windowMin) {
  const targetMs = nowMs + leadMinutes * 60 * 1000
  const t = new Date(dueUtcIso).getTime()
  const deltaMs = t - targetMs // > 0 = we're early, < 0 = we're late
  return deltaMs <= windowMin * 60 * 1000 && deltaMs >= -lateWindowMin * 60 * 1000
}
