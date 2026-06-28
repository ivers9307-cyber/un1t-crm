// P2-7 (Part B) — server-side data access for the engagement→churn analytics.
//
// Loads the live member base + the authoritative arrears context (reusing the
// churn radar's own fetchers so the active base + at-risk verdict match the
// Churn tab), plus each member's accepted-friend count, then hands them to the
// pure summarizer. DB-touching — kept out of engagement-analytics.js so that
// module stays pure + unit-tested.

import { fetchMembers, fetchPastDue } from '@/lib/churn-radar-data'
import { summarizeEngagementChurn } from '@/lib/engagement-analytics'

const PAGE = 1000
const HARD_LIMIT = 50_000

/**
 * Accepted-friend count per member, keyed by contact_id. Each accepted
 * member_friendships row contributes +1 to BOTH endpoints. Same-studio
 * (social v1) so we scope by location. Paginated — the 1000-row cap applies.
 * Only counts toward members in `memberIds` (the rest we never look up).
 *
 * @param {object} db          service-role client
 * @param {string} locationId
 * @param {Set<string>} memberIds
 * @returns {Promise<Map<string, number>>}
 */
async function fetchFriendCounts(db, locationId, memberIds) {
  const counts = new Map()
  for (let from = 0; from < HARD_LIMIT; from += PAGE) {
    const { data, error } = await db
      .from('member_friendships')
      .select('id, requester_contact_id, addressee_contact_id')
      .eq('location_id', locationId)
      .eq('status', 'accepted')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) break
    for (const r of data || []) {
      for (const cid of [r.requester_contact_id, r.addressee_contact_id]) {
        if (cid && (!memberIds || memberIds.has(cid))) counts.set(cid, (counts.get(cid) || 0) + 1)
      }
    }
    if (!data || data.length < PAGE) break
  }
  return counts
}

/**
 * Load the engagement→churn cross-tab for a location.
 *
 * @param {object} db         service-role client
 * @param {string} locationId
 * @param {number} [nowMs]
 * @returns {Promise<object|null>}  summarizeEngagementChurn output, or null
 */
export async function loadEngagementChurn(db, locationId, nowMs = Date.now()) {
  if (!db || !locationId) return null
  const [members, pastDue] = await Promise.all([
    fetchMembers(db, locationId),
    fetchPastDue(db, locationId),
  ])
  const memberIds = new Set(members.map((m) => m.id))
  const friendCountById = await fetchFriendCounts(db, locationId, memberIds)
  return summarizeEngagementChurn({
    members,
    friendCountById,
    ctx: { pastDueIds: pastDue.ids, pastDueById: pastDue.byId },
    nowMs,
  })
}
