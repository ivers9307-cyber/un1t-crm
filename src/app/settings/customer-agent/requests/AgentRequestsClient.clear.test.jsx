// @vitest-environment jsdom
// APPROVALSQ.1 — "Clear, don't notify" on the requests history page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import AgentRequestsClient from './AgentRequestsClient.jsx'

const contacts = { id: 'c1', name: 'Ann', first_name: 'Ann' }
const pending = { id: 'p1', kind: 'class_booking', status: 'pending', details: {}, contacts, created_at: '2026-11-01T10:00:00Z' }
const failed = { id: 'f1', kind: 'class_booking', status: 'failed', details: { starts_at: '2099-01-01T10:00:00Z', result: {} }, contacts, created_at: '2026-11-01T10:00:00Z', decided_at: '2026-11-01T11:00:00Z' }
const stuck = { id: 's1', kind: 'class_booking', status: 'approved', details: { execution: { stage: 'executing', started_at: '2020-01-01T00:00:00Z' } }, contacts, created_at: '2026-11-01T10:00:00Z' }
const clearedRow = { id: 'd1', kind: 'class_booking', status: 'declined', details: { cleared: { silent: true, from_status: 'pending' } }, contacts, created_at: '2026-11-01T10:00:00Z' }
const declinedRow = { id: 'd2', kind: 'class_booking', status: 'declined', details: {}, contacts, created_at: '2026-11-01T10:00:00Z' }

const CLEAR = "Clear, don't notify"
const row = (id) => within(document.getElementById(`agent-req-${id}`))
let list
const patchCalls = () => fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')

afterEach(cleanup)
beforeEach(() => {
  list = [pending, failed, stuck, clearedRow, declinedRow]
  globalThis.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'PATCH') {
      return { status: 200, json: async () => ({ success: true, request: { id: 'p1', status: 'declined', decided_at: '2026-11-14T10:00:00Z', decision_note: 'dup', details: { cleared: { silent: true, from_status: 'pending' } } }, executed: null, customer_notified: { sent: false, channel: null, reason: 'cleared' }, planned_end_date: null }) }
    }
    return { status: 200, json: async () => ({ success: true, requests: list }) }
  })
})

describe('AgentRequestsClient clear', () => {
  it('offers the clear on pending and failed rows, not on a stuck row', async () => {
    render(<AgentRequestsClient />)
    await screen.findByText('Needs a retry')
    expect(row('p1').getByRole('button', { name: CLEAR })).toBeTruthy()
    expect(row('f1').getByRole('button', { name: CLEAR })).toBeTruthy()
    expect(row('s1').queryByRole('button', { name: CLEAR })).toBeNull()
  })

  it('never fires from a single click, then sends one silent decline with the note', async () => {
    render(<AgentRequestsClient />)
    await screen.findByText('Needs a retry')
    fireEvent.click(row('p1').getByRole('button', { name: CLEAR }))
    expect(patchCalls()).toHaveLength(0)
    fireEvent.change(row('p1').getByPlaceholderText('Note (optional)'), { target: { value: 'dup' } })
    const confirm = row('p1').getByRole('button', { name: CLEAR })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => expect(patchCalls()).toHaveLength(1))
    expect(JSON.parse(patchCalls()[0][1].body)).toEqual({ status: 'declined', silent: true, decision_note: 'dup' })
    // The row moves to the decided list, labelled as cleared.
    await waitFor(() => expect(row('p1').getByText('Cleared, customer not told')).toBeTruthy())
  })

  it('a plain decline still sends only the status', async () => {
    render(<AgentRequestsClient />)
    await screen.findByText('Needs a retry')
    fireEvent.click(row('p1').getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(patchCalls()).toHaveLength(1))
    expect(JSON.parse(patchCalls()[0][1].body)).toEqual({ status: 'declined' })
  })

  it('labels a silently cleared row "Cleared, customer not told" and a plain decline "declined"', async () => {
    render(<AgentRequestsClient />)
    await screen.findByText('Needs a retry')
    expect(row('d1').getByText('Cleared, customer not told')).toBeTruthy()
    expect(row('d1').queryByText('declined')).toBeNull()
    expect(row('d2').getByText('declined')).toBeTruthy()
  })
})
