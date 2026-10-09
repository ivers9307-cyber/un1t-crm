// EVENT-MOVE.7 — approving Mia's event_move request runs the shared move
// (moveRegistration, mocked here: its rules are tested in
// registration-move.test.js) with the agent as actor and the approving staff
// member named, then tells the customer in-thread. A refusal lands on
// 'failed' with the code kept, and the customer hears a plain reason.
// Decline sends the existing decline notice and moves nothing. Approving
// needs `races` and a manager role at the source AND target studio, judged
// before the claim.
//
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
// Manager at the source (L1) and the target (L2) studio by default.
const MANAGER_BOTH = { id: 'staff-1', full_name: 'Sam Staff', email: 'sam@example.com', profileRole: 'staff', rolesByLocation: { L1: 'manager', L2: 'manager' } }
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => MANAGER_BOTH) }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/registration-move', async (importOriginal) => ({
  ...(await importOriginal()),
  moveRegistration: vi.fn(),
}))
vi.mock('@/lib/agent/notify', async (importOriginal) => ({
  ...(await importOriginal()),
  sendAgentThreadMessage: vi.fn(async () => ({ sent: true })),
  agentConfirmationTemplates: vi.fn(async () => ({})),
}))

import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { moveRegistration } from '@/lib/registration-move'
import { sendAgentThreadMessage, agentConfirmationTemplates } from '@/lib/agent/notify'
import { explainFailure } from '@/lib/approvals/event-move-card'
import { PATCH } from './route.js'

const REG = 'd0000000-0000-0000-0000-000000000001'
const SRC = 'e0000000-0000-0000-0000-0000000000e1'
const TGT = 'e0000000-0000-0000-0000-0000000000e2'
const WAVE = 'f0000000-0000-0000-0000-0000000000f1'

const DETAILS = {
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
  target_wave_id: WAVE,
  target_wave_label: '09:30',
  price_gap_cents: 1000,
  currency: 'EUR',
  note: 'Away that weekend',
}

const ROW = {
  id: 'req-1', location_id: 'L1', kind: 'event_move', status: 'pending', contact_id: 'c1',
  channel: 'whatsapp', conversation_id: 'conv1', details: DETAILS,
}

let updates
function makeDb(row, { registration = null, target = { id: TGT, location_id: 'L2', locations: { name: 'UN1T Hatch Street' } } } = {}) {
  updates = []
  return {
    from(table) {
      let patch = null
      const b = {
        select: () => b, eq: () => b, order: () => b, limit: () => b,
        update(p) { patch = p; updates.push({ table, patch: p }); return b },
        async maybeSingle() {
          if (patch) return { data: { id: row.id }, error: null }
          if (table === 'race_registrations') return { data: registration, error: null }
          if (table === 'race_events') return { data: target, error: null }
          if (table === 'locations') return { data: { name: 'UN1T Stillorgan' }, error: null }
          return { data: row, error: null }
        },
        async single() {
          return { data: { id: row.id, status: patch?.status, decided_at: null, decision_note: null, details: patch?.details }, error: null }
        },
      }
      return b
    },
  }
}

const decide = (body) => PATCH(
  new Request('http://localhost/api/agent/membership-requests/req-1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: 'req-1' }) },
)
const finalUpdate = () => updates.filter((u) => u.table === 'agent_membership_requests').at(-1).patch

beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb(ROW)
})

describe('approve an event_move', () => {
  it('runs moveRegistration as the agent, approved by the staff member, notify on, never forced', async () => {
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv-1' }, registration: { id: REG }, notified: true })
    const res = await decide({ status: 'approved' })
    expect(res.status).toBe(200)
    expect(moveRegistration).toHaveBeenCalledTimes(1)
    expect(moveRegistration.mock.calls[0][1]).toEqual({
      registrationId: REG,
      targetEventId: TGT,
      targetWaveId: WAVE,
      expectedSourceEventId: SRC,
      actor: { type: 'agent', id: null, name: 'Mia, approved by Sam Staff' },
      note: 'Away that weekend',
      notify: true,
      force: false,
    })
  })

  it('names the staff member by email when they have no name', async () => {
    getCurrentUser.mockResolvedValueOnce({ ...MANAGER_BOTH, id: 'staff-2', full_name: null, email: 'pat@example.com' })
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv-1' }, registration: { id: REG }, notified: true })
    await decide({ status: 'approved' })
    expect(moveRegistration.mock.calls[0][1].actor).toEqual({ type: 'agent', id: null, name: 'Mia, approved by pat@example.com' })
  })

  it('a move that went through: actioned, the execution marker closed, the customer told the new date, time and the difference', async () => {
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv-1' }, registration: { id: REG }, notified: true })
    const res = await decide({ status: 'approved' })
    const body = await res.json()
    expect(updates[0].patch.details.execution.stage).toBe('executing')
    const final = finalUpdate()
    expect(final.status).toBe('actioned')
    expect(final.details.result).toEqual({ ok: true, move_id: 'mv-1', notified: true })
    expect(final.details.execution.stage).toBe('done')
    expect(body.executed).toEqual({ ok: true, move_id: 'mv-1', notified: true })
    expect(sendAgentThreadMessage).toHaveBeenCalledTimes(1)
    const sent = sendAgentThreadMessage.mock.calls[0][1]
    expect(sent).toMatchObject({ channel: 'whatsapp', conversationId: 'conv1' })
    expect(sent.text).toBe('Done, your entry is now on Hyrox Sim, Sun 25 Oct at 09:30. New tickets are on their way by email. The team will send a link for the €10 difference.')
  })

  it('no difference line when the new date costs the same or less; no tickets line when the email did not go', async () => {
    db = makeDb({ ...ROW, details: { ...DETAILS, price_gap_cents: -500 } })
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv-1' }, registration: { id: REG }, notified: false })
    await decide({ status: 'approved' })
    expect(sendAgentThreadMessage.mock.calls[0][1].text).toBe('Done, your entry is now on Hyrox Sim, Sun 25 Oct at 09:30.')
  })

  it("uses the operator's confirmation text when set", async () => {
    agentConfirmationTemplates.mockResolvedValueOnce({ eventMove: 'Sorted, see you at {event}.' })
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv-1' }, registration: { id: REG }, notified: true })
    await decide({ status: 'approved' })
    expect(sendAgentThreadMessage.mock.calls[0][1].text).toBe('Sorted, see you at Hyrox Sim, Sun 25 Oct at 09:30. New tickets are on their way by email. The team will send a link for the €10 difference.')
  })

  it('a refusal: failed, the code kept on details.failure, the card explains it, the customer gets a plain reason', async () => {
    moveRegistration.mockResolvedValue({ ok: false, error: 'wave_full', spots_left: 0 })
    const res = await decide({ status: 'approved' })
    const body = await res.json()
    const final = finalUpdate()
    expect(final.status).toBe('failed')
    expect(final.details.failure).toBe('wave_full')
    expect(final.details.result).toEqual({ ok: false, move_error: 'wave_full', message: 'That time is full.' })
    expect(body.executed).toEqual({ ok: false, move_error: 'wave_full', message: 'That time is full.' })
    expect(explainFailure({ status: 'failed', details: final.details })).toMatch(/^The move did not go through: That time is full\./)
    expect(sendAgentThreadMessage).toHaveBeenCalledTimes(1)
    const text = sendAgentThreadMessage.mock.calls[0][1].text
    expect(text).toBe('We could not move your entry: that time is now full. The team will be in touch.')
    // Never a number to the customer.
    expect(text).not.toMatch(/\d+ (spot|place|space)/i)
  })

  it('a retry that fails again does not message the customer a second time', async () => {
    db = makeDb({ ...ROW, status: 'failed', details: { ...DETAILS, failure: 'load_failed', result: { ok: false, move_error: 'load_failed' } } })
    moveRegistration.mockResolvedValue({ ok: false, error: 'load_failed' })
    await decide({ status: 'approved' })
    expect(moveRegistration).toHaveBeenCalledTimes(1)
    expect(finalUpdate().status).toBe('failed')
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })

  it('a retry that succeeds confirms as usual', async () => {
    db = makeDb({ ...ROW, status: 'failed', details: { ...DETAILS, failure: 'load_failed', result: { ok: false, move_error: 'load_failed' } } })
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv-2' }, registration: { id: REG }, notified: true })
    await decide({ status: 'approved' })
    expect(finalUpdate().status).toBe('actioned')
    expect(sendAgentThreadMessage).toHaveBeenCalledTimes(1)
  })
})

describe('who may approve a move', () => {
  it('a manager at the source only: 403 naming the target studio, nothing claimed, nothing moved', async () => {
    getCurrentUser.mockResolvedValueOnce({ ...MANAGER_BOTH, rolesByLocation: { L1: 'manager' } })
    const res = await decide({ status: 'approved' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Approving this move needs a manager at UN1T Hatch Street')
    expect(updates).toEqual([])
    expect(moveRegistration).not.toHaveBeenCalled()
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })
  it('a manager at the target only: 403 naming the source studio', async () => {
    getCurrentUser.mockResolvedValueOnce({ ...MANAGER_BOTH, rolesByLocation: { L2: 'manager' } })
    const res = await decide({ status: 'approved' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Approving this move needs a manager at UN1T Stillorgan')
    expect(updates).toEqual([])
  })
  it('a manager at both without races at the target: 403', async () => {
    hasPermissionForLocation.mockImplementation((_u, loc, key) => !(loc === 'L2' && key === 'races'))
    const res = await decide({ status: 'approved' })
    hasPermissionForLocation.mockImplementation(() => true)
    expect(res.status).toBe(403)
    expect(updates).toEqual([])
  })
  it('a manager at both: proceeds', async () => {
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv-1' }, registration: { id: REG }, notified: true })
    const res = await decide({ status: 'approved' })
    expect(res.status).toBe(200)
    expect(moveRegistration).toHaveBeenCalledTimes(1)
  })
  it('a master: proceeds', async () => {
    getCurrentUser.mockResolvedValueOnce({ id: 'm-1', full_name: 'Rita Master', email: 'r@example.com', profileRole: 'master', rolesByLocation: {} })
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv-1' }, registration: { id: REG }, notified: true })
    const res = await decide({ status: 'approved' })
    expect(res.status).toBe(200)
    expect(moveRegistration.mock.calls[0][1].actor.name).toBe('Mia, approved by Rita Master')
  })
  it('declining needs no manager at the target', async () => {
    getCurrentUser.mockResolvedValueOnce({ ...MANAGER_BOTH, rolesByLocation: { L1: 'manager' } })
    const res = await decide({ status: 'declined' })
    expect(res.status).toBe(200)
    expect(finalUpdate().status).toBe('declined')
  })
  it('under impersonation the master is named: "<master> as <user>"', async () => {
    getCurrentUser.mockResolvedValueOnce({ ...MANAGER_BOTH, impersonatingFrom: { masterId: 'm-1', masterName: 'Rita Master', masterEmail: 'r@example.com' } })
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv-1' }, registration: { id: REG }, notified: true })
    await decide({ status: 'approved' })
    expect(moveRegistration.mock.calls[0][1].actor).toEqual({ type: 'agent', id: null, name: 'Mia, approved by Rita Master as Sam Staff' })
  })
})

describe('a conflict whose entry is already on the target', () => {
  it('is a move that landed (crashed earlier attempt or a hand move): actioned and confirmed, never re-moved', async () => {
    db = makeDb({ ...ROW, status: 'approved', details: { ...DETAILS, execution: { stage: 'executing', started_at: '2000-01-01T00:00:00Z' } } },
      { registration: { race_event_id: TGT, wave_id: WAVE, status: 'confirmed' } })
    moveRegistration.mockResolvedValue({ ok: false, error: 'conflict' })
    await decide({ status: 'approved' })
    const final = finalUpdate()
    expect(final.status).toBe('actioned')
    expect(final.details.result).toEqual({ ok: true, move_id: null, notified: false, recovered: 'already_on_target' })
    expect(sendAgentThreadMessage).toHaveBeenCalledTimes(1)
    expect(sendAgentThreadMessage.mock.calls[0][1].text).toMatch(/^Done, your entry is now on Hyrox Sim, Sun 25 Oct at 09:30\./)
  })
  it('an entry on the target but no longer live (cancelled) is not a move that landed', async () => {
    db = makeDb(ROW, { registration: { race_event_id: TGT, wave_id: WAVE, status: 'cancelled' } })
    moveRegistration.mockResolvedValue({ ok: false, error: 'conflict' })
    await decide({ status: 'approved' })
    expect(finalUpdate().status).toBe('failed')
  })
  it('a conflict with the entry elsewhere stays a failure', async () => {
    db = makeDb(ROW, { registration: { race_event_id: 'e-somewhere-else', wave_id: null } })
    moveRegistration.mockResolvedValue({ ok: false, error: 'conflict' })
    await decide({ status: 'approved' })
    expect(finalUpdate().status).toBe('failed')
    expect(sendAgentThreadMessage.mock.calls[0][1].text).toBe('We could not move your entry: the entry changed in the meantime. The team will be in touch.')
  })
})

describe('decline an event_move', () => {
  it('moves nothing and sends the decline notice', async () => {
    const res = await decide({ status: 'declined' })
    expect(res.status).toBe(200)
    expect(moveRegistration).not.toHaveBeenCalled()
    expect(finalUpdate().status).toBe('declined')
    expect(sendAgentThreadMessage).toHaveBeenCalledTimes(1)
    expect(sendAgentThreadMessage.mock.calls[0][1].text).toMatch(/couldn't complete that request/i)
  })
})
