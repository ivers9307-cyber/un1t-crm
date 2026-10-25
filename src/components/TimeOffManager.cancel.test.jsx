// @vitest-environment jsdom
//
// LEAVECANCEL.1 — the Time Off page and a request to cancel APPROVED leave.
// The list rows arrive annotated by GET /api/schedule/time-off
// (cancel_request_state + can_* flags); the screen offers exactly those and
// never says "cancelled" when the server answered "requested".

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor, within } from '@testing-library/react'

let query = ''
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(query) }))

import TimeOffManager from '@/components/TimeOffManager'

const at = (id, role) => ({ id, role, employment_type: 'fte', activeLocation: { id: 'loc1', name: 'Hatch' } })
const MANAGER = at('mgr', 'manager')
const OWNER = at('own', 'owner')
const OTHER_MANAGER = at('mgr-2', 'manager')

const base = {
  id: 'r1', profile_id: 'mgr', type: 'holiday', status: 'approved', effective_status: 'approved', expired: false,
  start_date: '2026-10-05', end_date: '2026-10-07', total_days: 3, profiles: { full_name: 'Mia Manager' },
  cancel_request_state: null, can_request_cancel: false, cancel_needs_owner: false, can_withdraw_cancel: false, can_decide_cancel: false,
}
const ASKABLE = { ...base, can_request_cancel: true, cancel_needs_owner: true }
const OPEN = { ...base, cancel_request_state: 'open', cancel_request_note: 'Trip fell through' }

function mockFetch({ requests, respond = () => ({ success: true, data: {} }) }) {
  const calls = []
  global.fetch = vi.fn(async (url, opts = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
    if (opts.method && opts.method !== 'GET') {
      const body = opts.body ? JSON.parse(opts.body) : null
      calls.push([opts.method, url, body])
      const out = respond(opts.method, url, body)
      return json(out.body || out, out.status || 200)
    }
    if (url.includes('allowance')) return json({ success: true, data: { total_days: 20, used_days: 4, carried_over: 0, remaining: 16 } })
    if (url.includes('/api/staff')) return json({ success: true, data: [] })
    calls.push(['GET', url, null])
    return json({ success: true, data: requests })
  })
  return calls
}

const show = async (user, props = {}) => {
  await act(async () => { render(<TimeOffManager user={user} canApprove {...props} />) })
  await waitFor(() => expect(screen.getAllByText(/Holiday/).length).toBeGreaterThan(0))
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); query = '' })

describe('TimeOffManager — asking to cancel your own approved leave', () => {
  it('explains that an owner must approve, sends the reason, and reports REQUESTED, never cancelled', async () => {
    const calls = mockFetch({
      requests: [ASKABLE],
      respond: () => ({ success: true, data: { ...OPEN }, cancellation: 'requested' }),
    })
    await show(MANAGER)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel approved Holiday request from Mia Manager' })) })

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/needs an owner's approval/)).toBeTruthy()
    expect(within(dialog).getByText(/stays approved until they decide/)).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'Trip fell through' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Ask an owner' })) })

    const put = calls.find(([m]) => m === 'PUT')
    expect(put[1]).toBe('/api/schedule/time-off/r1')
    expect(put[2]).toEqual({ status: 'cancelled', cancel_request_note: 'Trip fell through' })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/sent to an owner/i))
    expect(screen.getByRole('status').textContent).toMatch(/still approved/i)
    expect(screen.getByRole('status').textContent).not.toMatch(/—/)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a refusal (ended leave, declined under a day ago, nobody else to decide) is shown in the server\'s own words and the dialog stays open', async () => {
    mockFetch({
      requests: [ASKABLE],
      respond: () => ({ status: 409, body: { success: false, error: 'An owner declined this less than a day ago. You can ask again after 24 hours, or speak to them directly.' } }),
    })
    await show(MANAGER)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel approved Holiday request from Mia Manager' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask an owner' })) })
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toMatch(/declined this less than a day ago/))
  })

  it('within a day of a decline the row says when it can be asked again, and offers no ask', async () => {
    mockFetch({ requests: [{
      ...base, cancel_request_state: 'rejected', cancel_decision_note: null,
      can_request_cancel: false, cancel_retry_after: '2026-09-22T13:30:00.000Z', cancel_retry_after_label: '14:30 on 22 Sep',
    }] })
    await show(MANAGER)
    expect(screen.getByText(/You can ask again after 14:30 on 22 Sep\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Cancel approved/ })).toBeNull()
  })

  it('a cancelled row whose cancellation an owner approved says how it came to be cancelled, to the person and to managers', async () => {
    const done = { ...base, status: 'cancelled', effective_status: 'cancelled', cancel_request_state: 'approved', cancel_decision: 'approved', cancel_decider: { id: 'own', full_name: 'Olive Owner' } }
    mockFetch({ requests: [done] })
    await show(MANAGER)
    expect(screen.getByText('Cancelled at your request, approved by Olive Owner.')).toBeTruthy()
    cleanup()
    mockFetch({ requests: [done] })
    await show(OTHER_MANAGER)
    expect(screen.getByText("Cancelled at Mia Manager's request, approved by Olive Owner.")).toBeTruthy()
  })

  it('a plain approved row of someone who may not ask offers nothing', async () => {
    mockFetch({ requests: [base] })
    await show(MANAGER)
    expect(screen.queryByRole('button', { name: /Cancel approved/ })).toBeNull()
  })

  it('an open ask of your own reads "Cancellation requested, waiting for an owner" and offers Withdraw, not Cancel', async () => {
    const calls = mockFetch({
      requests: [{ ...OPEN, can_withdraw_cancel: true }],
      respond: () => ({ success: true, data: base, cancellation: 'withdrawn' }),
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await show(MANAGER)
    expect(screen.getByText('Cancellation requested')).toBeTruthy()
    expect(screen.getByText(/Waiting for an owner/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Cancel approved/ })).toBeNull()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Withdraw cancellation request for Holiday request from Mia Manager' })) })
    const del = calls.find(([m]) => m === 'DELETE')
    expect(del[1]).toBe('/api/schedule/time-off/r1/cancel-request')
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/withdrawn/i))
  })

  it('a declined ask says so, with the owner\'s note, and may be asked again', async () => {
    mockFetch({ requests: [{ ...ASKABLE, cancel_request_state: 'rejected', cancel_decision_note: 'We are short that week' }] })
    await show(MANAGER)
    expect(screen.getByText(/Cancellation declined/)).toBeTruthy()
    expect(screen.getByText(/We are short that week/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel approved Holiday request from Mia Manager' })).toBeTruthy()
  })
})

describe('TimeOffManager — deciding someone else\'s cancellation', () => {
  it('an owner approves with an optional note', async () => {
    const calls = mockFetch({
      requests: [{ ...OPEN, can_decide_cancel: true }],
      respond: () => ({ success: true, data: { ...base, status: 'cancelled' }, cancellation: 'approved' }),
    })
    await show(OWNER)
    expect(screen.getByText(/Trip fell through/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve cancellation of Holiday request from Mia Manager' })) })
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/holiday days go back/i)).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('Note to Mia Manager (optional)'), { target: { value: 'No problem' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Approve cancellation' })) })

    const post = calls.find(([m]) => m === 'POST')
    expect(post[1]).toBe('/api/schedule/time-off/r1/cancel-request')
    expect(post[2]).toEqual({ decision: 'approve', note: 'No problem' })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/leave is cancelled/i))
  })

  it('an owner declines: the leave stays approved', async () => {
    const calls = mockFetch({
      requests: [{ ...OPEN, can_decide_cancel: true }],
      respond: () => ({ success: true, data: base, cancellation: 'rejected' }),
    })
    await show(OWNER)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Decline cancellation of Holiday request from Mia Manager' })) })
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Decline cancellation' })) })
    expect(calls.find(([m]) => m === 'POST')[2]).toEqual({ decision: 'reject', note: null })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/stays approved/i))
  })

  it('a manager who can see the row is shown that it is waiting, and NO decide button (the route would refuse them)', async () => {
    mockFetch({ requests: [OPEN] })
    await show(OTHER_MANAGER)
    expect(screen.getByText('Cancellation requested')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Approve cancellation/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Decline cancellation/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Withdraw/ })).toBeNull()
  })

  it('arriving from the approvals queue (?focus=&view=cancellations) lands on Team + Approved, where the row lives', async () => {
    query = 'focus=r1&view=cancellations'
    // jsdom has no layout, so no scrollIntoView; the focused row calls it.
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    const calls = mockFetch({ requests: [{ ...OPEN, can_decide_cancel: true }] })
    await show(OWNER)
    const list = calls.find(([m, u]) => m === 'GET' && u.startsWith('/api/schedule/time-off?'))[1]
    expect(list).toContain('status=approved')
    expect(list).not.toContain('profile_id=')
    await waitFor(() => expect(scrolled).toHaveBeenCalled())
    delete Element.prototype.scrollIntoView
  })

  it('an owner WITHOUT the time-off approval permission still gets the Team tab, or the queue would link to a row they cannot reach', async () => {
    mockFetch({ requests: [{ ...OPEN, can_decide_cancel: true }] })
    await show(OWNER, { canApprove: false, canDecideCancellations: true })
    expect(screen.getByRole('button', { name: 'Team Requests' })).toBeTruthy()
  })
})
