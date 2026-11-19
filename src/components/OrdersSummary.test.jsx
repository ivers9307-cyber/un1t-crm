// @vitest-environment jsdom
// ORDERSVIEW.1 — the owner totals above the Orders list.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
import OrdersSummary from './OrdersSummary.jsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const DATA = {
  totals: [
    { location_id: 'L1', source_type: 'offer_purchase', currency: 'EUR', orders: 2, gross_cents: 20000, refunded_cents: 5000, net_cents: 15000 },
    { location_id: 'L1', source_type: 'donation', currency: 'EUR', orders: 1, gross_cents: 2500, refunded_cents: 0, net_cents: 2500 },
  ],
  studios: [{ id: 'L1', name: 'Hatch' }],
  refunds: [
    { id: 'r1', order_id: 'o1', amount_cents: 5000, currency: 'EUR', reason: 'Changed their mind', status: 'completed', declined: true, order: { source_type: 'offer_purchase', contact_name: 'Ann' } },
  ],
  truncated: false,
}
const stub = (body, ok = true, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status, json: async () => body })))

describe('OrdersSummary', () => {
  it('shows taken, refunded and kept, a row per kind, and the refunds', async () => {
    stub({ success: true, data: DATA })
    render(<OrdersSummary />)
    expect(await screen.findByText('€225.00')).toBeTruthy()
    expect(screen.getAllByText('€50.00').length).toBeGreaterThan(0)
    expect(screen.getByText('€175.00')).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'Offer' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'Donation' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: 'Studio' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Ann' }).getAttribute('href')).toBe('/orders/o1')
    expect(screen.getByText(/Revolut declined this refund/)).toBeTruthy()
  })

  it('asks for the last 30 days first, and nothing when All time is picked', async () => {
    stub({ success: true, data: DATA })
    render(<OrdersSummary />)
    await screen.findByText('€225.00')
    expect(String(fetch.mock.calls[0][0])).toMatch(/from=/)
    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), { target: { value: 'all' } })
    await screen.findByText('€225.00')
    expect(String(fetch.mock.calls.at(-1)[0])).not.toMatch(/from=/)
  })

  it('a failed load says so instead of showing zero', async () => {
    stub({ success: false, error: 'Could not load the totals. Try again.' }, false, 503)
    render(<OrdersSummary />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load the totals/)
    expect(screen.queryByText('€0.00')).toBeNull()
  })
})
