// @vitest-environment jsdom
// APPROVALSQ.1 — "Clear, don't notify" on the inbox approval card.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
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
    const line = await screen.findByText('Cleared, customer not told.')
    expect(line.parentElement.textContent).not.toContain('please follow up')
    expect(document.body.textContent).not.toContain('NOT told')
    expect(JSON.parse(patchCalls()[0][1].body)).toEqual({ status: 'declined', silent: true, decision_note: 'dup' })
    expect(suggestCalls()).toHaveLength(0)
    expect(onPrefillComposer).not.toHaveBeenCalled()
    expect(onDecided).toHaveBeenCalledTimes(1)
  })

  it('the clear confirm warns on a pending class booking and not on a pause', () => {
    const { unmount } = render(<ApprovalActionCard request={request} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    expect(screen.getByText('Mia told this customer the team would confirm. Clearing sends them nothing.')).toBeTruthy()
    unmount()
    render(<ApprovalActionCard request={{ ...request, kind: 'pause' }} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    expect(screen.queryByText(/Mia told this customer/)).toBeNull()
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

  it('a cleared request with a staff note separates it from the cleared line', () => {
    const { container } = render(<ApprovalActionCard request={{ ...request, status: 'declined', decision_note: 'dup', details: { cleared: { silent: true, from_status: 'pending' } } }} />)
    expect(container.textContent).toContain('Cleared, customer not told. dup')
  })

  it('a cleared request with a name and a staff note keeps both in order', () => {
    const { container } = render(<ApprovalActionCard request={{ ...request, status: 'declined', decision_note: 'dup', details: { cleared: { silent: true } }, decided_by_name: 'Sarah', decided_at: '2026-11-14T16:20:00Z' }} />)
    expect(container.textContent).toMatch(/Cleared, customer not told · by Sarah, 14 Nov 2026, \d\d:\d\d\. dup/)
  })

  it('a cleared request seen again shows the cleared line and no next steps', () => {
    const { container } = render(<ApprovalActionCard request={{ ...request, status: 'declined', details: { cleared: { silent: true, from_status: 'pending' } } }} />)
    expect(screen.getByText('Cleared, customer not told.')).toBeTruthy()
    expect(container.textContent).not.toContain('please follow up')
    expect(container.textContent).not.toContain('Next steps')
  })

  it('a cleared request shows who cleared it and when, and still no follow-up line', () => {
    render(<ApprovalActionCard request={{ ...request, status: 'declined', details: { cleared: { silent: true, from_status: 'pending' } }, decided_by_name: 'Sarah', decided_at: '2026-11-14T16:20:00Z' }} />)
    const line = screen.getByText(/^Cleared, customer not told/).parentElement.textContent
    expect(line).toMatch(/Cleared, customer not told · by Sarah, 14 Nov 2026, \d\d:\d\d\./)
    expect(line).not.toContain('please follow up')
  })

  it('a cleared request with no name shows only the time', () => {
    render(<ApprovalActionCard request={{ ...request, status: 'declined', details: { cleared: { silent: true } }, decided_at: '2026-11-14T16:20:00Z' }} />)
    const line = screen.getByText(/^Cleared, customer not told/).parentElement.textContent
    expect(line).toMatch(/Cleared, customer not told · 14 Nov 2026, \d\d:\d\d\./)
    expect(line).not.toContain(' by ')
  })
})

describe('ApprovalActionCard separate notes (APPROVALSQ.3)', () => {
  const noteBox = () => screen.getByPlaceholderText('Note (optional)')

  it('a note typed in decline does not appear in clear', () => {
    render(<ApprovalActionCard request={request} />)
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    fireEvent.change(noteBox(), { target: { value: 'for decline' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    expect(noteBox().value).toBe('')
  })

  it('a note typed in clear does not appear in decline', () => {
    render(<ApprovalActionCard request={request} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.change(noteBox(), { target: { value: 'for clear' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(noteBox().value).toBe('')
  })

  it('the clear PATCH carries only the clear note and the decline PATCH only the decline note', async () => {
    reply = cleared
    const { unmount } = render(<ApprovalActionCard request={request} />)
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    fireEvent.change(noteBox(), { target: { value: 'declinenote' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.change(noteBox(), { target: { value: 'clearnote' } })
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    await screen.findByText('Cleared, customer not told.')
    expect(JSON.parse(patchCalls()[0][1].body).decision_note).toBe('clearnote')
    unmount()

    fetch.mockClear()
    reply = declined
    render(<ApprovalActionCard request={request} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.change(noteBox(), { target: { value: 'clearnote' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    fireEvent.change(noteBox(), { target: { value: 'declinenote' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm decline' }))
    await waitFor(() => expect(patchCalls()).toHaveLength(1))
    const note = JSON.parse(patchCalls()[0][1].body).decision_note
    expect(note).toMatch(/declinenote$/)
    expect(note).not.toContain('clearnote')
  })
})


// APPROVALSQ.5 review fix: the restored overlay must not outlive a decision.
describe('ApprovalActionCard after an undo', () => {
  const undone = { success: true, request: { id: request.id, status: 'pending', decided_at: null, decision_note: null, details: {} }, undone: true }
  const approved = { success: true, request: { id: request.id, status: 'approved' }, executed: null, customer_notified: null, planned_end_date: null }
  const replyFor = (body, decide) => (body.undo_clear ? undone : body.silent ? cleared : decide)

  // A parent that does what the thread does: replaces the request with what onDecided hands back.
  function Parent({ initial = request }) {
    const [req, setReq] = useState(initial)
    return <ApprovalActionCard request={req} onDecided={setReq} />
  }
  async function clearAndUndo(ui) {
    const view = render(ui)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    await screen.findByText('Cleared, customer not told.')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await screen.findByRole('button', { name: 'Approve' })
    return view
  }

  it('clear, Undo, Approve shows the approved state and no buttons', async () => {
    globalThis.fetch = vi.fn(async (url, init) => ({ status: 200, json: async () => replyFor(JSON.parse(init.body), approved) }))
    await clearAndUndo(<Parent />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Approved')
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
  })

  it('clear, Undo, Decline shows the declined state and no buttons', async () => {
    globalThis.fetch = vi.fn(async (url, init) => ({ status: 200, json: async () => replyFor(JSON.parse(init.body), declined) }))
    await clearAndUndo(<Parent />)
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm decline' }))
    await screen.findByText('Declined')
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
  })

  it('clear, Undo, then the parent delivers a request someone else actioned: the card shows that', async () => {
    globalThis.fetch = vi.fn(async (url, init) => ({ status: 200, json: async () => replyFor(JSON.parse(init.body), approved) }))
    const { rerender } = await clearAndUndo(<ApprovalActionCard request={request} onDecided={() => {}} />)
    rerender(<ApprovalActionCard request={{ ...request, status: 'actioned' }} onDecided={() => {}} />)
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('clear, Undo, with the parent still sending the stale declined row keeps showing pending', async () => {
    globalThis.fetch = vi.fn(async (url, init) => ({ status: 200, json: async () => replyFor(JSON.parse(init.body), approved) }))
    const stale = { ...request, ...cleared.request }
    const { rerender } = render(<ApprovalActionCard request={request} onDecided={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    await screen.findByText('Cleared, customer not told.')
    rerender(<ApprovalActionCard request={stale} onDecided={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await screen.findByRole('button', { name: 'Approve' })
    rerender(<ApprovalActionCard request={{ ...stale }} onDecided={() => {}} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.queryByText(/Cleared, customer not told/)).toBeNull()
  })
})
