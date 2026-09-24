// @vitest-environment jsdom
//
// LEAVECANCEL.1 — the dashboard's My requests card lists PENDING time off only
// and treated any 2xx from the cancel PUT as "cancelled". If the request was
// approved while the card sat open and a manager clicks Cancel, the server now
// answers { success: true, cancellation: 'requested' }: nothing was cancelled,
// an owner was asked. The refresh then drops the row from this pending-only
// list, which reads exactly like a cancel. The card has to say what happened.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { LEAVE_CANCEL_NOTICES } from '@/lib/time-off-cancel-copy'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import MyRequests from '@/components/dashboard/MyRequests'

const PENDING = { id: 't1', type: 'holiday', status: 'pending', start_date: '2026-10-05', end_date: '2026-10-07' }

function answer(body, status = 200) {
  global.fetch = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); refresh.mockClear() })

describe('MyRequests — cancelling time off', () => {
  it('"requested" is said out loud, in the Time Off page\'s own words, and survives the refresh that removes the row', async () => {
    answer({ success: true, data: {}, cancellation: 'requested' })
    const view = render(<MyRequests timeOff={[PENDING]} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(LEAVE_CANCEL_NOTICES.requested))
    expect(screen.getByRole('status').textContent).toMatch(/still approved/)
    expect(refresh).toHaveBeenCalledTimes(1)

    // What router.refresh() does next: the row is no longer pending, so it goes.
    view.rerender(<MyRequests timeOff={[]} />)
    expect(screen.getByRole('status').textContent).toContain(LEAVE_CANCEL_NOTICES.requested)
    expect(global.fetch).toHaveBeenCalledWith('/api/schedule/time-off/t1', expect.objectContaining({ method: 'PUT' }))
  })

  it('a plain cancel says nothing extra: the row going IS the news', async () => {
    answer({ success: true, data: {} })
    render(<MyRequests timeOff={[PENDING]} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a refusal is shown in the server\'s own words instead of only reaching the console, and nothing is refreshed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    answer({ success: false, error: 'An owner declined this less than a day ago. You can ask again after 24 hours, or speak to them directly.' }, 409)
    render(<MyRequests timeOff={[PENDING]} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/declined this less than a day ago/))
    expect(refresh).not.toHaveBeenCalled()
  })
})
