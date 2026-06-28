// P2-7 (Part B) — engagement → churn analytics (pure).
//
// Cross-tabulates the live member base by friend-count tier against the churn
// radar's at-risk signal + attendance, to surface whether community keeps
// members ("members with more friends churn less"). I/O-free so the bucketing
// + headline maths are fixture-testable; the data layer
// (engagement-analytics-data.js) loads the rows and the friend counts.
//
// Churn signal: the authoritative churn radar verdict — classifyContact() for
// the live base, scoreMember() for the at-risk flag. We reuse those rather than
// re-deriving a parallel definition of "at risk".

import { classifyContact, scoreMember } from '@/lib/churn-radar'

// Friend-count tiers. A member with no app friends is the baseline; the upper
// tiers are where the retention thesis should show up.
export const FRIEND_BUCKETS = Object.freeze([
  { key: '0', label: 'No friends', min: 0, max: 0 },
  { key: '1-2', label: '1–2 friends', min: 1, max: 2 },
  { key: '3-5', label: '3–5 friends', min: 3, max: 5 },
  { key: '6+', label: '6+ friends', min: 6, max: Infinity },
])

// Below this many members in the 3+ tier the comparison isn't meaningful —
// we say so rather than quoting a percentage off a handful of people.
const MIN_HIGH_SAMPLE = 5

/**
 * Which friend-count tier a count falls in.
 * @param {number} n  accepted-friend count
 * @returns {string}  the bucket key
 */
export function friendBucketKey(n) {
  const c = Number.isFinite(n) ? n : 0
  for (const b of FRIEND_BUCKETS) if (c >= b.min && c <= b.max) return b.key
  return '0'
}

/**
 * Build the engagement→churn cross-tab + headline for a location.
 *
 * @param {object} opts
 * @param {object[]} opts.members            contact rows (MEMBER_COLUMNS shape)
 * @param {Map<string,number>} opts.friendCountById  contact_id → accepted friends
 * @param {{ pastDueIds?: Set, pastDueById?: Map }} [opts.ctx]  churn classify context
 * @param {number} [opts.nowMs]
 * @returns {{
 *   totalMembers: number, withFriends: number, adoptionPct: number|null,
 *   buckets: Array<{ key, label, members, atRisk, atRiskPct, avgAttended30d, avgTenureDays }>,
 *   headline: object,
 * }}
 */
export function summarizeEngagementChurn({
  members = [], friendCountById = new Map(), ctx = {}, nowMs = Date.now(),
} = {}) {
  const agg = new Map(FRIEND_BUCKETS.map((b) => [b.key, {
    members: 0, atRisk: 0, attendSum: 0, tenureSum: 0, tenureN: 0,
  }]))
  let totalMembers = 0
  let withFriends = 0

  for (const m of members) {
    // Only the live active base — out-of-scope contacts (spent packs, PAYG,
    // lapsed subs) aren't members and would skew the denominator.
    if (classifyContact(m, ctx) === 'out') continue
    totalMembers++
    const fc = friendCountById.get(m.id) || 0
    if (fc > 0) withFriends++
    const a = agg.get(friendBucketKey(fc))
    a.members++
    if (scoreMember(m, nowMs, ctx)) a.atRisk++
    const att = Number(m.total_attended_30d)
    a.attendSum += Number.isFinite(att) ? att : 0
    const joined = m.joined_at ? new Date(m.joined_at).getTime() : null
    if (joined && Number.isFinite(joined)) {
      a.tenureSum += (nowMs - joined) / 86_400_000
      a.tenureN++
    }
  }

  const buckets = FRIEND_BUCKETS.map((b) => {
    const a = agg.get(b.key)
    return {
      key: b.key,
      label: b.label,
      members: a.members,
      atRisk: a.atRisk,
      atRiskPct: a.members ? a.atRisk / a.members : null,
      avgAttended30d: a.members ? a.attendSum / a.members : null,
      avgTenureDays: a.tenureN ? Math.round(a.tenureSum / a.tenureN) : null,
    }
  })

  // Headline: 0-friends ("low") vs 3+-friends ("high").
  const zero = buckets.find((x) => x.key === '0')
  const high = buckets.filter((x) => x.key === '3-5' || x.key === '6+')
  const highMembers = high.reduce((s, x) => s + x.members, 0)
  const highAtRisk = high.reduce((s, x) => s + x.atRisk, 0)
  const highAttendSum = high.reduce((s, x) => s + (x.avgAttended30d ?? 0) * x.members, 0)

  const lowAtRiskPct = zero && zero.members ? zero.atRiskPct : null
  const highAtRiskPct = highMembers ? highAtRisk / highMembers : null
  const lowAvgAttended = zero ? zero.avgAttended30d : null
  const highAvgAttended = highMembers ? highAttendSum / highMembers : null
  const insufficientData = highMembers < MIN_HIGH_SAMPLE

  const headline = {
    highSample: highMembers,
    insufficientData,
    lowAtRiskPct,
    highAtRiskPct,
    lowAvgAttended,
    highAvgAttended,
    atRiskDelta: (lowAtRiskPct != null && highAtRiskPct != null) ? lowAtRiskPct - highAtRiskPct : null,
    // The thesis holds when the high-friend tier is genuinely less at-risk.
    supported: !insufficientData && lowAtRiskPct != null && highAtRiskPct != null
      && highAtRiskPct < lowAtRiskPct,
  }

  return {
    totalMembers,
    withFriends,
    adoptionPct: totalMembers ? withFriends / totalMembers : null,
    buckets,
    headline,
  }
}
