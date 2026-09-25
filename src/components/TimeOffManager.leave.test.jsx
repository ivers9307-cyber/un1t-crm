// @vitest-environment jsdom
//
// LEAVE.2 — the Time Off page: approvers see the team first and their own
// allowance below; clash counts; the "Unassign them" follow-up; expired
// requests cannot be approved; the form offers a contractor Unavailable only
// and lets an approver record leave for a colleague.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))

import TimeOffManager from '@/components/TimeOffManager'

const APPROVER = { id: 'u1', role: 'head_coach', employment_type: 'fte', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const CONTRACTOR = { id: 'u9', role: 'staff', employment_type: 'contractor', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

const PENDING = {
  id: 'r1', profile_id: 'u2', type: 'unavailable', status: 'pending', effective_status: 'pending', expired: false,
  start_date: '2026-10-01', end_date: '2026-10-03', total_days: 3, clash_count: 2, profiles: { full_name: 'Sam Demo' },
}
const EXPIRED = {
  id: 'r2', profile_id: 'u3', type: 'holiday', status: 'pending', effective_status: 'expired', expired: true,
  start_date: '2026-08-26', end_date: '2026-08-26', total_days: 1, profiles: { full_name: 'Toby Beta' },
}

function mockFetch({ requests = [PENDING], staff = [], onPut, onPost } = {}) {
  const calls = []
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push([url, opts])
    const json = (body) => ({ ok: true, status: 200, json: async () => body })
    if (opts.method === 'PUT') return json(onPut ? onPut(url, JSON.parse(opts.body)) : { success: true, data: {} })
    if (opts.method === 'POST') return json(onPost ? onPost(url, JSON.parse(opts.body)) : { success: true, data: {} })
    if (url.includes('allowance')) return json({ success: true, data: { total_days: 20, used_days: 4, carried_over: 0, remaining: 16 } })
    if (url.includes('/api/staff')) return json({ success: true, data: staff })
    return json({ success: true, data: requests })
  })
  return calls
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('TimeOffManager — LEAVE.2', () => {
  it('approvers land on team requests, with their own allowance in a section below', async () => {
    const calls = mockFetch()
    await act(async () => { render(<TimeOffManager user={APPROVER} canApprove />) })
    await waitFor(() => expect(screen.getByText('Sam Demo')).toBeTruthy())
    const heading = screen.getByRole('heading', { name: 'Your allowance' })
    // The list precedes the allowance in document order.
    expect(screen.getByText('Sam Demo').compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const listCall = calls.find(([u]) => u.startsWith('/api/schedule/time-off?'))[0]
    expect(listCall).toContain('with_clashes=1')
    expect(listCall).not.toContain('profile_id=')
  })

  it('a coach still sees their allowance first and no "Your allowance" section', async () => {
    mockFetch({ requests: [] })
    await act(async () => { render(<TimeOffManager user={{ ...APPROVER, role: 'staff' }} canApprove={false} />) })
    await waitFor(() => expect(screen.getByText('Total Allowance')).toBeTruthy())
    expect(screen.queryByRole('heading', { name: 'Your allowance' })).toBeNull()
  })

  it('shows the clash count and offers "Unassign them" after approving; unassigns only the shown shifts', async () => {
    const clashes = [
      { id: 'a1', block_date: '2026-10-01', start_time: '06:30:00', template_name: 'AM', location_name: 'Stillorgan' },
      { id: 'a2', block_date: '2026-10-02' },
    ]
    const posted = []
    mockFetch({
      onPut: () => ({ success: true, data: { ...PENDING, status: 'approved' }, clashes }),
      onPost: (url, body) => { posted.push([url, body]); return { success: true, data: { removed: [{}, {}], skipped: [] } } },
    })
    await act(async () => { render(<TimeOffManager user={APPROVER} canApprove />) })
    await waitFor(() => expect(screen.getByText('Clashes with 2 rostered shifts')).toBeTruthy())

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve Unavailable request from Sam Demo' })) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unassign them' })).toBeTruthy())
    expect(posted).toHaveLength(0) // nothing is unassigned without the click

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unassign them' })) })
    await waitFor(() => expect(screen.getByText(/Unassigned from 2 shifts/)).toBeTruthy())
    expect(posted).toEqual([['/api/schedule/time-off/r1/unassign-clashes', { assignment_ids: ['a1', 'a2'] }]])
  })

  it('"Keep them" dismisses without touching the roster', async () => {
    const posted = []
    mockFetch({
      onPut: () => ({ success: true, data: PENDING, clashes: [{ id: 'a1', block_date: '2026-10-01' }] }),
      onPost: (url) => { posted.push(url); return { success: true } },
    })
    await act(async () => { render(<TimeOffManager user={APPROVER} canApprove />) })
    await waitFor(() => expect(screen.getByText('Sam Demo')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve Unavailable request from Sam Demo' })) })
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Keep them' })) })
    expect(screen.queryByRole('button', { name: 'Unassign them' })).toBeNull()
    expect(posted).toHaveLength(0)
  })

  it('an expired request shows EXPIRED and cannot be approved, only rejected', async () => {
    mockFetch({ requests: [EXPIRED] })
    await act(async () => { render(<TimeOffManager user={APPROVER} canApprove />) })
    await waitFor(() => expect(screen.getByText('Toby Beta')).toBeTruthy())
    expect(screen.getByText('expired')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reject Holiday request from Toby Beta' })).toBeTruthy()
  })

  it('AVAIL.3 — a contractor gets a My availability link instead of Request Time Off', async () => {
    mockFetch({ requests: [] })
    await act(async () => { render(<TimeOffManager user={CONTRACTOR} canApprove={false} />) })
    expect(screen.getByRole('link', { name: 'My availability' }).getAttribute('href')).toBe('/schedule/availability')
    expect(screen.queryByRole('button', { name: /Request Time Off/ })).toBeNull()
  })

  it('an approver can record leave for a colleague; types follow that person', async () => {
    const posted = []
    mockFetch({
      requests: [],
      staff: [
        { id: 'u1', full_name: 'Me', employment_type: 'fte', active: true },
        { id: 'c1', full_name: 'Ciara Contractor', employment_type: 'contractor', active: true },
        { id: 'f1', full_name: 'Fiona FTE', employment_type: 'fte', active: true },
      ],
      onPost: (url, body) => { posted.push(body); return { success: true, data: { id: 'new', profiles: { full_name: 'Fiona FTE' } }, clashes: [] } },
    })
    await act(async () => { render(<TimeOffManager user={APPROVER} canApprove />) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Request Time Off/ })) })
    const select = await screen.findByLabelText('For')
    // The viewer is "Myself", never listed twice.
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Myself', 'Ciara Contractor', 'Fiona FTE'])

    // AVAIL.3 — a contractor has nothing to record: a note, no types, no submit.
    fireEvent.change(select, { target: { value: 'c1' } })
    let dialog = screen.getByRole('dialog')
    expect(dialog.querySelectorAll('button[aria-pressed]')).toHaveLength(0)
    expect(dialog.textContent).toMatch(/Contractors don’t take leave, so there is nothing to record here/)
    expect(screen.queryByRole('button', { name: 'Record Time Off' })).toBeNull()

    fireEvent.change(select, { target: { value: 'f1' } })
    dialog = screen.getByRole('dialog')
    fireEvent.click(Array.from(dialog.querySelectorAll('button[aria-pressed]')).find((b) => b.textContent.trim() === 'Sick'))
    const [start, end] = dialog.querySelectorAll('input[type="date"]')
    fireEvent.change(start, { target: { value: '2026-09-17' } })
    fireEvent.change(end, { target: { value: '2026-09-17' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Record Time Off' })) })
    expect(posted).toEqual([expect.objectContaining({ type: 'sick', profile_id: 'f1', location_id: 'loc1', start_date: '2026-09-17' })])
  })
})
