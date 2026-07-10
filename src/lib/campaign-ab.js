// CAMPAIGN-AB (COMMS-AUDIT 2026-07-10) — subject-line A/B testing v1.
//
// Pure helpers for the classic split test: send variant A
// (campaigns.subject) and variant B (campaigns.ab_subject_b) to a
// small deterministic test slice, wait ab_wait_hours, auto-pick the
// winner by open rate, send the remainder with the winning subject.
//
// The phase machine is COLUMN-driven (mig 398) — no new
// campaigns.status values. Every overlapping cron tick derives the
// same phase from the campaign row, and each phase transition is a
// CAS write (…IS NULL guard) in campaign-sender.js so exactly one
// tick performs it:
//
//   ab_subject_b NULL                          → 'off'   (default path)
//   recipients populated, no ab_test_started_at→ 'slice' (send slice only)
//   started, winner NULL, inside wait window   → 'waiting' (no-op ticks)
//   started, winner NULL, wait elapsed         → 'decide'  (CAS ab_winner)
//   ab_winner set                              → 'final'  (send remainder)

export const AB_TEST_PCT_MIN = 5
export const AB_TEST_PCT_MAX = 50
export const AB_TEST_PCT_DEFAULT = 10
export const AB_WAIT_HOURS_MIN = 1
export const AB_WAIT_HOURS_MAX = 24
export const AB_WAIT_HOURS_DEFAULT = 4

// Smallest audience worth testing: 2 in the slice (one per variant)
// + at least 1 remainder recipient for the winner to matter.
export const AB_MIN_AUDIENCE = 3

function clampInt(value, min, max, fallback) {
  // null/undefined/'' mean "not set" → fallback (Number(null) is 0,
  // which would otherwise silently clamp to the minimum).
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Bound the operator-supplied test percentage to 5–50 (default 10). */
export function clampAbTestPct(pct) {
  return clampInt(pct, AB_TEST_PCT_MIN, AB_TEST_PCT_MAX, AB_TEST_PCT_DEFAULT)
}

/** Bound the operator-supplied wait to 1–24 hours (default 4). */
export function clampAbWaitHours(hours) {
  return clampInt(hours, AB_WAIT_HOURS_MIN, AB_WAIT_HOURS_MAX, AB_WAIT_HOURS_DEFAULT)
}

/**
 * Derive the campaign's A/B phase from its row. Pure — overlapping
 * cron ticks all agree, and the transitions themselves are CAS'd in
 * the sender.
 *
 * @param {object} campaign — campaigns row (ab_* columns, mig 398)
 * @param {number} [now] — epoch ms, injectable for tests
 * @returns {'off'|'slice'|'waiting'|'decide'|'final'}
 */
export function resolveAbPhase(campaign, now = Date.now()) {
  if (!campaign?.ab_subject_b) return 'off'
  if (campaign.ab_winner) return 'final'
  if (!campaign.ab_test_started_at) return 'slice'
  const startedMs = Date.parse(campaign.ab_test_started_at)
  const waitMs = clampAbWaitHours(campaign.ab_wait_hours) * 3600_000
  // An unparseable timestamp decides immediately rather than stalling
  // the remainder forever.
  if (!Number.isFinite(startedMs)) return 'decide'
  return now < startedMs + waitMs ? 'waiting' : 'decide'
}

// FNV-1a 32-bit — tiny, dependency-free, stable across runs. Used to
// order contacts for slice selection so the assignment is deterministic
// AND independent of audience load order / id monotonicity (a sorted-id
// prefix would bias the slice toward the oldest contacts).
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Deterministically assign the A/B test slice at populate time.
 *
 * Orders contacts by FNV-1a hash of their id (tie-broken by id),
 * takes the first pct% (min 2, and always leaving ≥1 remainder) as
 * the slice, and alternates a/b through it so the variants differ by
 * at most one. The result is recorded on campaign_recipients.ab_variant
 * so the assignment is stable across cron ticks — this helper's own
 * determinism additionally makes a re-populate (never expected) and
 * tests reproducible.
 *
 * @param {string[]} contactIds
 * @param {number} testPct — already-clamped percent (5–50)
 * @returns {Map<string, 'a'|'b'>} slice assignment; ids absent from
 *   the map are the remainder. Empty map = audience too small to test.
 */
export function assignAbVariants(contactIds, testPct) {
  const n = contactIds.length
  if (n < AB_MIN_AUDIENCE) return new Map()
  const pct = clampAbTestPct(testPct)
  // ≥2 so both variants get a recipient; ≤n-1 so a remainder exists.
  const sliceSize = Math.min(Math.max(2, Math.floor((n * pct) / 100)), n - 1)

  const ordered = [...contactIds].sort((x, y) => {
    const hx = fnv1a(String(x))
    const hy = fnv1a(String(y))
    if (hx !== hy) return hx - hy
    return String(x) < String(y) ? -1 : 1
  })

  const map = new Map()
  for (let i = 0; i < sliceSize; i++) {
    map.set(ordered[i], i % 2 === 0 ? 'a' : 'b')
  }
  return map
}

/**
 * Pick the winner by open rate. B must be STRICTLY better — ties,
 * zero-send and zero-open data all go to A (the operator's primary
 * subject is the safe default).
 *
 * @param {Array<{ab_variant: string, sent_count: number|string, opened_count: number|string}>} statRows
 *   — output of the campaign_ab_variant_stats RPC (mig 398)
 * @returns {'a'|'b'}
 */
export function decideAbWinner(statRows) {
  const rate = (variant) => {
    const row = (statRows || []).find(r => r.ab_variant === variant)
    const sent = Number(row?.sent_count) || 0
    const opened = Number(row?.opened_count) || 0
    return sent > 0 ? opened / sent : 0
  }
  return rate('b') > rate('a') ? 'b' : 'a'
}

/**
 * Resolve the raw (pre-merge-tag) subject for one recipient row.
 *
 * - variant 'a' → campaigns.subject
 * - variant 'b' → campaigns.ab_subject_b (blank falls back to subject —
 *   an email must never go out subjectless)
 * - remainder (null) → the winner's subject; before a decision (which
 *   the phase machine prevents reaching) it falls back to A.
 * - non-A/B campaigns always resolve to campaigns.subject, keeping the
 *   default path byte-identical to today.
 *
 * @param {object} campaign
 * @param {'a'|'b'|null|undefined} variant — campaign_recipients.ab_variant
 * @param {'a'|'b'|null} [winnerOverride] — the just-decided winner, for
 *   the tick that wins the decide CAS and sends in the same invocation
 *   (its local campaign row predates the stamp).
 * @returns {string}
 */
export function subjectForVariant(campaign, variant, winnerOverride = null) {
  const subjectB = campaign.ab_subject_b || campaign.subject
  if (variant === 'b') return subjectB
  if (variant === 'a') return campaign.subject
  const winner = winnerOverride || campaign.ab_winner
  return winner === 'b' ? subjectB : campaign.subject
}
