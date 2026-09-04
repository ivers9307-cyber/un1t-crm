// Pure race-control timing helpers (mig 081 / 124). Shared by the web
// race control panel (src/lib/race-control.js re-exports these) and the
// mobile race-day control screen (mobile/app/races). Kept dependency-free
// (no logging, no db) so both platforms import the same source of truth —
// the IO helper ensureTeamForBooking stays web-only in src/lib.

/**
 * Format an elapsed-time number of seconds as HH:MM:SS.
 *
 *    0    -> "00:00"   59 -> "00:59"   60 -> "01:00"
 *    3599 -> "59:59"   3600 -> "1:00:00"   null -> "—"
 *
 * No hour component for sub-60-min times — keeps the race UI scannable.
 *
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
export function formatElapsed(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  if (hh === 0) return `${pad(mm)}:${pad(ss)}`
  return `${hh}:${pad(mm)}:${pad(ss)}`
}

/**
 * Classify a registration/booking's race state into one of four buckets.
 *
 *   'next_up'   — confirmed, no race_started_at yet
 *   'on_course' — race_started_at set, race_finished_at not yet
 *   'completed' — both timestamps set
 *   'no_show'   — status is 'no_show' OR 'cancelled'
 *
 * @param {object} booking
 * @returns {'next_up' | 'on_course' | 'completed' | 'no_show'}
 */
export function classifyBookingState(booking) {
  if (!booking) return 'next_up'
  if (booking.status === 'no_show' || booking.status === 'cancelled') return 'no_show'
  if (booking.race_finished_at) return 'completed'
  if (booking.race_started_at) return 'on_course'
  return 'next_up'
}

/**
 * Elapsed seconds between two ISO timestamps. null if either is missing.
 * Negative clamps to 0 (defensive against clock skew / reset-then-start).
 *
 * @param {string|null|undefined} startIso
 * @param {string|null|undefined} endIso
 * @returns {number|null}
 */
export function elapsedSecondsBetween(startIso, endIso) {
  if (!startIso || !endIso) return null
  const ms = Date.parse(endIso) - Date.parse(startIso)
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor(ms / 1000))
}

/**
 * Sum a registration's penalties[] (mig 124). Returns 0 (not null) for
 * missing/empty so callers can additively combine. Coerces non-numeric
 * entries to 0 — defensive against malformed payloads.
 *
 * @param {Array<{seconds:number}>|null|undefined} penalties
 * @returns {number}
 */
export function penaltySumSeconds(penalties) {
  if (!Array.isArray(penalties) || penalties.length === 0) return 0
  let total = 0
  for (const p of penalties) {
    const n = Number(p?.seconds)
    if (Number.isFinite(n)) total += n
  }
  return total
}

/**
 * Adjusted elapsed time: base elapsed + sum(penalties.seconds). null if the
 * base is unknowable (no start). For live "on course" rows pass nowIso as
 * endIso so penalties show before the team finishes. Negative clamps to 0.
 *
 * @param {string|null|undefined} startIso
 * @param {string|null|undefined} endIso
 * @param {Array<{seconds:number}>|null|undefined} penalties
 * @returns {number|null}
 */
export function elapsedWithPenalties(startIso, endIso, penalties) {
  const base = elapsedSecondsBetween(startIso, endIso)
  if (base == null) return null
  return Math.max(0, base + penaltySumSeconds(penalties))
}

// ─── RACEDAY.1 — wave labelling, participant lists, portrait layout ─────────
//
// The race-day control surfaces (web RaceControlPanel, the mobile race-day
// screen, the portrait display board) each grew their own copy of "what is
// this wave called", "which names print under a team" and "how big is each
// panel". They disagreed, and one of the disagreements was a live bug — see
// waveSortKey. These live here so both platforms read one answer.

/**
 * Human label for a wave: the operator's label if they set one, else the
 * wave's start time as HH:MM, else null when there is nothing to show.
 *
 *   { label: 'Wave A', start_time: '10:30:00' } -> 'Wave A'
 *   { label: null,     start_time: '10:30:00' } -> '10:30'
 *   null / undefined / a wave with neither     -> null
 *
 * Label OR time, never both — the caller composes 'Label · HH:MM' itself if
 * it wants the pair (the badge in RaceControlPanel does; the portrait board
 * has no room for it).
 *
 * A whitespace-only label counts as unset: an operator who clears the field
 * in a text input leaves ' ' behind often enough that treating it as a label
 * would render a blank badge on the board.
 *
 * @param {{ label?: string|null, start_time?: string|null }|null|undefined} wave
 * @returns {string|null}
 */
export function waveDisplayLabel(wave) {
  if (!wave) return null
  const label = typeof wave.label === 'string' ? wave.label.trim() : ''
  if (label) return label
  // race_waves.start_time (mig 083) is a Postgres TIME, so it arrives as
  // 'HH:MM:SS'. The event form's <input type="time"> posts 'HH:MM'. Both
  // slice to the HH:MM the board shows.
  const time = wave.start_time == null ? '' : String(wave.start_time).trim()
  if (!time) return null
  return time.slice(0, 5)
}

// Sort key for a registration whose wave is missing or has no usable start
// time. U+FFFF is above every character a Postgres TIME can contain, so such
// rows land at the END of an ascending sort. It is a non-character permanently
// reserved by Unicode, so no real label or time can collide with it.
const MISSING_WAVE_SORT_KEY = '\uffff'

/**
 * Sort key for ordering registrations by their wave's start time.
 *
 * Sorts a wave-less registration LAST. That is the point of this helper: the
 * call sites all wrote `(wave?.start_time || '')`, and the empty string sorts
 * BEFORE every real time, so a registration whose wave_id was null (or whose
 * wave row failed to join) jumped to the top of Next Up and read as the team
 * starting next. On a race morning that is the row an operator starts.
 *
 * Ordering among real waves is total: mig 083 puts a unique constraint on
 * (race_event_id, start_time), so no two waves of one race share a key.
 *
 * @param {{ start_time?: string|null }|null|undefined} wave
 * @returns {string}
 */
export function waveSortKey(wave) {
  const time = wave?.start_time == null ? '' : String(wave.start_time).trim()
  if (!time) return MISSING_WAVE_SORT_KEY
  // Compare at one width. Postgres returns 'HH:MM:SS' and the event form
  // posts 'HH:MM', and a board fed from both would otherwise order two waves
  // by string length at the same minute. Hours are zero-padded by both
  // sources, so no further normalisation is reachable.
  return time.length === 5 ? `${time}:00` : time
}

/**
 * Display names for a team's participants, in the order the members were
 * given.
 *
 * Trims, drops blanks, and de-duplicates case-insensitively keeping the FIRST
 * spelling — operator-entered rosters routinely carry the same person twice
 * with different capitalisation ('Ann' then 'ann'), and printing both makes a
 * 2-person team look like a 3-person one on the board.
 *
 * Accepts `team_members` rows (reads `.name`) or plain strings, so a caller
 * that already flattened its roster doesn't have to re-wrap it.
 *
 * @param {Array<{name?: string|null}|string>|null|undefined} members
 * @returns {string[]}
 */
export function participantNames(members) {
  if (!Array.isArray(members)) return []
  const names = []
  const seen = new Set()
  for (const member of members) {
    const raw = typeof member === 'string' ? member : member?.name
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

/**
 * Whether a team's participant list is worth rendering under its team name.
 *
 * false when there is nothing to show, and false for the solo entry whose one
 * participant IS the team — a solo team is usually named after the person
 * ("John O'Kane") while their member row holds just the first name ("John"),
 * so printing both stutters the same person twice down the card.
 *
 * The prefix test runs one way only: the single name must be a prefix of the
 * team name. The reverse (team 'John', member "John O'Kane") stays visible
 * because the longer member name carries information the team name does not.
 *
 * Two or more names always show — that is a real roster, however the team is
 * named.
 *
 * @param {string|null|undefined} teamName
 * @param {string[]|null|undefined} names  Typically participantNames(members)
 * @returns {boolean}
 */
export function shouldShowParticipants(teamName, names) {
  const list = Array.isArray(names) ? names : []
  if (list.length === 0) return false
  if (list.length > 1) return true
  const only = typeof list[0] === 'string' ? list[0].trim().toLowerCase() : ''
  if (!only) return false
  const team = typeof teamName === 'string' ? teamName.trim().toLowerCase() : ''
  // No team name to stutter against — show the person.
  if (!team) return true
  return !team.startsWith(only)
}

// The portrait board never lets one panel squeeze the other to a sliver: a
// 12-vs-3 split reads fine at 3:1 but not at 4:1, where the completed panel
// stops fitting a row. Both ends of the band sit the same distance from 0.5,
// which is what lets the partner take the remainder and stay in band too.
const PORTRAIT_MIN_FLEX = 0.25
const PORTRAIT_MAX_FLEX = 0.75

/**
 * Flex weights for the two stacked panels of the portrait race board.
 *
 * An EMPTY panel gets 0 and its partner takes the whole height (1) — an empty
 * state gets no space it can't use. With both populated the split is
 * proportional to the row counts, clamped into [0.25, 0.75] so neither panel
 * collapses, and the two always sum to exactly 1.
 *
 *   (7, 0)  -> { active: 1,    completed: 0 }
 *   (0, 3)  -> { active: 0,    completed: 1 }
 *   (12, 3) -> { active: 0.75, completed: 0.25 }   // 0.8 clamped
 *   (0, 0)  -> { active: 0,    completed: 0 }      // caller renders both empty states
 *
 * Non-numeric or negative counts read as 0 — a board fed a bad count should
 * fall back to an empty panel, never to a NaN flex that collapses the layout.
 *
 * @param {number} activeCount     Rows in the active (next-up + on-course) panel
 * @param {number} completedCount  Rows in the completed panel
 * @returns {{ active: number, completed: number }}
 */
export function portraitPanelFlex(activeCount, completedCount) {
  const active = normalisePanelCount(activeCount)
  const completed = normalisePanelCount(completedCount)
  if (active === 0 && completed === 0) return { active: 0, completed: 0 }
  if (active === 0) return { active: 0, completed: 1 }
  if (completed === 0) return { active: 1, completed: 0 }
  const share = active / (active + completed)
  const activeFlex = Math.min(PORTRAIT_MAX_FLEX, Math.max(PORTRAIT_MIN_FLEX, share))
  // The partner takes the remainder rather than clamping independently: two
  // separate clamps can sum to something other than 1, and a flex pair that
  // doesn't sum to 1 leaves a gap on the board.
  return { active: activeFlex, completed: 1 - activeFlex }
}

function normalisePanelCount(count) {
  const n = Number(count)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n
}
