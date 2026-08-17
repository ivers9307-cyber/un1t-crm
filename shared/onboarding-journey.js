// Display shaping for the first-90-days journey card (Pulse hub
// sub-project 1 — spec: un1t-crm docs/superpowers/specs/
// 2026-06-28-pulse-hub-first-90-days-design.md).
//
// un1t-crm computes; champ-app renders. The CRM's pure pace lib
// (un1t-crm src/lib/onboarding-journey.js) does all the pace math and
// GET /api/me/journey (via mobile/lib/crm-api.js) returns either
// `journey: null` (out-of-window / not a new member) or a status row:
//
//   { inWindow, dayIndex, weekIndex, attended, target, windowDays,
//     expectedByNow, status, lastAttendedAt, daysSinceLastAttended,
//     completedDaysAgo? }
//
// A2 CONTRACT NOTE — `completedDaysAgo` (Dublin days since the
// target-th attendance) is NOT produced by the pure journeyStatus lib
// (it only retains the LAST attendance); the /api/me/journey route must
// compute it for the spec's "completed > 3 days → hide" rule to be
// exact. Until it arrives we approximate with `daysSinceLastAttended`,
// which journeyStatus does return — see the hide rule below for why
// that proxy is safe (it can only hide late, never early).
//
// This module turns that row into exactly what JourneyCard.jsx draws —
// or `null`, meaning "render nothing". The card is fail-invisible: any
// missing/malformed payload shapes to null or safe defaults, never NaN.
//
// HARD PRODUCT CONSTRAINTS (Richard):
//   - pulse-scope-no-booking: the card is purely motivational. No copy
//     variant may contain booking language — no "book", "booking", or a
//     booking deep-link, ever. Enforced by test (/book/i must match
//     nothing in any variant).
//   - Customer copy never abbreviates zones ("Zone 4", not "Z4").
//
// Pure + framework-free: no React Native imports, importable by both
// mobile/ and src/. Co-located tests in onboarding-journey.test.js.

const DEFAULT_TARGET = 9
const DEFAULT_WINDOW_DAYS = 42
// Celebration lingers this many days after the member hits the target,
// then the card auto-hides ("completed > 3d" rule from the spec).
const CELEBRATION_DAYS = 3

/** Statuses the card renders (everything else hides or falls back). */
export const JOURNEY_CARD_STATUSES = Object.freeze([
  'on_track',
  'behind',
  'at_risk',
  'completed',
])

function toCount(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

// Finite number or null — never coerce null/undefined to 0 (Number(null)
// is 0, which would read "completed today" out of a missing field).
function toFiniteDays(value) {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

// Status-variant motivational copy. Warm, booking-free, habit-focused.
function journeyMessage({ status, attended, target, totalWeeks }) {
  if (status === 'completed') {
    return `You did it — ${target} classes inside your first ${totalWeeks} weeks. That's how habits are built. Keep going.`
  }
  if (status === 'at_risk') {
    return 'We miss you at the studio. One class is all it takes to get moving again — your crew will be there.'
  }
  if (status === 'behind') {
    return "A strong week puts you right back on pace. You've got this."
  }
  // on_track (and any unknown status falls back to encouragement).
  if (attended === 0) {
    return `Your first ${totalWeeks} weeks start now. Every class counts — let's build the habit.`
  }
  return "Right on pace. Keep showing up — it's working."
}

/**
 * Shape a /api/me/journey row into JourneyCard display props.
 *
 * @param {object|null} journey  the `journey` field of the API response
 * @returns {null | {
 *   ringPct: number,                 // 0–100, attended/target
 *   ticks: { filled: boolean }[],    // one per target class (default 9)
 *   weekLabel: string,               // 'Week 2 of 6'
 *   week: number,                    // current week, 1-based, clamped
 *   totalWeeks: number,              // weeks in the window (default 6)
 *   countLabel: string,              // '4 of 9 classes'
 *   message: string,                 // status-variant motivational copy
 *   status: string,                  // normalised status driving the variant
 * }}  null means: render nothing.
 *
 * `week`/`totalWeeks` are the numeric twins of `weekLabel` — the card's
 * week tick bar needs numbers, not a parsed string.
 */
export function shapeJourneyCard(journey) {
  if (!journey || typeof journey !== 'object') return null
  const status = typeof journey.status === 'string' ? journey.status : 'on_track'
  if (status === 'expired') return null
  if (status === 'completed') {
    // Handled BEFORE the inWindow guard below: the server deliberately keeps
    // serving a completed journey with inWindow:false through the celebration
    // tail (loadContactJourney), so bailing on inWindow first would cut the
    // celebration short for anyone who finishes in the last few days of their
    // window. Spec: "auto-hides after completion (short celebration state
    // first)". Recency = `completedDaysAgo` (the API computes it — days since
    // the target-crossing class); fallback `daysSinceLastAttended`, which is
    // never later than the completion class, so the proxy can only hide LATE,
    // never early.
    const daysAgo =
      toFiniteDays(journey.completedDaysAgo) ??
      toFiniteDays(journey.daysSinceLastAttended)
    // Recency unknown on both → keep celebrating; the server flips to
    // journey:null at the end of the tail anyway.
    if (daysAgo != null && daysAgo > CELEBRATION_DAYS) return null
  } else if (journey.inWindow === false) {
    // Non-completed + out of window → nothing to show.
    return null
  }

  const target = toCount(journey.target) || DEFAULT_TARGET
  const attended = toCount(journey.attended)
  const windowDays = toCount(journey.windowDays) || DEFAULT_WINDOW_DAYS
  const totalWeeks = Math.max(1, Math.ceil(windowDays / 7))
  const dayIndex = toCount(journey.dayIndex)
  const rawWeek = toCount(journey.weekIndex, 0) || Math.floor(dayIndex / 7) + 1
  const week = clamp(rawWeek, 1, totalWeeks)

  const filled = clamp(attended, 0, target)
  return {
    ringPct: Math.round((filled / target) * 100),
    ticks: Array.from({ length: target }, (_, i) => ({ filled: i < filled })),
    weekLabel: `Week ${week} of ${totalWeeks}`,
    week,
    totalWeeks,
    countLabel: `${attended} of ${target} classes`,
    message: journeyMessage({ status, attended, target, totalWeeks }),
    status: JOURNEY_CARD_STATUSES.includes(status) ? status : 'on_track',
  }
}
