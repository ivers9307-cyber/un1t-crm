// @vitest-environment jsdom
// OFFERSEDIT.1 — the offers editor card.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import OffersEditorCard, { bodyFromForm } from './OffersEditorCard.jsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const DATA = {
  offers: [{ id: 'o1', name: '30 + 10 Pack', category: 'class_pack', price_cents: 30000, slug: '30-10-pack', active: false, bonus_headline: '10 free', problems: [{ code: 'price_mismatch', message: 'The price differs from the un1t.online product.' }] }],
  products: [{ un1t_id: 'p1', title: '30 Pack', price_cents: 29000 }],
  platform: 'un1t_online',
  can_edit: true,
}

describe('OffersEditorCard', () => {
  it('lists offers with their problems, and owners get New offer and Edit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: DATA }) })))
    render(<OffersEditorCard locationId="L1" />)
    expect(await screen.findByText('30 + 10 Pack')).toBeTruthy()
    expect(screen.getByText(/price differs/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /New offer/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit 30 + 10 Pack' })).toBeTruthy()
  })

  it('a reader sees no edit controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { ...DATA, can_edit: false } }) })))
    render(<OffersEditorCard locationId="L1" />)
    expect(await screen.findByText(/Only owners and masters/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /New offer/ })).toBeNull()
  })

  it('creating posts the form and shows the server refusal', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (init?.method === 'POST') return { ok: false, status: 422, json: async () => ({ success: false, error: 'Pick the un1t.online product.' }) }
      return { ok: true, json: async () => ({ success: true, data: { ...DATA, offers: [] } }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<OffersEditorCard locationId="L1" />)
    fireEvent.click(await screen.findByRole('button', { name: /New offer/ }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Pack' } })
    fireEvent.change(screen.getByLabelText(/Price/), { target: { value: '200' } })
    fireEvent.change(screen.getByLabelText(/Bonus headline/), { target: { value: '5 free' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create offer' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/un1t.online product/))
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')
    expect(post[0]).toBe('/api/locations/L1/offers')
    expect(JSON.parse(post[1].body)).toMatchObject({ name: 'Pack', price_cents: 20000, bonus_headline: '5 free', active: false })
  })
})

describe('bodyFromForm', () => {
  it('turns euros into cents and blanks into nulls', () => {
    expect(bodyFromForm({ name: ' A ', category: 'gift_card', bonus_headline: 'x', description: '', fine_print: '', price: '12.5', active: true, starts_at: '', ends_at: '', sort: '', stock_limit: '', un1t_product_id: '' }))
      .toEqual({ name: 'A', category: 'gift_card', bonus_headline: 'x', description: '', fine_print: '', price_cents: 1250, active: true, ends_at: null, sort: 0, stock_limit: null, un1t_product_id: null })
  })
})
