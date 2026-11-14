// @vitest-environment jsdom
// APPROVALSQ.5 — "Undo" on the requests history page after a quiet clear.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react'
import AgentRequestsClient from './AgentRequestsClient.jsx'
import { UNDO_CLEAR_WINDOW_MS } from '@/lib/approvals/undo-clear'

const contacts = { id: 'c1', name: 'Ann', first_name: 'Ann' }
const pending = { id: 'p1', kind: 'class_booking', status: 'pending', details: {}, contacts, created_at: '2026-11-01T10:00:00Z' }
const failed = { id: 'f1', kind: 'class_booking', status: 'failed', details: { starts_at: '2099-01-01T10:00:00Z', result: {} }, contacts, created_at: '2026-11-01T10:00:00Z', decided_at: '2026-11-01T11:00:00Z' }
const oldCleared = { id: 'd1', kind: 'class_booking', status: 'declined', details: { cleared: { silent: true, from_status: 'pending' } }, contacts, created_at: '2026-11-01T10:00:00Z' }

const CLEAR = "Clear, don't notify"
const row = (id) => within(document.getElementById(`agent-req-${id}`))
const bodies = () => fetch.mock.calls.filter(([, i]) => i?.method === 'PATCH').map(([, i]) => JSON.parse(i.body))
const undoCalls = () => bodies().filter((b) => b.undo_clear)
let undoStatus
let undoFor

afterEach(cleanup)
beforeEach(() => {
  undoStatus = 200
  undoFor = (id) => ({ success: true, request: { id, status: id === 'f1' ? 'failed' : 'pending', decided_at: id === 'f1' ? '2026-11-01T11:00:00Z' : null, decision_note: null, details: id === 'f1' ? failed.details : {} }, undone: true })
  globalThis.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'PATCH') {
      const id = String(url).split('/').pop()
      const body = JSON.parse(init.body)
      if (body.undo_clear) return { status: undoStatus, json: async () => (undoStatus === 200 ? undoFor(id) : { success: false, error: 'This clear can no longer be undone.' }) }
      return { status: 200, json: async () => ({ success: true, request: { id, status: 'declined', decided_at: '2026-11-14T10:00:00Z', decision_note: null, details: body.silent ? { cleared: { silent: true, from_status: id === 'f1' ? 'failed' : 'pending' } } : {} }, executed: null, customer_notified: { sent: false, channel: null, reason: 'cleared' }, planned_end_date: null }) }
    }
    return { status: 200, json: async () => ({ success: true, requests: [pending, failed, oldCleared] }) }
  })
})

const ready = () => waitFor(() => expect(document.getElementById('agent-req-p1')).toBeTruthy())

async function clearRow(id) {
  fireEvent.click(row(id).getByRole('button', { name: CLEAR }))
  fireEvent.click(row(id).getByRole('button', { name: CLEAR }))
  await waitFor(() => expect(row(id).getByText('Cleared, customer not told')).toBeTruthy())
}

describe('AgentRequestsClient undo', () => {
  it('a row cleared here shows Undo; a row that was already cleared does not', async () => {
    render(<AgentRequestsClient />)
    await ready()
    expect(row('d1').queryByRole('button', { name: 'Undo' })).toBeNull()
    await clearRow('p1')
    expect(row('p1').getByRole('button', { name: 'Undo' })).toBeTruthy()
    expect(row('d1').queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('a normal decline shows no Undo', async () => {
    render(<AgentRequestsClient />)
    await ready()
    fireEvent.click(row('p1').getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(row('p1').getByText('declined')).toBeTruthy())
    expect(row('p1').queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('Undo sends exactly { undo_clear: true } once and the request goes back to pending with its buttons', async () => {
    render(<AgentRequestsClient />)
    await ready()
    await clearRow('p1')
    const undo = row('p1').getByRole('button', { name: 'Undo' })
    fireEvent.click(undo)
    fireEvent.click(undo)
    await waitFor(() => expect(row('p1').getByRole('button', { name: 'Approve' })).toBeTruthy())
    expect(undoCalls()).toEqual([{ undo_clear: true }])
    expect(row('p1').getByRole('button', { name: CLEAR })).toBeTruthy()
    expect(row('p1').queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(row('p1').queryByText('Cleared, customer not told')).toBeNull()
  })

  it('a failed request goes back to the fix and retry list', async () => {
    render(<AgentRequestsClient />)
    await ready()
    await clearRow('f1')
    fireEvent.click(row('f1').getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(row('f1').getByRole('button', { name: CLEAR })).toBeTruthy())
    expect(row('f1').queryByText('Cleared, customer not told')).toBeNull()
    expect(screen.getByText(/Failed . fix/)).toBeTruthy()
  })

  it('a 409 shows the route\'s reason and removes the button', async () => {
    render(<AgentRequestsClient />)
    await ready()
    await clearRow('p1')
    undoStatus = 409
    fireEvent.click(row('p1').getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('This clear can no longer be undone.')).toBeTruthy()
    expect(row('p1').queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(row('p1').getByText('Cleared, customer not told')).toBeTruthy()
  })

  describe('window', () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
    afterEach(() => { vi.useRealTimers() })
    it('the button is gone after 120 seconds', async () => {
      render(<AgentRequestsClient />)
      await ready()
      await clearRow('p1')
      await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_CLEAR_WINDOW_MS + 1000) })
      expect(row('p1').queryByRole('button', { name: 'Undo' })).toBeNull()
      expect(row('p1').getByText('Cleared, customer not told')).toBeTruthy()
    })
  })
})
