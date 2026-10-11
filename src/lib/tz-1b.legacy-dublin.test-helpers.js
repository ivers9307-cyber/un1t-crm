// TZ.1b — FROZEN copies of the three private wall-clock solvers this task
// retired, copied verbatim from origin/main a3b205e3. Bodies are unchanged;
// only the exported names gain a `Legacy` suffix, and computeDeadlineAt's
// private helpers travel with it. src/lib/tz-1b.tz.test.js diffs the new code
// against these. Test-only: nothing in src/ imports this file. TZ.18b deletes
// it once the timezone wave has merged.

// ── src/lib/push-reminders.js: localToUtc ──────────────────────────────────
const partsFormatters = new Map()
function partsFormatterFor(tz) {
  let fmt = partsFormatters.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    partsFormatters.set(tz, fmt)
  }
  return fmt
}

export function localToUtcLegacy(dateStr, timeStr, tz) {
  try {
    const [y, m, d] = dateStr.split('-').map(Number)
    const [hh, mm, ss = '0'] = String(timeStr).split(':')
    const candidate = new Date(Date.UTC(y, m - 1, d, Number(hh), Number(mm), Number(ss)))
    if (Number.isNaN(candidate.getTime())) return null

    const parts = partsFormatterFor(tz).formatToParts(candidate).reduce((a, p) => (a[p.type] = p.value, a), {})

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

// ── src/lib/checklist-instances.js: todayInTimezone, computeDeadlineAt ──
export function todayInTimezoneLegacy(now, timezone) {
  const tz = timezone || 'Europe/Dublin'
  // Get the calendar-date parts in tz.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now)
  const find = (t) => parts.find((p) => p.type === t)?.value
  const date = `${find('year')}-${find('month')}-${find('day')}`
  // Convert weekday short label to dow (Pg convention).
  const weekday = find('weekday')   // e.g. "Mon"
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { date, dow: DOW[weekday] ?? 0 }
}

export function computeDeadlineAtLegacy(blocks, timezone) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null
  let latestUtcMs = null
  for (const b of blocks) {
    if (!b?.block_date || !b?.end_time) continue
    const iso = `${b.block_date}T${b.end_time}`
    const ms = parseLocalToUtcMs(iso, timezone || 'Europe/Dublin')
    if (Number.isFinite(ms) && (latestUtcMs == null || ms > latestUtcMs)) {
      latestUtcMs = ms
    }
  }
  return latestUtcMs == null ? null : new Date(latestUtcMs).toISOString()
}

function parseLocalToUtcMs(localIso, timezone) {
  // Trim off any trailing 'Z' or offset — local means local.
  const cleaned = localIso.replace(/[zZ].*$/, '').replace(/[+-]\d\d:?\d\d$/, '')
  // Compose a guess UTC and snap by the timezone offset at that
  // moment. Two-pass to absorb DST in the same direction.
  const guess = Date.parse(`${cleaned}Z`)
  if (!Number.isFinite(guess)) return NaN
  const offsetMs = tzOffsetMs(new Date(guess), timezone)
  const candidate = guess - offsetMs
  // One refinement in case DST shifted under us.
  const offsetMs2 = tzOffsetMs(new Date(candidate), timezone)
  return guess - offsetMs2
}

function tzOffsetMs(date, timezone) {
  // Intl can give us the wall-clock parts in the target tz; compute
  // their UTC ms and the diff is the offset.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = fmt.formatToParts(date)
  const find = (t) => parts.find((p) => p.type === t)?.value
  const localMs = Date.UTC(
    Number(find('year')),
    Number(find('month')) - 1,
    Number(find('day')),
    Number(find('hour')),
    Number(find('minute')),
    Number(find('second')),
  )
  return localMs - date.getTime()
}

// ── src/lib/staff-attendance.js: resolveScheduledAt ────────────────────────
export function resolveScheduledAtLegacy(dateStr, timeStr, tz = 'UTC') {
  if (!dateStr || !timeStr) return null
  const [yy, mm, dd] = String(dateStr).split('-').map(Number)
  const [hh = 0, mi = 0, ss = 0] = String(timeStr).split(':').map(Number)
  if ([yy, mm, dd, hh, mi].some((n) => !Number.isFinite(n))) return null

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  // The zone's wall clock at instant `ms`, re-encoded as if it were UTC.
  const wallAt = (ms) => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
    // Intl reports midnight as '24' in some locales — normalise.
    const h = (+parts.hour === 24) ? 0 : +parts.hour
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, h, +parts.minute, +parts.second)
  }

  // The wall clock values AS IF they were UTC.
  const want = Date.UTC(yy, mm - 1, dd, hh, mi, ss)
  // Pass 1: the offset read at `want` itself (the old single pass).
  const ms1 = want - (wallAt(want) - want)
  // Pass 2: the offset read at pass 1's answer, kept only when exact.
  const ms2 = want - (wallAt(ms1) - ms1)
  return new Date(ms2 !== ms1 && wallAt(ms2) === want ? ms2 : ms1)
}
