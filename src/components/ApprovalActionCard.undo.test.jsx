// @vitest-environment jsdom
// APPROVALSQ.5 — "Undo" on the inbox approval card after a quiet clear.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { UNDO_CLEAR_WINDOW_MS } from '@/lib/approvals/undo-clear'

vi.mock('@/components/SequencePicker', () => ({ default: () => null }))

const { default: ApprovalActionCard } = await import('./ApprovalActionCard.jsx')

const id = 'a0000000-0000-4000-8000-000000000001'
const request = { id, kind: 'class_booking', status: 'pending', details: {}, decision_note: null }
const clearedReply = { success: true, request: { id, status: 'declined', decided_at: 'x', decision_note: null, details: { cleared: { silent: true, from_status: 'pending' } } }, executed: null, customer_notified: { sent: false, channel: null, reason: 'cleared' }, planned_end_date: null }
const declinedReply = { success: true, request: { id, status: 'declined' }, executed: null, customer_notified: null, planned_end_date: null }

let undoReply
let undoStatus
const bodies = () => fetch.mock.calls.filter(([, i]) => i?.method === 'PATCH').map(([, i]) => JSON.parse(i.body))
const undoCalls = () => bodies().filter((b) => b.undo_clear)

afterEach(cleanup)
beforeEach(() => {
  undoReply = { success: true, request: { id, status: 'pending', decided_at: null, decision_note: null, details: {} }, undone: true }
  undoStatus = 200
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url).endsWith('/suggest')) return { status: 200, json: async () => ({ success: false }) }
    const body = JSON.parse(init.body)
    if (body.undo_clear) return { status: undoStatus, json: async () => undoReply }
    return { status: 200, json: async () => (body.silent ? clearedReply : declinedReply) }
  })
})

async function clearIt(props = {}, req = request) {
  render(<ApprovalActionCard request={req} {...props} />)
  fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
  fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
  await screen.findByText(/Cleared, customer not told/)
}

describe('ApprovalActionCard undo', () => {
  it('a clear made here offers Undo, a request seen already cleared does not', async () => {
    await clearIt()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
    cleanup()
    render(<ApprovalActionCard request={{ ...request, status: 'declined', details: { cleared: { silent: true } } }} />)
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('a normal decline offers no Undo', async () => {
    render(<ApprovalActionCard request={request} />)
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm decline' }))
    await waitFor(() => expect(bodies()).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm decline' }).disabled).toBe(false))
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('Undo sends exactly { undo_clear: true }, once for a double press, and brings the buttons back', async () => {
    const onDecided = vi.fn()
    await clearIt({ onDecided })
    const undo = screen.getByRole('button', { name: 'Undo' })
    fireEvent.click(undo)
    fireEvent.click(undo)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy())
    expect(undoCalls()).toEqual([{ undo_clear: true }])
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy()
    expect(screen.getByRole('button', { name: "Clear, don't notify" })).toBeTruthy()
    expect(screen.queryByText(/Cleared, customer not told/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    // the thread's copy of the request is put back too
    expect(onDecided).toHaveBeenLastCalledWith(expect.objectContaining({ id, status: 'pending' }))
  })

  it('still restores the buttons when the parent had already replaced the request with the cleared one', async () => {
    const { rerender } = render(<ApprovalActionCard request={request} onDecided={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    await screen.findByText(/Cleared, customer not told/)
    rerender(<ApprovalActionCard request={{ ...request, ...clearedReply.request }} onDecided={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy())
    expect(screen.queryByText(/Cleared, customer not told/)).toBeNull()
  })

  it('a 409 shows the route\'s reason and removes the button', async () => {
    undoStatus = 409
    undoReply = { success: false, error: 'This clear can no longer be undone.' }
    await clearIt()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('This clear can no longer be undone.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  describe('window', () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
    afterEach(() => { vi.useRealTimers() })
    it('the button is gone after 120 seconds', async () => {
      await clearIt()
      await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_CLEAR_WINDOW_MS + 1000) })
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
      expect(screen.getByText(/Cleared, customer not told/)).toBeTruthy()
    })
  })
})
