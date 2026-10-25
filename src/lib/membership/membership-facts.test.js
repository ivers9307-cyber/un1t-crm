// ORGCONTACTS.7 (mig 770) — the one mapper between the membership facts on
// contact_studios and the row shape the pure un1t shapes have always taken
// ({ contact_id, source, status, ended_at, plan_name }).
import { describe, it, expect } from 'vitest'
import { MEMBERSHIP_FACT_READ_COLS, membershipRowsFromStudioRows } from './membership-facts.js'
import { shapePipelineSnapshot } from './reads/un1t-online-shape.js'

describe('membershipRowsFromStudioRows', () => {
  it('maps the four fact columns onto the shape row, source un1t_online_api, drops rows with no membership, keeps order', () => {
    const rows = [
      { contact_id: 'c1', membership_plan: 'Unlimited', membership_status: 'active', membership_since: '2026-02-01T00:00:00Z', membership_ended_at: null },
      { contact_id: 'c2', membership_plan: null, membership_status: null, membership_since: null, membership_ended_at: null },
      { contact_id: 'c3', membership_plan: 'Monthly', membership_status: 'ended', membership_since: '2026-03-01T00:00:00Z', membership_ended_at: '2026-09-01T00:00:00Z' },
    ]
    expect(membershipRowsFromStudioRows(rows)).toEqual([
      { contact_id: 'c1', source: 'un1t_online_api', status: 'active', ended_at: null, plan_name: 'Unlimited', first_seen_at: '2026-02-01T00:00:00Z' },
      { contact_id: 'c3', source: 'un1t_online_api', status: 'ended', ended_at: '2026-09-01T00:00:00Z', plan_name: 'Monthly', first_seen_at: '2026-03-01T00:00:00Z' },
    ])
    expect(membershipRowsFromStudioRows(null)).toEqual([])
    expect(MEMBERSHIP_FACT_READ_COLS).toBe('contact_id, membership_plan, membership_status, membership_since, membership_ended_at')
  })

  // Review Focus 5: an ended membership followed by a paid pack is a lead, not an ex-member; the mapper's source keeps the row in the shape's own-source set.
  it('feeds shapePipelineSnapshot: an ended membership and no activity since is ex_member; a paid pack bought after the end makes it lead', () => {
    const memberships = membershipRowsFromStudioRows([{ contact_id: 'c1', membership_plan: 'Monthly', membership_status: 'ended', membership_since: '2026-01-01T00:00:00Z', membership_ended_at: '2026-06-01T00:00:00Z' }])
    const client = { un1t_user_id: 'u1', contact_id: 'c1', credit_balance: 0, credit_unlimited: false, last_attended_at: '2026-05-01T00:00:00Z', remote_created_at: '2025-12-01T00:00:00Z' }
    const base = { client, contact: { id: 'c1', location_id: 'loc-1' }, locationId: 'loc-1', freshSubs: [], bookings: [], memberships }
    expect(shapePipelineSnapshot({ ...base, transactions: [], productsById: new Map() }).glofox_membership_status).toBe('ex_member')
    const productsById = new Map([['p-pack', { un1t_id: 'p-pack', type: 'pack', price_cents: 9900, credits_per_period: 10, title: '10 class pack' }]])
    const pack = { un1t_id: 't1', un1t_user_id: 'u1', contact_id: 'c1', product_id: 'p-pack', product_type: 'pack', type: 'purchase', amount_cents: 9900, refunded: false, remote_created_at: '2026-07-01T00:00:00Z' }
    expect(shapePipelineSnapshot({ ...base, transactions: [pack], productsById }).glofox_membership_status).toBe('lead')
  })
})
