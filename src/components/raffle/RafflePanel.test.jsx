// @vitest-environment jsdom
//
// RAFFLE.1 — the till: a guest sale sends name, email, quantity and payment
// method, with no contact_id, and shows the ticket numbers afterwards.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import RafflePanel from './RafflePanel.jsx'

const STATE = {
  success: true,
  data: {
    event: { id: 'e1', name: 'Charity Day' },
    can_manage: false,
    raffle: { id: 'r1', name: 'Charity Day Raffle', ticket_price_cents: 500, currency: 'EUR', sales_open: true, ticket_options: [{ tickets: 3, price_cents: 1000 }] },
    sales: [],
    draws: [],
    totals: { cents: 0, tickets: 0, sales: 0, cashCents: 0, cardCents: 0 },
  },
}

const json = (body) => ({ ok: true, status: 200, json: async () => body })

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RafflePanel till', () => {
  it('sells three tickets to a guest for cash', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url: String(url), opts })
      if (String(url).endsWith('/raffle/sales')) {
        return json({ success: true, data: { sale: { id: 's1', first_ticket: 1, last_ticket: 3, email_status: 'sent' } } })
      }
      return json(STATE)
    }))
    render(<RafflePanel raceId="e1" />)
    await screen.findByText('Charity Day Raffle')

    fireEvent.click(screen.getByText('Add as guest'))
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Sarah Byrne' } })
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'sarah@example.test' } })
    fireEvent.click(screen.getByText('Use this guest'))
    fireEvent.click(screen.getByLabelText('One more'))
    fireEvent.click(screen.getByLabelText('One more'))
    fireEvent.click(screen.getByText('cash'))
    expect(screen.getByText(/Sell 3 tickets · €10.00/)).toBeTruthy()
    fireEvent.click(screen.getByText(/Sell 3 tickets/))

    await screen.findByText('#001, #002, #003')
    const sale = calls.find((c) => c.url.endsWith('/raffle/sales'))
    const body = JSON.parse(sale.opts.body)
    expect(body).toMatchObject({ buyer_name: 'Sarah Byrne', buyer_email: 'sarah@example.test', quantity: 3, payment_method: 'cash', contact_id: null })
    expect(body.request_id).toBeTruthy()
  })

  it('will not sell without cash or card chosen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(STATE)))
    render(<RafflePanel raceId="e1" />)
    await screen.findByText('Charity Day Raffle')
    fireEvent.click(screen.getByText('Add as guest'))
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Ann' } })
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'ann@example.test' } })
    fireEvent.click(screen.getByText('Use this guest'))
    fireEvent.click(screen.getByText(/Sell 1 ticket/))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Choose cash or card.'))
  })

  it('a ticket option button sets the quantity and the option price', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(STATE)))
    render(<RafflePanel raceId="e1" />)
    await screen.findByText('Charity Day Raffle')
    fireEvent.click(screen.getByText('3 for €10'))
    expect(screen.getByLabelText('Number of tickets').value).toBe('3')
    expect(screen.getByText(/Sell 3 tickets · €10.00/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('One more'))
    expect(screen.getByText(/Sell 4 tickets · €20.00/)).toBeTruthy()
  })

  it('managers edit the price and options in Settings', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url: String(url), opts })
      return json({ ...STATE, data: { ...STATE.data, can_manage: true } })
    }))
    render(<RafflePanel raceId="e1" />)
    await screen.findByText('Charity Day Raffle')
    fireEvent.click(screen.getByText('Settings'))
    fireEvent.change(screen.getByLabelText('Price for one ticket'), { target: { value: '4' } })
    fireEvent.click(screen.getByText('Add an option'))
    fireEvent.change(screen.getByLabelText('Option 2 tickets'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Option 2 price'), { target: { value: '25' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(calls.some((c) => c.opts?.method === 'POST')).toBe(true))
    const body = JSON.parse(calls.find((c) => c.opts?.method === 'POST').opts.body)
    expect(body).toMatchObject({ ticket_price_cents: 400, ticket_options: [{ tickets: 3, price_cents: 1000 }, { tickets: 10, price_cents: 2500 }] })
  })
})
