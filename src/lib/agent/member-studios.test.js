// src/lib/agent/member-studios.test.js — MIAHATCH.1
//
// Which studios is this person active at, and which of those may Mia answer
// for? Fictional ids only (the repo is public).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('./settings-resolve', () => ({ resolveAgentSettings: vi.fn() }))

import { logWarn } from '@/lib/log'
import { resolveAgentSettings } from './settings-resolve'
import {
  isAgentOnForSender, glofoxStudioActive, un1tStudioActive, classifyMemberStudios,
  answerableStudios, otherStudioOnly, resolveMemberStudios,
} from './member-studios'

const ORG = 'org-0001'
const OTHER_ORG = 'org-0002'
const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const FOREIGN = 'loc-foreign'

const LOCATIONS = [
  { id: STILL, name: 'Stillorgan', membership_source: 'glofox', organization_id: ORG },
  { id: HATCH, name: 'Hatch Street', membership_source: 'un1t_online', organization_id: ORG },
]

describe('isAgentOnForSender', () => {
  it('enabled; test_mode only for test_phones; enabled+test_mode is everyone', () => {
    expect(isAgentOnForSender({ enabled: true, test_mode: false }, '353871110000')).toBe(true)
    expect(isAgentOnForSender({ enabled: false, test_mode: false, test_phones: ['353871110000'] }, '353871110000')).toBe(false)
    expect(isAgentOnForSender({ enabled: false, test_mode: true, test_phones: ['353871110000'] }, '+353 87 111 0000')).toBe(true)
    expect(isAgentOnForSender({ enabled: false, test_mode: true, test_phones: ['353871110000'] }, '353872220000')).toBe(false)
    // LIVE FOR EVERYONE: the allowlist is not in effect.
    expect(isAgentOnForSender({ enabled: true, test_mode: true, test_phones: ['353871110000'] }, '353872220000')).toBe(true)
    expect(isAgentOnForSender(null, '353871110000')).toBe(false)
  })
})

describe('studio activity', () => {
  it('glofox active = bookable membership or trial credits', () => {
    expect(glofoxStudioActive([{ glofox_membership_status: 'member', glofox_membership_state: 'active' }])).toBe(true)
    expect(glofoxStudioActive([{ glofox_membership_status: 'member', glofox_membership_state: 'paused' }])).toBe(false)
    expect(glofoxStudioActive([{ trial_credits_remaining: 2 }])).toBe(true)
    expect(glofoxStudioActive([{ trial_credits_remaining: 0 }])).toBe(false)
    expect(glofoxStudioActive([])).toBe(false)
  })

  it('un1t active = live subscription status, unlimited, or balance > 0', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(un1tStudioActive({ subscriptions: [{ status }] })).toBe(true)
    }
    expect(un1tStudioActive({ subscriptions: [{ status: 'canceled' }], client: { credit_unlimited: true, credit_balance: 0 } })).toBe(true)
    expect(un1tStudioActive({ subscriptions: [{ status: 'canceled' }], client: { credit_balance: 3 } })).toBe(true)
    expect(un1tStudioActive({ subscriptions: [], client: { credit_balance: 0 } })).toBe(false)
    expect(un1tStudioActive({ subscriptions: [{ status: 'canceled' }] })).toBe(false)
    expect(un1tStudioActive({})).toBe(false)
  })
})

const stillContact = (over = {}) => ({
  id: 'c-still', location_id: STILL, glofox_member_id: 'gx-1',
  glofox_membership_status: 'member', glofox_membership_state: 'active', trial_credits_remaining: 0,
  un1t_user_id: null, ...over,
})
const hatchContact = (over = {}) => ({ id: 'c-hatch', location_id: HATCH, glofox_member_id: null, un1t_user_id: 'u-1', ...over })
const hatchClient = (over = {}) => ({
  location_id: HATCH, un1t_user_id: 'u-1', contact_id: 'c-hatch', credit_balance: 0, credit_unlimited: false, last_attended_at: null, ...over,
})
const hatchSub = (over = {}) => ({ location_id: HATCH, un1t_user_id: 'u-1', status: 'active', ...over })

function classify({ contacts = [], un1tClients = [], un1tSubscriptions = [], agentOn = {}, locations = LOCATIONS } = {}) {
  return classifyMemberStudios({ contacts, un1tClients, un1tSubscriptions, locations, agentOnByLocation: agentOn })
}
const byLoc = (studios, id) => studios.find((s) => s.locationId === id)

describe('classifyMemberStudios', () => {
  it('builds a glofox studio and a un1t studio with their ids', () => {
    const studios = classify({
      contacts: [stillContact(), hatchContact()],
      un1tClients: [hatchClient()],
      un1tSubscriptions: [hatchSub()],
      agentOn: { [STILL]: true, [HATCH]: false },
    })
    expect(byLoc(studios, STILL)).toMatchObject({
      name: 'Stillorgan', providerKey: 'glofox', active: true, answerable: true, contactIds: ['c-still'], glofoxMemberId: 'gx-1',
    })
    expect(byLoc(studios, STILL).un1tUserId).toBeUndefined()
    expect(byLoc(studios, HATCH)).toMatchObject({
      name: 'Hatch Street', providerKey: 'un1t_online', active: true, answerable: false, contactIds: ['c-hatch'], un1tUserId: 'u-1',
    })
  })

  it('maps membership_source to a provider key: unknown values are none', () => {
    const studios = classify({
      locations: [
        { id: 'l-a', name: 'A', membership_source: 'un1t', organization_id: ORG },
        { id: 'l-b', name: 'B', membership_source: null, organization_id: ORG },
      ],
    })
    expect(studios.map((s) => s.providerKey)).toEqual(['none', 'none'])
    expect(studios.every((s) => s.active === false)).toBe(true)
  })

  it('a studio with no account is still emitted (the thread studio), inactive', () => {
    const studios = classify({ agentOn: { [STILL]: true } })
    expect(byLoc(studios, STILL)).toMatchObject({ active: false, answerable: true, contactIds: [] })
    expect(byLoc(studios, STILL).glofoxMemberId).toBeUndefined()
  })

  it('two un1t user ids at one studio: active one wins, then latest last_attended_at; logs multiple_un1t_users; contactIds not mixed', () => {
    logWarn.mockClear()
    const contacts = [
      hatchContact({ id: 'c-h1', un1t_user_id: 'u-a' }),
      hatchContact({ id: 'c-h2', un1t_user_id: 'u-b' }),
    ]
    const clients = [
      hatchClient({ un1t_user_id: 'u-a', contact_id: 'c-h1', last_attended_at: '2026-10-10T10:00:00Z' }),
      hatchClient({ un1t_user_id: 'u-b', contact_id: 'c-h2', last_attended_at: '2026-01-01T10:00:00Z' }),
    ]
    // u-b is the only one with a live subscription: it wins despite older attendance.
    let studios = classify({ contacts, un1tClients: clients, un1tSubscriptions: [hatchSub({ un1t_user_id: 'u-b' })] })
    expect(byLoc(studios, HATCH)).toMatchObject({ un1tUserId: 'u-b', contactIds: ['c-h2'], active: true })
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn.mock.calls[0][0]).toBe('mia-un1t')
    expect(logWarn.mock.calls[0][1]).toBe('multiple_un1t_users')

    // Neither active: latest attendance wins.
    logWarn.mockClear()
    studios = classify({ contacts, un1tClients: clients })
    expect(byLoc(studios, HATCH)).toMatchObject({ un1tUserId: 'u-a', contactIds: ['c-h1'], active: false })
    expect(logWarn).toHaveBeenCalledTimes(1)

    // No attendance difference: lexical user id.
    logWarn.mockClear()
    studios = classify({
      contacts,
      un1tClients: clients.map((c) => ({ ...c, last_attended_at: null })),
    })
    expect(byLoc(studios, HATCH).un1tUserId).toBe('u-a')
  })

  it('the log carries ids only, never phone, email or name', () => {
    logWarn.mockClear()
    classify({
      contacts: [hatchContact({ id: 'c-h1', un1t_user_id: 'u-a', name: 'Ada Example', email: 'ada@example.com', phone: '353871110000' }), hatchContact({ id: 'c-h2', un1t_user_id: 'u-b' })],
      un1tClients: [hatchClient({ un1t_user_id: 'u-a', contact_id: 'c-h1' }), hatchClient({ un1t_user_id: 'u-b', contact_id: 'c-h2' })],
    })
    const logged = JSON.stringify(logWarn.mock.calls)
    expect(logged).not.toMatch(/Ada|example\.com|35387/)
  })

  it('a sibling subscription of the other user does not make the chosen user active', () => {
    const studios = classify({
      contacts: [hatchContact({ id: 'c-h1', un1t_user_id: 'u-a' }), hatchContact({ id: 'c-h2', un1t_user_id: 'u-b' })],
      un1tClients: [hatchClient({ un1t_user_id: 'u-a', contact_id: 'c-h1' }), hatchClient({ un1t_user_id: 'u-b', contact_id: 'c-h2' })],
      un1tSubscriptions: [hatchSub({ un1t_user_id: 'u-b', status: 'canceled' })],
    })
    expect(byLoc(studios, HATCH).active).toBe(false)
  })
})

const studio = (over) => ({
  locationId: STILL, name: 'S', providerKey: 'glofox', active: false, answerable: false, contactIds: [], ...over,
})
const S = (over = {}) => studio({ locationId: STILL, glofoxMemberId: 'gx-1', contactIds: ['c1'], ...over })
const H = (over = {}) => studio({ locationId: HATCH, name: 'H', providerKey: 'un1t_online', un1tUserId: 'u-1', contactIds: ['c2'], ...over })

describe('answerableStudios (spec 6.1)', () => {
  // [label, studios, expected locationIds, expected basis]
  const table = [
    ['Stillorgan-only member', [S({ active: true, answerable: true }), H({ answerable: true })], [STILL], 'active'],
    ['Stillorgan-only member, Hatch off', [S({ active: true, answerable: true }), H({ answerable: false })], [STILL], 'active'],
    ['Hatch-only member, Hatch on', [S({ answerable: true, glofoxMemberId: undefined, contactIds: [] }), H({ active: true, answerable: true })], [HATCH], 'active'],
    ['Hatch-only member, Hatch off', [S({ answerable: true, glofoxMemberId: undefined, contactIds: [] }), H({ active: true, answerable: false })], [], 'thread'],
    ['both active, both on', [S({ active: true, answerable: true }), H({ active: true, answerable: true })], [STILL, HATCH], 'active'],
    ['both active, Hatch off (or test mode, not on the list)', [S({ active: true, answerable: true }), H({ active: true, answerable: false })], [STILL], 'active'],
    ['both active, Stillorgan off', [S({ active: true, answerable: false }), H({ active: true, answerable: true })], [HATCH], 'active'],
    ['neither active, nothing answerable', [S(), H()], [], 'thread'],
  ]
  for (const [label, studios, ids, basis] of table) {
    it(label, () => {
      const out = answerableStudios(studios, STILL)
      expect(out.answerable.map((s) => s.locationId)).toEqual(ids)
      expect(out.basis).toBe(basis)
    })
  }

  it('lists the thread studio first', () => {
    const out = answerableStudios([H({ active: true, answerable: true }), S({ active: true, answerable: true })], STILL)
    expect(out.answerable.map((s) => s.locationId)).toEqual([STILL, HATCH])
  })

  it('fallback: nobody answerable-active -> the one answerable studio with an account', () => {
    const out = answerableStudios([S({ active: false, answerable: true }), H({ active: false, answerable: false })], HATCH)
    expect(out.basis).toBe('fallback')
    expect(out.answerable.map((s) => s.locationId)).toEqual([STILL])
  })

  it('fallback needs exactly one answerable studio with an account; a studio with no account never counts', () => {
    // Two accounts, both answerable, neither active: ambiguous -> thread.
    expect(answerableStudios([S({ answerable: true }), H({ answerable: true })], STILL)).toMatchObject({ basis: 'thread', answerable: [] })
    // The only answerable studio is the thread studio and the person has no account there.
    const noAccount = S({ answerable: true, glofoxMemberId: undefined, contactIds: [] })
    expect(answerableStudios([noAccount, H({ answerable: false })], STILL)).toMatchObject({ basis: 'thread', answerable: [] })
  })

  it('empty studios -> thread', () => {
    expect(answerableStudios([], STILL)).toEqual({ answerable: [], basis: 'thread' })
  })
})

describe('otherStudioOnly', () => {
  it('Hatch-only member, Stillorgan thread, Hatch off -> Hatch; Hatch on -> null', () => {
    const thread = S({ answerable: true, glofoxMemberId: undefined, contactIds: [] })
    expect(otherStudioOnly([thread, H({ active: true, answerable: false })], STILL)?.locationId).toBe(HATCH)
    expect(otherStudioOnly([thread, H({ active: true, answerable: true })], STILL)).toBeNull()
  })

  it('null when the thread studio is itself active, or the other studio is not active, or it is a glofox studio', () => {
    expect(otherStudioOnly([S({ active: true, answerable: true }), H({ active: true, answerable: false })], STILL)).toBeNull()
    expect(otherStudioOnly([S(), H({ active: false, answerable: false })], STILL)).toBeNull()
    expect(otherStudioOnly([S({ active: true, answerable: false }), H()], HATCH)).toBeNull()
  })

  it('null when something else is answerable-active', () => {
    const third = studio({ locationId: 'loc-third', providerKey: 'un1t_online', active: true, answerable: true, un1tUserId: 'u-9', contactIds: ['c9'] })
    expect(otherStudioOnly([S(), H({ active: true, answerable: false }), third], STILL)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveMemberStudios — fake db
// ---------------------------------------------------------------------------

function makeDb(tables, { errors = {} } = {}) {
  const calls = []
  const db = {
    calls,
    from(table) {
      const state = { table, select: '', filters: [], maybe: false }
      const run = () => {
        calls.push({ table, select: state.select, filters: state.filters.map((f) => ({ ...f })) })
        const key = Object.keys(errors).find((k) => {
          const [t, frag] = k.split(':')
          return t === table && (!frag || state.select.includes(frag))
        })
        if (key) return { data: null, error: { message: `fake ${key} failed` } }
        let rows = (tables[table] || []).filter((r) =>
          state.filters.every((f) => (f.op === 'eq' ? r[f.col] === f.val : f.val.includes(r[f.col]))),
        )
        if (state.maybe) return { data: rows[0] ?? null, error: null }
        return { data: rows, error: null }
      }
      const b = {
        select(s) { state.select = s; return b },
        eq(col, val) { state.filters.push({ op: 'eq', col, val }); return b },
        in(col, val) { state.filters.push({ op: 'in', col, val }); return b },
        maybeSingle() { state.maybe = true; return b },
        then(res, rej) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
  }
  return db
}

const settingsFor = (map) => async (_db, locationId) => {
  const s = map[locationId]
  if (s === 'fail') return { ok: false, reason: 'read_failed' }
  return { ok: true, settings: s || { enabled: false, test_mode: false } }
}

const SENDER = '353871110000'

function world(over = {}) {
  return {
    person_group_members: [
      { group_id: 'g-1', contact_id: 'c-still' },
      { group_id: 'g-1', contact_id: 'c-hatch' },
    ],
    contacts: [
      { id: 'c-still', name: 'A', glofox_member_id: 'gx-1', glofox_membership_status: 'member', glofox_membership_state: 'active', trial_credits_remaining: 0, last_attended_at: null, phone: null, wa_phone: null, email: null, updated_at: null, location_id: STILL, un1t_user_id: null },
      { id: 'c-hatch', name: 'A', glofox_member_id: null, glofox_membership_status: null, glofox_membership_state: null, trial_credits_remaining: null, last_attended_at: null, phone: null, wa_phone: null, email: null, updated_at: null, location_id: HATCH, un1t_user_id: 'u-1' },
      { id: 'c-stranger', glofox_member_id: 'gx-9', location_id: STILL, un1t_user_id: 'u-9' },
    ],
    locations: [
      ...LOCATIONS,
      { id: FOREIGN, name: 'Elsewhere', membership_source: 'un1t_online', organization_id: OTHER_ORG },
    ],
    un1t_clients: [
      { location_id: HATCH, un1t_user_id: 'u-1', contact_id: 'c-hatch', credit_balance: 0, credit_unlimited: false, last_attended_at: null },
      { location_id: FOREIGN, un1t_user_id: 'u-1', contact_id: null, credit_balance: 5, credit_unlimited: false, last_attended_at: null },
    ],
    un1t_subscriptions: [
      { location_id: HATCH, un1t_user_id: 'u-1', status: 'active' },
      { location_id: FOREIGN, un1t_user_id: 'u-1', status: 'active' },
    ],
    ...over,
  }
}

const args = (over = {}) => ({ anchorContactId: 'c-still', threadLocationId: STILL, organizationId: ORG, senderPhone: SENDER, ...over })

describe('resolveMemberStudios', () => {
  beforeEach(() => {
    resolveAgentSettings.mockReset()
    resolveAgentSettings.mockImplementation(settingsFor({
      [STILL]: { enabled: true, test_mode: false },
      [HATCH]: { enabled: false, test_mode: false },
    }))
  })

  it('resolves both studios for a member of both; Hatch off -> not answerable', async () => {
    const db = makeDb(world())
    const out = await resolveMemberStudios(db, args())
    expect(out.readFailed).toBe(false)
    expect(out.studios.map((s) => [s.locationId, s.active, s.answerable])).toEqual([
      [STILL, true, true],
      [HATCH, true, false],
    ])
    expect(out.studios.find((s) => s.locationId === HATCH)).toMatchObject({ un1tUserId: 'u-1', contactIds: ['c-hatch'] })
  })

  it('Hatch in test mode answers only for a sender on test_phones', async () => {
    resolveAgentSettings.mockImplementation(settingsFor({
      [STILL]: { enabled: true, test_mode: false },
      [HATCH]: { enabled: false, test_mode: true, test_phones: [SENDER] },
    }))
    expect((await resolveMemberStudios(makeDb(world()), args())).studios.find((s) => s.locationId === HATCH).answerable).toBe(true)
    expect((await resolveMemberStudios(makeDb(world()), args({ senderPhone: '353872220000' }))).studios.find((s) => s.locationId === HATCH).answerable).toBe(false)
  })

  it('only locations of organizationId are considered', async () => {
    const db = makeDb(world())
    const out = await resolveMemberStudios(db, args())
    expect(out.studios.map((s) => s.locationId)).not.toContain(FOREIGN)
    expect(resolveAgentSettings.mock.calls.map((c) => c[1]).sort()).toEqual([HATCH, STILL].sort())
    const locRead = db.calls.find((c) => c.table === 'locations')
    expect(locRead.filters).toEqual([{ op: 'eq', col: 'organization_id', val: ORG }])
    for (const t of ['un1t_clients', 'un1t_subscriptions']) {
      const read = db.calls.find((c) => c.table === t)
      expect(read.filters.find((f) => f.col === 'location_id').val.sort()).toEqual([HATCH, STILL].sort())
      expect(read.filters.find((f) => f.col === 'un1t_user_id').val).toEqual(['u-1'])
    }
  })

  it('the stranger in another group is never read as part of this person', async () => {
    const db = makeDb(world())
    const out = await resolveMemberStudios(db, args())
    const unitRead = db.calls.find((c) => c.table === 'un1t_clients')
    expect(unitRead.filters.find((f) => f.col === 'un1t_user_id').val).not.toContain('u-9')
    expect(out.studios.flatMap((s) => s.contactIds)).not.toContain('c-stranger')
  })

  it('shares one orgCache across every studio resolve', async () => {
    await resolveMemberStudios(makeDb(world()), args())
    const caches = resolveAgentSettings.mock.calls.map((c) => c[2]?.orgCache)
    expect(caches[0]).toBeInstanceOf(Map)
    expect(new Set(caches).size).toBe(1)
  })

  it('the thread studio is a candidate even when the person has no account there', async () => {
    const w = world({
      person_group_members: [{ group_id: 'g-1', contact_id: 'c-hatch' }, { group_id: 'g-1', contact_id: 'c-hatch2' }],
      contacts: world().contacts.concat([{ id: 'c-hatch2', glofox_member_id: null, location_id: HATCH, un1t_user_id: 'u-1' }]),
    })
    const out = await resolveMemberStudios(makeDb(w), args({ anchorContactId: 'c-hatch' }))
    expect(out.studios.map((s) => s.locationId)).toEqual([STILL, HATCH])
    expect(out.studios.find((s) => s.locationId === STILL)).toMatchObject({ active: false, answerable: true, contactIds: [] })
  })

  it('an ungrouped contact still resolves', async () => {
    const out = await resolveMemberStudios(makeDb(world({ person_group_members: [] })), args())
    expect(out.readFailed).toBe(false)
    expect(out.studios.map((s) => s.locationId)).toEqual([STILL])
    expect(out.studios[0]).toMatchObject({ active: true, contactIds: ['c-still'] })
  })

  it('reads no un1t tables when nobody in the group has a un1t_user_id', async () => {
    const w = world({ person_group_members: [] })
    const db = makeDb(w)
    await resolveMemberStudios(db, args())
    expect(db.calls.some((c) => c.table === 'un1t_clients')).toBe(false)
  })

  describe('a failed read -> { studios: [], readFailed: true }, never a guessed studio', () => {
    const failures = {
      'group (person_group_members)': { person_group_members: true },
      'group contacts': { 'contacts:glofox_member_id': true },
      'contacts un1t_user_id': { 'contacts:un1t_user_id': true },
      locations: { locations: true },
      un1t_clients: { un1t_clients: true },
      un1t_subscriptions: { un1t_subscriptions: true },
    }
    for (const [label, spec] of Object.entries(failures)) {
      it(label, async () => {
        const errors = Object.fromEntries(Object.keys(spec).map((k) => [k, true]))
        const out = await resolveMemberStudios(makeDb(world(), { errors }), args())
        expect(out).toEqual({ studios: [], readFailed: true })
      })
    }

    it('settings', async () => {
      resolveAgentSettings.mockImplementation(settingsFor({ [STILL]: { enabled: true }, [HATCH]: 'fail' }))
      expect(await resolveMemberStudios(makeDb(world()), args())).toEqual({ studios: [], readFailed: true })
    })

    it('a thrown settings read', async () => {
      resolveAgentSettings.mockRejectedValue(new Error('boom'))
      expect(await resolveMemberStudios(makeDb(world()), args())).toEqual({ studios: [], readFailed: true })
    })

    it('no anchor contact', async () => {
      expect(await resolveMemberStudios(makeDb(world()), args({ anchorContactId: null }))).toEqual({ studios: [], readFailed: true })
    })
  })
})
