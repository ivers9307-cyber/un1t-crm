// TRIALSTUDIO.3 — the eligibility reads behind the public /trial routes.
// Stillorgan refuses a buyer with any trial history before money is taken;
// Hatch Street refuses only a buyer with an active membership. A read that
// fails is { ok: false }, never a verdict.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { logWarn } from '@/lib/log'
import { stillorganTrialHistory, hatchActiveMembership, reasonsText } from './trial-eligibility'

const LOC = 'loc-stillorgan'
const CONTACT = { id: 'c1', glofox_member_id: 'g1', glofox_membership_status: 'lead', glofox_membership_plan: null }

// A db whose from(table) returns a chainable builder answering per table.
// rows[table] is the array the read resolves to; failing[table] makes it
// resolve with an error. Every chained call is recorded per table.
function makeDb({ rows = {}, failing = [] } = {}) {
  const calls = []
  const db = {
    from: (table) => {
      const log = { table, ops: [] }
      calls.push(log)
      const result = failing.includes(table)
        ? { data: null, error: { message: 'boom' } }
        : { data: rows[table] ?? [], error: null }
      const chain = {
        select: (...a) => { log.ops.push(['select', ...a]); return chain },
        eq: (...a) => { log.ops.push(['eq', ...a]); return chain },
        is: (...a) => { log.ops.push(['is', ...a]); return chain },
        in: (...a) => { log.ops.push(['in', ...a]); return chain },
        limit: (...a) => { log.ops.push(['limit', ...a]); return chain },
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      }
      return chain
    },
  }
  return { db, calls }
}

describe('stillorganTrialHistory', () => {
  it('a contact with no signals and empty reads is eligible', async () => {
    const { db } = makeDb()
    expect(await stillorganTrialHistory(db, { locationId: LOC, contact: CONTACT })).toEqual({ ok: true, hadTrial: false, reasons: [] })
  })

  it.each([['trial'], ['no_sale_trial']])('membership status %s is a trial', async (status) => {
    const { db } = makeDb()
    const r = await stillorganTrialHistory(db, { locationId: LOC, contact: { ...CONTACT, glofox_membership_status: status } })
    expect(r).toEqual({ ok: true, hadTrial: true, reasons: [`membership_status=${status}`] })
  })

  it('a plan named "The UN1T Trial" counts; "Monthly Unlimited" does not', async () => {
    const { db } = makeDb()
    const yes = await stillorganTrialHistory(db, { locationId: LOC, contact: { ...CONTACT, glofox_membership_plan: 'The UN1T Trial' } })
    expect(yes).toEqual({ ok: true, hadTrial: true, reasons: ['membership_plan_trial'] })
    const no = await stillorganTrialHistory(db, { locationId: LOC, contact: { ...CONTACT, glofox_membership_plan: 'Monthly Unlimited' } })
    expect(no).toEqual({ ok: true, hadTrial: false, reasons: [] })
  })

  it('a live glofox_trial_claims row counts', async () => {
    const { db, calls } = makeDb({ rows: { glofox_trial_claims: [{ id: 'cl1' }] } })
    const r = await stillorganTrialHistory(db, { locationId: LOC, contact: CONTACT })
    expect(r).toEqual({ ok: true, hadTrial: true, reasons: ['glofox_trial_claim'] })
    const ops = calls.find((c) => c.table === 'glofox_trial_claims').ops
    expect(ops).toContainEqual(['eq', 'glofox_member_id', 'g1'])
    expect(ops).toContainEqual(['is', 'released_at', null])
  })

  it('a released claim does not count', async () => {
    // The read filters released_at is null, so a released claim never comes
    // back; the filter is what is pinned here.
    const { db, calls } = makeDb({ rows: { glofox_trial_claims: [] } })
    const r = await stillorganTrialHistory(db, { locationId: LOC, contact: CONTACT })
    expect(r.hadTrial).toBe(false)
    expect(calls.find((c) => c.table === 'glofox_trial_claims').ops).toContainEqual(['is', 'released_at', null])
  })

  it('a glofox_push_events created row counts; needs_review does not', async () => {
    const { db, calls } = makeDb({ rows: { glofox_push_events: [{ id: 'e1' }] } })
    const r = await stillorganTrialHistory(db, { locationId: LOC, contact: CONTACT })
    expect(r).toEqual({ ok: true, hadTrial: true, reasons: ['glofox_push_created'] })
    const ops = calls.find((c) => c.table === 'glofox_push_events').ops
    expect(ops).toContainEqual(['eq', 'contact_id', 'c1'])
    expect(ops).toContainEqual(['eq', 'status', 'created'])
    // needs_review is never asked for: the read is pinned to status 'created'.
    expect(ops.some((o) => o.includes('needs_review'))).toBe(false)
  })

  it('a granted paid trial counts', async () => {
    const { db, calls } = makeDb({ rows: { trial_purchases: [{ id: 'tp1' }] } })
    const r = await stillorganTrialHistory(db, { locationId: LOC, contact: CONTACT })
    // (This fake answers both trial_purchases reads with the row.)
    expect(r).toMatchObject({ ok: true, hadTrial: true })
    expect(r.reasons).toContain('paid_trial_granted')
    const ops = calls.find((c) => c.table === 'trial_purchases').ops
    expect(ops).toContainEqual(['eq', 'contact_id', 'c1'])
    expect(ops).toContainEqual(['eq', 'status', 'granted'])
  })

  // Final-review F4 — a first paid trial still on its way: never charge twice.
  it('a paid trial still queued, processing or in review counts (paid_trial_pending), scoped and limited', async () => {
    const calls = []
    const db = {
      from: (table) => {
        const log = { table, ops: [] }
        calls.push(log)
        const chain = {
          select: (...a) => { log.ops.push(['select', ...a]); return chain },
          eq: (...a) => { log.ops.push(['eq', ...a]); return chain },
          is: (...a) => { log.ops.push(['is', ...a]); return chain },
          in: (...a) => { log.ops.push(['in', ...a]); return chain },
          limit: (...a) => { log.ops.push(['limit', ...a]); return chain },
          // Only the pending read (payment_status = paid) finds a row.
          then: (resolve, reject) => Promise.resolve({
            data: table === 'trial_purchases' && log.ops.some((o) => o[0] === 'eq' && o[1] === 'payment_status') ? [{ id: 'tp-pending' }] : [],
            error: null,
          }).then(resolve, reject),
        }
        return chain
      },
    }
    const r = await stillorganTrialHistory(db, { locationId: LOC, contact: CONTACT })
    expect(r).toEqual({ ok: true, hadTrial: true, reasons: ['paid_trial_pending'] })
    const pending = calls.filter((c) => c.table === 'trial_purchases').find((c) => c.ops.some((o) => o[1] === 'payment_status'))
    expect(pending.ops).toContainEqual(['eq', 'location_id', LOC])
    expect(pending.ops).toContainEqual(['eq', 'contact_id', 'c1'])
    expect(pending.ops).toContainEqual(['eq', 'payment_status', 'paid'])
    expect(pending.ops).toContainEqual(['in', 'status', ['queued', 'processing', 'needs_review']])
    expect(pending.ops).toContainEqual(['limit', 1])
  })

  it('a failed pending read is ok:false, never hadTrial', async () => {
    let n = 0
    const db = {
      from: () => {
        const chain = {
          select: () => chain, eq: () => chain, is: () => chain, in: () => chain, limit: () => chain,
          then: (resolve, reject) => Promise.resolve(++n === 3 ? { data: null, error: { message: 'boom' } } : { data: [], error: null }).then(resolve, reject),
        }
        return chain
      },
    }
    // No member id, so no claim read: push, granted, then pending (the 3rd).
    const r = await stillorganTrialHistory(db, { locationId: LOC, contact: { ...CONTACT, glofox_member_id: null } })
    expect(r).toEqual({ ok: false, reason: 'trial_purchases_unreadable' })
  })

  it('sibling-studio history does not count (every read filters on the Stillorgan location id)', async () => {
    const { db, calls } = makeDb()
    await stillorganTrialHistory(db, { locationId: LOC, contact: CONTACT })
    expect(calls.map((c) => c.table).sort()).toEqual(['glofox_push_events', 'glofox_trial_claims', 'trial_purchases', 'trial_purchases'])
    for (const c of calls) expect(c.ops, c.table).toContainEqual(['eq', 'location_id', LOC])
    for (const c of calls) expect(c.ops, c.table).toContainEqual(['limit', 1])
  })

  it('a contact with no Glofox member id skips the claim read', async () => {
    const { db, calls } = makeDb()
    await stillorganTrialHistory(db, { locationId: LOC, contact: { ...CONTACT, glofox_member_id: null } })
    expect(calls.some((c) => c.table === 'glofox_trial_claims')).toBe(false)
  })

  it.each([['glofox_trial_claims'], ['glofox_push_events'], ['trial_purchases']])('a failed %s read is ok:false, never hadTrial', async (table) => {
    const { db } = makeDb({ failing: [table] })
    const r = await stillorganTrialHistory(db, { locationId: LOC, contact: CONTACT })
    expect(r).toEqual({ ok: false, reason: `${table}_unreadable` })
    expect(logWarn).toHaveBeenCalledWith('trial-eligibility', expect.any(String), expect.not.objectContaining({ email: expect.anything() }))
  })

  it('a thrown read is ok:false too', async () => {
    const db = { from: () => { throw new Error('connection reset') } }
    const r = await stillorganTrialHistory(db, { locationId: LOC, contact: CONTACT })
    expect(r.ok).toBe(false)
  })

  it('collects every reason', async () => {
    const { db } = makeDb({ rows: { glofox_trial_claims: [{ id: 'a' }], glofox_push_events: [{ id: 'b' }], trial_purchases: [{ id: 'c' }] } })
    const r = await stillorganTrialHistory(db, { locationId: LOC, contact: { ...CONTACT, glofox_membership_status: 'trial', glofox_membership_plan: '2 Week Trial' } })
    expect(r.reasons).toEqual(['membership_status=trial', 'membership_plan_trial', 'glofox_trial_claim', 'glofox_push_created', 'paid_trial_granted', 'paid_trial_pending'])
  })
})

describe('hatchActiveMembership', () => {
  it('an empty read is not an active member', async () => {
    const { db } = makeDb()
    expect(await hatchActiveMembership(db, { locationId: 'loc-hatch', contactId: 'c1' })).toEqual({ ok: true, active: false, reasons: [] })
  })

  it('an active subscription refuses, scoped to the location and the active statuses', async () => {
    const { db, calls } = makeDb({ rows: { un1t_subscriptions: [{ status: 'trialing' }] } })
    const r = await hatchActiveMembership(db, { locationId: 'loc-hatch', contactId: 'c1' })
    expect(r).toEqual({ ok: true, active: true, reasons: ['un1t_subscription=trialing'] })
    const ops = calls.find((c) => c.table === 'un1t_subscriptions').ops
    expect(ops).toContainEqual(['eq', 'location_id', 'loc-hatch'])
    expect(ops).toContainEqual(['eq', 'contact_id', 'c1'])
    expect(ops).toContainEqual(['in', 'status', ['active', 'trialing', 'past_due']])
  })

  it('an active contact_membership refuses, scoped to the location, not ended', async () => {
    const { db, calls } = makeDb({ rows: { contact_memberships: [{ id: 'm1' }] } })
    const r = await hatchActiveMembership(db, { locationId: 'loc-hatch', contactId: 'c1' })
    expect(r).toEqual({ ok: true, active: true, reasons: ['contact_membership_active'] })
    const ops = calls.find((c) => c.table === 'contact_memberships').ops
    expect(ops).toContainEqual(['eq', 'location_id', 'loc-hatch'])
    expect(ops).toContainEqual(['eq', 'status', 'active'])
    expect(ops).toContainEqual(['is', 'ended_at', null])
  })

  it('a cancelled subscription and an ended membership do not refuse (the filters exclude them)', async () => {
    // Cancelled rows never come back from the status-filtered reads.
    const { db } = makeDb({ rows: { un1t_subscriptions: [], contact_memberships: [] } })
    const r = await hatchActiveMembership(db, { locationId: 'loc-hatch', contactId: 'c1' })
    expect(r.active).toBe(false)
  })

  it.each([['un1t_subscriptions'], ['contact_memberships']])('a failed %s read is ok:false', async (table) => {
    const { db } = makeDb({ failing: [table] })
    expect(await hatchActiveMembership(db, { locationId: 'loc-hatch', contactId: 'c1' })).toEqual({ ok: false, reason: `${table}_unreadable` })
  })
})

describe('reasonsText', () => {
  it('formats reasons for last_error', () => {
    expect(reasonsText(['a', 'b'], 'trial_used')).toBe('trial_used: a, b')
    expect(reasonsText(['a'], 'active_member')).toBe('active_member: a')
  })
})
