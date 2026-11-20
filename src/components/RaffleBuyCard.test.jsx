// @vitest-environment jsdom
//
// RAFFLE.3 — the online raffle card: shows the closing time, prices an option,
// posts quantity + name + email (never a price), and says when sales closed.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import RaffleBuyCard from './RaffleBuyCard.jsx'

vi.mock('./landing-page/ClassFunnelCheckout', () => ({ default: ({ priceLabel }) => <div>Checkout: {priceLabel}</div> }))

const RAFFLE = {
  name: 'Charity Raffle', currency: 'EUR', ticket_price_cents: 500,
  ticket_options: [{ tickets: 3, price_cents: 1000 }], max_tickets: 50,
  open: true, closes_label: 'Monday, 23 November at 1:30 pm',
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaffleBuyCard', () => {
  it('buys the 3-ticket option and opens the checkout', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url: String(url), opts })
      return { ok: true, status: 200, json: async () => ({ success: true, data: { order: { id: 'o1', amount_cents: 1000, currency: 'EUR', quantity: 3, checkout: { provider: 'revolut', token: 't' } } } }) }
    }))
    render(<RaffleBuyCard slug="day" raffle={RAFFLE} />)
    expect(screen.getByText(/Online sales close Monday, 23 November at 1:30 pm/)).toBeTruthy()
    expect(screen.getByText(/Buy 3 tickets · €10.00/)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Your name *'), { target: { value: 'Ann Kelly' } })
    fireEvent.change(screen.getByPlaceholderText('Your email *'), { target: { value: 'ann@example.test' } })
    fireEvent.click(screen.getByText(/Buy 3 tickets/))
    await screen.findByText(/Checkout: 3 raffle tickets · €10.00/)
    expect(calls[0].url).toBe('/api/public/events/day/raffle')
    expect(JSON.parse(calls[0].opts.body)).toEqual({ quantity: 3, name: 'Ann Kelly', email: 'ann@example.test' })
  })

  it('a custom number is priced per ticket', () => {
    render(<RaffleBuyCard slug="day" raffle={RAFFLE} />)
    fireEvent.click(screen.getByLabelText('One more'))
    expect(screen.getByText(/Buy 4 tickets · €20.00/)).toBeTruthy()
  })

  it('needs a name and a valid email', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    render(<RaffleBuyCard slug="day" raffle={RAFFLE} />)
    fireEvent.click(screen.getByText(/Buy 3 tickets/))
    await waitFor(() => expect(screen.getByText('Enter your name')).toBeTruthy())
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('says when online sales have closed', () => {
    render(<RaffleBuyCard slug="day" raffle={{ ...RAFFLE, open: false }} />)
    expect(screen.getByText(/Online raffle sales have closed/)).toBeTruthy()
    expect(screen.queryByText(/Buy/)).toBeNull()
  })
})
