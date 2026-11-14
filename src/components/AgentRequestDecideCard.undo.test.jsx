// @vitest-environment jsdom
// APPROVALSQ.5 — "Undo" on the Mia card after a quiet clear.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import AgentRequestDecideCard from './AgentRequestDecideCard'
import { UNDO_CLEAR_WINDOW_MS } from '@/lib/approvals/undo-clear'

const base = { id: 'r1', kind: 'class_booking', contactName: 'Ann', subtitle: 'Wants a class', reviewUrl: '/x' }
const clearedReply = { success: true, request: { id: 'r1', status: 'declined', details: { cleared: { silent: true, from_status: 'pending' } } }, executed: null, customer_notified: { sent: false, channel: null, reason: 'cleared' }, planned_end_date: null }
const approvedReply = { success: true, request: { id: 'r1', status: 'approved' }, executed: null, customer_notified: null, planned_end_date: null }
const declinedReply = { success: true, request: { id: 'r1', status: 'declined' }, executed: null, customer_notified: null, planned_end_date: null }

let undoReply
let undoStatus
const sent = () => fetch.mock.calls.map(([, init]) => JSON.parse(init.body))
const undoCalls = () => sent().filter((b) => b.undo_clear)

afterEach(cleanup)
beforeEach(() => {
  undoReply = { success: true, request: { id: 'r1', status: 'pending', details: {} }, undone: true }
  undoStatus = 200
  globalThis.fetch = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.undo_clear) return { status: undoStatus, json: async () => undoReply }
    if (body.silent) return { status: 200, json: async () => clearedReply }
    return { status: 200, json: async () => (body.status === 'approved' ? approvedReply : declinedReply) }
  })
})

async function clearIt(item = base, props = {}) {
  render(<AgentRequestDecideCard item={item} {...props} />)
  fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
  fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
  await screen.findByText('Cleared. The customer was not told.')
}

describe('AgentRequestDecideCard undo', () => {
  it('offers Undo beside the cleared line', async () => {
    await clearIt()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })

  it('offers no Undo after an approve or a normal decline', async () => {
    const { unmount } = render(<AgentRequestDecideCard item={base} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText(/^Done|^Approved/)
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    unmount()
    render(<AgentRequestDecideCard item={base} />)
    fireEvent.click(screen.getByRole('button', { name: 'Decline and tell them' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm decline' }))
    await screen.findByText(/Declined/)
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('Undo sends exactly { undo_clear: true } to the request', async () => {
    await clearIt()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(undoCalls()).toHaveLength(1))
    expect(sent().at(-1)).toEqual({ undo_clear: true })
    expect(fetch.mock.calls.at(-1)[0]).toBe('/api/agent/membership-requests/r1')
  })

  it('a double press sends one request', async () => {
    await clearIt()
    const undo = screen.getByRole('button', { name: 'Undo' })
    fireEvent.click(undo)
    fireEvent.click(undo)
    await waitFor(() => expect(screen.queryByText('Cleared. The customer was not told.')).toBeNull())
    expect(undoCalls()).toHaveLength(1)
  })

  it('success brings the buttons back, drops the outcome and calls onUndone once', async () => {
    const onDecided = vi.fn()
    const onUndone = vi.fn()
    await clearIt(base, { onDecided, onUndone })
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Decline and tell them' })).toBeTruthy()
    expect(screen.getByRole('button', { name: "Clear, don't notify" })).toBeTruthy()
    expect(screen.queryByText('Cleared. The customer was not told.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(onDecided).toHaveBeenCalledTimes(1)
    expect(onUndone).toHaveBeenCalledTimes(1)
    expect(onUndone).toHaveBeenCalledWith('r1', undoReply.request)
  })

  it('a failed card comes back as a failed card with its retry', async () => {
    undoReply = { success: true, request: { id: 'r1', status: 'failed', details: {} }, undone: true }
    await clearIt({ ...base, failed: true, details: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixed it, retry' })).toBeTruthy())
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Decline and tell them' })).toBeNull()
  })

  it('it can be cleared again after an undo, and the parent is told again', async () => {
    const onDecided = vi.fn()
    await clearIt(base, { onDecided })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    await screen.findByText('Cleared. The customer was not told.')
    expect(onDecided).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })

  it('a 409 shows the route\'s reason and removes the button', async () => {
    undoStatus = 409
    undoReply = { success: false, error: 'This clear can no longer be undone.' }
    const onUndone = vi.fn()
    await clearIt(base, { onUndone })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('This clear can no longer be undone.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(screen.getByText('Cleared. The customer was not told.')).toBeTruthy()
    expect(onUndone).not.toHaveBeenCalled()
  })

  it('another failure shows the reason and keeps the button for a retry', async () => {
    undoStatus = 500
    undoReply = { success: false, error: 'Something broke.' }
    await clearIt()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Something broke.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })
})

describe('AgentRequestDecideCard undo window', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  it('the button is gone after 120 seconds and still there just before', async () => {
    await clearIt()
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_CLEAR_WINDOW_MS - 5000) })
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(screen.getByText('Cleared. The customer was not told.')).toBeTruthy()
  })
})
