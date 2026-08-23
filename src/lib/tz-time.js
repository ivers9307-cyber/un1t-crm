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
// DST edges, and exactly what is promised:
//   • GAP (spring forward): the wall-clock does not exist, so there is no right
//     answer. Resolves EARLIER, uniformly — the same deterministic nearby
//     instant the Dublin engine already accepts for a schedule boundary.
//     dayStartMsInTz is the ONE deliberate exception; see there.
//   • OVERLAP (fall back): the wall-clock happens twice. Resolves to ONE
//     deterministic instant — the LATER one for a positive standard offset
//     (Dublin, Berlin, Sydney), the EARLIER one for a negative standard offset
//     (New York, Los Angeles, Santiago). This asymmetry is not chased: either
//     instant is a genuine instant for that wall-clock, which is all the
//     engine's contract requires, and forcing uniformity would cost two extra
//     Intl reads on EVERY call to buy nothing the engine uses.
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

function partsFmt(tz) {
  if (!_fmt.has(tz)) {
    _fmt.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }))
  }
  return _fmt.get(tz)
}

// The IANA zone names this runtime actually knows, built once on first use.
// 'UTC' is accepted explicitly: Intl resolves it (and 'GMT') to 'UTC', but it
// is NOT a member of supportedValuesOf('timeZone').
let _ianaZones = null
function ianaZones() {
  if (_ianaZones === null) _ianaZones = new Set(Intl.supportedValuesOf('timeZone'))
  return _ianaZones
}

// POSITIVE-only cache: raw input → canonical name. Constructing an
// Intl.DateTimeFormat to canonicalise costs ~27 µs, and a cron resolving a
// fleet asks the same handful of strings over and over. A FAILED lookup is
// never stored — negative caching is what would let arbitrary garbage grow the
// Map forever. Keys are LOWERCASED (Intl canonicalises case anyway), so every
// key names a real zone exactly once and the Map is bounded by the IANA set,
// literally. No eviction, so no thrash.
const _canon = new Map()

// Canonical IANA name for `tz`, or null if it is not one.
//
// Intl.DateTimeFormat also accepts FIXED OFFSETS ('+05:30', '-0800') and the
// Etc/GMT±N pseudo-zones. Those are rejected on purpose: a fixed offset has no
// DST, so accepting one would silently be an hour wrong for half the year —
// the exact class of bug this module exists to remove. Membership of the IANA
// set is the test; case is normalised for free ('europe/dublin' works).
// ('Etc/GMT' and 'Etc/UTC' DO pass: Intl canonicalises them to plain 'UTC',
// which has no DST hazard. Only the offset-bearing 'Etc/GMT±N' are rejected.)
function canonicalTz(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return null
  const key = tz.toLowerCase()
  const hit = _canon.get(key)
  if (hit !== undefined) return hit
  let canon
  try {
    canon = new Intl.DateTimeFormat('en-GB', { timeZone: tz }).resolvedOptions().timeZone
  } catch {
    return null
  }
  if (canon !== 'UTC' && !ianaZones().has(canon)) return null
  _canon.set(key, canon)
  return canon
}

export function isValidTz(tz) {
  return canonicalTz(tz) !== null
}

// locations.timezone is nullable free text; an invalid value must not throw
// inside a cron. Returns the CANONICAL name, so a row saved as 'europe/dublin'
// and one saved as 'Europe/Dublin' resolve to the same string. A hit is served
// from the positive cache above; a miss still pays the full Intl construction
// every time, on purpose — see _canon.
export function resolveTz(tz) {
  return canonicalTz(tz) ?? DEFAULT_TZ
}

function readParts(ms, tz) {
  const p = {}
  for (const { type, value } of partsFmt(tz).formatToParts(new Date(ms))) p[type] = value
  // 'en-GB' has historically emitted hour '24' at midnight (the guard
  // dublin-time.js carries for the same reason). hourCycle:'h23' should
  // prevent it; the guard costs nothing and is kept rather than trusted away.
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

// Solve ms + offset(ms) = want. Pass 1 samples the offset at `want` itself,
// which is the wrong side of a transition for a band of wall-clock times on
// each DST day in any zone whose standard offset is not 0. Pass 2 re-samples at
// that candidate, which lands on the correct side.
//
// `gapPrefer` only ever applies when `want` does not exist (spring-forward gap).
function solveWallMs(want, tz, gapPrefer) {
  const ms1 = want - offsetMsAt(want, tz)
  const ms2 = want - offsetMsAt(ms1, tz)
  if (ms1 === ms2) return ms1                     // converged: exact
  if (naiveWallMs(ms2, tz) === want) return ms2   // pass 2 reads back exactly
  // Neither candidate reads back, so `want` is inside a gap. (A matching ms1 is
  // unreachable here: naive(ms1)===want forces offset(ms1)===offset(want),
  // hence ms2===ms1, which the convergence test above already returned.)
  return gapPrefer === 'later' ? Math.max(ms1, ms2) : Math.min(ms1, ms2)
}

// 'YYYY-MM-DD' → { y, mo, d }, or null for anything that is not a real
// calendar date. Date.UTC ROLLS a nonexistent date over (Feb 30 → Mar 2) and a
// 2-digit year into the 1900s, so the parse is re-derived and rejected rather
// than left to schedule against a date the operator never wrote.
function parseYmd(dateStr) {
  const m = String(dateStr ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const back = new Date(Date.UTC(y, mo - 1, d))
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) return null
  return { y, mo, d }
}

// 'YYYY-MM-DD' of the instant in `tz`. Intl parts, never toISOString().slice.
// Accepts Date | epoch-ms | ISO 8601 TIMESTAMP, matching dublinDayStr — house
// idiom is to hand these a row value directly (`dublinDayStr(row.created_at)`).
// Throws RangeError on anything unparseable: a silent '1970-01-01' for null is
// how a whole day of schedule lands on the wrong date unnoticed.
//
// A date-ONLY string ('2026-07-06') is not a timestamp: Date.parse reads it as
// UTC midnight, which in a negative-offset zone is still the PREVIOUS local
// day, so it returns '2026-07-05'. That is dublinDayStr's behaviour too, and it
// is why a calendar date must go through parseYmd/dayStartMsInTz, never here.
export function dayStrInTz(instant = Date.now(), tz = DEFAULT_TZ) {
  // Note the type tests rather than a bare Number(): Number(null), Number(''),
  // Number(false) and Number([]) are all 0, so a coercing guard still lets a
  // null row value through as epoch 0 and returns '1970-01-01'.
  let ms
  if (instant instanceof Date) ms = instant.getTime()
  else if (typeof instant === 'number') ms = instant
  else if (typeof instant === 'string' && instant.trim()) ms = Date.parse(instant)
  else ms = NaN
  if (!Number.isFinite(ms)) throw new RangeError('dayStrInTz: invalid instant')
  const { y, mo, d } = readParts(ms, tz)
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// UTC ms of wall-clock HH:MM on calendar date `dateStr` in `tz`.
// null for a malformed time, a malformed date, or a date that does not exist
// (2026-02-30). Callers treat null as "skip this window", so a bad operator
// value must never silently roll over into a real neighbouring date.
export function wallMsInTz(dateStr, hhmm, tz = DEFAULT_TZ) {
  const t = String(hhmm ?? '').match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  if (!t) return null
  const ymd = parseYmd(dateStr)
  if (!ymd) return null
  const want = Date.UTC(ymd.y, ymd.mo - 1, ymd.d, Number(t[1]), Number(t[2]))
  return solveWallMs(want, tz, 'earlier')
}

// UTC ms of 00:00 local on `dateStr`.
//
// The ONE place the gap convention is inverted. In zones whose DST starts at
// 00:00 local (America/Santiago, America/Havana, Asia/Beirut) local midnight
// does not exist on that date, and resolving EARLIER yields 23:00 on the day
// BEFORE — a day boundary that precedes its own day, which breaks
// nextLocalMidnightMs's "strictly after" and would expire an override a day
// early. Resolving later yields the transition instant itself, i.e. the first
// instant of the new local day, which is what a day boundary means.
export function dayStartMsInTz(dateStr, tz = DEFAULT_TZ) {
  const ymd = parseYmd(dateStr)
  if (!ymd) return null
  return solveWallMs(Date.UTC(ymd.y, ymd.mo - 1, ymd.d, 0, 0), tz, 'later')
}

// Next local midnight strictly after `instant` — the default expiry of a manual override.
export function nextLocalMidnightMs(instant = Date.now(), tz = DEFAULT_TZ) {
  return dayStartMsInTz(addDaysISO(dayStrInTz(instant, tz), 1), tz)
}
