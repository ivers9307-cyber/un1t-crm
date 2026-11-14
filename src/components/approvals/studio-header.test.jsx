// @vitest-environment jsdom
//
// APPROVALSQ.6 — every request a card sends about an item carries the item's
// studio as x-active-location, so the route judges it at that studio. One test
// per card family, against the REAL request helpers (nothing about the request
// is mocked, only fetch). An item without a studio sends no such header.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import AgentRequestDecideCard from '@/components/AgentRequestDecideCard'
import TrialPurchaseReviewCard from '@/components/TrialPurchaseReviewCard'
import CorpPromoClaimCard from '@/components/CorpPromoClaimCard'
import OfferPurchaseCard from './OfferPurchaseCard'
import TeamDecideCard from './TeamDecideCard'
import TimeOffCard from './TimeOffCard'
import ShiftSwapCard from './ShiftSwapCard'
import ContractorInvoiceCard from './ContractorInvoiceCard'
import BulkClearBar from './BulkClearBar'
import { runBulkUndo } from '@/lib/approvals/bulk-clear'
import { undoClearRequest } from '@/lib/approvals/undo-clear-request'

vi.mock('next/link', () => ({ default: ({ href, children, ...r }) => <a href={href} {...r}>{children}</a> }))

const H = 'x-active-location'
const AT = { studioId: 'studio-2', studioName: 'Hatch Street' }
const headerOf = (call) => (call[1].headers || {})[H]
const bodies = () => fetch.mock.calls.map(([, init]) => (init.body ? JSON.parse(init.body) : null))

const miaCleared = { success: true, request: { id: 'r1', status: 'declined', details: { cleared: { silent: true } } }, customer_notified: { sent: false, reason: 'cleared' } }
const miaApproved = { success: true, request: { id: 'r1', status: 'approved' }, executed: null, customer_notified: null }
const mia = { id: 'r1', kind: 'class_booking', contactName: 'Ann', subtitle: 'Wants a class', reviewUrl: '/x', ...AT }

function replyWith(fn) {
  globalThis.fetch = vi.fn(async (url, init) => {
    const { status = 200, body = { success: true, data: {} } } = fn(url, init, init?.body ? JSON.parse(init.body) : null)
    return { ok: status < 400, status, json: async () => body }
  })
}
beforeEach(() => replyWith(() => ({})))
afterEach(cleanup)

describe('Mia card', () => {
  it('approve sends the studio header', async () => {
    replyWith(() => ({ body: miaApproved }))
    render(<AgentRequestDecideCard item={mia} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(headerOf(fetch.mock.calls[0])).toBe('studio-2')
    expect(fetch.mock.calls[0][1].headers['Content-Type']).toBe('application/json')
  })
  it('clear sends the studio header, then undo does too', async () => {
    replyWith((_u, _i, b) => ({ body: b.undo_clear ? { success: true, request: { id: 'r1', status: 'pending', details: {} } } : miaCleared }))
    render(<AgentRequestDecideCard item={mia} />)
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    await screen.findByText('Cleared. The customer was not told.')
    expect(headerOf(fetch.mock.calls[0])).toBe('studio-2')
    expect(bodies()[0]).toMatchObject({ status: 'declined', silent: true })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(bodies()[1]).toEqual({ undo_clear: true })
    expect(headerOf(fetch.mock.calls[1])).toBe('studio-2')
  })
  it('an item with no studio sends no studio header', async () => {
    replyWith(() => ({ body: miaApproved }))
    const { studioId: _a, studioName: _b, ...plain } = mia
    render(<AgentRequestDecideCard item={plain} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty(H)
  })
})

describe('trial, corporate promo and offer cards', () => {
  it('trial', async () => {
    render(<TrialPurchaseReviewCard item={{ kind: 'grant', id: 't1', title: 'J', submittedAt: '2026-11-10T10:00:00Z', ...AT }} />)
    fireEvent.click(screen.getByText('Retry grant'))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(headerOf(fetch.mock.calls[0])).toBe('studio-2')
  })
  it('corporate promo', async () => {
    render(<CorpPromoClaimCard item={{ id: 'p1', title: 'S', submittedAt: '2026-11-10T10:00:00Z', ...AT }} />)
    fireEvent.click(screen.getByText('Mark handled'))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(headerOf(fetch.mock.calls[0])).toBe('studio-2')
  })
  it('offer', async () => {
    render(<OfferPurchaseCard item={{ id: 'o1', title: 'P', subtitle: 'x', amount: 5, submittedAt: '2026-11-10T10:00:00Z', ...AT }} />)
    fireEvent.click(screen.getByText('Mark fulfilled (emails buyer)'))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(headerOf(fetch.mock.calls[0])).toBe('studio-2')
  })
  it('none of them sends the header without a studio', async () => {
    render(<OfferPurchaseCard item={{ id: 'o1', title: 'P', subtitle: 'x', amount: 5, submittedAt: '2026-11-10T10:00:00Z' }} />)
    fireEvent.click(screen.getByText('Mark fulfilled (emails buyer)'))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(fetch.mock.calls[0][1].headers || {}).not.toHaveProperty(H)
  })
})

describe('team cards', () => {
  const base = { submittedAt: '2026-11-10T10:00:00Z', ...AT }
  it('a team action (expenses approve and decline)', async () => {
    render(<TeamDecideCard item={{ id: 'e1', title: 'Exp', ...base }} providerKey="fte_expenses" providerLabel="Expenses" />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(headerOf(fetch.mock.calls[0])).toBe('studio-2')
  })
  it('the invoice roster check, on mount', async () => {
    replyWith(() => ({ body: { success: true, data: { roster_unavailable: false, review_comparison: null } } }))
    render(<ContractorInvoiceCard item={{ id: 'v1', title: 'Inv', ...base }} providerKey="contractor_invoices" providerLabel="Invoices" />)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(fetch.mock.calls[0][0]).toBe('/api/invoices/v1')
    expect(headerOf(fetch.mock.calls[0])).toBe('studio-2')
  })
  it('unassign clashes after a time-off approve', async () => {
    const clash = (id) => ({ id, block_date: '2026-11-20', start_time: '07:00:00', template_name: 'Early', location_name: 'Hatch' })
    replyWith((url) => ({ body: url.endsWith('/unassign-clashes')
      ? { success: true, data: { removed: [{ assignment_id: 'a1' }], already_removed: [], skipped: [], failed: [] } }
      : { success: true, data: { profiles: { full_name: 'Jo' } }, clashes: [clash('a1')] } }))
    render(<TimeOffCard item={{ id: 't1', title: 'Jo', ...base }} providerKey="time_off" providerLabel="Time off" />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Unassign them' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls[1][0]).toBe('/api/schedule/time-off/t1/unassign-clashes')
    expect(headerOf(fetch.mock.calls[0])).toBe('studio-2')
    expect(headerOf(fetch.mock.calls[1])).toBe('studio-2')
  })
  it('approve anyway after a swap conflict', async () => {
    replyWith((_u, _i, b) => (b.confirm_conflicts
      ? { body: { success: true, data: {} } }
      : { status: 409, body: { success: false, code: 'swap_conflicts', error: 'x', conflicts: [{ message: 'On leave.' }] } }))
    render(<ShiftSwapCard item={{ id: 's1', title: 'Swap', ...base }} providerKey="shift_swaps" providerLabel="Swaps" />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Approve anyway' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(bodies()[1]).toMatchObject({ confirm_conflicts: true })
    expect(headerOf(fetch.mock.calls[0])).toBe('studio-2')
    expect(headerOf(fetch.mock.calls[1])).toBe('studio-2')
  })
})

describe('bulk clear and bulk undo send each id with its own studio', () => {
  const items = [
    { id: 'm1', providerKey: 'agent_requests', kind: 'class_booking', studioId: 'studio-1' },
    { id: 'm2', providerKey: 'agent_requests', kind: 'class_booking', studioId: 'studio-2' },
    { id: 'm3', providerKey: 'agent_requests', kind: 'class_booking' },
  ]
  it('clear', async () => {
    const onFinished = vi.fn()
    render(<BulkClearBar items={items} onSelectAll={() => {}} onCancel={() => {}} onFinished={onFinished} />)
    fireEvent.click(screen.getAllByRole('button', { name: "Clear, don't notify" })[0])
    fireEvent.click(screen.getByRole('button', { name: "Clear 3 requests, don't notify" }))
    await waitFor(() => expect(onFinished).toHaveBeenCalled())
    const sent = fetch.mock.calls.map((c) => [c[0].split('/').pop(), headerOf(c)])
    expect(sent).toEqual([['m1', 'studio-1'], ['m2', 'studio-2'], ['m3', undefined]])
    expect(onFinished.mock.calls[0][0].cleared).toEqual(items)
  })
  it('undo', async () => {
    const res = await runBulkUndo(items, { undoOne: (it) => undoClearRequest(it) })
    expect(res.restored).toEqual(items)
    const sent = fetch.mock.calls.map((c) => [c[0].split('/').pop(), headerOf(c)])
    expect(sent).toEqual([['m1', 'studio-1'], ['m2', 'studio-2'], ['m3', undefined]])
  })
})
