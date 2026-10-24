// ENTRYPOLICY.1 — Mia's event tools under the per-event entry policy:
//   • cancel_event_registration / reschedule_event_wave answer a HAND-OFF
//     (never a cancel, never a draft request) when the switch is off or the
//     cutoff has passed, carrying the operator's own sentence;
//   • list_event_move_options / move_event_entry refuse the same way;
//   • list_upcoming_events' full/limited flags stop counting a lapsed unpaid
//     entry; get_my_event_registrations labels one `lapsed`.
// Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/person-accounts', () => ({
  linkedAccountsForContact: vi.fn(async () => ({ readFailed: false, contacts: [{ id: 'c-1' }] })),
  hasBookableMembership: vi.fn(() => false),
}))
vi.mock('@/lib/race-cancel', () => ({
  registrationPaidCents: vi.fn(async () => 0),
  cancelRaceRegistration: vi.fn(async () => ({ ok: true })),
  moveRegistrationWave: vi.fn(async () => ({ ok: true })),
}))
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))
vi.mock('@/lib/registration-move', () => ({ listMoveTargets: vi.fn(async () => ({ ok: true, entry: { headcount: 1 }, source: {}, targets: [] })), moveRegistration: vi.fn() }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://crm.test') }))

import { registrationPaidCents, cancelRaceRegistration, moveRegistrationWave } from '@/lib/race-cancel'
import { notifyAgentApprovalRequest } from './approval-notify'
import { executeEventTool, shapeMyRegistrationsForAgent } from './event-tools'

const LOC = 'a0000000-0000-0000-0000-0000000000a1'
const REG = 'd0000000-0000-0000-0000-000000000001'
const NOW = Date.parse('2026-10-24T12:00:00Z')

// A race the day after tomorrow at 09:00 Dublin: inside the default 48 h cutoff.
const soon = (entry_policy = null) => ({
  id: REG, status: 'confirmed', contact_id: 'c-1', wave_id: 'w-1',
  race_events: { id: 'e-1', name: 'Hyrox Sim', race_date: '2026-10-26', location_id: LOC, entry_policy },
  race_waves: { start_time: '09:00:00' },
})
// A race in two weeks: outside any default cutoff.
const later = (entry_policy = null) => ({ ...soon(entry_policy), race_events: { ...soon(entry_policy).race_events, race_date: '2026-11-07' } })

function db({ reg = null, events = [], regs = [], myRows = [] } = {}) {
  const inserts = []
  return {
    inserts,
    from(table) {
      const st = { ops: [] }
      const b = {}
      for (const n of ['select', 'eq', 'in', 'gte', 'not', 'order', 'limit']) b[n] = (...a) => { st.ops.push([n, ...a]); return b }
      b.insert = (row) => { inserts.push({ table, row }); return b }
      b.update = () => b
      b.single = async () => ({ data: { id: 'req-1' }, error: null })
      b.maybeSingle = async () => ({ data: table === 'race_registrations' ? reg : null, error: null })
      b.then = (res, rej) => Promise.resolve({
        data: table === 'race_events' ? events : table === 'race_registrations' ? (st.ops.some((o) => o[0] === 'in' && o[1] === 'wave_id') ? regs : myRows) : [],
        error: null,
      }).then(res, rej)
      return b
    },
  }
}
const ctx = (d) => ({ db: d, locationId: LOC, contactId: 'c-1', verifiedContactId: 'c-1', channel: 'whatsapp', zone: 'Europe/Dublin', settings: { booking_mode: 'auto' } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})

describe('cancel_event_registration under the entry policy', () => {
  it('inside the cutoff: a hand-off with the operator copy; nothing cancelled, nothing filed', async () => {
    const d = db({ reg: soon() })
    const res = await executeEventTool('cancel_event_registration', { registration_id: REG }, ctx(d))
    expect(res).toMatchObject({ cancelled: false, handoff: true, reason: 'cutoff' })
    expect(res.customer_message).toBe('Changes to entries for Hyrox Sim close 48 hours before the start time. The team can still help: get in touch with the studio.')
    expect(res.message).toMatch(/hand off to the team/i)
    expect(res.message).toMatch(/do not file a request/i)
    expect(cancelRaceRegistration).not.toHaveBeenCalled()
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
    expect(d.inserts).toHaveLength(0)
    expect(res.requested).toBeUndefined()
  })
  it('switched off: the same hand-off even for a PAID entry (never a draft approval)', async () => {
    registrationPaidCents.mockResolvedValueOnce(4500)
    const d = db({ reg: later({ self_cancel_enabled: false, disabled_message: 'Ring us about {{event_name}}.' }) })
    const res = await executeEventTool('cancel_event_registration', { registration_id: REG }, ctx(d))
    expect(res).toMatchObject({ cancelled: false, handoff: true, reason: 'disabled', customer_message: 'Ring us about Hyrox Sim.' })
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
    expect(d.inserts).toHaveLength(0)
  })
  it('allowed: a free entry outside the cutoff still cancels directly', async () => {
    const res = await executeEventTool('cancel_event_registration', { registration_id: REG }, ctx(db({ reg: later() })))
    expect(res.cancelled).toBe(true)
    expect(cancelRaceRegistration).toHaveBeenCalledTimes(1)
  })
  it('cutoff_hours 0 lets a free entry cancel on the eve of the race', async () => {
    const res = await executeEventTool('cancel_event_registration', { registration_id: REG }, ctx(db({ reg: soon({ cutoff_hours: 0 }) })))
    expect(res.cancelled).toBe(true)
  })
  it('an already-cancelled entry is still answered warmly, policy or not', async () => {
    const res = await executeEventTool('cancel_event_registration', { registration_id: REG }, ctx(db({ reg: { ...soon(), status: 'cancelled' } })))
    expect(res.cancelled).toBe(true)
    expect(res.handoff).toBeUndefined()
  })
  it("someone else's entry is not_yours before any policy answer", async () => {
    const res = await executeEventTool('cancel_event_registration', { registration_id: REG }, ctx(db({ reg: { ...soon(), contact_id: 'c-x' } })))
    expect(res.error).toBe('not_yours')
  })
})

describe('reschedule_event_wave under the entry policy', () => {
  it('switched off: hand-off, no move', async () => {
    const res = await executeEventTool('reschedule_event_wave', { registration_id: REG, new_wave_id: 'w-2' }, ctx(db({ reg: later({ self_reschedule_enabled: false }) })))
    expect(res).toMatchObject({ rescheduled: false, handoff: true, reason: 'disabled' })
    expect(res.customer_message).toMatch(/handled by the team/)
    expect(moveRegistrationWave).not.toHaveBeenCalled()
  })
  it('inside the cutoff: hand-off, no move; the cancel switch does not matter here', async () => {
    const res = await executeEventTool('reschedule_event_wave', { registration_id: REG, new_wave_id: 'w-2' }, ctx(db({ reg: soon({ self_cancel_enabled: false }) })))
    expect(res).toMatchObject({ rescheduled: false, handoff: true, reason: 'cutoff' })
    expect(moveRegistrationWave).not.toHaveBeenCalled()
  })
  it('allowed: moves as before', async () => {
    const res = await executeEventTool('reschedule_event_wave', { registration_id: REG, new_wave_id: 'w-2' }, ctx(db({ reg: later() })))
    expect(res.rescheduled).toBe(true)
    expect(moveRegistrationWave).toHaveBeenCalledWith(expect.anything(), REG, 'w-2')
  })
})

describe('list_event_move_options / move_event_entry under the entry policy', () => {
  for (const tool of ['list_event_move_options', 'move_event_entry']) {
    it(`${tool}: a move is a reschedule, so the switch and the cutoff hand off`, async () => {
      const off = await executeEventTool(tool, { registration_id: REG, target_event_id: 'e-2' }, ctx(db({ reg: later({ self_reschedule_enabled: false }) })))
      expect(off).toMatchObject({ requested: false, handoff: true, reason: 'disabled' })
      const { listMoveTargets } = await import('@/lib/registration-move')
      expect(listMoveTargets).not.toHaveBeenCalled()
      const late = await executeEventTool(tool, { registration_id: REG, target_event_id: 'e-2' }, ctx(db({ reg: soon() })))
      expect(late).toMatchObject({ requested: false, handoff: true, reason: 'cutoff' })
      expect(late.customer_message).toMatch(/48 hours/)
    })
  }
})

describe('list_upcoming_events: a lapsed unpaid entry frees its place', () => {
  const event = (entry_policy = null) => ({
    id: 'e-1', name: 'Hyrox Sim', kind: 'race', slug: 'hyrox', description: '', race_date: '2026-11-07', active: true, capacity_mode: 'people', entry_policy,
    registration_opens_at: null, registration_closes_at: null, member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: null, members_only: false,
    waves: [{ id: 'w-1', start_time: '09:00:00', capacity: 2, label: null }],
  })
  it('a fresh checkout still fills the wave; a lapsed one does not', async () => {
    const fresh = [{ wave_id: 'w-1', status: 'confirmed', registered_at: '2026-10-01T00:00:00Z' }, { wave_id: 'w-1', status: 'pending_payment', registered_at: '2026-10-24T11:00:00Z' }]
    const full = await executeEventTool('list_upcoming_events', {}, ctx(db({ events: [event()], regs: fresh })))
    expect(full.events[0].waves[0].full).toBe(true)
    const stale = [{ wave_id: 'w-1', status: 'confirmed', registered_at: '2026-10-01T00:00:00Z' }, { wave_id: 'w-1', status: 'pending_payment', registered_at: '2026-10-20T11:00:00Z' }]
    const open = await executeEventTool('list_upcoming_events', {}, ctx(db({ events: [event()], regs: stale })))
    expect(open.events[0].waves[0].full).toBeUndefined()
    expect(open.events[0].waves[0].limited).toBe(true)
  })
  it("the hold is the EVENT's: a 120 h hold keeps a 4-day-old checkout counting", async () => {
    const stale = [{ wave_id: 'w-1', status: 'confirmed', registered_at: '2026-10-01T00:00:00Z' }, { wave_id: 'w-1', status: 'pending_payment', registered_at: '2026-10-20T11:00:00Z' }]
    const res = await executeEventTool('list_upcoming_events', {}, ctx(db({ events: [event({ unpaid_hold_hours: 120 })], regs: stale })))
    expect(res.events[0].waves[0].full).toBe(true)
  })
})

describe('get_my_event_registrations labels a lapsed unpaid entry', () => {
  it('shapeMyRegistrationsForAgent: lapsed past the hold, pending_payment inside it', () => {
    const row = (registered_at, entry_policy = null) => ({
      id: 'r1', status: 'pending_payment', registered_at,
      race_events: { name: 'Hyrox Sim', kind: 'race', race_date: '2026-11-07', entry_policy }, race_waves: { start_time: '09:00:00' },
    })
    const [lapsed] = shapeMyRegistrationsForAgent([row('2026-10-20T11:00:00Z')], NOW)
    expect(lapsed.status).toBe('lapsed')
    expect(lapsed.note).toMatch(/register again/i)
    const [fresh] = shapeMyRegistrationsForAgent([row('2026-10-24T11:00:00Z')], NOW)
    expect(fresh.status).toBe('pending_payment')
    expect(fresh.note).toBeUndefined()
    const [longHold] = shapeMyRegistrationsForAgent([row('2026-10-20T11:00:00Z', { unpaid_hold_hours: 240 })], NOW)
    expect(longHold.status).toBe('pending_payment')
  })
  it('the executor reads registered_at and the policy and answers lapsed', async () => {
    const rows = [{ id: 'r1', status: 'pending_payment', registered_at: '2026-10-01T00:00:00Z', race_events: { name: 'Hyrox Sim', kind: 'race', race_date: '2026-11-07', location_id: LOC, entry_policy: null }, race_waves: null }]
    const res = await executeEventTool('get_my_event_registrations', {}, ctx(db({ myRows: rows })))
    expect(res.registrations[0].status).toBe('lapsed')
  })
})
