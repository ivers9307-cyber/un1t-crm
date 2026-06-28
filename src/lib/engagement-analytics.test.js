import { describe, it, expect } from 'vitest'
import { friendBucketKey, summarizeEngagementChurn } from './engagement-analytics'

const DAY = 86_400_000

// A live 'time' subscription member. attendedDaysAgo tunes the churn signal:
//   ~3 days  → healthy (not at-risk)
//   ~20 days → "gone quiet" → at-risk
function member(id, { attendedDaysAgo = 3, attended30 = 4, joinedDaysAgo = 200 } = {}, nowMs = Date.now()) {
  return {
    id,
    glofox_membership_status: 'member',
    glofox_membership_type: 'time',
    glofox_membership_state: 'active',
    glofox_membership_plan: 'Unlimited Monthly',
    last_attended_at: attendedDaysAgo == null ? null : new Date(nowMs - attendedDaysAgo * DAY).toISOString(),
    last_booked_at: new Date(nowMs - 1 * DAY).toISOString(),
    total_attended_30d: attended30,
    total_attended_7d: attendedDaysAgo != null && attendedDaysAgo <= 7 ? 2 : 0,
    total_noshow_30d: 0,
    joined_at: new Date(nowMs - joinedDaysAgo * DAY).toISOString(),
  }
}

const healthy = (id) => member(id, { attendedDaysAgo: 3, attended30: 4 })
const atRisk = (id) => member(id, { attendedDaysAgo: 20, attended30: 2 })

describe('friendBucketKey', () => {
  it('maps counts to tiers', () => {
    expect(friendBucketKey(0)).toBe('0')
    expect(friendBucketKey(1)).toBe('1-2')
    expect(friendBucketKey(2)).toBe('1-2')
    expect(friendBucketKey(3)).toBe('3-5')
    expect(friendBucketKey(5)).toBe('3-5')
    expect(friendBucketKey(6)).toBe('6+')
    expect(friendBucketKey(99)).toBe('6+')
    expect(friendBucketKey(undefined)).toBe('0')
  })
})

describe('summarizeEngagementChurn', () => {
  const nowMs = Date.now()

  it('excludes out-of-scope (non-member) contacts from the base', () => {
    const members = [
      healthy('m1'),
      { id: 'x1', glofox_membership_status: 'classpass_payg' }, // PAYG → out
      { id: 'x2', glofox_membership_status: 'ex_member' },      // lapsed → out
    ]
    const res = summarizeEngagementChurn({ members, friendCountById: new Map(), nowMs })
    expect(res.totalMembers).toBe(1)
  })

  it('buckets members by friend count and computes adoption', () => {
    const members = [healthy('a'), healthy('b'), healthy('c')]
    const friends = new Map([['a', 0], ['b', 2], ['c', 4]])
    const res = summarizeEngagementChurn({ members, friendCountById: friends, nowMs })
    expect(res.totalMembers).toBe(3)
    expect(res.withFriends).toBe(2)
    expect(res.adoptionPct).toBeCloseTo(2 / 3)
    const byKey = Object.fromEntries(res.buckets.map((b) => [b.key, b.members]))
    expect(byKey['0']).toBe(1)
    expect(byKey['1-2']).toBe(1)
    expect(byKey['3-5']).toBe(1)
    expect(byKey['6+']).toBe(0)
  })

  it('supports the thesis when high-friend members are less at-risk', () => {
    const members = []
    const friends = new Map()
    // 10 with 0 friends, half at-risk.
    for (let i = 0; i < 5; i++) { members.push(atRisk(`low-r${i}`)); friends.set(`low-r${i}`, 0) }
    for (let i = 0; i < 5; i++) { members.push(healthy(`low-h${i}`)); friends.set(`low-h${i}`, 0) }
    // 6 with 4 friends, none at-risk.
    for (let i = 0; i < 6; i++) { members.push(healthy(`hi${i}`)); friends.set(`hi${i}`, 4) }

    const res = summarizeEngagementChurn({ members, friendCountById: friends, nowMs })
    expect(res.headline.insufficientData).toBe(false)
    expect(res.headline.highSample).toBe(6)
    expect(res.headline.lowAtRiskPct).toBeCloseTo(0.5)
    expect(res.headline.highAtRiskPct).toBeCloseTo(0)
    expect(res.headline.atRiskDelta).toBeCloseTo(0.5)
    expect(res.headline.supported).toBe(true)
  })

  it('flags insufficient data when too few high-friend members', () => {
    const members = [healthy('a'), healthy('b'), member('c', { attendedDaysAgo: 4 })]
    const friends = new Map([['a', 0], ['b', 0], ['c', 6]]) // only 1 in the 6+ tier
    const res = summarizeEngagementChurn({ members, friendCountById: friends, nowMs })
    expect(res.headline.insufficientData).toBe(true)
    expect(res.headline.supported).toBe(false)
  })
})
