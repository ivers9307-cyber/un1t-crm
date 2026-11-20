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
    raffle: { id: 'r1', name: 'Charity Day Raffle', ticket_price_cents: 500, currency: 'EUR', sales_open: true },
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
    fireEvent.click(screen.getByText(/Sell 3 tickets/))

    await screen.findByText('#001–#003')
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
})
