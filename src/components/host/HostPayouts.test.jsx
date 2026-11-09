// @vitest-environment jsdom
// HOSTPORTAL.1 — one payouts fetch feeds both Balance and Payouts.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

const { HostPayoutsProvider, HostBalance, HostPayoutList } = await import('./HostPayouts.jsx')

const DATA = {
  balance: { available_cents: 12000, pending_cents: 3400, currency: 'EUR' },
  payouts: [{ id: 'po_1', amount: 5000, currency: 'EUR', status: 'paid', arrival_date: 1790000000 }],
}

function stubFetch(body, ok = true) {
  const fn = vi.fn(async () => ({ ok, json: async () => body }))
  vi.stubGlobal('fetch', fn)
  return fn
}

function Page() {
  return (
    <HostPayoutsProvider>
      <HostBalance />
      <HostPayoutList />
    </HostPayoutsProvider>
  )
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('HostPayouts', () => {
  it('renders neither heading when the fetch returns no data', async () => {
    const fetchFn = stubFetch({ success: true, data: null })
    render(<Page />)
    await waitFor(() => expect(fetchFn).toHaveBeenCalled())
    expect(screen.queryByText('Balance')).toBeNull()
    expect(screen.queryByText('Payouts')).toBeNull()
  })

  it('renders neither heading when the fetch fails', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', fetchFn)
    render(<Page />)
    await waitFor(() => expect(fetchFn).toHaveBeenCalled())
    expect(screen.queryByText('Balance')).toBeNull()
    expect(screen.queryByText('Payouts')).toBeNull()
  })

  it('renders Balance and Payouts from one fetch', async () => {
    const fetchFn = stubFetch({ success: true, data: DATA })
    render(<Page />)
    await screen.findByText('Balance')
    expect(screen.getByText('Payouts')).toBeTruthy()
    expect(screen.getByText('Available')).toBeTruthy()
    expect(screen.getByText('On the way')).toBeTruthy()
    expect(screen.getByText('€120.00')).toBeTruthy()
    expect(screen.getByText('€50.00')).toBeTruthy()
    expect(screen.getByText('Paid')).toBeTruthy()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('says there are no payouts when the list is empty', async () => {
    stubFetch({ success: true, data: { ...DATA, payouts: [] } })
    render(<Page />)
    await screen.findByText('No payouts yet.')
  })
})
