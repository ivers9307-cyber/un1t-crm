// MIAHATCH.5 Task 18 — approving Mia's Hatch Street class_booking /
// class_cancellation cards: the account guard, D's executor (mocked by its
// real module path), and the one in-thread confirmation. Nothing here calls
// un1t.online. Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ execute: null }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/un1t-online-approval-execute', async () => {
  const { fakeUn1tWrite } = await import('./un1t-fakes.test-helpers')
  const w = fakeUn1tWrite({ executeUn1tApproval: vi.fn() })
  h.execute = w.fns.executeUn1tApproval
  return w['@/lib/un1t-online-approval-execute']()
})
vi.mock('@/lib/agent/notify', () => ({
  sendAgentThreadMessage: vi.fn(async () => ({ sent: true })),
  buildBookingConfirmationText: vi.fn(({ className, classTime }) => `Booked ${className} ${classTime}`),
  buildCancellationConfirmationText: vi.fn(({ className, classTime }) => `Cancelled ${className} ${classTime}`),
  agentConfirmationTemplates: vi.fn(async () => ({ booking: 'TPL booking', cancellation: 'TPL cancel' })),
}))

import { sendAgentThreadMessage, buildBookingConfirmationText, buildCancellationConfirmationText } from '@/lib/agent/notify'
import { logWarn } from '@/lib/log'
import { executeMiaUn1tCard, isMiaUn1tCard } from './un1t-approval-branch'

const LOC = 'loc-hatch-test'
const future = new Date(Date.now() + 86_400_000).toISOString()

const BOOK = (over = {}) => ({
  provider: 'un1t_online', origin: 'mia', reason: 'mia_booking', event_id: 'ev-1', un1t_user_id: 'u-1',
  executing_contact_id: 'c-1', starts_at: future, class_name: 'RALLY', class_time: 'Tue 20 Oct, 7:00am', ...over,
})
const CANCEL = (over = {}) => ({
  provider: 'un1t_online', origin: 'mia', reason: 'mia_cancellation', booking_id: 'bk-1', un1t_user_id: 'u-1',
  executing_contact_id: 'c-1', starts_at: future, class_name: 'RALLY', class_time: 'Tue 20 Oct, 7:00am', ...over,
})
const ROW = (kind, details, over = {}) => ({
  id: 'r-1', location_id: LOC, kind, status: 'approved', contact_id: 'c-1', channel: 'whatsapp', conversation_id: 'conv-1', details, ...over,
})

// A table-driven fake: contacts / locations / un1t_clients answer as set.
function fakeDb({ contact = { id: 'c-1', email: 'member@example.test', un1t_user_id: 'u-1' }, clients = ['u-1'], siblings = [], fail = {} } = {}) {
  const reads = []
  return {
    reads,
    from(table) {
      reads.push(table)
      const answer = () => {
        if (fail[table]) return { data: null, error: { code: 'XX000', message: 'down' } }
        if (table === 'locations') return { data: { id: LOC, name: 'Hatch', organization_id: 'org-1', membership_source: 'un1t_online', settings: {} }, error: null }
        if (table === 'contacts') return { data: contact, error: null }
        if (table === 'un1t_clients') return { data: clients.map((id) => ({ un1t_user_id: id })), error: null }
        return { data: null, error: null }
      }
      const many = () => {
        if (fail[table]) return { data: null, error: { code: 'XX000', message: 'down' } }
        if (table === 'contacts') return { data: siblings, error: null }
        return answer()
      }
      const b = {
        select: () => b, eq: () => b, in: () => b, ilike: () => b, neq: () => b, not: () => b, limit: () => b,
        maybeSingle: async () => answer(),
        then: (ok, bad) => Promise.resolve(many()).then(ok, bad),
      }
      return b
    },
  }
}

const ACTIONED = (extra = {}) => ({ finalStatus: 'actioned', details: { result: { ok: true } }, executed: { ok: true, verdict: 'done', un1t_booking_id: 'bk-9', ...extra }, customerNotified: null })

beforeEach(() => {
  vi.clearAllMocks()
  h.execute.mockImplementation(async (_db, { row }) => ({ ...ACTIONED(), details: { ...row.details, result: { ok: true, verdict: 'done' } } }))
})

describe('isMiaUn1tCard', () => {
  it('is a un1t.online card filed by Mia only', () => {
    expect(isMiaUn1tCard(BOOK())).toBe(true)
    expect(isMiaUn1tCard(BOOK({ origin: undefined }))).toBe(false)
    expect(isMiaUn1tCard({ provider: 'un1t_online', source: 'start_funnel' })).toBe(false)
    expect(isMiaUn1tCard({ origin: 'mia' })).toBe(false)
    expect(isMiaUn1tCard(null)).toBe(false)
  })
})

describe('executeMiaUn1tCard', () => {
  it("Mia un1t card goes to D's executeUn1tApproval with the approver as actor, and sends no email", async () => {
    const db = fakeDb()
    const r = await executeMiaUn1tCard(db, { row: ROW('class_booking', BOOK()), details: BOOK(), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(h.execute).toHaveBeenCalledOnce()
    const [, args, deps] = h.execute.mock.calls[0]
    expect(args.actor).toEqual({ id: 'staff-1' })
    expect(args.row.details).toMatchObject({ event_id: 'ev-1', origin: 'mia' })
    // R4: step 7 (the set-password and booking confirmation emails) is replaced.
    expect(typeof deps.afterBooking).toBe('function')
    expect(await deps.afterBooking()).toEqual({})
    expect(r.finalStatus).toBe('actioned')
    expect(r.executed).toMatchObject({ ok: true })
  })

  it('ACCOUNT_MISMATCH refuses and lands failed: the contact now holds another account', async () => {
    const db = fakeDb({ contact: { id: 'c-1', email: 'member@example.test', un1t_user_id: 'u-2' }, clients: ['u-2'] })
    const r = await executeMiaUn1tCard(db, { row: ROW('class_booking', BOOK()), details: BOOK(), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(h.execute).not.toHaveBeenCalled()
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    expect(r.finalStatus).toBe('failed')
    expect(r.executed).toMatchObject({ ok: false, message_code: 'ACCOUNT_MISMATCH' })
    expect(r.details.result).toEqual(r.executed)
  })

  it('ACCOUNT_MISMATCH when the mirror no longer resolves any account for the contact (never an API walk)', async () => {
    const db = fakeDb({ contact: { id: 'c-1', email: 'member@example.test', un1t_user_id: null }, clients: [] })
    const r = await executeMiaUn1tCard(db, { row: ROW('class_cancellation', CANCEL()), details: CANCEL(), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(h.execute).not.toHaveBeenCalled()
    expect(r.finalStatus).toBe('failed')
    expect(r.executed.message_code).toBe('ACCOUNT_MISMATCH')
  })

  it('a same-email sibling holding the card account passes the guard (D resolves it the same way)', async () => {
    const db = fakeDb({ contact: { id: 'c-1', email: 'member@example.test', un1t_user_id: null }, clients: ['u-1'], siblings: [{ id: 'c-2', email: 'member@example.test', un1t_user_id: 'u-1' }] })
    const r = await executeMiaUn1tCard(db, { row: ROW('class_booking', BOOK()), details: BOOK(), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(h.execute).toHaveBeenCalledOnce()
    expect(r.finalStatus).toBe('actioned')
  })

  it('an unreadable account fails closed with its own code, nothing called', async () => {
    for (const fail of [{ un1t_clients: true }, { contacts: true }, { locations: true }]) {
      vi.clearAllMocks()
      const r = await executeMiaUn1tCard(fakeDb({ fail }), { row: ROW('class_booking', BOOK()), details: BOOK(), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
      expect(h.execute).not.toHaveBeenCalled()
      expect(r.finalStatus).toBe('failed')
      expect(r.executed.message_code).toBe('UN1T_ACCOUNT_UNREADABLE')
      expect(logWarn).toHaveBeenCalledWith('mia-un1t', 'approval account read failed', expect.objectContaining({ locationId: LOC, status: null }))
    }
  })

  it('a card naming no account fails closed as a mismatch', async () => {
    const d = BOOK({ un1t_user_id: null })
    const r = await executeMiaUn1tCard(fakeDb(), { row: ROW('class_booking', d), details: d, actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(h.execute).not.toHaveBeenCalled()
    expect(r.executed.message_code).toBe('ACCOUNT_MISMATCH')
  })

  it('past start -> expired, no call, no message', async () => {
    const d = { ...BOOK(), result: { ok: false, reason: 'CLASS_ALREADY_STARTED' } }
    const db = fakeDb()
    const r = await executeMiaUn1tCard(db, { row: ROW('class_booking', d), details: d, actor: { id: 'staff-1' }, expiredBeforeExecution: true })
    expect(r).toMatchObject({ finalStatus: 'expired', executed: { ok: false, reason: 'CLASS_ALREADY_STARTED' } })
    expect(h.execute).not.toHaveBeenCalled()
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    expect(db.reads).toEqual([])
  })

  it('confirmation sent in-thread once on actioned (booking text, operator template)', async () => {
    const r = await executeMiaUn1tCard(fakeDb(), { row: ROW('class_booking', BOOK()), details: BOOK(), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
    expect(sendAgentThreadMessage.mock.calls[0][1]).toEqual({ channel: 'whatsapp', conversationId: 'conv-1', text: 'Booked RALLY Tue 20 Oct, 7:00am' })
    expect(buildBookingConfirmationText).toHaveBeenCalledWith({ className: 'RALLY', classTime: 'Tue 20 Oct, 7:00am', template: 'TPL booking' })
    expect(r.details.confirmation).toEqual({ sent: true })
    expect(r.customerNotified).toEqual({ sent: true, channel: 'whatsapp' })
  })

  it('a cancellation is confirmed with the cancellation text', async () => {
    await executeMiaUn1tCard(fakeDb(), { row: ROW('class_cancellation', CANCEL()), details: CANCEL(), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(h.execute.mock.calls[0][1].row.kind).toBe('class_cancellation')
    expect(buildCancellationConfirmationText).toHaveBeenCalledWith({ className: 'RALLY', classTime: 'Tue 20 Oct, 7:00am', template: 'TPL cancel' })
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
  })

  it('window_closed recorded on the card, the card stays actioned', async () => {
    sendAgentThreadMessage.mockResolvedValueOnce({ sent: false, reason: 'window_closed' })
    const r = await executeMiaUn1tCard(fakeDb(), { row: ROW('class_booking', BOOK()), details: BOOK(), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
    expect(r.finalStatus).toBe('actioned')
    expect(r.details.confirmation).toEqual({ sent: false, reason: 'window_closed' })
    expect(r.customerNotified).toEqual({ sent: false, channel: 'whatsapp', reason: 'window_closed' })
  })

  it('a send that throws never flips the card', async () => {
    sendAgentThreadMessage.mockRejectedValueOnce(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await executeMiaUn1tCard(fakeDb(), { row: ROW('class_booking', BOOK()), details: BOOK(), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    warn.mockRestore()
    expect(r.finalStatus).toBe('actioned')
    expect(r.details.confirmation).toEqual({ sent: false, reason: 'send_error' })
  })

  it('a failed or record-only execution, or a card with no thread, sends nothing', async () => {
    h.execute.mockResolvedValueOnce({ finalStatus: 'failed', details: { result: { ok: false } }, executed: { ok: false, code: 'X' }, customerNotified: null })
    let r = await executeMiaUn1tCard(fakeDb(), { row: ROW('class_booking', BOOK()), details: BOOK(), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(r.finalStatus).toBe('failed')
    h.execute.mockResolvedValueOnce({ finalStatus: 'actioned', details: { result: { ok: true, record_only: true } }, executed: { ok: true, record_only: true }, customerNotified: null })
    r = await executeMiaUn1tCard(fakeDb(), { row: ROW('class_booking', BOOK({ reason: 'account_ambiguous' })), details: BOOK({ reason: 'account_ambiguous' }), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(r.executed.record_only).toBe(true)
    r = await executeMiaUn1tCard(fakeDb(), { row: ROW('class_booking', BOOK(), { conversation_id: null }), details: BOOK(), actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(r.finalStatus).toBe('actioned')
    expect(r.details.confirmation).toBeUndefined()
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })

  it('a record-only booking reason records without the account guard', async () => {
    h.execute.mockResolvedValueOnce({ finalStatus: 'actioned', details: { result: { ok: true, record_only: true } }, executed: { ok: true, record_only: true }, customerNotified: null })
    const d = BOOK({ reason: 'account_ambiguous' })
    const db = fakeDb({ contact: { id: 'c-1', email: null, un1t_user_id: 'u-2' }, clients: ['u-2'] })
    const r = await executeMiaUn1tCard(db, { row: ROW('class_booking', d), details: d, actor: { id: 'staff-1' }, expiredBeforeExecution: false })
    expect(h.execute).toHaveBeenCalledOnce()
    expect(r.executed.record_only).toBe(true)
    expect(db.reads).toEqual([])
  })
})
