// UN1TWRITE.22 — the un1t.online funnel processor. Every collaborator is
// injected (the account step, the trial, the booking, the emails, the card);
// the fake database models the reads it makes and the queue row it stamps.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { processUn1tClassBookingRequest, Un1tFunnelRetry } from './un1t-online-booking-processor'

const LOC = 'loc-hatch'
const EVENT = 'ev-1'
const HOUR = 3_600_000
let tables
let rowUpdates
let order
function makeDb() {
  return {
    from(table) {
      const q = { f: [], op: 'select', payload: null }
      const rows = () => (tables[table] || []).filter((r) => q.f.every(([k, c, v]) => (k === 'eq' ? r[c] === v : k === 'in' ? v.includes(r[c]) : true)))
      const b = {
        select: () => b, order: () => b, limit: () => b, range: () => b,
        eq: (c, v) => { q.f.push(['eq', c, v]); return b },
        in: (c, v) => { q.f.push(['in', c, v]); return b },
        update: (p) => { q.op = 'update'; q.payload = p; return b },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok, no) => {
          if (q.op === 'update' && table === 'class_booking_requests') rowUpdates.push(q.payload)
          return Promise.resolve({ data: q.op === 'update' ? [{ id: 'q-1' }] : rows(), error: null }).then(ok, no)
        },
      }
      return b
    },
  }
}

const request = (over = {}) => ({
  id: 'q-1', location_id: LOC, contact_id: 'c-1', glofox_event_id: `un1t:${EVENT}`, class_name: 'RALLY',
  starts_at: new Date(Date.now() + 24 * HOUR).toISOString(), attempts: 1,
  terms_accepted_at: '2026-10-18T09:00:00.000Z', terms_source: 'website', terms_version: 'v', ...over,
})
const settings = (over = {}) => ({ writesEnabled: true, funnelEnabled: true, sendsWelcome: false, welcomeSetsLogin: false, sendsBookingConfirmation: false, ...over })
const ctx = (over = {}) => ({ settings: settings(over), studioName: 'Hatch Street', organizationId: 'org-1' })
const done = (over) => ({ verdict: 'done', sent: true, id: 'bk-9', code: null, message: null, alreadyBooked: false, retryable: false, ledgerId: 'l-b', ...over })

let deps
let writer
beforeEach(() => {
  vi.clearAllMocks()
  // Never the live API: any request a collaborator forgot to route through the fake fails loudly.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test: real network call') }))
  order = []
  rowUpdates = []
  tables = {
    un1t_events: [{ location_id: LOC, un1t_id: EVENT, title: 'RALLY', status: 'scheduled', starts_at: new Date(Date.now() + 24 * HOUR).toISOString() }],
    contacts: [{ id: 'c-1', organization_id: 'org-1', first_name: 'Jane', last_name: 'Doe', name: 'Jane Doe', email: 'jane@example.test', phone: null, un1t_user_id: null, ctwa_clid: null }],
    un1t_subscriptions: [],
    landing_page_settings: [{ location_id: LOC, public_path: 'hatch-street', blocks: [] }],
    locations: [{ id: LOC, name: 'Hatch Street', address: '1 Hatch St', timezone: 'Europe/Dublin' }],
  }
  writer = { locationId: LOC, studioId: 'studio-1', read: vi.fn(async () => ({ balance: 0, is_unlimited: false })) }
  const track = (name, value) => vi.fn(async (...args) => { order.push(name); return typeof value === 'function' ? value(...args) : value })
  deps = {
    writerFactory: vi.fn(async () => writer),
    ensureUn1tAccount: track('account', { kind: 'created', un1tUserId: 'usr-1', executingContactId: 'c-1' }),
    readPaidTrialReply: vi.fn(async () => null),
    grantTrial: track('trial', { outcome: 'granted', method: 'charge', ledgerId: 'l-t' }),
    book: track('book', done()),
    runSetPasswordStep: track('set_password', { explanation: 'sent', forgotPassword: 'done' }),
    sendManualBookingConfirmEmail: track('confirmation', { sent: true, channel: 'email' }),
    sendUn1tTrialUsedEmail: track('trial_used_email', { sent: true, channel: 'email' }),
    trialUsedHandoff: track('handoff', { handled: false }),
    trialUsedOptionsText: vi.fn(async () => null),
    routeToReview: vi.fn(async (db, req, reason) => { order.push(`card:${reason}`); return { outcome: 'needs_review', detail: reason } }),
    sendCtwaConversion: vi.fn(async () => {}),
    sendWebsiteConversion: vi.fn(async () => {}),
  }
})
const run = (req = request(), c = ctx()) => processUn1tClassBookingRequest(makeDb(), req, c, deps)
const lastRow = () => Object.assign({}, ...rowUpdates)

describe('processUn1tClassBookingRequest', () => {
  it('happy path new person: create, trial, book, explanation email then forgot-password, in that order', async () => {
    const out = await run()
    expect(out).toEqual({ outcome: 'booked', detail: 'un1t:bk-9' })
    expect(order).toEqual(['account', 'trial', 'book', 'set_password'])
    expect(deps.book.mock.calls[0][1]).toMatchObject({ locationId: LOC, contactId: 'c-1', un1tUserId: 'usr-1', eventId: EVENT, origin: 'funnel', originRef: 'q-1' })
    expect(deps.grantTrial.mock.calls[0][1]).toMatchObject({ locationId: LOC, un1tUserId: 'usr-1', contactId: 'c-1', origin: 'funnel', originRef: 'q-1' })
    expect(lastRow()).toMatchObject({ status: 'booked', glofox_booking_id: 'un1t:bk-9' })
    expect(lastRow().un1t_steps).toMatchObject({ account: 'created', trial: 'granted:charge', book: 'done', explanation: 'sent', forgot_password: 'done' })
    expect(deps.sendWebsiteConversion).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventName: 'Schedule', eventId: 'classbooking-q-1' }))
  })

  it('TRIALREGRANT.1: a credit re-grant (claimed the trial, never used, run out) books exactly as after a trial grant', async () => {
    deps.ensureUn1tAccount.mockImplementation(async () => { order.push('account'); return { kind: 'existing', un1tUserId: 'usr-1', executingContactId: 'c-1' } })
    deps.grantTrial.mockImplementation(async () => { order.push('trial'); return { outcome: 'granted', method: 'credit_regrant', ledgerId: 'l-rg' } })
    deps.runSetPasswordStep.mockImplementation(async () => { order.push('set_password'); return { explanation: 'skipped_not_created', forgotPassword: 'skipped_not_created' } })
    const out = await run()
    expect(out).toEqual({ outcome: 'booked', detail: 'un1t:bk-9' })
    expect(order).toEqual(['account', 'trial', 'book', 'set_password', 'confirmation'])
    expect(deps.book.mock.calls[0][1]).toMatchObject({ locationId: LOC, contactId: 'c-1', un1tUserId: 'usr-1', eventId: EVENT, origin: 'funnel' })
    expect(lastRow()).toMatchObject({ status: 'booked', glofox_booking_id: 'un1t:bk-9' })
    expect(lastRow().un1t_steps).toMatchObject({ account: 'existing', trial: 'granted:credit_regrant', book: 'done' })
    expect(deps.trialUsedHandoff).not.toHaveBeenCalled()
    expect(deps.sendUn1tTrialUsedEmail).not.toHaveBeenCalled()
  })

  it('existing account by own link, sibling email or API walk books with no create; the step finds no create and the confirmation goes', async () => {
    deps.ensureUn1tAccount.mockImplementation(async () => { order.push('account'); return { kind: 'existing', un1tUserId: 'usr-sib', executingContactId: 'c-sib' } })
    deps.runSetPasswordStep.mockImplementation(async () => { order.push('set_password'); return { explanation: 'skipped_not_created', forgotPassword: 'skipped_not_created' } })
    await run()
    expect(order).toEqual(['account', 'trial', 'book', 'set_password', 'confirmation'])
    expect(deps.book.mock.calls[0][1]).toMatchObject({ contactId: 'c-sib', un1tUserId: 'usr-sib' })
    expect(lastRow().un1t_steps).toMatchObject({ account: 'existing', confirmation: 'sent' })
  })

  it('a later booking for an account the CRM made long ago (reset done) still gets the booking confirmation', async () => {
    deps.ensureUn1tAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'usr-1', executingContactId: 'c-1' })
    deps.runSetPasswordStep.mockResolvedValue({ explanation: 'skipped_already_done', forgotPassword: 'skipped_already_done' })
    await run()
    expect(deps.sendManualBookingConfirmEmail).toHaveBeenCalledOnce()
    expect(lastRow().un1t_steps).toMatchObject({ confirmation: 'sent' })
  })

  it('an account we created that a re-run now finds "existing" still gets its set-password step', async () => {
    deps.ensureUn1tAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'usr-1', executingContactId: 'c-1' })
    await run()
    expect(deps.runSetPasswordStep).toHaveBeenCalledOnce()
    expect(deps.sendManualBookingConfirmEmail).not.toHaveBeenCalled()
    expect(lastRow().un1t_steps).toMatchObject({ explanation: 'sent', forgot_password: 'done' })
  })

  it('credits or an active subscription skip the trial', async () => {
    writer.read.mockResolvedValueOnce({ balance: 2, is_unlimited: false })
    await run()
    expect(deps.grantTrial).not.toHaveBeenCalled()
    expect(lastRow().un1t_steps.trial).toBe('skipped_credits')
    order.length = 0
    writer.read.mockResolvedValueOnce({ balance: 0, is_unlimited: false })
    tables.un1t_subscriptions = [{ location_id: LOC, un1t_user_id: 'usr-1', status: 'active' }]
    await run()
    expect(deps.grantTrial).toHaveBeenCalledTimes(0)
  })

  it('a failed credits read throws (the queue retries); the account is kept', async () => {
    writer.read.mockRejectedValueOnce(new Error('down'))
    await expect(run()).rejects.toBeInstanceOf(Un1tFunnelRetry)
  })

  it('ineligible on the website: trial-used email, row failed trial_used_options_sent, one record-only card, no booking', async () => {
    deps.grantTrial.mockImplementation(async () => { order.push('trial'); return { outcome: 'ineligible', reason: 'trial_used' } })
    const out = await run()
    expect(deps.book).not.toHaveBeenCalled()
    expect(order).toEqual(['account', 'trial', 'handoff', 'trial_used_email', 'card:un1t_trial_used'])
    const [, , , opts] = deps.routeToReview.mock.calls[0]
    expect(opts).toMatchObject({ provider: 'un1t_online', rowStatus: 'failed', rowLastError: 'trial_used_options_sent', executingContactId: 'c-1' })
    expect(out).toEqual({ outcome: 'failed', detail: 'trial_used_options_sent' })
  })

  it('ineligible with the hand-off handled: no email, row failed trial_used_handed_to_mia', async () => {
    deps.grantTrial.mockResolvedValue({ outcome: 'ineligible', reason: 'trial_used' })
    deps.trialUsedHandoff.mockResolvedValue({ handled: true })
    const out = await run()
    expect(deps.sendUn1tTrialUsedEmail).not.toHaveBeenCalled()
    expect(lastRow()).toMatchObject({ status: 'failed', last_error: 'trial_used_handed_to_mia' })
    expect(out).toEqual({ outcome: 'failed', detail: 'trial_used_handed_to_mia' })
  })

  it('trial needs_staff files its reason; trial retry throws', async () => {
    deps.grantTrial.mockResolvedValueOnce({ outcome: 'needs_staff', reason: 'un1t_trial_unverified' })
    await run()
    expect(deps.routeToReview.mock.calls[0][2]).toBe('un1t_trial_unverified')
    expect(deps.routeToReview.mock.calls[0][3]).toMatchObject({ provider: 'un1t_online' })
    deps.grantTrial.mockResolvedValueOnce({ outcome: 'retry', code: 'credits_unreadable' })
    const err = await run().catch((e) => e)
    expect(err).toBeInstanceOf(Un1tFunnelRetry)
    expect(err.reviewOptions).toMatchObject({ provider: 'un1t_online', executingContactId: 'c-1' })
  })

  it('booking fails after create: card un1t_booking_failed, account kept, no set-password step', async () => {
    deps.book.mockResolvedValue(done({ verdict: 'refused', code: 'CLASS_FULL', id: null }))
    await run()
    expect(deps.routeToReview.mock.calls[0][2]).toBe('un1t_booking_failed:CLASS_FULL')
    expect(deps.runSetPasswordStep).not.toHaveBeenCalled()
  })

  it('an unclear booking is un1t_outcome_unknown; a busy or in-flight one throws', async () => {
    deps.book.mockResolvedValueOnce(done({ verdict: 'unknown', id: null }))
    await run()
    expect(deps.routeToReview.mock.calls[0][2]).toBe('un1t_outcome_unknown')
    deps.book.mockResolvedValueOnce(done({ verdict: 'refused', code: 'UN1T_ATTEMPT_IN_FLIGHT', retryable: true }))
    await expect(run()).rejects.toBeInstanceOf(Un1tFunnelRetry)
  })

  it('two concurrent requests for one person create one account (RF2): the second throws and retries', async () => {
    deps.ensureUn1tAccount.mockResolvedValueOnce({ kind: 'retry', code: 'UN1T_ATTEMPT_IN_FLIGHT' })
    await expect(run()).rejects.toBeInstanceOf(Un1tFunnelRetry)
    expect(deps.book).not.toHaveBeenCalled()
  })

  it('a class whose start has passed but whose status is still scheduled is class_unavailable (RF4)', async () => {
    tables.un1t_events[0].starts_at = new Date(Date.now() - 60_000).toISOString()
    await run()
    expect(deps.routeToReview.mock.calls[0][2]).toBe('class_unavailable')
    expect(deps.ensureUn1tAccount).not.toHaveBeenCalled()
  })

  it('no email → no_email card; no acceptance + new person → terms_not_accepted card', async () => {
    tables.contacts[0].email = null
    await run()
    expect(deps.routeToReview.mock.calls[0][2]).toBe('no_email')
    tables.contacts[0].email = 'jane@example.test'
    deps.ensureUn1tAccount.mockResolvedValueOnce({ kind: 'card', reason: 'terms_not_accepted' })
    await run(request({ terms_accepted_at: null, terms_source: null }))
    expect(deps.routeToReview.mock.calls[1][2]).toBe('terms_not_accepted')
    expect(deps.book).not.toHaveBeenCalled()
  })

  it('sendsBookingConfirmation skips our confirmation and records the skip in un1t_steps', async () => {
    deps.ensureUn1tAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'usr-1', executingContactId: 'c-1' })
    deps.runSetPasswordStep.mockResolvedValue({ explanation: 'skipped_not_created', forgotPassword: 'skipped_not_created' })
    await run(request(), ctx({ sendsBookingConfirmation: true }))
    expect(deps.sendManualBookingConfirmEmail).not.toHaveBeenCalled()
    expect(lastRow().un1t_steps.confirmation).toBe('skipped_flag')
  })

  it('any other error is rethrown as the retry signal, carrying the provider (D-8)', async () => {
    deps.ensureUn1tAccount.mockRejectedValueOnce(Object.assign(new Error('contacts read failed'), { code: 'XX000' }))
    const err = await run().catch((e) => e)
    expect(err).toBeInstanceOf(Un1tFunnelRetry)
    expect(err.reviewOptions).toEqual({ provider: 'un1t_online', executingContactId: null })
    expect(err.cause.message).toBe('contacts read failed')
    // The row was marked as the un1t.online processor's before anything else.
    expect(rowUpdates[0]).toHaveProperty('un1t_steps')
  })

  it('a malformed event id is class_unavailable and nothing is read from un1t.online', async () => {
    await run(request({ glofox_event_id: 'un1t: bad id' }))
    expect(deps.routeToReview.mock.calls[0][2]).toBe('class_unavailable')
    expect(deps.writerFactory).not.toHaveBeenCalled()
  })
})

// FLOWACK.1 — a booking made through the WhatsApp Flow is confirmed on the
// thread (un1t.online sends no WhatsApp; the confirmation email still goes).
// notifyFlowBookingOutcome decides whether the row came from the Flow; a card
// is told by routeToReview, never here. A notice never changes the outcome.
describe('processUn1tClassBookingRequest — the WhatsApp Flow outcome (FLOWACK.1)', () => {
  it('booked: one booked notice, after the row is stamped booked', async () => {
    deps.notifyFlowBookingOutcome = vi.fn(async () => { order.push('flow_notice'); return { flow: true, sent: true } })
    const r = await run()
    expect(r.outcome).toBe('booked')
    expect(deps.notifyFlowBookingOutcome).toHaveBeenCalledTimes(1)
    expect(deps.notifyFlowBookingOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'q-1' }), { outcome: 'booked' })
    expect(rowUpdates.findIndex((u) => u.status === 'booked')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('flow_notice')).toBeGreaterThan(order.indexOf('book'))
  })

  it('a notice that throws never changes the booking', async () => {
    deps.notifyFlowBookingOutcome = vi.fn(async () => { throw new Error('boom') })
    const r = await run()
    expect(r.outcome).toBe('booked')
    expect(lastRow().status).toBe('booked')
  })

  it('a card is told by routeToReview, not here', async () => {
    deps.notifyFlowBookingOutcome = vi.fn(async () => ({ flow: true, sent: true }))
    deps.book.mockResolvedValueOnce({ verdict: 'refused', code: 'CLASS_FULL', retryable: false })
    const r = await run()
    expect(r.outcome).toBe('needs_review')
    expect(deps.notifyFlowBookingOutcome).not.toHaveBeenCalled()
  })

  it('with no notifier injected, a website row (no Flow thread) sends nothing and still books', async () => {
    const r = await run()
    expect(r.outcome).toBe('booked')
  })
})

// PAIDTRIALONLY.1 — where the studio has set its paid trial reply, nobody is
// given a free trial: a person with nothing to book with is sent the reply.
describe('processUn1tClassBookingRequest — paid trial only (PAIDTRIALONLY.1)', () => {
  const REPLY = 'New here? Start with the 14 Day Reset: https://x.test/trial?studio=hatch'

  it('no credits, no membership: no trial and no booking; the Flow customer gets the reply; row failed', async () => {
    deps.readPaidTrialReply.mockResolvedValue(REPLY)
    deps.notifyFlowBookingOutcome = vi.fn(async () => ({ flow: true, sent: true }))
    const out = await run()
    expect(out).toEqual({ outcome: 'failed', detail: 'paid_trial_offered' })
    expect(deps.grantTrial).not.toHaveBeenCalled()
    expect(deps.book).not.toHaveBeenCalled()
    expect(deps.notifyFlowBookingOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'q-1' }), { outcome: 'paid_trial', text: REPLY })
    expect(lastRow()).toMatchObject({ status: 'failed', last_error: 'paid_trial_offered' })
    expect(lastRow().un1t_steps).toMatchObject({ trial: 'paid_trial_only' })
  })

  it('credits on the account still book when the reply is set', async () => {
    deps.readPaidTrialReply.mockResolvedValue(REPLY)
    writer.read.mockResolvedValue({ balance: 3, is_unlimited: false })
    const out = await run()
    expect(out.outcome).toBe('booked')
    expect(deps.grantTrial).not.toHaveBeenCalled()
  })

  it('an unreadable reply setting is a retry, before any write', async () => {
    deps.readPaidTrialReply.mockRejectedValue(new Error('unreadable'))
    await expect(run()).rejects.toBeInstanceOf(Un1tFunnelRetry)
    expect(deps.ensureUn1tAccount).not.toHaveBeenCalled()
  })
})
