// UN1TRADAR.1 — pure shaping of un1t.online rows into the churn / lead
// scorer's existing row contract.
import { describe, it, expect } from 'vitest'
import { shapeCounts, packHolderIds } from './un1t-online-shape'
import {
  RENEWAL_EXPIRY_RULE, expiryFor, pickLiveMembership, shapeRadarMembers, shapeWinbackRows, shapeLeadRows,
  foldPastDue, arrearsFromFold,
} from './un1t-online-radar-shape'
import { shapePipelineSnapshot } from './un1t-online-shape'
import { buildFunnel, buildClassPass, NON_MEMBER_STATUSES } from '@/lib/lead-radar'
import { buildRadar, buildWinback, classifyContact } from '@/lib/churn-radar'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString()

const sub = (over = {}) => ({
  un1t_id: 's1', un1t_user_id: 'u1', contact_id: 'c1', status: 'active', product_id: 'p1',
  product_title: 'Hatch plan', price_cents: 12000, billing_interval: 'month', billing_interval_count: 1,
  current_period_end: '2026-11-01T00:00:00Z', cancel_at_period_end: false, paused_at: null,
  paused_until: null, past_due_at: null, remote_created_at: '2026-08-20T00:00:00Z', ...over,
})
const client = (over = {}) => ({
  un1t_user_id: 'u1', contact_id: 'c1', credit_balance: 0, credit_unlimited: false,
  last_attended_at: '2026-10-15T09:00:00Z', bookings_30d_attended: 6, bookings_30d_no_show: 1,
  ltv_cents: 48000, remote_created_at: '2026-08-19T10:00:00Z', ...over,
})
const PRODUCTS = [
  { un1t_id: 'pk1', type: 'one_time', price_cents: 5400, title: '5 Class Pack' },
  { un1t_id: 'pk0', type: 'one_time', price_cents: 0, title: 'Free pack' },
  { un1t_id: 'trial', type: 'one_time', price_cents: 0, title: 'The UN1T Trial' },
]
const ptx = (over = {}) => ({
  un1t_user_id: 'u2', product_id: 'pk1', product_type: 'pack', product_title: '5 Class Pack',
  amount_cents: 5400, remote_created_at: '2026-10-01T10:00:00Z', ...over,
})

const fx = (over = {}) => ({
  subs: [sub()],
  clients: [client()],
  packTxs: [],
  products: PRODUCTS,
  contactsById: new Map([['c1', { id: 'c1', name: 'Alex' }], ['c2', { id: 'c2', name: 'Bea' }], ['c3', { id: 'c3', name: 'Cal' }]]),
  events: [],
  bookings: [],
  newestBookingAtByUser: new Map(),
  lastPaymentAtByUser: new Map(),
  nowMs: NOW,
  ...over,
})

const ROW_KEYS = [
  'id', 'name', 'glofox_membership_status', 'glofox_membership_type', 'glofox_membership_plan',
  'glofox_membership_state', 'glofox_membership_expiry', 'glofox_membership_price_cents',
  'glofox_billing_interval', 'trial_credits_remaining', 'last_attended_at', 'last_booked_at',
  'total_attended_30d', 'total_noshow_30d', 'total_attended_7d', 'total_bookings_30d',
  'last_payment_at', 'joined_at', 'lifetime_value_cents', 'person_group_id', 'cancel_at_period_end',
]

describe('RENEWAL_EXPIRY_RULE', () => {
  it('is period_end (Stillorgan rolling monthly plans carry the next charge date: 98 of 102 within 31 days)', () => {
    expect(RENEWAL_EXPIRY_RULE).toBe('period_end')
  })
})

describe('expiryFor', () => {
  const monthly = sub()
  const annual = sub({ billing_interval: 'year', billing_interval_count: 1, current_period_end: '2027-08-20T00:00:00Z' })
  it('period_end vs cancelling_or_long', () => {
    expect(expiryFor(monthly, 'period_end')).toBe(monthly.current_period_end)
    expect(expiryFor(monthly, 'cancelling_or_long')).toBeNull()
    expect(expiryFor({ ...monthly, cancel_at_period_end: true }, 'cancelling_or_long')).toBe(monthly.current_period_end)
    expect(expiryFor(annual, 'cancelling_or_long')).toBe(annual.current_period_end)
  })
  it('defaults to RENEWAL_EXPIRY_RULE; a missing period end is null', () => {
    expect(expiryFor(monthly)).toBe(monthly.current_period_end)
    expect(expiryFor(sub({ current_period_end: null }))).toBeNull()
    expect(expiryFor(null)).toBeNull()
  })
})

describe('pickLiveMembership', () => {
  it('null when no subscription is live', () => {
    expect(pickLiveMembership([sub({ status: 'cancelled' }), sub({ status: 'trialing' })], NOW)).toBeNull()
    expect(pickLiveMembership([], NOW)).toBeNull()
  })
  it('two live subs: plan from the dearest monthly price; cancelling only when both cancel', () => {
    const cheapMonthly = sub({ un1t_id: 'a', product_title: 'Monthly', price_cents: 9000 })
    const dearQuarterly = sub({ un1t_id: 'b', product_title: 'Quarterly', price_cents: 24000, billing_interval_count: 3, cancel_at_period_end: true })
    // 24000/3 = 8000 a month < 9000: the monthly is dearer once normalised
    const one = pickLiveMembership([cheapMonthly, dearQuarterly], NOW)
    expect(one.sub.product_title).toBe('Monthly')
    expect(one.cancelling).toBe(false)
    const both = pickLiveMembership([{ ...cheapMonthly, cancel_at_period_end: true }, dearQuarterly], NOW)
    expect(both.cancelling).toBe(true)
  })
  it('paused when every live sub is paused and paused_until is null or future', () => {
    const p = { paused_at: '2026-10-01T00:00:00Z' }
    expect(pickLiveMembership([sub(p)], NOW).paused).toBe(true)
    expect(pickLiveMembership([sub({ ...p, paused_until: iso(NOW + DAY) })], NOW).paused).toBe(true)
    expect(pickLiveMembership([sub({ ...p, paused_until: iso(NOW - DAY) })], NOW).paused).toBe(false)
    expect(pickLiveMembership([sub(p), sub({ un1t_id: 's2' })], NOW).paused).toBe(false)
  })
  it('a price tie goes to the newest subscription, whatever the order', () => {
    const a = sub({ un1t_id: 'a', product_title: 'Older', remote_created_at: '2026-08-01T00:00:00Z' })
    const b = sub({ un1t_id: 'b', product_title: 'Newer', remote_created_at: '2026-09-01T00:00:00Z' })
    expect(pickLiveMembership([a, b], NOW).sub.product_title).toBe('Newer')
    expect(pickLiveMembership([b, a], NOW).sub.product_title).toBe('Newer')
  })
  it('past_due is live', () => {
    expect(pickLiveMembership([sub({ status: 'past_due' })], NOW)).not.toBeNull()
  })
})

describe('shapeRadarMembers', () => {
  it('rows carry exactly the scorer contract keys', () => {
    const { rows } = shapeRadarMembers(fx())
    expect(Object.keys(rows[0]).sort()).toEqual([...ROW_KEYS].sort())
  })

  it('live sub maps to member/time with plan, price and glofoxInterval', () => {
    const { rows } = shapeRadarMembers(fx({ subs: [sub({ product_title: 'Unlimited', price_cents: 12000, billing_interval: 'month', billing_interval_count: 3 })] }))
    expect(rows[0]).toMatchObject({
      id: 'c1', name: 'Alex',
      glofox_membership_status: 'member', glofox_membership_type: 'time', glofox_membership_plan: 'Unlimited',
      glofox_membership_state: 'active', glofox_membership_price_cents: 12000, glofox_billing_interval: '3 months',
      glofox_membership_expiry: '2026-11-01T00:00:00Z', person_group_id: null, cancel_at_period_end: false,
    })
  })

  it('maps the client and activity columns', () => {
    const { rows } = shapeRadarMembers(fx({
      clients: [client({ credit_balance: 3 })],
      newestBookingAtByUser: new Map([['u1', '2026-10-16T08:00:00Z']]),
      lastPaymentAtByUser: new Map([['u1', '2026-10-01T00:00:00Z']]),
    }))
    expect(rows[0]).toMatchObject({
      trial_credits_remaining: 3, last_attended_at: '2026-10-15T09:00:00Z', last_booked_at: '2026-10-16T08:00:00Z',
      total_attended_30d: 6, total_noshow_30d: 1, last_payment_at: '2026-10-01T00:00:00Z',
      joined_at: '2026-08-19T10:00:00Z', lifetime_value_cents: 48000,
    })
  })

  it('a member with no un1t_clients row still counts, activity unknown', () => {
    const { rows } = shapeRadarMembers(fx({ clients: [] }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'c1', glofox_membership_status: 'member', last_attended_at: null, total_attended_30d: null })
  })

  it('a paid pack holder with credits is credit_member/num_classes with the pack title', () => {
    const { rows, packHolders } = shapeRadarMembers(fx({
      subs: [],
      clients: [client({ un1t_user_id: 'u2', contact_id: 'c2', credit_balance: 4 })],
      packTxs: [ptx()],
    }))
    expect(packHolders).toBe(1)
    expect(rows[0]).toMatchObject({
      id: 'c2', glofox_membership_status: 'credit_member', glofox_membership_type: 'num_classes',
      glofox_membership_plan: '5 Class Pack', trial_credits_remaining: 4, glofox_membership_expiry: null,
      glofox_billing_interval: null, cancel_at_period_end: false, glofox_membership_price_cents: 5400,
    })
    // the unchanged scorer treats it as a live pack
    expect(classifyContact(rows[0])).toBe('active')
  })

  it('pack holder set is identical to shapeCounts', () => {
    const input = fx({
      subs: [sub(), sub({ un1t_id: 's9', un1t_user_id: 'u3', contact_id: 'c3' })],
      clients: [
        client(),
        client({ un1t_user_id: 'u2', contact_id: 'c2', credit_balance: 4 }), // paid pack → holder
        client({ un1t_user_id: 'u3', contact_id: 'c3', credit_balance: 2 }), // member: not a holder
        client({ un1t_user_id: 'u4', contact_id: 'c4', credit_balance: 5 }), // €0 pack: never
        client({ un1t_user_id: 'u5', contact_id: 'c5', credit_balance: 5, credit_unlimited: true }), // unlimited: never
        client({ un1t_user_id: 'u6', contact_id: 'c6', credit_balance: 1 }), // trial only
      ],
      packTxs: [
        ptx(), ptx({ un1t_user_id: 'u3' }), ptx({ un1t_user_id: 'u4', product_id: 'pk0', amount_cents: 0 }),
        ptx({ un1t_user_id: 'u5' }), ptx({ un1t_user_id: 'u6', product_id: 'trial', amount_cents: 0 }),
      ],
      contactsById: new Map(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => [id, { id, name: id }])),
    })
    const holders = packHolderIds(input)
    const rows = shapeRadarMembers(input).rows.filter((r) => r.glofox_membership_status === 'credit_member')
    const contactOfUser = new Map(input.clients.map((c) => [c.un1t_user_id, c.contact_id]))
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([...holders].map((u) => contactOfUser.get(u))))
    expect(rows.length).toBe(shapeCounts(input).class_packs)
    expect(holders).toEqual(new Set(['u2']))
  })

  it('a pack row prices from the product, else what was paid', () => {
    const disc = shapeRadarMembers(fx({
      subs: [], clients: [client({ un1t_user_id: 'u2', contact_id: 'c2', credit_balance: 4 })],
      packTxs: [ptx({ amount_cents: 4000 })],
    }))
    expect(disc.rows[0].glofox_membership_price_cents).toBe(5400)
    const gone = shapeRadarMembers(fx({
      subs: [], clients: [client({ un1t_user_id: 'u2', contact_id: 'c2', credit_balance: 4 })],
      packTxs: [ptx({ product_id: 'deleted', amount_cents: 4000 })],
    }))
    expect(gone.rows[0].glofox_membership_price_cents).toBe(4000)
  })

  it('€0 pack never becomes a holder; "The UN1T Trial" plan is kept so NON_MEMBER_PLAN_RE drops it', () => {
    const zero = shapeRadarMembers(fx({
      subs: [], clients: [client({ un1t_user_id: 'u2', contact_id: 'c2', credit_balance: 3 })],
      packTxs: [ptx({ product_id: 'pk0', amount_cents: 0 })],
    }))
    expect(zero.rows).toHaveLength(0)
    const trialSub = shapeRadarMembers(fx({ subs: [sub({ product_title: 'The UN1T Trial' })] }))
    expect(trialSub.rows[0].glofox_membership_plan).toBe('The UN1T Trial')
    expect(classifyContact(trialSub.rows[0])).toBe('out')
  })

  it('cancel_at_period_end true → row.cancel_at_period_end true', () => {
    const { rows } = shapeRadarMembers(fx({ subs: [sub({ cancel_at_period_end: true })] }))
    expect(rows[0].cancel_at_period_end).toBe(true)
  })

  it('paused → glofox_membership_state paused (the scorer classifies it paused)', () => {
    const { rows } = shapeRadarMembers(fx({ subs: [sub({ paused_at: '2026-10-01T00:00:00Z' })] }))
    expect(rows[0].glofox_membership_state).toBe('paused')
    expect(classifyContact(rows[0])).toBe('paused')
  })

  it('unlinked client (contact_id null) excluded and counted in unlinkedClients', () => {
    const { rows, unlinkedClients, members } = shapeRadarMembers(fx({
      subs: [sub(), sub({ un1t_id: 's2', un1t_user_id: 'u9', contact_id: null })],
      clients: [client(), client({ un1t_user_id: 'u9', contact_id: null })],
    }))
    expect(rows.map((r) => r.id)).toEqual(['c1'])
    expect(unlinkedClients).toBe(1)
    expect(members).toBe(1)
  })

  it('two un1t accounts linked to one contact are one row (dearest plan, summed counts, newest activity)', () => {
    const { rows, members } = shapeRadarMembers(fx({
      subs: [sub(), sub({ un1t_id: 's2', un1t_user_id: 'u1b', price_cents: 20000, product_title: 'Dear' })],
      clients: [client(), client({ un1t_user_id: 'u1b', last_attended_at: '2026-10-17T09:00:00Z', bookings_30d_attended: 2, bookings_30d_no_show: 0, ltv_cents: 1000 })],
    }))
    expect(rows).toHaveLength(1)
    expect(members).toBe(1)
    expect(rows[0]).toMatchObject({
      glofox_membership_plan: 'Dear', last_attended_at: '2026-10-17T09:00:00Z',
      total_attended_30d: 8, total_noshow_30d: 1, lifetime_value_cents: 49000,
    })
  })

  it('shapeRadarMembers ignores contacts.glofox_* on a dual-studio contact', () => {
    const { rows } = shapeRadarMembers(fx({
      contactsById: new Map([['c1', {
        id: 'c1', name: 'A', glofox_membership_status: 'member', glofox_membership_plan: 'Stillorgan Gold',
        glofox_membership_type: 'num_classes', last_attended_at: '2026-10-16T07:00:00Z', total_attended_30d: 40,
        last_payment_at: '2026-09-01T00:00:00Z', joined_at: '2020-01-01T00:00:00Z',
      }]]),
    }))
    expect(rows[0].glofox_membership_plan).toBe('Hatch plan')
    expect(rows[0].glofox_membership_type).toBe('time')
    expect(rows[0].last_attended_at).toBe(client().last_attended_at)
    expect(rows[0].total_attended_30d).toBe(6)
    expect(rows[0].last_payment_at).toBeNull()
    expect(rows[0].joined_at).toBe(client().remote_created_at)
    expect(rows[0].name).toBe('A')
  })

  describe('derived booking counts', () => {
    const ev = (id, startsMs) => ({ un1t_id: id, starts_at: startsMs == null ? null : iso(startsMs) })
    const bk = (eventId, status, user = 'u1') => ({ un1t_user_id: user, event_id: eventId, status })

    it('total_attended_7d boundary: event at now-7d counts, at now-7d-1ms does not', () => {
      const { rows } = shapeRadarMembers(fx({
        events: [ev('e1', NOW - 7 * DAY), ev('e2', NOW - 7 * DAY - 1)],
        bookings: [bk('e1', 'attended'), bk('e2', 'attended')],
      }))
      expect(rows[0].total_attended_7d).toBe(1)
    })

    it('an event after now is not counted', () => {
      const { rows } = shapeRadarMembers(fx({ events: [ev('e1', NOW + 1)], bookings: [bk('e1', 'attended')] }))
      expect(rows[0].total_attended_7d).toBe(0)
      expect(rows[0].total_bookings_30d).toBe(0)
    })

    it('null starts_at excluded and counted in skippedEvents', () => {
      const out = shapeRadarMembers(fx({
        events: [ev('e1', null), ev('e2', NOW - DAY)],
        bookings: [bk('e1', 'attended'), bk('e2', 'attended')],
      }))
      expect(out.skippedEvents).toBe(1)
      expect(out.rows[0].total_attended_7d).toBe(1)
    })

    it('statuses compared lowercase: "attended" counts, "ATTENDED" does not', () => {
      const { rows } = shapeRadarMembers(fx({
        events: [ev('e1', NOW - DAY), ev('e2', NOW - 2 * DAY)],
        bookings: [bk('e1', 'attended'), bk('e2', 'ATTENDED')],
      }))
      expect(rows[0].total_attended_7d).toBe(1)
    })

    it('total_bookings_30d excludes cancelled and events outside 30 days', () => {
      const { rows } = shapeRadarMembers(fx({
        events: [ev('e1', NOW - DAY), ev('e2', NOW - 2 * DAY), ev('e3', NOW - 3 * DAY), ev('e4', NOW - 31 * DAY)],
        bookings: [bk('e1', 'booked'), bk('e2', 'cancelled'), bk('e3', 'no_show'), bk('e4', 'attended')],
      }))
      expect(rows[0].total_bookings_30d).toBe(2)
    })

    it('another user\'s bookings never count', () => {
      const { rows } = shapeRadarMembers(fx({ events: [ev('e1', NOW - DAY)], bookings: [bk('e1', 'attended', 'u9')] }))
      expect(rows[0].total_attended_7d).toBe(0)
    })
  })

  it('a shaped member goes through the unchanged scorer', () => {
    const { rows } = shapeRadarMembers(fx({ clients: [client({ last_attended_at: iso(NOW - 20 * DAY) })] }))
    const radar = buildRadar(rows, NOW)
    expect(radar).toHaveLength(1)
    expect(radar[0].signals.map((s) => s.key)).toContain('gone_quiet')
  })
})

describe('shapeWinbackRows', () => {
  const CUTOFF = '2026-10-18T11:50:00Z'
  const fresh = '2026-10-18T11:55:00Z'
  const stale = '2026-09-01T00:00:00Z'
  // c2 / u2: a former member who last trained 60 days ago
  const exClient = client({ un1t_user_id: 'u2', contact_id: 'c2', last_attended_at: iso(NOW - 60 * DAY), credit_balance: 0 })
  const wfx = (over = {}) => fx({
    subs: [sub({ synced_at: fresh })],
    clients: [client(), exClient],
    allSubs: [sub({ synced_at: fresh })],
    freshCutoffIso: CUTOFF,
    endedMemberships: [],
    ...over,
  })
  const byId = (rows, id) => rows.find((r) => r.id === id)

  it('keeps every live row from shapeRadarMembers', () => {
    const rows = shapeWinbackRows(wfx())
    expect(byId(rows, 'c1').glofox_membership_status).toBe('member')
    expect(byId(rows, 'c2')).toBeUndefined() // no evidence of a past membership
  })

  it('ex_member from a non-live subscription row', () => {
    const rows = shapeWinbackRows(wfx({
      allSubs: [sub({ synced_at: fresh }), sub({ un1t_id: 'old', un1t_user_id: 'u2', contact_id: 'c2', status: 'cancelled', product_title: 'Old plan', price_cents: 9900, synced_at: fresh })],
    }))
    expect(byId(rows, 'c2')).toMatchObject({
      glofox_membership_status: 'ex_member', glofox_membership_type: 'time', glofox_membership_plan: 'Old plan',
      glofox_membership_price_cents: 9900, glofox_billing_interval: '1 month', cancel_at_period_end: false,
      last_attended_at: exClient.last_attended_at, person_group_id: null,
    })
    const wb = buildWinback(rows, NOW)
    expect(wb.map((r) => r.contactId)).toEqual(['c2'])
  })

  it('ex_member from a stale-active row', () => {
    const rows = shapeWinbackRows(wfx({
      allSubs: [sub({ synced_at: fresh }), sub({ un1t_id: 'gone', un1t_user_id: 'u2', contact_id: 'c2', status: 'active', synced_at: stale })],
    }))
    expect(byId(rows, 'c2').glofox_membership_status).toBe('ex_member')
  })

  it('a fresh active row is never ex_member evidence (it is live)', () => {
    const rows = shapeWinbackRows(wfx({
      subs: [sub({ synced_at: fresh }), sub({ un1t_id: 's2', un1t_user_id: 'u2', contact_id: 'c2', synced_at: fresh })],
      allSubs: [sub({ synced_at: fresh }), sub({ un1t_id: 's2', un1t_user_id: 'u2', contact_id: 'c2', synced_at: fresh })],
    }))
    expect(byId(rows, 'c2').glofox_membership_status).toBe('member')
  })

  it('ex_member from an ended export row, plan from plan_name', () => {
    const rows = shapeWinbackRows(wfx({
      endedMemberships: [{ contact_id: 'c2', plan_name: 'Export plan', ended_at: '2026-08-01T00:00:00Z', source: 'un1t_online_export' }],
    }))
    expect(byId(rows, 'c2')).toMatchObject({ glofox_membership_status: 'ex_member', glofox_membership_plan: 'Export plan' })
  })

  it('a current member with an ended export row is NOT an ex_member', () => {
    // live sub + ended un1t_online_export row (the mig 728 case)
    const rows = shapeWinbackRows(wfx({
      endedMemberships: [{ contact_id: 'c1', plan_name: 'Export plan', ended_at: '2026-08-01T00:00:00Z', source: 'un1t_online_export' }],
    }))
    expect(rows.filter((r) => r.id === 'c1')).toHaveLength(1)
    expect(byId(rows, 'c1').glofox_membership_status).toBe('member')
  })

  it('a pack holder with credits is not an ex_member', () => {
    const rows = shapeWinbackRows(wfx({
      clients: [client(), { ...exClient, credit_balance: 3 }],
      packTxs: [ptx({ un1t_user_id: 'u2' })],
      allSubs: [sub({ synced_at: fresh }), sub({ un1t_id: 'old', un1t_user_id: 'u2', contact_id: 'c2', status: 'cancelled', synced_at: fresh })],
    }))
    expect(byId(rows, 'c2').glofox_membership_status).toBe('credit_member')
  })

  it('trialing-only history is not ex_member evidence', () => {
    const rows = shapeWinbackRows(wfx({
      allSubs: [sub({ synced_at: fresh }), sub({ un1t_id: 't', un1t_user_id: 'u2', contact_id: 'c2', status: 'trialing', synced_at: stale })],
    }))
    expect(byId(rows, 'c2')).toBeUndefined()
  })

  it('plan comes from the newest non-trial subscription row', () => {
    const rows = shapeWinbackRows(wfx({
      allSubs: [
        sub({ synced_at: fresh }),
        sub({ un1t_id: 'a', un1t_user_id: 'u2', contact_id: 'c2', status: 'cancelled', product_title: 'First', remote_created_at: '2026-08-20T00:00:00Z', synced_at: fresh }),
        sub({ un1t_id: 'b', un1t_user_id: 'u2', contact_id: 'c2', status: 'cancelled', product_title: 'Second', remote_created_at: '2026-09-10T00:00:00Z', synced_at: fresh }),
        sub({ un1t_id: 'c', un1t_user_id: 'u2', contact_id: 'c2', status: 'trialing', product_title: 'Trial', remote_created_at: '2026-10-01T00:00:00Z', synced_at: stale }),
      ],
    }))
    expect(byId(rows, 'c2').glofox_membership_plan).toBe('Second')
  })

  it('paused, unpaid, incomplete or blank statuses are not evidence', () => {
    for (const status of ['paused', 'unpaid', 'incomplete', null, '']) {
      const rows = shapeWinbackRows(wfx({
        allSubs: [sub({ synced_at: fresh }), sub({ un1t_id: 'x', un1t_user_id: 'u2', contact_id: 'c2', status, synced_at: stale })],
      }))
      expect(byId(rows, 'c2')).toBeUndefined()
    }
  })

  it('a fresh paused subscription keeps them off win-back even with an ended row', () => {
    const rows = shapeWinbackRows(wfx({
      allSubs: [
        sub({ synced_at: fresh }),
        sub({ un1t_id: 'p', un1t_user_id: 'u2', contact_id: 'c2', status: 'paused', synced_at: fresh }),
        sub({ un1t_id: 'old', un1t_user_id: 'u2', contact_id: 'c2', status: 'cancelled', synced_at: fresh }),
      ],
    }))
    expect(byId(rows, 'c2')).toBeUndefined()
  })

  it('a fresh trialing subscription alone keeps a person with ended history off win-back', () => {
    const rows = shapeWinbackRows(wfx({
      allSubs: [
        sub({ synced_at: fresh }),
        sub({ un1t_id: 't', un1t_user_id: 'u2', contact_id: 'c2', status: 'trialing', synced_at: fresh }),
        sub({ un1t_id: 'old', un1t_user_id: 'u2', contact_id: 'c2', status: 'cancelled', synced_at: fresh }),
      ],
    }))
    expect(byId(rows, 'c2')).toBeUndefined()
  })

  it('a fresh paused_at on a non-ended status keeps them off too (spec A member rule)', () => {
    const rows = shapeWinbackRows(wfx({
      allSubs: [
        sub({ synced_at: fresh }),
        sub({ un1t_id: 'i', un1t_user_id: 'u2', contact_id: 'c2', status: 'incomplete', paused_at: '2026-10-01T00:00:00Z', synced_at: fresh }),
        sub({ un1t_id: 'old', un1t_user_id: 'u2', contact_id: 'c2', status: 'cancelled', synced_at: fresh }),
      ],
    }))
    expect(byId(rows, 'c2')).toBeUndefined()
  })

  it('a stale past_due row is evidence too', () => {
    const rows = shapeWinbackRows(wfx({
      allSubs: [sub({ synced_at: fresh }), sub({ un1t_id: 'g', un1t_user_id: 'u2', contact_id: 'c2', status: 'past_due', synced_at: stale })],
    }))
    expect(byId(rows, 'c2').glofox_membership_status).toBe('ex_member')
  })

  it('a stalled sync (every row equally old) yields no stale-active ex_member', () => {
    const old = '2026-09-01T00:00:00Z'
    const rows = shapeWinbackRows(wfx({
      freshCutoffIso: '2026-08-31T23:50:00Z',
      allSubs: [sub({ synced_at: old }), sub({ un1t_id: 's2', un1t_user_id: 'u2', contact_id: 'c2', synced_at: old })],
    }))
    expect(byId(rows, 'c1').glofox_membership_status).toBe('member')
    expect(byId(rows, 'c2').glofox_membership_status).toBe('member')
  })

  it('live rows come from allSubs by the same cutoff (subs input ignored)', () => {
    const rows = shapeWinbackRows(wfx({
      subs: [],
      allSubs: [sub({ synced_at: fresh })],
    }))
    expect(byId(rows, 'c1').glofox_membership_status).toBe('member')
  })

  it('an unlimited-credit client is not an ex_member', () => {
    const rows = shapeWinbackRows(wfx({
      clients: [client(), { ...exClient, credit_unlimited: true, credit_balance: 0 }],
      allSubs: [sub({ synced_at: fresh }), sub({ un1t_id: 'old', un1t_user_id: 'u2', contact_id: 'c2', status: 'cancelled', synced_at: fresh })],
    }))
    expect(byId(rows, 'c2')).toBeUndefined()
  })

  it('credits left from a €0 trial do not keep a former member off win-back', () => {
    const rows = shapeWinbackRows(wfx({
      clients: [client(), { ...exClient, credit_balance: 2 }],
      packTxs: [ptx({ un1t_user_id: 'u2', product_id: 'trial', amount_cents: 0 })],
      allSubs: [sub({ synced_at: fresh }), sub({ un1t_id: 'old', un1t_user_id: 'u2', contact_id: 'c2', status: 'cancelled', synced_at: fresh })],
    }))
    expect(byId(rows, 'c2').glofox_membership_status).toBe('ex_member')
  })

  it('plan prefers the newest REAL plan over a newer trial-titled row', () => {
    const rows = shapeWinbackRows(wfx({
      allSubs: [
        sub({ synced_at: fresh }),
        sub({ un1t_id: 'a', un1t_user_id: 'u2', contact_id: 'c2', status: 'cancelled', product_title: 'Unlimited', remote_created_at: '2026-08-20T00:00:00Z', synced_at: fresh }),
        sub({ un1t_id: 'b', un1t_user_id: 'u2', contact_id: 'c2', status: 'cancelled', product_title: 'The UN1T Trial', remote_created_at: '2026-09-10T00:00:00Z', synced_at: fresh }),
      ],
    }))
    expect(byId(rows, 'c2').glofox_membership_plan).toBe('Unlimited')
  })

  it('shapeRadarMembers does not expose its lookups', () => {
    expect(Object.keys(shapeRadarMembers(fx())).sort()).toEqual(['members', 'packHolders', 'rows', 'skippedEvents', 'unlinkedClients'])
  })

  it('an ex-member with no contact is left out', () => {
    const rows = shapeWinbackRows(wfx({
      clients: [client(), { ...exClient, contact_id: null }],
      allSubs: [sub({ synced_at: fresh }), sub({ un1t_id: 'old', un1t_user_id: 'u2', contact_id: null, status: 'cancelled', synced_at: fresh })],
    }))
    expect(rows.map((r) => r.id)).toEqual(['c1'])
  })
})

describe('shapeLeadRows', () => {
  const L = 'loc-hatch'
  const products = new Map([
    ['trial', { un1t_id: 'trial', type: 'one_time', price_cents: 0, credits_per_period: 3, title: 'The UN1T Trial' }],
    ['pk1', { un1t_id: 'pk1', type: 'one_time', price_cents: 5400, credits_per_period: 5, title: '5 Class Pack' }],
  ])
  const pclient = (over = {}) => ({ un1t_user_id: 'u', credit_balance: 0, credit_unlimited: false, last_attended_at: null, remote_created_at: '2026-10-01T00:00:00Z', ...over })
  // Each fixture is one person's shapePipelineSnapshot input (spec A's board classifier).
  const fixtures = [
    { contactId: 'm', input: { client: pclient(), freshSubs: [{ status: 'active' }] } },
    { contactId: 'cm', input: { client: pclient({ credit_balance: 4 }), transactions: [{ product_id: 'pk1', product_type: 'pack', amount_cents: 5400, remote_created_at: '2026-10-02T00:00:00Z' }] } },
    { contactId: 'tr', input: { client: pclient({ credit_balance: 3 }), transactions: [{ product_id: 'trial', product_type: 'one_time', amount_cents: 0, remote_created_at: '2026-10-10T00:00:00Z' }] } },
    { contactId: 'trl', input: { client: pclient({ credit_balance: 3 }), ledgerTrials: [{ at: '2026-10-12T00:00:00Z', product_id: 'trial' }] } },
    { contactId: 'cp', input: { client: pclient(), bookings: [{ source: 'classpass', status: 'attended', starts_at: '2026-10-05T09:00:00Z' }] } },
    { contactId: 'gp', input: { client: pclient(), bookings: [{ source: 'wellhub', external_member_ref: 'W1', status: 'booked', starts_at: '2026-10-05T09:00:00Z' }] } },
    { contactId: 'ref', input: { client: pclient(), bookings: [{ source: 'direct', external_member_ref: 'X9', status: 'booked', starts_at: '2026-10-05T09:00:00Z' }] } },
    { contactId: 'ld', input: { client: pclient({ last_attended_at: '2026-10-14T09:00:00Z' }) } },
    { contactId: 'ex', input: { client: pclient(), memberships: [{ source: 'un1t_online_api', status: 'ended', ended_at: '2026-09-01T00:00:00Z' }] } },
    // members with a Wellhub booking: still members, never leads
    { contactId: 'mgp', input: { client: pclient(), freshSubs: [{ status: 'active' }], bookings: [{ source: 'wellhub', external_member_ref: 'W2', status: 'attended', starts_at: '2026-10-05T09:00:00Z' }] } },
    { contactId: 'cmgp', input: { client: pclient({ credit_balance: 4 }), transactions: [{ product_id: 'pk1', product_type: 'pack', amount_cents: 5400, remote_created_at: '2026-10-02T00:00:00Z' }], bookings: [{ source: 'gympass', status: 'booked', starts_at: '2026-10-05T09:00:00Z' }] } },
    // an ex-member with a Gympass booking: the board's Gympass pile, so the aggregator view
    { contactId: 'exgp', input: { client: pclient(), memberships: [{ source: 'un1t_online_api', status: 'ended', ended_at: '2026-09-01T00:00:00Z' }], bookings: [{ source: 'wellhub', status: 'booked', starts_at: '2026-08-05T09:00:00Z' }] } },
  ]
  const snapshots = new Map(fixtures.map((f) => [f.contactId, shapePipelineSnapshot({ productsById: products, locationId: L, contact: null, ...f.input })]))
  const contacts = fixtures.map((f) => ({ id: f.contactId, name: f.contactId, email: null, location_id: 'loc-stillorgan' }))
  const contactsById = new Map(fixtures.map((f) => [f.contactId, {
    id: f.contactId, name: `N ${f.contactId}`, email: `${f.contactId}@example.com`, phone: '+353000', lead_source: 'web',
    // a Stillorgan member: their Glofox status must never be read here (G1)
    glofox_membership_status: 'member',
  }]))
  const run = (over = {}) => shapeLeadRows({ pipeline: { contacts, snapshots }, contactsById, ownedWithoutClient: [], newestBookingAtByContact: new Map(), ...over })
  const byId = (rows, id) => rows.find((r) => r.id === id)

  it('rows carry exactly CONTACT_COLUMNS', () => {
    expect(Object.keys(run()[0]).sort()).toEqual(['email', 'glofox_membership_status', 'id', 'joined_at', 'last_attended_at', 'last_booked_at', 'lead_source', 'name', 'phone'].sort())
  })

  it("same status as A's snapshot for every shared un1t client fixture", () => {
    const rows = run()
    for (const r of rows) {
      const snap = snapshots.get(r.id)
      expect(['member', 'credit_member']).not.toContain(snap.glofox_membership_status)
      if (snap.gympass_member_id) expect(r.glofox_membership_status).toBe('classpass_payg')
      else expect(r.glofox_membership_status).toBe(snap.glofox_membership_status)
    }
    expect(rows.length).toBeGreaterThan(0)
  })

  it('a member or credit member with a Gympass booking is not a lead row', () => {
    const ids = run().map((r) => r.id)
    expect(snapshots.get('mgp').gympass_member_id).not.toBeNull()
    expect(snapshots.get('cmgp').glofox_membership_status).toBe('credit_member')
    expect(snapshots.get('cmgp').gympass_member_id).not.toBeNull()
    expect(ids).not.toContain('mgp')
    expect(ids).not.toContain('cmgp')
  })

  it('an ex-member with a Gympass booking goes to the aggregator view (board order)', () => {
    expect(byId(run(), 'exgp').glofox_membership_status).toBe('classpass_payg')
  })

  it('member, credit_member and ex_member snapshots are not lead rows', () => {
    const ids = run().map((r) => r.id)
    expect(ids).not.toContain('m')
    expect(ids).not.toContain('cm')
    expect(ids).not.toContain('ex')
    for (const r of run()) expect(NON_MEMBER_STATUSES).toContain(r.glofox_membership_status)
  })

  it('a Stillorgan member with no Hatch membership is a Hatch lead or trial', () => {
    expect(byId(run(), 'ld').glofox_membership_status).toBe('lead')
    expect(byId(run(), 'tr').glofox_membership_status).toBe('trial')
  })

  it("trial comes from the trial purchase or D's op=trial ledger row, not the credit balance", () => {
    const rows = run()
    expect(byId(rows, 'tr').glofox_membership_status).toBe('trial')
    expect(byId(rows, 'trl').glofox_membership_status).toBe('trial')
    // a balance with no trial and no paid pack behind it is not a trial
    const snap = shapePipelineSnapshot({ productsById: products, locationId: L, client: pclient({ credit_balance: 6 }) })
    const out = shapeLeadRows({ pipeline: { contacts: [{ id: 'bal' }], snapshots: new Map([['bal', snap]]) }, contactsById: new Map(), ownedWithoutClient: [], newestBookingAtByContact: new Map() })
    expect(out[0].glofox_membership_status).toBe('lead')
  })

  it('aggregator booking (source not direct, or external_member_ref) → classpass view', () => {
    const rows = run()
    expect(byId(rows, 'cp').glofox_membership_status).toBe('classpass_payg')
    expect(byId(rows, 'gp').glofox_membership_status).toBe('classpass_payg')
    expect(byId(rows, 'ref').glofox_membership_status).toBe('classpass_payg')
    const cpIds = buildClassPass(rows, NOW).map((r) => r.contactId)
    expect(cpIds).toEqual(expect.arrayContaining(['cp', 'gp', 'ref']))
  })

  it('joined_at and last_attended_at from the snapshot; last_booked_at from the booking map; lead fields from contacts', () => {
    const rows = run({ newestBookingAtByContact: new Map([['ld', '2026-10-13T08:00:00Z']]) })
    expect(byId(rows, 'ld')).toMatchObject({
      name: 'N ld', email: 'ld@example.com', phone: '+353000', lead_source: 'web',
      joined_at: snapshots.get('ld').joined_at, last_attended_at: '2026-10-14T09:00:00Z', last_booked_at: '2026-10-13T08:00:00Z',
    })
    expect(byId(rows, 'tr').last_booked_at).toBeNull()
  })

  it('owned contact with no un1t client → lead, joined_at falls back to created_at', () => {
    const rows = run({ ownedWithoutClient: [
      { id: 'o1', name: 'Owned', email: 'o1@example.com', phone: null, lead_source: 'form', joined_at: null, created_at: '2026-10-11T00:00:00Z' },
      { id: 'o2', name: 'Owned2', email: null, phone: null, lead_source: null, joined_at: '2026-09-01T00:00:00Z', created_at: '2026-10-11T00:00:00Z' },
    ] })
    expect(byId(rows, 'o1')).toMatchObject({ glofox_membership_status: 'lead', joined_at: '2026-10-11T00:00:00Z', last_attended_at: null, last_booked_at: null, lead_source: 'form' })
    expect(byId(rows, 'o2').joined_at).toBe('2026-09-01T00:00:00Z')
    expect(buildFunnel(rows, NOW).map((r) => r.contactId)).toContain('o1')
  })

  it('an owned contact who IS a un1t client is not listed twice', () => {
    const rows = run({ ownedWithoutClient: [{ id: 'ld', name: 'x', created_at: '2026-10-11T00:00:00Z' }] })
    expect(rows.filter((r) => r.id === 'ld')).toHaveLength(1)
  })
})

// UN1TRADAR.2 — spec A's past-due rows folded into fetchPastDue's Map shape.
describe('foldPastDue', () => {
  const pd = (over = {}) => ({
    contactId: 'c1', un1tUserId: 'u1', subscriptionId: 's1', productTitle: 'Hatch plan', since: '2026-10-01T00:00:00Z',
    amountCents: 4500, currency: 'EUR', openInvoiceIds: ['i1'], cancelAtPeriodEnd: false, pausedUntil: null, ...over,
  })
  const deps = { priceBySubscriptionId: new Map([['s1', 12000], ['s2', 9000]]), lastAttendedByUser: new Map([['u1', '2026-10-10T09:00:00Z']]) }

  it("folds A's rows into fetchPastDue's Map shape", () => {
    const f = foldPastDue([pd({ since: '2026-10-01' })], deps)
    expect(f.ids).toEqual(new Set(['c1']))
    expect(f.membershipById.get('c1')).toEqual({ amountCents: 4500, count: 1, oldestDueAt: '2026-10-01' })
    expect(f.byId.get('c1')).toEqual({ amountCents: 4500, count: 1, oldestDueAt: '2026-10-01' })
    expect(f.byId.get('c1')).not.toBe(f.membershipById.get('c1'))
    expect(f.chargesById.size).toBe(0)
    expect(f.pendingById.size).toBe(0)
    expect(f.unavailable).toEqual(['unpaidCharges', 'awaitingAuth'])
  })

  it('null amount (flag only, no open invoice) becomes the subscription price with amountEstimated', () => {
    const f = foldPastDue([pd({ amountCents: null, openInvoiceIds: [] })], deps)
    expect(f.membershipById.get('c1')).toEqual({ amountCents: 12000, count: 1, oldestDueAt: '2026-10-01T00:00:00Z', amountEstimated: true })
  })

  it('flag only: the price stands in only for a EUR (or currency-less) subscription; another currency is amountUnknown', () => {
    const gbp = foldPastDue([pd({ amountCents: null, openInvoiceIds: [], currency: 'GBP' })], deps)
    expect(gbp.membershipById.get('c1')).toEqual({ amountCents: 0, count: 1, oldestDueAt: '2026-10-01T00:00:00Z', amountUnknown: true })
    const eur = foldPastDue([pd({ amountCents: null, openInvoiceIds: [], currency: 'eur' })], deps)
    expect(eur.membershipById.get('c1').amountEstimated).toBe(true)
    const none = foldPastDue([pd({ amountCents: null, openInvoiceIds: [], currency: null })], deps)
    expect(none.membershipById.get('c1')).toEqual({ amountCents: 12000, count: 1, oldestDueAt: '2026-10-01T00:00:00Z', amountEstimated: true })
  })

  it('no amount and no price: kept as amountUnknown (never dropped), adds 0', () => {
    const f = foldPastDue([pd({ amountCents: null, subscriptionId: 'gone' })], deps)
    expect(f.membershipById.get('c1')).toEqual({ amountCents: 0, count: 1, oldestDueAt: '2026-10-01T00:00:00Z', amountUnknown: true })
    expect(arrearsFromFold(f)).toEqual({ totalCents: 0, memberCount: 1, estimated: true })
  })

  it('mixed currencies (amount null with open invoices) and a non-EUR amount are unknown, never priced or added', () => {
    const mixed = foldPastDue([pd({ amountCents: null, currency: null, openInvoiceIds: ['a', 'b'] })], deps)
    expect(mixed.membershipById.get('c1')).toMatchObject({ amountCents: 0, amountUnknown: true })
    expect(mixed.membershipById.get('c1').amountEstimated).toBeUndefined()
    const gbp = foldPastDue([pd({ amountCents: 3000, currency: 'GBP' })], deps)
    expect(gbp.membershipById.get('c1')).toMatchObject({ amountCents: 0, amountUnknown: true })
  })

  it('a €0 price or a €0 reported sum is amountUnknown, never a silent €0', () => {
    const zeroPrice = foldPastDue([pd({ amountCents: null, openInvoiceIds: [], subscriptionId: 'free' })], { ...deps, priceBySubscriptionId: new Map([['free', 0]]) })
    expect(zeroPrice.membershipById.get('c1')).toMatchObject({ amountCents: 0, amountUnknown: true })
    const zeroSum = foldPastDue([pd({ amountCents: 0 })], deps)
    expect(zeroSum.membershipById.get('c1')).toMatchObject({ amountCents: 0, amountUnknown: true })
  })

  it('the plan shown is the one owed longest', () => {
    const f = foldPastDue([
      pd({ productTitle: 'Newer', since: '2026-10-05T00:00:00Z' }),
      pd({ subscriptionId: 's2', productTitle: 'Older', since: '2026-09-01T00:00:00Z' }),
    ], deps)
    expect(f.profileById.get('c1').glofox_membership_plan).toBe('Older')
  })

  it('two rows for one contact sum and keep the earliest since', () => {
    const f = foldPastDue([
      pd({ since: '2026-10-05T00:00:00Z' }),
      pd({ subscriptionId: 's2', amountCents: null, openInvoiceIds: [], since: '2026-09-20T00:00:00Z' }),
    ], deps)
    expect(f.membershipById.get('c1')).toEqual({ amountCents: 13500, count: 2, oldestDueAt: '2026-09-20T00:00:00Z', amountEstimated: true })
  })

  it('a row with no contact is not surfaced; a row with no since keeps the other', () => {
    const f = foldPastDue([pd({ contactId: null }), pd({ contactId: 'c2', since: null })], deps)
    expect([...f.ids]).toEqual(['c2'])
    expect(f.membershipById.get('c2').oldestDueAt).toBeNull()
  })

  it('profileById carries the un1t plan and last attended, never the contact row', () => {
    const f = foldPastDue([pd()], deps)
    expect(f.profileById.get('c1')).toEqual({
      glofox_membership_status: 'member', glofox_membership_type: 'time',
      glofox_membership_plan: 'Hatch plan', last_attended_at: '2026-10-10T09:00:00Z',
    })
  })
})

describe('arrearsFromFold', () => {
  it('arrears: totals, member count and estimated flag', () => {
    const deps = { priceBySubscriptionId: new Map([['s1', 12000]]), lastAttendedByUser: new Map() }
    const exact = foldPastDue([{ contactId: 'a', subscriptionId: 's1', amountCents: 4500, currency: 'EUR', since: null }, { contactId: 'b', subscriptionId: 's1', amountCents: 500, currency: 'EUR', since: null }], deps)
    expect(arrearsFromFold(exact)).toEqual({ totalCents: 5000, memberCount: 2, estimated: false })
    const est = foldPastDue([{ contactId: 'a', subscriptionId: 's1', amountCents: null, openInvoiceIds: [], since: null }], deps)
    expect(arrearsFromFold(est)).toEqual({ totalCents: 12000, memberCount: 1, estimated: true })
    expect(arrearsFromFold(foldPastDue([], deps))).toEqual({ totalCents: 0, memberCount: 0, estimated: false })
  })
})


// HATCH39 — a €39 trial purchase is a trial membership, never a pack holder on the radar.
describe('HATCH39 — the paid-trial product set', () => {
  it('a client whose latest pack transaction is the paid trial is not credit_member; without the set it is (today)', () => {
    const base = {
      subs: [],
      clients: [client({ un1t_user_id: 'u2', contact_id: 'c2', credit_balance: 4 })],
      packTxs: [ptx({ product_id: 'paid39', product_title: 'The UN1T Trial', amount_cents: 3900 })],
      products: [...PRODUCTS, { un1t_id: 'paid39', type: 'one_time', price_cents: 3900, title: 'The UN1T Trial' }],
    }
    expect(shapeRadarMembers(fx(base)).packHolders).toBe(1)
    const out = shapeRadarMembers(fx({ ...base, paidTrialProductIds: new Set(['paid39']) }))
    expect(out.packHolders).toBe(0)
    expect(out.rows.filter((r) => r.glofox_membership_status === 'credit_member')).toEqual([])
  })
})
