// EVENT-MOVE.7 — Mia's move tools: list_event_move_options (read only) and
// move_event_entry (files an approval request, never moves). The move rules
// themselves are listMoveTargets/moveRegistration's (registration-move.js,
// tested there); these tests pin what the AGENT sees and files: the gate
// (verified, owner, confirmed), the customer-safe options shape (no capacity
// or counts of any kind), and the request row.
//
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/registration-move', () => ({ listMoveTargets: vi.fn() }))
vi.mock('@/lib/person-accounts', () => ({
  linkedAccountsForContact: vi.fn(),
  hasBookableMembership: vi.fn(() => false),
}))
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))

import { listMoveTargets } from '@/lib/registration-move'
import { linkedAccountsForContact } from '@/lib/person-accounts'
import { notifyAgentApprovalRequest } from './approval-notify'
import {
  EVENT_TOOLS,
  executeEventTool,
  priceDifferenceSentence,
  shapeMoveOptionsForAgent,
} from './event-tools'

const LOC = 'a0000000-0000-0000-0000-0000000000a1'
const LOC_2 = 'a0000000-0000-0000-0000-0000000000a2'
const ORG = 'b0000000-0000-0000-0000-0000000000b1'
const REG = 'r0000000-0000-0000-0000-000000000001'
const SRC = 'e0000000-0000-0000-0000-0000000000e1'
const TGT = 'e0000000-0000-0000-0000-0000000000e2'
const TGT_FULL = 'e0000000-0000-0000-0000-0000000000e3'
const TGT_NOWAVES = 'e0000000-0000-0000-0000-0000000000e4'
const W_OPEN = 'f0000000-0000-0000-0000-0000000000f1'
const W_FULL = 'f0000000-0000-0000-0000-0000000000f2'
const W_UNCAPPED = 'f0000000-0000-0000-0000-0000000000f3'

const REG_ROW = {
  id: REG, status: 'confirmed', contact_id: 'c-1', wave_id: 'w-src',
  race_events: { id: SRC, name: 'Hyrox Sim', race_date: '2099-10-18', location_id: LOC },
}

function targetsResult({ headcount = 2, targets } = {}) {
  return {
    ok: true,
    entry: { id: REG, status: 'confirmed', label: 'The Crushers', headcount, lead_first_name: 'Ann', member_count: 1, non_member_count: 1, team_id: 't-1' },
    source: { event_id: SRC, event_name: 'Hyrox Sim', race_date: '2099-10-18', wave_id: 'w-src', location_id: LOC },
    targets: targets || [
      {
        id: TGT, name: 'Hyrox Sim', race_date: '2099-10-25', kind: 'race', location_id: LOC, location_name: 'Stillorgan',
        crosses_studio: false, capacity_mode: 'people', price_gap_cents: 1000, currency: 'EUR',
        waves: [
          { id: W_OPEN, start_time: '09:30:00', label: null, capacity: 20, spots_left: 5 },
          { id: W_FULL, start_time: '11:00:00', label: 'Late wave', capacity: 20, spots_left: 1 },
          { id: W_UNCAPPED, start_time: '12:30:00', label: null, capacity: null, spots_left: null },
        ],
      },
      {
        id: TGT_FULL, name: 'Hyrox Sim', race_date: '2099-11-01', kind: 'race', location_id: LOC, location_name: 'Stillorgan',
        crosses_studio: false, capacity_mode: 'people', price_gap_cents: 0, currency: 'EUR',
        waves: [{ id: 'f-x', start_time: '09:00:00', label: null, capacity: 10, spots_left: 0 }],
      },
      {
        id: TGT_NOWAVES, name: 'Open Day', race_date: '2099-11-08', kind: 'open_day', location_id: LOC_2, location_name: 'Hatch',
        crosses_studio: true, capacity_mode: 'teams', price_gap_cents: -500, currency: 'EUR', waves: [],
      },
    ],
  }
}

// A traced stub: records inserts and the filters on the duplicate check.
function stubDb(trace, {
  reg = REG_ROW,
  orgId = ORG,
  orgLocations = [{ id: LOC }, { id: LOC_2 }],
  pendingMove = null,
  insertError = null,
} = {}) {
  return {
    from(table) {
      const st = { table, filters: {}, op: null }
      const settle = (single) => {
        if (table === 'race_registrations') return { data: reg, error: null }
        if (table === 'locations') {
          if (st.filters.id) return { data: { organization_id: orgId }, error: null }
          return { data: orgLocations, error: null }
        }
        if (table === 'agent_membership_requests') {
          if (st.op === 'insert') return insertError ? { data: null, error: insertError } : { data: { id: 'req-1' }, error: null }
          return { data: single ? pendingMove : (pendingMove ? [pendingMove] : []), error: null }
        }
        return { data: single ? null : [], error: null }
      }
      const b = {
        select() { return b },
        eq(col, val) { st.filters[col] = val; trace.push({ step: 'eq', table, col, val }); return b },
        in(col, vals) { st.filters[col] = vals; trace.push({ step: 'in', table, col, vals }); return b },
        limit() { return b },
        order() { return b },
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
  locationId: LOC,
  channel: 'whatsapp',
  nameHint: 'Ann Example',
  settings: { booking_mode: 'auto' },
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  linkedAccountsForContact.mockResolvedValue({ readFailed: false, contacts: [{ id: 'c-1' }, { id: 'c-2' }] })
  listMoveTargets.mockResolvedValue(targetsResult())
})

/** Every key anywhere in a value, recursively. */
function allKeys(value, out = []) {
  if (Array.isArray(value)) { for (const v of value) allKeys(v, out); return out }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); allKeys(v, out) }
  }
  return out
}

describe('the move tools are declared', () => {
  it('both tools exist, after reschedule_event_wave', () => {
    const names = EVENT_TOOLS.map((t) => t.name)
    expect(names).toContain('list_event_move_options')
    expect(names).toContain('move_event_entry')
    expect(names.indexOf('list_event_move_options')).toBeGreaterThan(names.indexOf('reschedule_event_wave'))
  })
  it('descriptions say when to use each, that the move needs approval, and never cancel + rebook', () => {
    const byName = Object.fromEntries(EVENT_TOOLS.map((t) => [t.name, t.description]))
    expect(byName.list_event_move_options).toMatch(/different event|another date|change the date/i)
    expect(byName.list_event_move_options).toMatch(/approval/i)
    expect(byName.move_event_entry).toMatch(/never moves/i)
    expect(byName.move_event_entry).toMatch(/list_event_move_options/)
    expect(byName.reschedule_event_wave).toMatch(/move_event_entry/)
    expect(byName.reschedule_event_wave).not.toMatch(/cancel \+ a new booking/i)
    for (const name of ['list_event_move_options', 'move_event_entry', 'reschedule_event_wave']) {
      expect(byName[name]).not.toMatch(/—/)
    }
  })
})

describe('priceDifferenceSentence', () => {
  it('same price', () => {
    expect(priceDifferenceSentence(0, 1)).toBe('Same price.')
  })
  it('a solo entry: the difference is the person', () => {
    expect(priceDifferenceSentence(1000, 1)).toBe('€10 more.')
    expect(priceDifferenceSentence(-550, 1)).toBe('€5.50 less, not refunded.')
  })
  it('a team: the difference is for the whole entry (members and non-members can differ)', () => {
    expect(priceDifferenceSentence(1000, 2)).toBe('€10 more in total for the entry.')
    expect(priceDifferenceSentence(-500, 3)).toBe('€5 less in total for the entry, not refunded.')
  })
})

describe('shapeMoveOptionsForAgent', () => {
  it('keeps only times this entry fits, drops events with none, keeps an event with no times', () => {
    const { targets } = targetsResult()
    const options = shapeMoveOptionsForAgent(targets, { headcount: 2 })
    expect(options.map((o) => o.event_id)).toEqual([TGT, TGT_NOWAVES])
    expect(options[0]).toEqual({
      event_id: TGT,
      name: 'Hyrox Sim',
      date_label: 'Sun 25 Oct',
      times: [{ wave_id: W_OPEN, label: '09:30' }, { wave_id: W_UNCAPPED, label: '12:30' }],
      price_difference_sentence: '€10 more in total for the entry.',
    })
    expect(options[1].times).toEqual([])
  })
  it('in teams mode an entry takes one place whatever its size', () => {
    const options = shapeMoveOptionsForAgent([{
      id: TGT, name: 'Team Race', race_date: '2099-10-25', capacity_mode: 'teams', price_gap_cents: 0,
      waves: [{ id: W_OPEN, start_time: '09:30:00', label: 'Wave A', capacity: 10, spots_left: 1 }],
    }], { headcount: 4 })
    expect(options[0].times).toEqual([{ wave_id: W_OPEN, label: '09:30 (Wave A)' }])
  })
  it('never carries a capacity, spots or count key', () => {
    const options = shapeMoveOptionsForAgent(targetsResult().targets, { headcount: 2 })
    expect(allKeys(options).filter((k) => /spot|capacity|count|left/i.test(k))).toEqual([])
  })
})

describe('the gate (both tools)', () => {
  for (const tool of ['list_event_move_options', 'move_event_entry']) {
    it(`${tool} refuses an unverified sender`, async () => {
      const res = await executeEventTool(tool, { registration_id: REG, target_event_id: TGT, target_wave_id: W_OPEN },
        ctx(stubDb([]), { verifiedContactId: null }))
      expect(res.error).toBe('not_verified')
      expect(listMoveTargets).not.toHaveBeenCalled()
    })
    it(`${tool} refuses someone else's entry`, async () => {
      const db = stubDb([], { reg: { ...REG_ROW, contact_id: 'c-stranger' } })
      const res = await executeEventTool(tool, { registration_id: REG, target_event_id: TGT, target_wave_id: W_OPEN }, ctx(db))
      expect(res.error).toBe('not_yours')
      expect(listMoveTargets).not.toHaveBeenCalled()
    })
    it(`${tool} accepts an entry on a sibling account of the same person`, async () => {
      const db = stubDb([], { reg: { ...REG_ROW, contact_id: 'c-2' } })
      const res = await executeEventTool(tool, { registration_id: REG, target_event_id: TGT, target_wave_id: W_OPEN }, ctx(db))
      expect(res.error).toBeUndefined()
    })
    it(`${tool} refuses an unpaid entry and says to pay first`, async () => {
      const db = stubDb([], { reg: { ...REG_ROW, status: 'pending_payment' } })
      const res = await executeEventTool(tool, { registration_id: REG, target_event_id: TGT, target_wave_id: W_OPEN }, ctx(db))
      expect(res.error).toBe('not_paid')
      expect(res.message).toMatch(/pay/i)
      expect(listMoveTargets).not.toHaveBeenCalled()
    })
    it(`${tool} refuses a cancelled entry`, async () => {
      const db = stubDb([], { reg: { ...REG_ROW, status: 'cancelled' } })
      const res = await executeEventTool(tool, { registration_id: REG, target_event_id: TGT, target_wave_id: W_OPEN }, ctx(db))
      expect(res.error).toBe('not_active')
    })
    it(`${tool} answers not_found for an entry outside this studio`, async () => {
      const db = stubDb([], { reg: null })
      const res = await executeEventTool(tool, { registration_id: REG, target_event_id: TGT, target_wave_id: W_OPEN }, ctx(db))
      expect(res.error).toBe('not_found')
    })
  }
})

describe('list_event_move_options', () => {
  it('lists the eligible dates, scoped to the studio organisation, with no counts anywhere', async () => {
    const trace = []
    const res = await executeEventTool('list_event_move_options', { registration_id: REG }, ctx(stubDb(trace)))
    expect(listMoveTargets).toHaveBeenCalledWith(expect.anything(), { registrationId: REG, allowedLocationIds: [LOC, LOC_2] })
    expect(res.options.map((o) => o.event_id)).toEqual([TGT, TGT_NOWAVES])
    expect(res.entry).toEqual({ registration_id: REG, event_name: 'Hyrox Sim', date_label: 'Sun 18 Oct' })
    expect(allKeys(res).filter((k) => /spot|capacity|count|left/i.test(k))).toEqual([])
    expect(JSON.stringify(res)).not.toMatch(/—/)
  })
  it('a studio with no organisation offers its own events only', async () => {
    await executeEventTool('list_event_move_options', { registration_id: REG }, ctx(stubDb([], { orgId: null })))
    expect(listMoveTargets).toHaveBeenCalledWith(expect.anything(), { registrationId: REG, allowedLocationIds: [LOC] })
  })
  it('no eligible date: says so, offers nothing', async () => {
    listMoveTargets.mockResolvedValue(targetsResult({ targets: [] }))
    const res = await executeEventTool('list_event_move_options', { registration_id: REG }, ctx(stubDb([])))
    expect(res.options).toEqual([])
    expect(res.message).toMatch(/no other date/i)
  })
  it('a failed read is not "no dates"', async () => {
    listMoveTargets.mockResolvedValue({ ok: false, error: 'load_failed' })
    const res = await executeEventTool('list_event_move_options', { registration_id: REG }, ctx(stubDb([])))
    expect(res.error).toBe('load_failed')
    expect(res.options).toBeUndefined()
  })
})

describe('move_event_entry', () => {
  it('files a pending event_move request and notifies approvals; never moves', async () => {
    const trace = []
    const res = await executeEventTool('move_event_entry',
      { registration_id: REG, target_event_id: TGT, target_wave_id: W_OPEN, note: 'Away that weekend' }, ctx(stubDb(trace)))
    const insert = trace.find((t) => t.step === 'insert')
    expect(insert.table).toBe('agent_membership_requests')
    expect(insert.row).toEqual({
      location_id: LOC,
      contact_id: 'c-1',
      kind: 'event_move',
      channel: 'whatsapp',
      conversation_id: 'conv-1',
      status: 'pending',
      details: {
        registration_id: REG,
        entry_label: 'The Crushers',
        headcount: 2,
        source_event_id: SRC,
        source_event_name: 'Hyrox Sim',
        source_event_date: '2099-10-18',
        target_event_id: TGT,
        target_event_name: 'Hyrox Sim',
        target_event_date: '2099-10-25',
        target_date_label: 'Sun 25 Oct',
        target_wave_id: W_OPEN,
        target_wave_label: '09:30',
        price_gap_cents: 1000,
        currency: 'EUR',
        note: 'Away that weekend',
      },
    })
    expect(notifyAgentApprovalRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      requestId: 'req-1', locationId: LOC, kind: 'event_move', customerName: 'Ann Example',
      summary: 'Move The Crushers from Hyrox Sim (Sun 18 Oct) to Hyrox Sim (Sun 25 Oct, 09:30)',
    }))
    expect(res.requested).toBe(true)
    expect(res.message).toMatch(/with the team/i)
    expect(res.message).toMatch(/never say it is moved/i)
    expect(res.message).toMatch(/link for the difference/i)
    expect(res.message).not.toMatch(/—/)
  })

  it('a cheaper or same-price date never mentions a difference to pay', async () => {
    const res = await executeEventTool('move_event_entry', { registration_id: REG, target_event_id: TGT_NOWAVES }, ctx(stubDb([])))
    expect(res.requested).toBe(true)
    expect(res.message).not.toMatch(/link for the difference/i)
  })

  it('refuses a target that is not among the options (a full date included)', async () => {
    const trace = []
    const res = await executeEventTool('move_event_entry', { registration_id: REG, target_event_id: TGT_FULL, target_wave_id: 'f-x' }, ctx(stubDb(trace)))
    expect(res.error).toBe('not_an_option')
    expect(trace.find((t) => t.step === 'insert')).toBeUndefined()
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
  })

  it('refuses a time that is not offered for the target', async () => {
    const trace = []
    const res = await executeEventTool('move_event_entry', { registration_id: REG, target_event_id: TGT, target_wave_id: W_FULL }, ctx(stubDb(trace)))
    expect(res.error).toBe('not_an_option')
    expect(trace.find((t) => t.step === 'insert')).toBeUndefined()
  })

  it('asks for a time when the target has times and none was given', async () => {
    const trace = []
    const res = await executeEventTool('move_event_entry', { registration_id: REG, target_event_id: TGT }, ctx(stubDb(trace)))
    expect(res.error).toBe('pick_a_time')
    expect(trace.find((t) => t.step === 'insert')).toBeUndefined()
  })

  it('does not file a second request while one for the same entry is pending', async () => {
    const trace = []
    const res = await executeEventTool('move_event_entry', { registration_id: REG, target_event_id: TGT, target_wave_id: W_OPEN },
      ctx(stubDb(trace, { pendingMove: { id: 'req-0' } })))
    expect(res.already_requested).toBe(true)
    expect(trace.find((t) => t.step === 'insert')).toBeUndefined()
    expect(trace).toContainEqual({ step: 'eq', table: 'agent_membership_requests', col: 'details->>registration_id', val: REG })
  })

  it('a request that could not be filed is never reported as with the team', async () => {
    const res = await executeEventTool('move_event_entry', { registration_id: REG, target_event_id: TGT, target_wave_id: W_OPEN },
      ctx(stubDb([], { insertError: { message: 'boom' } })))
    expect(res.requested).toBe(false)
    expect(res.error).toBe('not_filed')
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
  })
})
