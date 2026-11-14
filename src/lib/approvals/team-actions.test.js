import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TEAM_ACTIONS, TEAM_LINK_ONLY_KEYS, isDecidableInPlace, loadInvoiceRosterCheck, unassignLeaveClashes, approveSwapAnyway } from './team-actions'

let fetchMock
function reply(body, { ok = true, status = 200, json = true } = {}) {
  fetchMock.mockResolvedValue({
    ok, status,
    json: json ? async () => body : async () => { throw new SyntaxError('Unexpected token') },
  })
}
function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)
  return { url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) }
}
beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock })

describe('TEAM_ACTIONS requests', () => {
  it('expenses approve: POST, no body', async () => {
    reply({ success: true })
    const r = await TEAM_ACTIONS.fte_expenses.approve({ id: 'c1' })
    expect(lastCall()).toEqual({ url: '/api/expenses/c1/approve', method: 'POST', body: undefined })
    expect(r).toMatchObject({ ok: true, status: 200 })
  })
  it('expenses decline: POST { reason }', async () => {
    reply({ success: true })
    await TEAM_ACTIONS.fte_expenses.decline({ id: 'c1' }, 'Missing receipt')
    expect(lastCall()).toEqual({ url: '/api/expenses/c1/decline', method: 'POST', body: { reason: 'Missing receipt' } })
  })
  it('host events approve and reject', async () => {
    reply({ success: true })
    await TEAM_ACTIONS.host_events.approve({ id: 'e1' })
    expect(lastCall()).toEqual({ url: '/api/events/e1/review', method: 'POST', body: { action: 'approve' } })
    await TEAM_ACTIONS.host_events.decline({ id: 'e1' }, 'Wrong venue')
    expect(lastCall()).toEqual({ url: '/api/events/e1/review', method: 'POST', body: { action: 'reject', reason: 'Wrong venue' } })
  })
  it('leave cancellation approve and reject send { decision, note }, note null when empty', async () => {
    reply({ success: true })
    await TEAM_ACTIONS.time_off_cancellations.approve({ id: 't1' })
    expect(lastCall()).toEqual({ url: '/api/schedule/time-off/t1/cancel-request', method: 'POST', body: { decision: 'approve', note: null } })
    await TEAM_ACTIONS.time_off_cancellations.decline({ id: 't1' }, '')
    expect(lastCall().body).toEqual({ decision: 'reject', note: null })
    await TEAM_ACTIONS.time_off_cancellations.decline({ id: 't1' }, 'Busy week')
    expect(lastCall().body).toEqual({ decision: 'reject', note: 'Busy week' })
  })
})

describe('TEAM_ACTIONS config', () => {
  it('labels and rules', () => {
    const { fte_expenses: e, host_events: h, time_off_cancellations: t } = TEAM_ACTIONS
    expect([e.approveLabel, e.declineLabel, e.reasonRequired]).toEqual(['Approve', 'Decline', true])
    expect([h.approveLabel, h.declineLabel, h.reasonRequired]).toEqual(['Approve', 'Decline', true])
    expect([t.approveLabel, t.declineLabel, t.reasonRequired]).toEqual(['Cancel their leave', 'Keep their leave', false])
    expect(t.approveConfirm).toBe('Cancel this approved leave?')
    expect(e.approveConfirm).toBeUndefined()
    for (const a of [e, h, t]) {
      for (const k of ['reasonLabel', 'approvedText', 'declinedText', 'pageLabel']) expect(typeof a[k]).toBe('string')
    }
  })
  it('isDecidableInPlace and link-only keys', () => {
    expect(isDecidableInPlace('fte_expenses')).toBe(true)
    expect(isDecidableInPlace('invoices_queue')).toBe(false)
    expect(isDecidableInPlace('nope')).toBe(false)
    expect(TEAM_LINK_ONLY_KEYS).toEqual(['invoices_queue', 'rosters', 'issues', 'hyrox_sessions'])
  })
})

describe('call() result handling', () => {
  it('a non-2xx with { error } returns the route text', async () => {
    reply({ success: false, error: 'You do not have permission to approve expenses.' }, { ok: false, status: 403 })
    const r = await TEAM_ACTIONS.fte_expenses.approve({ id: 'c1' })
    expect(r).toMatchObject({ ok: false, status: 403, error: 'You do not have permission to approve expenses.' })
  })
  it('a 200 with success:false is a failure', async () => {
    reply({ success: false, error: 'No' })
    expect(await TEAM_ACTIONS.host_events.approve({ id: 'e1' })).toMatchObject({ ok: false, error: 'No' })
  })
  it('a non-JSON body returns ok:false with a generic message and does not throw', async () => {
    reply(null, { ok: false, status: 502, json: false })
    const r = await TEAM_ACTIONS.host_events.approve({ id: 'e1' })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(502)
    expect(r.error).toMatch(/try again/i)
  })
  it('a network throw returns ok:false', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const r = await TEAM_ACTIONS.fte_expenses.decline({ id: 'c1' }, 'x')
    expect(r).toMatchObject({ ok: false, status: 0 })
    expect(r.error).toMatch(/network|try again/i)
  })
  it('success carries data', async () => {
    reply({ success: true, data: { id: 'e1', status: 'published' } })
    expect((await TEAM_ACTIONS.host_events.approve({ id: 'e1' })).data).toEqual({ id: 'e1', status: 'published' })
  })
})

describe('APPROVALSQ.4 task 2: invoices, time off, swaps', () => {
  it('invoice approve and decline', async () => {
    reply({ success: true })
    await TEAM_ACTIONS.contractor_invoices.approve({ id: 'v1' })
    expect(lastCall()).toEqual({ url: '/api/invoices/v1/approve', method: 'POST', body: undefined })
    await TEAM_ACTIONS.contractor_invoices.decline({ id: 'v1' }, ' Wrong month ')
    expect(lastCall()).toEqual({ url: '/api/invoices/v1/decline', method: 'POST', body: { reason: 'Wrong month' } })
    expect(TEAM_ACTIONS.contractor_invoices.reasonRequired).toBe(true)
  })
  it('loadInvoiceRosterCheck GETs the invoice with no cache', async () => {
    reply({ success: true, data: { id: 'v1', roster_unavailable: false } })
    const r = await loadInvoiceRosterCheck('v1')
    const [url, init] = fetchMock.mock.calls.at(-1)
    expect(url).toBe('/api/invoices/v1')
    expect(init.method).toBe('GET')
    expect(init.cache).toBe('no-store')
    expect(r).toMatchObject({ ok: true, data: { id: 'v1' } })
  })
  it('time off approve and reject (review_note optional)', async () => {
    reply({ success: true })
    await TEAM_ACTIONS.time_off.approve({ id: 't1' })
    expect(lastCall()).toEqual({ url: '/api/schedule/time-off/t1', method: 'PUT', body: { status: 'approved' } })
    await TEAM_ACTIONS.time_off.decline({ id: 't1' }, '')
    expect(lastCall()).toEqual({ url: '/api/schedule/time-off/t1', method: 'PUT', body: { status: 'rejected', review_note: null } })
    await TEAM_ACTIONS.time_off.decline({ id: 't1' }, 'Short staffed')
    expect(lastCall().body).toEqual({ status: 'rejected', review_note: 'Short staffed' })
    expect(TEAM_ACTIONS.time_off.reasonRequired).toBe(false)
  })
  it('time off approve result carries the clashes the route returns at the top level', async () => {
    reply({ success: true, data: { id: 't1' }, clashes: [{ id: 'a1' }] })
    const r = await TEAM_ACTIONS.time_off.approve({ id: 't1' })
    expect(r.body.clashes).toEqual([{ id: 'a1' }])
  })
  it('unassignLeaveClashes POSTs the ids', async () => {
    reply({ success: true, data: { removed: [{ assignment_id: 'a1' }], already_removed: [], skipped: [], failed: [] } })
    const r = await unassignLeaveClashes('t1', ['a1', 'a2'])
    expect(lastCall()).toEqual({ url: '/api/schedule/time-off/t1/unassign-clashes', method: 'POST', body: { assignment_ids: ['a1', 'a2'] } })
    expect(r.ok).toBe(true)
  })
  it('swap approve, reject and approve anyway', async () => {
    reply({ success: true })
    await TEAM_ACTIONS.shift_swaps.approve({ id: 's1' })
    expect(lastCall()).toEqual({ url: '/api/schedule/swaps/s1', method: 'PUT', body: { status: 'approved' } })
    await TEAM_ACTIONS.shift_swaps.decline({ id: 's1' }, 'No cover')
    expect(lastCall()).toEqual({ url: '/api/schedule/swaps/s1', method: 'PUT', body: { status: 'rejected', review_note: 'No cover' } })
    await approveSwapAnyway({ id: 's1' })
    expect(lastCall()).toEqual({ url: '/api/schedule/swaps/s1', method: 'PUT', body: { status: 'approved', confirm_conflicts: true } })
    expect(TEAM_ACTIONS.shift_swaps.reasonRequired).toBe(false)
  })
  it('a swap conflict 409 keeps its code and conflicts on the result', async () => {
    reply({ success: false, code: 'swap_conflicts', error: 'On leave.', conflicts: [{ message: 'On leave.' }] }, { ok: false, status: 409 })
    const r = await TEAM_ACTIONS.shift_swaps.approve({ id: 's1' })
    expect(r).toMatchObject({ ok: false, status: 409, error: 'On leave.' })
    expect(r.body).toMatchObject({ code: 'swap_conflicts', conflicts: [{ message: 'On leave.' }] })
  })
  it('every new entry has the copy fields', () => {
    for (const k of ['contractor_invoices', 'time_off', 'shift_swaps']) {
      for (const f of ['approveLabel', 'declineLabel', 'reasonLabel', 'approvedText', 'declinedText', 'pageLabel']) expect(typeof TEAM_ACTIONS[k][f], `${k}.${f}`).toBe('string')
    }
  })
})

describe('warning texts', () => {
  it('contractor invoices define the short outcomes shown when the answer carries warnings', () => {
    expect(TEAM_ACTIONS.contractor_invoices.approvedTextWithWarnings).toBe('Approved.')
    expect(TEAM_ACTIONS.contractor_invoices.declinedTextWithWarnings).toBe('Declined.')
  })
})
