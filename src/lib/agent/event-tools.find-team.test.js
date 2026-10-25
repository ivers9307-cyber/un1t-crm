// FINDTEAM.8 — Mia and the "placed" status: a placed solo is handed off, a team
// that solos were placed into goes to review when the solos paid, and the
// wave counts behind the full/limited flags skip placed rows and (in teams
// mode) unplaced solos.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb, eqOf } from '@/lib/event-waitlist.test-helpers'

vi.mock('@/lib/person-accounts', () => ({
  linkedAccountsForContact: vi.fn(async () => ({ contacts: [{ id: 'c-1' }], readFailed: false })),
  hasBookableMembership: vi.fn(() => false),
}))
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn() }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://un1t.test') }))

const { executeEventTool, classifyEventCancellation } = await import('./event-tools')

const now = Date.parse('2026-06-10T10:00:00Z')
const ctx = (db) => ({ db, conversationId: 'conv-1', contactId: 'c-1', verifiedContactId: 'c-1', locationId: 'loc-1', channel: 'whatsapp', nameHint: 'Anchor' })
const RACE = { id: 'race-1', name: 'Hatch Relay', race_date: '2099-06-20', location_id: 'loc-1' }

describe('classifyEventCancellation — placed', () => {
  it('hands a placed row off (no action)', () => {
    expect(classifyEventCancellation({ isOwner: true, status: 'placed', eventDate: '2026-06-20', paidCents: 0, nowMs: now }))
      .toEqual({ action: null, reason: 'placed' })
  })
})

function cancelDb({ reg, placedInto = [], pays = {} }) {
  return fakeDb((q) => {
    if (q.table === 'race_registrations' && q.action === 'select') {
      if (eqOf(q, 'placed_into_registration_id')) return { data: placedInto, count: placedInto.length, error: null }
      return { data: reg, error: null }
    }
    if (q.table === 'race_payments') {
      const ids = q.ops.find((o) => o[0] === 'in')?.[2] || []
      return { data: ids.flatMap((id) => pays[id] || []), error: null }
    }
    if (q.table === 'agent_membership_requests') return { data: { id: 'req-1' }, error: null }
    return { data: null, error: null }
  })
}
const cancels = (db) => db.queries.filter((x) => x.table === 'race_registrations' && x.action === 'update')

describe('cancel_event_registration (FINDTEAM.8 I3)', () => {
  it('a placed row is handed off and never cancelled', async () => {
    const db = cancelDb({ reg: { id: 'solo', status: 'placed', contact_id: 'c-1', wave_id: 'w1', race_events: RACE } })
    const res = await executeEventTool('cancel_event_registration', { registration_id: 'solo' }, ctx(db))
    expect(res).toMatchObject({ cancelled: false, reason: 'placed' })
    expect(cancels(db)).toHaveLength(0)
  })

  it('a free team that a PAID solo was placed into goes to review, not a direct cancel', async () => {
    const db = cancelDb({
      reg: { id: 'team', status: 'confirmed', contact_id: 'c-1', wave_id: 'w1', race_events: RACE },
      placedInto: [{ id: 'solo' }],
      pays: { solo: [{ amount_cents: 2000, status: 'completed' }] },
    })
    const res = await executeEventTool('cancel_event_registration', { registration_id: 'team' }, ctx(db))
    expect(res.requested).toBe(true)
    expect(cancels(db)).toHaveLength(0)
    const audit = db.queries.find((x) => x.table === 'agent_membership_requests')
    expect(audit.payload.details).toMatchObject({ paid_cents: 2000, mode: 'draft' })
  })

  // FINDTEAM.9 — the lib refuses a team solos were placed into; Mia inherits it.
  it('a free team that FREE solos were placed into is refused by the lib, never cancelled', async () => {
    const db = cancelDb({
      reg: { id: 'team', status: 'confirmed', contact_id: 'c-1', wave_id: 'w1', race_events: RACE },
      placedInto: [{ id: 'solo' }],
      pays: {},
    })
    const res = await executeEventTool('cancel_event_registration', { registration_id: 'team' }, ctx(db))
    expect(res).toMatchObject({ cancelled: false, reason: 'has_placed_solos' })
    expect(res.message).toMatch(/hand off/)
    expect(cancels(db)).toHaveLength(0)
    const audit = db.queries.find((x) => x.table === 'agent_membership_requests')
    expect(audit.payload.status).toBe('failed')
    expect(audit.payload.details.result).toMatchObject({ ok: false, error: 'has_placed_solos', placedCount: 1 })
  })

  it('an unreadable payment total is never a direct cancel', async () => {
    const db = fakeDb((q) => {
      if (q.table === 'race_registrations' && eqOf(q, 'placed_into_registration_id')) return { data: null, error: { message: 'boom' } }
      if (q.table === 'race_registrations') return { data: { id: 'team', status: 'confirmed', contact_id: 'c-1', wave_id: 'w1', race_events: RACE }, error: null }
      return { data: null, error: null }
    })
    const res = await executeEventTool('cancel_event_registration', { registration_id: 'team' }, ctx(db))
    expect(res).toMatchObject({ cancelled: false, reason: 'payment_unknown' })
    expect(cancels(db)).toHaveLength(0)
  })
})

describe('list_upcoming_events wave counts (FINDTEAM.8 I4)', () => {
  const event = (mode, capacity) => ({
    id: `e-${mode}`, name: 'Relay', kind: 'race', slug: 'relay', race_date: '2099-06-20', active: true, capacity_mode: mode,
    registration_opens_at: null, registration_closes_at: null, member_pricing_enabled: false, member_fee_cents: null,
    non_member_fee_cents: null, members_only: false, waves: [{ id: `w-${mode}`, start_time: '10:00:00', capacity, label: null }],
  })
  const run = async (events, regs) => {
    const db = fakeDb((q) => {
      if (q.table === 'race_events') return { data: events, error: null }
      if (q.table === 'race_registrations') return { data: regs, error: null }
      return { data: null, error: null }
    })
    const res = await executeEventTool('list_upcoming_events', {}, ctx(db))
    return { res, read: db.queries.find((x) => x.table === 'race_registrations') }
  }

  it('reads live statuses and the looking_for_team flag', async () => {
    const { read } = await run([event('teams', 2)], [])
    expect(read.ops).toContainEqual(['in', 'status', ['pending_payment', 'confirmed']])
    expect(read.ops.find((o) => o[0] === 'select')[1]).toContain('looking_for_team')
  })

  it('solos do not fill a teams-mode wave', async () => {
    const regs = [
      { wave_id: 'w-teams', status: 'confirmed', looking_for_team: false },
      { wave_id: 'w-teams', status: 'confirmed', looking_for_team: true },
      { wave_id: 'w-teams', status: 'confirmed', looking_for_team: true },
    ]
    const { res } = await run([event('teams', 2)], regs)
    expect(res.events[0].waves[0].full).toBeUndefined()
    expect(res.events[0].waves[0].limited).toBe(true)
  })

  it('people mode counts a solo', async () => {
    const regs = [
      { wave_id: 'w-people', status: 'confirmed', looking_for_team: false },
      { wave_id: 'w-people', status: 'confirmed', looking_for_team: true },
    ]
    const { res } = await run([event('people', 2)], regs)
    expect(res.events[0].waves[0].full).toBe(true)
  })
})
