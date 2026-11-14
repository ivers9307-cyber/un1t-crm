// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ load: vi.fn(), approve: vi.fn(), decline: vi.fn() }))
vi.mock('@/lib/approvals/team-actions', async () => {
  const real = await vi.importActual('@/lib/approvals/team-actions')
  return {
    ...real,
    loadInvoiceRosterCheck: mocks.load,
    TEAM_ACTIONS: { ...real.TEAM_ACTIONS, contractor_invoices: { ...real.TEAM_ACTIONS.contractor_invoices, approve: mocks.approve, decline: mocks.decline } },
  }
})

import ContractorInvoiceCard from './ContractorInvoiceCard'

const item = { id: 'v1', title: 'Sam Coach', subtitle: 'October 2026', meta: 'UN1T Stillorgan', submittedAt: '2026-11-10T10:20:00Z', amount: 420, currency: 'EUR', reviewUrl: '/schedule/invoices?focus=v1' }
const check = (extra = {}) => ({
  ok: true, status: 200,
  data: {
    status: 'submitted', invoice_amount: 420, roster_unavailable: false, computed_scheduled: null,
    review_comparison: { primary: { source: 'live', comparison: { verdict: 'over', diff: 42, pct: 11.1, significant: true } } },
    ...extra,
  },
})
const renderCard = () => render(<ContractorInvoiceCard item={item} providerKey="contractor_invoices" providerLabel="Contractor invoices" timezone="Europe/Dublin" />)
const approveBtn = () => screen.getByRole('button', { name: 'Approve' })

beforeEach(() => { for (const m of Object.values(mocks)) m.mockReset() })
afterEach(cleanup)

describe('ContractorInvoiceCard', () => {
  it('keeps Approve disabled with a reason until the check has loaded, then enables it', async () => {
    let resolve
    mocks.load.mockReturnValue(new Promise((r) => { resolve = r }))
    renderCard()
    expect(approveBtn().disabled).toBe(true)
    expect(screen.getByText('Checking the roster…')).toBeTruthy()
    await act(async () => { resolve(check()) })
    expect(approveBtn().disabled).toBe(false)
    expect(screen.queryByText('Checking the roster…')).toBeNull()
  })

  it('shows an over-roster verdict on the card', async () => {
    mocks.load.mockResolvedValue(check())
    renderCard()
    expect(await screen.findByText(/€42\.00 over roster \(\+11\.1%\)/)).toBeTruthy()
  })

  it('shows the roster-unavailable note from RosterCheckNotes', async () => {
    mocks.load.mockResolvedValue(check({ roster_unavailable: true, review_comparison: null }))
    renderCard()
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not read the roster/)
  })

  it('a failed check keeps Approve disabled and Retry reloads it', async () => {
    mocks.load.mockResolvedValueOnce({ ok: false, status: 500, error: 'x' })
    renderCard()
    expect(await screen.findByText('The roster check could not be loaded.')).toBeTruthy()
    expect(approveBtn().disabled).toBe(true)
    mocks.load.mockResolvedValueOnce(check())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(approveBtn().disabled).toBe(false))
    expect(mocks.load).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('The roster check could not be loaded.')).toBeNull()
  })

  it('a thrown check also counts as failed', async () => {
    mocks.load.mockRejectedValue(new Error('boom'))
    renderCard()
    expect(await screen.findByText('The roster check could not be loaded.')).toBeTruthy()
    expect(approveBtn().disabled).toBe(true)
  })

  it('surfaces the approve route error (503 roster unreadable)', async () => {
    mocks.load.mockResolvedValue(check())
    mocks.approve.mockResolvedValue({ ok: false, status: 503, error: 'Could not read the roster. Try again.' })
    renderCard()
    await waitFor(() => expect(approveBtn().disabled).toBe(false))
    fireEvent.click(approveBtn())
    expect(await screen.findByText('Could not read the roster. Try again.')).toBeTruthy()
  })

  it('decline requires a reason', async () => {
    mocks.load.mockResolvedValue(check())
    mocks.decline.mockResolvedValue({ ok: true, status: 200 })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Wrong month' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(mocks.decline).toHaveBeenCalledWith(item, 'Wrong month'))
  })
})
