// PERSON-ACCT.4 — one person routinely holds 2-3 `contacts` rows (linked via
// person_groups/person_group_members). Before this task get_my_event_registrations,
// cancel_event_registration, reschedule_event_wave and book_event's member gate
// all read/acted on the single acting contact row, so a customer whose
// registration or real Glofox membership sat on a SIBLING row got told they had
// no registration (live incident, "Julie Cross") or was refused/charged as a
// non-member. Mirrors the idiom in booking-tools-fanout.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/race-register-solo', () => ({
  registerSoloEventEntry: vi.fn(async () => ({ ok: true, registrationId: 'reg-new' })),
}))

import * as raceRegisterSolo from '@/lib/race-register-solo'
import { executeEventTool } from './event-tools'

// A person group: c-1 is the anchor/acting contact, c-2 a sibling.
const GROUP = [
  { id: 'c-1', name: 'Anchor', first_name: 'Anchor', last_name: 'A', email: 'anchor@example.com', phone: '+353871111111', wa_phone: '353871111111', glofox_member_id: null, glofox_membership_status: 'lead', glofox_membership_state: null },
  { id: 'c-2', name: 'Sibling', first_name: 'Sibling', last_name: 'B', email: 'sibling@example.com', phone: '087 111 1111', wa_phone: null, glofox_member_id: 'gf-2', glofox_membership_status: 'member', glofox_membership_state: 'active' },
]

const FUTURE_RACE = {
  id: 'race-1', name: 'Hyrox Sim', kind: 'race', slug: 'hyrox-sim', race_date: '2099-06-20',
  active: true, location_id: 'loc-1', capacity_mode: 'teams',
  registration_opens_at: null, registration_closes_at: null,
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: null, members_only: false,
  payment_currency: 'EUR', waves: [],
}

// Traced stub — mirrors booking-tools-fanout.test.js: select()/in()/update()/
// insert() are all recorded so a test can pin the exact column list / id set
// a query used, not just the shape the double happens to hand back.
function stubDb(trace, {
  contacts = [],
  groupId = 'g-1',
  groupReadError = null,
  raceEvent = FUTURE_RACE,
  registrations = {},
  waves = {},
  payments = {},
} = {}) {
  return {
    from(table) {
      const st = { table, cols: '', filters: {}, op: null }
      const settle = (single) => {
        if (table === 'person_group_members') {
          if (groupReadError) return { data: null, error: groupReadError }
          if (st.cols.includes('group_id')) return { data: { group_id: groupId }, error: null }
          return { data: contacts.map((c) => ({ contact_id: c.id })), error: null }
        }
        if (table === 'contacts') {
          const want = st.filters.id
          const list = Array.isArray(want)
            ? contacts.filter((c) => want.includes(c.id))
            : contacts.filter((c) => c.id === want)
          return single ? { data: list[0] || null, error: null } : { data: list, error: null }
        }
        if (table === 'race_events') {
          return { data: raceEvent, error: null }
        }
        if (table === 'race_registrations') {
          if (st.op === 'update') return { data: null, error: null }
          if (st.filters.contact_id != null) {
            const ids = Array.isArray(st.filters.contact_id) ? st.filters.contact_id : [st.filters.contact_id]
            const rows = Object.values(registrations).filter((r) => ids.includes(r.contact_id))
            return { data: rows, error: null }
          }
          if (st.filters.id != null) {
            const row = registrations[st.filters.id] || null
            return single ? { data: row, error: null } : { data: row ? [row] : [], error: null }
          }
          return { data: single ? null : [], error: null }
        }
        if (table === 'race_waves') {
          return { data: waves[st.filters.id] || null, error: null }
        }
        if (table === 'race_payments') {
          return { data: payments[st.filters.race_registration_id] || [], error: null }
        }
        if (table === 'agent_membership_requests' && st.op === 'insert') {
          return { data: { id: 'req-1' }, error: null }
        }
        return { data: single ? null : [], error: null }
      }
      const b = {
        select(cols) { st.cols = cols || ''; trace.push({ step: 'select', table, cols }); return b },
        eq(col, val) { st.filters[col] = val; return b },
        in(col, vals) { st.filters[col] = vals; trace.push({ step: 'in', table, col, vals }); return b },
        gte: () => b,
        not: () => b,
        order: () => b,
        limit: () => b,
        update(patch) { st.op = 'update'; trace.push({ step: 'update', table, patch }); return b },
        insert(row) { st.op = 'insert'; trace.push({ step: 'insert', table, row }); return b },
        async maybeSingle() { return settle(true) },
        async single() { return settle(true) },
        then(resolve, reject) { return Promise.resolve(settle(false)).then(resolve, reject) },
      }
      return b
    },
  }
}

const ctx = (db, overrides = {}) => ({
  db,
  conversationId: 'conv-1',
  contactId: 'c-1',
  verifiedContactId: 'c-1',
  locationId: 'loc-1',
  channel: 'whatsapp',
  nameHint: 'Anchor',
  settings: { booking_mode: 'auto' },
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  raceRegisterSolo.registerSoloEventEntry.mockResolvedValue({ ok: true, registrationId: 'reg-new' })
})

describe('get_my_event_registrations fans out across the person group', () => {
  it('a registration owned by a SIBLING contact is listed', async () => {
    const trace = []
    const registrations = {
      'reg-sib': {
        id: 'reg-sib', status: 'confirmed', contact_id: 'c-2', wave_id: null,
        race_events: { name: 'Hyrox Sim', kind: 'race', race_date: '2099-06-20', location_id: 'loc-1' },
        race_waves: null,
      },
    }
    const res = await executeEventTool('get_my_event_registrations', {},
      ctx(stubDb(trace, { contacts: GROUP, registrations })))

    expect(res.registrations.map((r) => r.registration_id)).toEqual(['reg-sib'])
    expect(res.registrations[0].event_name).toBe('Hyrox Sim')
  })

  // The .in() must carry EVERY id in the group, not just the acting contact's.
  it('the widened .in() receives ALL group ids', async () => {
    const trace = []
    await executeEventTool('get_my_event_registrations', {},
      ctx(stubDb(trace, { contacts: GROUP, registrations: {} })))

    const inCall = trace.find((t) => t.step === 'in' && t.table === 'race_registrations' && t.col === 'contact_id')
    expect(inCall).toBeTruthy()
    expect(inCall.vals.sort()).toEqual(['c-1', 'c-2'])
  })

  it('readFailed from linkedAccountsForContact → single-contact fallback, sibling registration NOT shown', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const trace = []
    const registrations = {
      'reg-sib': {
        id: 'reg-sib', status: 'confirmed', contact_id: 'c-2', wave_id: null,
        race_events: { name: 'Hyrox Sim', kind: 'race', race_date: '2099-06-20', location_id: 'loc-1' },
        race_waves: null,
      },
      'reg-own': {
        id: 'reg-own', status: 'confirmed', contact_id: 'c-1', wave_id: null,
        race_events: { name: 'Own Event', kind: 'race', race_date: '2099-06-20', location_id: 'loc-1' },
        race_waves: null,
      },
    }
    const db = stubDb(trace, { contacts: GROUP, registrations, groupReadError: { message: 'group lookup down' } })
    const res = await executeEventTool('get_my_event_registrations', {}, ctx(db))

    expect(res.registrations.map((r) => r.registration_id)).toEqual(['reg-own'])
    err.mockRestore()
  })

  it('no registrations anywhere in the group → the unchanged none-found answer', async () => {
    const trace = []
    const res = await executeEventTool('get_my_event_registrations', {},
      ctx(stubDb(trace, { contacts: GROUP, registrations: {} })))
    expect(res).toEqual({ registrations: [], message: 'No upcoming event registrations found for this person.' })
  })
})

describe('cancel_event_registration / reschedule_event_wave ownership spans the person group', () => {
  it('cancel is accepted for a SIBLING-owned registration', async () => {
    const trace = []
    const registrations = {
      'reg-sib': {
        id: 'reg-sib', status: 'confirmed', contact_id: 'c-2', wave_id: 'w-1',
        race_events: { id: 'race-1', name: 'Hyrox Sim', race_date: '2099-06-20', location_id: 'loc-1' },
      },
    }
    const res = await executeEventTool('cancel_event_registration', { registration_id: 'reg-sib' },
      ctx(stubDb(trace, { contacts: GROUP, registrations, payments: {} })))

    expect(res).toMatchObject({ cancelled: true })
    expect(trace.some((t) => t.step === 'update' && t.table === 'race_registrations' && t.patch.status === 'cancelled')).toBe(true)
  })

  it('reschedule is accepted for a SIBLING-owned registration', async () => {
    const trace = []
    const registrations = {
      'reg-sib': {
        id: 'reg-sib', status: 'confirmed', contact_id: 'c-2', wave_id: 'w-1', race_event_id: 'race-1',
        race_events: { id: 'race-1', name: 'Hyrox Sim', race_date: '2099-06-20', location_id: 'loc-1' },
      },
    }
    const waves = { 'w-2': { id: 'w-2', race_event_id: 'race-1', capacity: null } }
    const res = await executeEventTool('reschedule_event_wave', { registration_id: 'reg-sib', new_wave_id: 'w-2' },
      ctx(stubDb(trace, { contacts: GROUP, registrations, waves })))

    expect(res).toMatchObject({ rescheduled: true, event_name: 'Hyrox Sim' })
  })

  it('a registration owned by neither the acting contact nor any sibling is refused (not_yours)', async () => {
    const trace = []
    const registrations = {
      'reg-other': {
        id: 'reg-other', status: 'confirmed', contact_id: 'c-9', wave_id: 'w-1',
        race_events: { id: 'race-1', name: 'Hyrox Sim', race_date: '2099-06-20', location_id: 'loc-1' },
      },
    }
    const res = await executeEventTool('cancel_event_registration', { registration_id: 'reg-other' },
      ctx(stubDb(trace, { contacts: GROUP, registrations })))
    expect(res).toEqual({ error: 'not_yours', message: 'That registration belongs to someone else — hand off to the team.' })
  })

  it('readFailed → single-contact fallback refuses a SIBLING-owned cancellation', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const trace = []
    const registrations = {
      'reg-sib': {
        id: 'reg-sib', status: 'confirmed', contact_id: 'c-2', wave_id: 'w-1',
        race_events: { id: 'race-1', name: 'Hyrox Sim', race_date: '2099-06-20', location_id: 'loc-1' },
      },
    }
    const db = stubDb(trace, { contacts: GROUP, registrations, groupReadError: { message: 'group lookup down' } })
    const res = await executeEventTool('cancel_event_registration', { registration_id: 'reg-sib' }, ctx(db))
    expect(res).toEqual({ error: 'not_yours', message: 'That registration belongs to someone else — hand off to the team.' })
    err.mockRestore()
  })

  it('readFailed → single-contact fallback refuses a SIBLING-owned reschedule', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const trace = []
    const registrations = {
      'reg-sib': {
        id: 'reg-sib', status: 'confirmed', contact_id: 'c-2', wave_id: 'w-1', race_event_id: 'race-1',
        race_events: { id: 'race-1', name: 'Hyrox Sim', race_date: '2099-06-20', location_id: 'loc-1' },
      },
    }
    const db = stubDb(trace, { contacts: GROUP, registrations, groupReadError: { message: 'group lookup down' } })
    const res = await executeEventTool('reschedule_event_wave', { registration_id: 'reg-sib', new_wave_id: 'w-2' }, ctx(db))
    expect(res).toEqual({ error: 'not_yours', message: 'That registration belongs to someone else — hand off to the team.' })
    err.mockRestore()
  })

  it('readFailed → single-contact fallback still accepts the ACTING contact\'s own registration', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const trace = []
    const registrations = {
      'reg-own': {
        id: 'reg-own', status: 'confirmed', contact_id: 'c-1', wave_id: 'w-1',
        race_events: { id: 'race-1', name: 'Hyrox Sim', race_date: '2099-06-20', location_id: 'loc-1' },
      },
    }
    const db = stubDb(trace, { contacts: GROUP, registrations, groupReadError: { message: 'group lookup down' } })
    const res = await executeEventTool('cancel_event_registration', { registration_id: 'reg-own' }, ctx(db))
    expect(res).toMatchObject({ cancelled: true })
    err.mockRestore()
  })

  // Quality-review pin: `contact_id` drives the widened ownership predicate
  // (`ownerIds.includes(reg.contact_id)`) — a future editor trimming it off
  // this select would make every sibling-owned lookup silently read
  // `undefined`, which never `.includes()`-matches anything, and every test
  // above would still pass against a double that ignores its select
  // argument. Pin the column list itself.
  it('the registration-lookup select includes contact_id (pins the ownership-predicate column)', async () => {
    const trace = []
    const registrations = {
      'reg-sib': {
        id: 'reg-sib', status: 'confirmed', contact_id: 'c-2', wave_id: 'w-1',
        race_events: { id: 'race-1', name: 'Hyrox Sim', race_date: '2099-06-20', location_id: 'loc-1' },
      },
    }
    await executeEventTool('cancel_event_registration', { registration_id: 'reg-sib' },
      ctx(stubDb(trace, { contacts: GROUP, registrations })))
    const sel = trace.find((t) => t.step === 'select' && t.table === 'race_registrations' && String(t.cols).includes('race_events!inner'))
    expect(sel).toBeTruthy()
    expect(sel.cols).toContain('contact_id')
  })
})

describe('book_event member gate spans the person group', () => {
  const memberRace = { ...FUTURE_RACE, member_pricing_enabled: true, member_fee_cents: null, non_member_fee_cents: 3500 }
  const membersOnlyRace = { ...FUTURE_RACE, members_only: true }

  it('a SIBLING with a genuinely bookable membership (member/active) satisfies the gate', async () => {
    const trace = []
    await executeEventTool('book_event', { event_id: 'race-1' },
      ctx(stubDb(trace, { contacts: GROUP, raceEvent: memberRace })))

    expect(raceRegisterSolo.registerSoloEventEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberOverride: true }),
    )
  })

  it('a SIBLING who is classpass_payg does NOT satisfy the gate', async () => {
    const trace = []
    const group = [GROUP[0], { ...GROUP[1], glofox_membership_status: 'classpass_payg' }]
    await executeEventTool('book_event', { event_id: 'race-1' },
      ctx(stubDb(trace, { contacts: group, raceEvent: memberRace })))

    expect(raceRegisterSolo.registerSoloEventEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberOverride: false }),
    )
  })

  it('a SIBLING who is trial does NOT satisfy the gate', async () => {
    const trace = []
    const group = [GROUP[0], { ...GROUP[1], glofox_membership_status: 'trial', glofox_membership_state: null, trial_credits_remaining: 3 }]
    await executeEventTool('book_event', { event_id: 'race-1' },
      ctx(stubDb(trace, { contacts: group, raceEvent: memberRace })))

    expect(raceRegisterSolo.registerSoloEventEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberOverride: false }),
    )
  })

  it('members-only events use the same group-wide gate', async () => {
    const trace = []
    await executeEventTool('book_event', { event_id: 'race-1' },
      ctx(stubDb(trace, { contacts: GROUP, raceEvent: membersOnlyRace })))

    expect(raceRegisterSolo.registerSoloEventEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberOverride: true }),
    )
  })

  it('readFailed from linkedAccountsForContact → no override (unchanged single-contact/email behaviour)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const trace = []
    const db = stubDb(trace, { contacts: GROUP, raceEvent: memberRace, groupReadError: { message: 'group lookup down' } })
    await executeEventTool('book_event', { event_id: 'race-1' }, ctx(db))

    expect(raceRegisterSolo.registerSoloEventEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberOverride: false }),
    )
    err.mockRestore()
  })

  it('a free, non-members-only event never even checks the group (no override needed)', async () => {
    const trace = []
    await executeEventTool('book_event', { event_id: 'race-1' },
      ctx(stubDb(trace, { contacts: GROUP, raceEvent: FUTURE_RACE })))

    expect(raceRegisterSolo.registerSoloEventEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberOverride: false }),
    )
  })
})
