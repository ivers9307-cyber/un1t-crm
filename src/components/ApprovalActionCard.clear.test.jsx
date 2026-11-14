// @vitest-environment jsdom
// APPROVALSQ.1 — "Clear, don't notify" on the inbox approval card.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('@/components/SequencePicker', () => ({ default: () => null }))

const { default: ApprovalActionCard } = await import('./ApprovalActionCard.jsx')

const request = {
  id: 'a0000000-0000-4000-8000-000000000001',
  kind: 'class_booking',
  status: 'pending',
  details: {},
  decision_note: null,
}
const cleared = { success: true, request: { id: request.id, status: 'declined', decided_at: 'x', decision_note: null, details: { cleared: { silent: true, from_status: 'pending' } } }, executed: null, customer_notified: { sent: false, channel: null, reason: 'cleared' }, planned_end_date: null }
const declined = { success: true, request: { id: request.id, status: 'declined' }, executed: null, customer_notified: null, planned_end_date: null }

let reply
const suggestCalls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/suggest'))
const patchCalls = () => fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')

afterEach(cleanup)
beforeEach(() => {
  reply = cleared
  globalThis.fetch = vi.fn(async () => ({ status: 200, json: async () => reply }))
})

describe('ApprovalActionCard clear', () => {
  it("Clear, don't notify sends silent:true, fetches no suggestion and prefills nothing", async () => {
    const onPrefillComposer = vi.fn()
    const onDecided = vi.fn()
    render(<ApprovalActionCard request={request} onPrefillComposer={onPrefillComposer} onDecided={onDecided} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    // Opening the confirm step sends nothing.
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText('Note (optional)'), { target: { value: 'dup' } })
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    expect(await screen.findByText(/Cleared, customer not told/)).toBeTruthy()
    expect(JSON.parse(patchCalls()[0][1].body)).toEqual({ status: 'declined', silent: true, decision_note: 'dup' })
    expect(suggestCalls()).toHaveLength(0)
    expect(onPrefillComposer).not.toHaveBeenCalled()
    expect(onDecided).toHaveBeenCalledTimes(1)
  })

  it('a double click on confirm sends one request', async () => {
    render(<ApprovalActionCard request={request} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    const confirm = screen.getByRole('button', { name: "Clear, don't notify" })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await screen.findByText(/Cleared, customer not told/)
    expect(patchCalls()).toHaveLength(1)
  })

  it('a plain decline still fetches the suggestion and prefills the composer', async () => {
    reply = declined
    const onPrefillComposer = vi.fn()
    render(<ApprovalActionCard request={request} onPrefillComposer={onPrefillComposer} contactFirstName="Ann" />)
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm decline' }))
    await waitFor(() => expect(suggestCalls()).toHaveLength(1))
    expect(JSON.parse(patchCalls()[0][1].body)).toEqual({ status: 'declined', decision_note: 'Class full' })
    expect(onPrefillComposer).toHaveBeenCalledTimes(1)
  })

  it('a cleared request seen again shows the cleared line and no next steps', () => {
    const { container } = render(<ApprovalActionCard request={{ ...request, status: 'declined', details: { cleared: { silent: true, from_status: 'pending' } } }} />)
    expect(screen.getByText(/Cleared, customer not told/)).toBeTruthy()
    expect(container.textContent).not.toContain('Next steps')
  })
})
