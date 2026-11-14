// @vitest-environment jsdom
// APPROVALSQ.1 — "Clear, don't notify" on the Mia request card.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import AgentRequestDecideCard from './AgentRequestDecideCard'

const base = { id: 'r1', kind: 'class_booking', contactName: 'Ann', subtitle: 'Wants a class', reviewUrl: '/x' }
const ok = { success: true, request: { status: 'declined' }, executed: null, customer_notified: { sent: false, channel: null, reason: 'cleared' }, planned_end_date: null }

afterEach(cleanup)
beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ status: 200, json: async () => ok }))
})

describe('AgentRequestDecideCard clear', () => {
  it("a waiting card offers Approve, Decline and tell them, Clear, don't notify", () => {
    render(<AgentRequestDecideCard item={base} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Decline and tell them' })).toBeTruthy()
    expect(screen.getByRole('button', { name: "Clear, don't notify" })).toBeTruthy()
  })

  it("a failed card offers Fixed it, retry and Clear, don't notify, and no Decline and tell them", () => {
    render(<AgentRequestDecideCard item={{ ...base, failed: true, details: {} }} />)
    expect(screen.getByRole('button', { name: 'Fixed it, retry' })).toBeTruthy()
    expect(screen.getByRole('button', { name: "Clear, don't notify" })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Decline and tell them' })).toBeNull()
  })

  it('the confirm warns on a waiting class booking and not on a pause', () => {
    const { unmount } = render(<AgentRequestDecideCard item={base} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    expect(screen.getByText('Mia told this customer the team would confirm. Clearing sends them nothing.')).toBeTruthy()
    unmount()
    render(<AgentRequestDecideCard item={{ ...base, kind: 'pause' }} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    expect(screen.queryByText(/Clearing sends them nothing/)).toBeNull()
  })

  it('confirming sends a silent decline and shows the cleared line', async () => {
    render(<AgentRequestDecideCard item={base} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.change(screen.getByPlaceholderText('Note (optional)'), { target: { value: 'dup' } })
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    expect(await screen.findByText('Cleared. The customer was not told.')).toBeTruthy()
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ status: 'declined', silent: true, decision_note: 'dup' })
  })

  it('a double click on confirm sends one request', async () => {
    render(<AgentRequestDecideCard item={base} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    const confirm = screen.getByRole('button', { name: "Clear, don't notify" })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await screen.findByText('Cleared. The customer was not told.')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('calls onDecided once', async () => {
    const onDecided = vi.fn()
    render(<AgentRequestDecideCard item={base} onDecided={onDecided} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1))
    expect(onDecided).toHaveBeenCalledWith('r1', ok.request)
  })
})
