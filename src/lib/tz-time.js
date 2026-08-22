// SHELLY.1 — wall-clock maths for an arbitrary IANA zone. Lives here, NOT in
// dublin-time.js: that file's export list is pinned by
// tests/shared-pair-sync.test.js (mode `diverged`), so it cannot grow.
//
// The guess-and-correct technique is the one dublin-time's dublinDayStartMs
// uses, with TWO fixes. Both were measured against an independent oracle
// (every instant that reads back as the wanted wall-clock) over 105,120
// quarter-hour slots per zone across 2025-2027, in 12 zones.
//
// FIX 1 — correct from the FULL date+time read-back, not minute-of-day.
// Minute-of-day alone is a whole DAY wrong whenever the read-back lands on a
// different calendar date than the guess. That is every wall-clock time in a
// negative-offset zone at/after (24h - |offset|)... and also Europe/Dublin
// itself at 23:00-23:59 during IST, which is why the engine's private
// dublinWallMs is NOT what this module reproduces — see FIX 1 note below.
//
// FIX 2 — TWO correction passes, not one. Pass 1 samples the zone's offset at
// the naive guess, which sits on the WRONG SIDE of a DST transition whenever
// the zone's standard offset is not 0. One pass is therefore exact only for
// UTC-anchored zones (Europe/Dublin, Europe/London, UTC). Measured one-pass
// errors on real (existing) wall-clock times, 2025-2027:
//
//   Europe/Dublin 0 · Europe/London 0 · UTC 0 · Asia/Kolkata 0
//   Europe/Berlin 24 · America/New_York 96 · America/Los_Angeles 168
//   Australia/Sydney 240 · Australia/Lord_Howe 252 · Pacific/Auckland 288
//   Pacific/Chatham 306
//
// Two passes measured 0 errors in all 12 zones, and is agnostic to the size of
// the DST step (Lord Howe's is 30 minutes, not an hour).
//
// Inside a spring-forward gap no instant exists, so there is no right answer;
// this resolves to the same deterministic nearby instant the Dublin engine
// already accepts (nonexistent → earlier, ambiguous → later).
//
// FIX 1 note, for whoever moves the engine onto this module: for Europe/Dublin
// this is bit-identical to desired-state.js's private dublinWallMs EXCEPT at
// wall-clock 23:00-23:59 during IST, where dublinWallMs is a whole day late
// (1,274 of 52,560 sampled pairs). This module is the correct one. No existing
// engine test covers a 23:00+ boundary, so that divergence is invisible to
// them; a fixed_window with a 23:00 on/off boundary is a live bug today.

import { addDaysISO } from '@/lib/dublin-time'

export const DEFAULT_TZ = 'Europe/Dublin'

const _fmt = new Map()
const _valid = new Map()

function partsFmt(tz) {
  if (!_fmt.has(tz)) {
    _fmt.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }))
  }
  return _fmt.get(tz)
}

export function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false
  if (!_valid.has(tz)) {
    try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); _valid.set(tz, true) }
    catch { _valid.set(tz, false) }
  }
  return _valid.get(tz)
}

// locations.timezone is nullable free text; an invalid value must not throw
// inside a cron. Callers log the fallback once per location if they care.
export function resolveTz(tz) {
  return isValidTz(tz) ? tz : DEFAULT_TZ
}

function readParts(ms, tz) {
  const p = {}
  for (const { type, value } of partsFmt(tz).formatToParts(new Date(ms))) p[type] = value
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: hour, mi: Number(p.minute) }
}

// Wall-clock in `tz` at `ms`, re-encoded as if it were UTC ("naive" ms).
function naiveWallMs(ms, tz) {
  const { y, mo, d, h, mi } = readParts(ms, tz)
  return Date.UTC(y, mo - 1, d, h, mi)
}

// The zone's UTC offset in ms at instant `ms` (east of UTC is positive).
function offsetMsAt(ms, tz) {
  return naiveWallMs(ms, tz) - ms
}

// 'YYYY-MM-DD' of the instant in `tz`. Intl parts, never toISOString().slice.
export function dayStrInTz(instant = Date.now(), tz = DEFAULT_TZ) {
  const ms = instant instanceof Date ? instant.getTime() : Number(instant)
  const { y, mo, d } = readParts(ms, tz)
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// UTC ms of wall-clock HH:MM on calendar date `dateStr` in `tz`; null on a bad HH:MM.
export function wallMsInTz(dateStr, hhmm, tz = DEFAULT_TZ) {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/)
  if (!m) return null
  const [y, mo, d] = String(dateStr).split('-').map(Number)
  if (![y, mo, d].every(Number.isFinite)) return null
  const want = Date.UTC(y, mo - 1, d, Number(m[1]), Number(m[2]))
  // Solve ms + offset(ms) = want. Pass 1 samples the offset at `want` itself,
  // which is the wrong side of a transition for a band of wall-clock times on
  // each DST day in any zone whose standard offset is not 0. Pass 2 re-samples
  // at that candidate, which lands on the correct side.
  const ms1 = want - offsetMsAt(want, tz)
  const ms2 = want - offsetMsAt(ms1, tz)
  if (ms1 === ms2) return ms1                        // converged: exact
  if (naiveWallMs(ms2, tz) === want) return ms2      // pass 2 reads back exactly
  if (naiveWallMs(ms1, tz) === want) return ms1      // (defensive; not observed)
  return Math.min(ms1, ms2)                          // spring-forward gap → earlier
}

export function dayStartMsInTz(dateStr, tz = DEFAULT_TZ) {
  return wallMsInTz(dateStr, '00:00', tz)
}

// Next local midnight strictly after `instant` — the default expiry of a manual override.
export function nextLocalMidnightMs(instant = Date.now(), tz = DEFAULT_TZ) {
  return dayStartMsInTz(addDaysISO(dayStrInTz(instant, tz), 1), tz)
}
