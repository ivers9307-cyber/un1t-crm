// UN1TWRITE.23 — executeUn1tApproval for un1t.online funnel cards.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { executeUn1tApproval } from './un1t-online-approval-execute'
import { UN1T_RECORD_ONLY_REASONS } from './un1t-online-approval'

let tables
let syncs
function makeDb() {
  return {
    from(table) {
      const q = { op: 'select', payload: null }
      const b = {
        select: () => b, eq: () => b, limit: () => b,
        update: (p) => { q.op = 'update'; q.payload = p; return b },
        maybeSingle: async () => ({ data: (tables[table] || [])[0] ?? null, error: null }),
        then: (ok, no) => {
          if (q.op === 'update' && table === 'class_booking_requests') syncs.push(q.payload)
          return Promise.resolve({ data: null, error: null }).then(ok, no)
        },
      }
      return b
    },
  }
}
const row = (reason, over = {}) => ({
  id: 'amr-1', location_id: 'loc-h', kind: 'class_booking', contact_id: 'c-1', status: 'approved',
  details: { provider: 'un1t_online', reason, event_id: 'un1t:ev-1', class_name: 'RALLY', starts_at: '2099-01-01T08:00:00Z', source: 'start_funnel' },
  ...over,
})
let deps
beforeEach(() => {
  vi.clearAllMocks()
  syncs = []
  tables = {
    contacts: [{ id: 'c-1', organization_id: 'org-1', email: 'jane@example.test', un1t_user_id: 'usr-1' }],
    class_booking_requests: [{ id: 'q-1', location_id: 'loc-h', contact_id: 'c-1', glofox_event_id: 'un1t:ev-1', class_name: 'RALLY', starts_at: '2099-01-01T08:00:00Z', terms_accepted_at: null }],
  }
  deps = {
    writerFactory: vi.fn(async () => ({ studioId: 's-1', read: vi.fn() })),
    readSettings: vi.fn(async () => ({ membershipSource: 'un1t_online', studioName: 'Hatch Street', organizationId: 'org-1', settings: { writesEnabled: true, funnelEnabled: true } })),
    bookOnce: vi.fn(async () => ({ kind: 'booked', account: { kind: 'existing', un1tUserId: 'usr-1', executingContactId: 'c-1' }, booking: { verdict: 'done', id: 'bk-1', ledgerId: 'l-1', alreadyBooked: false }, executingContactId: 'c-1', steps: { account: 'existing', book: 'done' } })),
    afterBooking: vi.fn(async () => ({ confirmation: 'sent' })),
    studioContext: vi.fn(async () => ({ blocks: [], studioName: 'Hatch Street', address: null, zone: 'Europe/Dublin' })),
    cancel: vi.fn(async () => ({ verdict: 'done', id: 'bk-1', ledgerId: 'l-c' })),
    move: vi.fn(async () => ({ verdict: 'done', id: 'bk-7', ledgerId: 'l-m' })),
  }
})
const approve = (r) => executeUn1tApproval(makeDb(), { row: r, actor: { id: 'staff-1' } }, deps)

describe('executeUn1tApproval', () => {
  it('record-only reasons execute nothing and mark the queue row booked', async () => {
    for (const reason of UN1T_RECORD_ONLY_REASONS) {
      syncs = []
      const out = await approve(row(reason))
      expect(out.finalStatus, reason).toBe('actioned')
      expect(out.executed).toEqual({ ok: true, record_only: true })
      expect(syncs).toEqual([{ status: 'booked', last_error: null }])
    }
    expect(deps.bookOnce).not.toHaveBeenCalled()
    expect(deps.writerFactory).not.toHaveBeenCalled()
  })

  it('approve runs with origin approval and the approver as actor; a confirmed booking emails and syncs the row', async () => {
    const out = await approve(row('un1t_outcome_unknown'))
    expect(deps.bookOnce.mock.calls[0][1]).toMatchObject({ origin: 'approval', actor: { id: 'staff-1' }, originRef: 'amr-1', eventId: 'ev-1', trialMode: 'normal' })
    expect(out).toMatchObject({ finalStatus: 'actioned', executed: { ok: true, un1t_booking_id: 'bk-1' }, customerNotified: { sent: true, channel: 'email' } })
    expect(syncs[0]).toEqual({ status: 'booked', last_error: null, glofox_booking_id: 'un1t:bk-1' })
    expect(deps.afterBooking.mock.calls[0][1]).toMatchObject({ origin: 'approval' })
  })

  it('un1t_trial_unverified never buys: credits only', async () => {
    deps.bookOnce.mockResolvedValueOnce({ kind: 'card', reason: 'un1t_trial_unverified', steps: { trial: 'unverified_no_credits' } })
    const out = await approve(row('un1t_trial_unverified'))
    expect(deps.bookOnce.mock.calls[0][1].trialMode).toBe('credits_only')
    expect(out).toMatchObject({ finalStatus: 'failed', executed: { ok: false, code: 'un1t_trial_unverified' } })
    expect(out.executed.message).toMatch(/nothing was bought/)
  })

  it('un1t_trial_failed re-runs the grant once (the normal steps)', async () => {
    await approve(row('un1t_trial_failed:SOMETHING'))
    expect(deps.bookOnce).toHaveBeenCalledTimes(1)
    expect(deps.bookOnce.mock.calls[0][1].trialMode).toBe('normal')
  })

  it('a booking that fails again lands failed with staff words; a retryable one says so', async () => {
    deps.bookOnce.mockResolvedValueOnce({ kind: 'card', reason: 'un1t_outcome_unknown', steps: {}, booking: { verdict: 'unknown', code: 'already_booked_unverified' } })
    let out = await approve(row('processing_error'))
    expect(out.finalStatus).toBe('failed')
    expect(out.executed.message).toMatch(/could not confirm|did not answer clearly/)
    deps.bookOnce.mockResolvedValueOnce({ kind: 'retry', code: 'UN1T_RATE_BUDGET', steps: {} })
    out = await approve(row('processing_error'))
    expect(out.executed).toMatchObject({ ok: false, code: 'UN1T_RATE_BUDGET', retryable: true })
  })

  it('UN1TMOVE.2: a cancellation card for a booking moved inside the late window lands failed, in staff words', async () => {
    deps.cancel.mockResolvedValueOnce({ verdict: 'refused', code: 'cancel_after_late_move', message: 'x', ledgerId: null })
    const out = await approve(row('cancel', { kind: 'class_cancellation', details: { provider: 'un1t_online', booking_id: 'bk-7', un1t_user_id: 'usr-1' } }))
    expect(out).toMatchObject({ finalStatus: 'failed', executed: { ok: false, code: 'cancel_after_late_move' } })
    expect(out.executed.message).toMatch(/will not cancel it/)
  })

  it('a class_cancellation row (E files these) runs cancel with origin approval; already happened has staff words', async () => {
    const r = row('cancel', { kind: 'class_cancellation', details: { provider: 'un1t_online', booking_id: 'bk-7', un1t_user_id: 'usr-1' } })
    let out = await approve(r)
    expect(deps.cancel.mock.calls[0][1]).toMatchObject({ bookingId: 'bk-7', un1tUserId: 'usr-1', origin: 'approval', actor: { id: 'staff-1' } })
    expect(out.finalStatus).toBe('actioned')
    deps.cancel.mockResolvedValueOnce({ verdict: 'refused', code: 'UN1T_ALREADY_HAPPENED', message: 'x' })
    out = await approve(r)
    expect(out.finalStatus).toBe('failed')
    expect(out.executed.message).toMatch(/already happened/)
  })
})

// UN1TMOVE.1 — a Mia move card is a class_booking row for the target class
// with move_from_booking_id: approving runs ONE moveBooking, never a book.
describe('executeUn1tApproval: a move card', () => {
  const moveRow = (over = {}) => row('mia_move', {
    details: {
      provider: 'un1t_online', origin: 'mia', reason: 'mia_move', event_id: 'ev-2', un1t_user_id: 'usr-1', executing_contact_id: 'c-1',
      starts_at: '2099-01-01T08:00:00Z', class_name: 'BASE', move_from_booking_id: 'bk-7', move_from_event_id: 'ev-1', ...over,
    },
  })

  it('moves with origin approval and the approver as actor; never books, never emails', async () => {
    const out = await approve(moveRow())
    expect(deps.move).toHaveBeenCalledTimes(1)
    expect(deps.move.mock.calls[0][1]).toEqual({
      locationId: 'loc-h', contactId: 'c-1', un1tUserId: 'usr-1', bookingId: 'bk-7', eventId: 'ev-2', fromEventId: 'ev-1',
      origin: 'approval', originRef: 'amr-1', actor: { id: 'staff-1' },
    })
    expect(deps.bookOnce).not.toHaveBeenCalled()
    expect(deps.afterBooking).not.toHaveBeenCalled()
    expect(out).toMatchObject({ finalStatus: 'actioned', executed: { ok: true, verdict: 'done', moved: true, un1t_booking_id: 'bk-7', ledger_id: 'l-m' }, customerNotified: null })
    expect(syncs).toEqual([])
  })

  it('UN1TMOVE.2: a move refused by the late-window rule lands failed in staff words', async () => {
    deps.move.mockResolvedValueOnce({ verdict: 'refused', code: 'move_late_other_day', message: 'x', ledgerId: null })
    const out = await approve(moveRow())
    expect(out).toMatchObject({ finalStatus: 'failed', executed: { ok: false, code: 'move_late_other_day' } })
    expect(out.executed.message).toMatch(/only move to another class on the same day/)
  })

  it('a refusal or an unknown lands failed with staff words; a prefixed id is read bare', async () => {
    deps.move.mockResolvedValueOnce({ verdict: 'refused', code: 'UN1T_ALREADY_HAPPENED', message: 'x', ledgerId: 'l-m' })
    let out = await approve(moveRow())
    expect(out).toMatchObject({ finalStatus: 'failed', executed: { ok: false, code: 'UN1T_ALREADY_HAPPENED' } })
    expect(out.executed.message).toMatch(/already happened/)
    deps.move.mockResolvedValueOnce({ verdict: 'unknown', code: null, ledgerId: 'l-m' })
    out = await approve(moveRow({ event_id: 'un1t:ev-3', move_from_booking_id: 'un1t:bk-8' }))
    expect(out.finalStatus).toBe('failed')
    expect(deps.move.mock.calls.at(-1)[1]).toMatchObject({ bookingId: 'bk-8', eventId: 'ev-3' })
  })
})
