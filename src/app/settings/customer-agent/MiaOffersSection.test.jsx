// @vitest-environment jsdom
//
// MIAHATCH.4 (Task 14) — "What Mia can sell": the picker, the order, the
// blurb counter, inactive offers flagged, and the Suggested starter.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import MiaOffersSection from './MiaOffersSection.jsx'

const LOC = 'a0000000-0000-0000-0000-0000000000a1'
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })

const PRODUCTS = [
  { id: 'p-credit', title: '1 Class Credit', price_cents: 1500, interval: null, private: false },
  { id: 'p-five', title: '5 Class Pack', price_cents: 6500, interval: null, private: false },
  { id: 'p-ten', title: '10 Class Pack', price_cents: 11000, interval: null, private: false },
  { id: 'p-founders', title: 'Founders Pass', price_cents: 9900, interval: 'month', private: true },
]

function mockFetch(data, { putReply } = {}) {
  global.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'PUT') return putReply || reply(200, { success: true, data })
    return reply(200, { success: true, data })
  })
}
afterEach(() => { cleanup(); delete global.fetch })

const rowTitles = () => screen.queryAllByTestId('offer-row').map((r) => within(r).getByTestId('offer-title').textContent)

describe('MiaOffersSection', () => {
  it('starter button pre-fills the four titles that exist', async () => {
    // "10 Class Pack" and the membership exist; "The Monthly Foundation
    // Membership" does not, and "Founders Pass" is not in the starter.
    mockFetch({ offers: [], products: [PRODUCTS[2], PRODUCTS[3], PRODUCTS[1], PRODUCTS[0]] })
    render(<MiaOffersSection locationId={LOC} canEdit />)
    const starter = await screen.findByRole('button', { name: 'Suggested starter' })
    fireEvent.click(starter)
    expect(rowTitles()).toEqual(['1 Class Credit', '5 Class Pack', '10 Class Pack'])
  })

  it('starter matches titles exactly and also finds the monthly membership', async () => {
    const monthly = { id: 'p-m', title: 'The Monthly Foundation Membership', price_cents: 8900, interval: 'month', private: false }
    const near = { id: 'p-n', title: 'The Monthly Foundation Membership Plus', price_cents: 9900, interval: 'month', private: false }
    mockFetch({ offers: [], products: [near, PRODUCTS[3], monthly, PRODUCTS[0]] })
    render(<MiaOffersSection locationId={LOC} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Suggested starter' }))
    expect(rowTitles()).toEqual(['1 Class Credit', 'The Monthly Foundation Membership'])
  })

  it('starter is a draft: nothing is saved until Save', async () => {
    mockFetch({ offers: [], products: PRODUCTS })
    render(<MiaOffersSection locationId={LOC} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Suggested starter' }))
    expect(global.fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  it('adds a product from the picker, flags a private one with the amber chip, and removes it', async () => {
    mockFetch({ offers: [], products: PRODUCTS })
    render(<MiaOffersSection locationId={LOC} canEdit />)
    const picker = await screen.findByTestId('offer-picker')
    const founders = within(picker).getByRole('button', { name: /Add Founders Pass/ })
    expect(within(picker).getAllByText('Private')[0].className).toContain('bg-amber-500/10 text-amber-700')
    fireEvent.click(founders)
    expect(rowTitles()).toEqual(['Founders Pass'])
    expect(within(screen.getByTestId('offer-row')).getByText('Private').className).toContain('bg-amber-500/10 text-amber-700')
    // Already listed: gone from the picker.
    expect(within(screen.getByTestId('offer-picker')).queryByRole('button', { name: /Add Founders Pass/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Founders Pass' }))
    expect(rowTitles()).toEqual([])
  })

  it('blurb field counts characters and stops at 140', async () => {
    mockFetch({ offers: [], products: PRODUCTS })
    render(<MiaOffersSection locationId={LOC} canEdit />)
    fireEvent.click(await within(await screen.findByTestId('offer-picker')).findByRole('button', { name: /Add 1 Class Credit/ }))
    const blurb = screen.getByLabelText('Blurb for 1 Class Credit')
    expect(blurb.getAttribute('maxlength')).toBe('140')
    expect(screen.getByText('0/140')).toBeTruthy()
    fireEvent.change(blurb, { target: { value: 'Try us once' } })
    expect(screen.getByText('11/140')).toBeTruthy()
  })

  it('an inactive offer is flagged and Save is held until it is removed', async () => {
    mockFetch({
      offers: [
        { id: 'o1', un1t_product_row_id: 'p-credit', title: '1 Class Credit', price_cents: 1500, interval: null, visibility: 'public', private: false, blurb: '', sort_order: 0, inactive: false },
        { id: 'o2', un1t_product_row_id: 'p-old', title: 'Old Pack', price_cents: 5000, interval: null, visibility: 'public', private: false, blurb: '', sort_order: 1, inactive: true },
      ],
      products: PRODUCTS,
    })
    render(<MiaOffersSection locationId={LOC} canEdit />)
    await screen.findByText('Old Pack')
    expect(screen.getByText(/Inactive/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Blurb for 1 Class Credit'), { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Old Pack' }))
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(false)
  })

  it('Save PUTs the list in order with blurbs', async () => {
    mockFetch({ offers: [], products: PRODUCTS })
    render(<MiaOffersSection locationId={LOC} canEdit />)
    const picker = await screen.findByTestId('offer-picker')
    fireEvent.click(within(picker).getByRole('button', { name: /Add 5 Class Pack/ }))
    fireEvent.click(within(screen.getByTestId('offer-picker')).getByRole('button', { name: /Add 1 Class Credit/ }))
    fireEvent.change(screen.getByLabelText('Blurb for 5 Class Pack'), { target: { value: 'Best for regulars' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(global.fetch.mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true))
    const [url, init] = global.fetch.mock.calls.find(([, i]) => i?.method === 'PUT')
    expect(url).toBe(`/api/locations/${LOC}/mia-offers`)
    expect(JSON.parse(init.body)).toEqual({ offers: [
      { un1t_product_row_id: 'p-five', blurb: 'Best for regulars' },
      { un1t_product_row_id: 'p-credit', blurb: '' },
    ] })
  })

  it('a refused save shows the error and keeps the draft', async () => {
    mockFetch({ offers: [], products: PRODUCTS }, { putReply: reply(400, { success: false, error: 'product_not_sellable', product_id: 'p-five' }) })
    render(<MiaOffersSection locationId={LOC} canEdit />)
    fireEvent.click(await within(await screen.findByTestId('offer-picker')).findByRole('button', { name: /Add 5 Class Pack/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    expect(rowTitles()).toEqual(['5 Class Pack'])
  })

  it('a failed read says so and shows no Save', async () => {
    global.fetch = vi.fn(async () => reply(500, { success: false }))
    render(<MiaOffersSection locationId={LOC} canEdit />)
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('read-only for a non-owner: the list shows, no controls', async () => {
    mockFetch({
      offers: [{ id: 'o1', un1t_product_row_id: 'p-credit', title: '1 Class Credit', price_cents: 1500, interval: null, visibility: 'public', private: false, blurb: 'Try us', sort_order: 0, inactive: false }],
      products: PRODUCTS,
    })
    render(<MiaOffersSection locationId={LOC} canEdit={false} />)
    await screen.findByText('1 Class Credit')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Suggested starter' })).toBeNull()
    expect(screen.queryByTestId('offer-picker')).toBeNull()
  })

  it('every button is type="button" and no em-dash or en-dash appears in any label', async () => {
    mockFetch({
      offers: [{ id: 'o2', un1t_product_row_id: 'p-old', title: 'Old Pack', price_cents: 5000, interval: null, visibility: 'private', private: true, blurb: '', sort_order: 0, inactive: true }],
      products: PRODUCTS,
    })
    const { container } = render(<MiaOffersSection locationId={LOC} canEdit />)
    await screen.findByText('Old Pack')
    for (const b of container.querySelectorAll('button')) expect(b.getAttribute('type')).toBe('button')
    const labels = [container.textContent, ...[...container.querySelectorAll('[aria-label],[placeholder],[title]')]
      .flatMap((e) => [e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('title')])]
    expect(labels.filter(Boolean).join('\n')).not.toMatch(/[—–]/)
  })
})
