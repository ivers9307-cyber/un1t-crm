// @vitest-environment jsdom
//
// STAFFPAYLINK.1 — send a un1t.online payment link on WhatsApp from the Hatch card.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import Un1tPaymentLink from './Un1tPaymentLink.jsx'

const OFFERS = [
  { offer_id: 'o1', title: '10 class pack', price_label: '€120', recurring: false },
  { offer_id: 'o2', title: 'Unlimited monthly', price_label: '€99 a month', recurring: true },
]
const base = (over = {}) => ({
  first_name: 'Aoife',
  offers: OFFERS,
  latest: null,
  can: { send: true, has_email: true, has_phone: true, window_open: true, template_ready: true },
  live_membership: null,
  preview_text: 'Hi Aoife, here is your link for {product}.',
  ...over,
})

let getStatus
let getData
let postAnswer
let calls
beforeEach(() => {
  calls = []
  getStatus = 200
  getData = base()
  postAnswer = { status: 200, body: { success: true, data: { linkId: 'l1', expiresAt: '2026-11-22T10:00:00Z', via: 'session' } } }
  global.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
    if (!init?.method || init.method === 'GET') {
      return new Response(JSON.stringify({ success: getStatus === 200, data: getData }), { status: getStatus })
    }
    return new Response(JSON.stringify(postAnswer.body), { status: postAnswer.status })
  })
})
afterEach(() => cleanup())

const mount = (props = {}) => render(<Un1tPaymentLink contactId="c1" locationId="loc1" studioName="UN1T Hatch Street" {...props} />)
// Let the fetch -> json() -> setState chain finish (a macrotask outlasts every microtask).
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const choose = (id) => fireEvent.change(screen.getByRole('combobox', { name: /product/i }), { target: { value: id } })

describe('Un1tPaymentLink', () => {
  it('renders the offers and fills the preview with the chosen one', async () => {
    mount()
    expect(await screen.findByRole('option', { name: '10 class pack — €120' })).toBeTruthy()
    expect(screen.queryByTestId('paylink-preview')).toBeNull()
    choose('o1')
    expect(screen.getByTestId('paylink-preview').textContent).toBe('Hi Aoife, here is your link for 10 class pack, €120.')
    expect(calls[0].url).toBe('/api/contacts/c1/un1t-payment-link?locationId=loc1')
  })

  it('posts locationId and offerId, then shows the sent line', async () => {
    mount()
    await screen.findByRole('combobox', { name: /product/i })
    const btn = screen.getByRole('button', { name: 'Send on WhatsApp' })
    expect(btn.disabled).toBe(true)
    choose('o1')
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(await screen.findByText(/Link sent .* · not opened yet/)).toBeTruthy()
    const post = calls.find((c) => c.method === 'POST')
    expect(post.body).toEqual({ locationId: 'loc1', offerId: 'o1' })
  })

  it('shows the error text when the send fails', async () => {
    postAnswer = { status: 409, body: { success: false, error: 'Offer gone', code: 'offer_not_available' } }
    mount()
    await screen.findByRole('combobox', { name: /product/i })
    choose('o1')
    fireEvent.click(screen.getByRole('button', { name: 'Send on WhatsApp' }))
    expect(await screen.findByText('Offer gone')).toBeTruthy()
  })

  it('warns only for a recurring offer with a live membership', async () => {
    getData = base({ live_membership: { plan: 'Unlimited' } })
    mount()
    await screen.findByRole('combobox', { name: /product/i })
    const warning = 'Aoife already has Unlimited, live. Sending a new membership could mean two payments.'
    choose('o1')
    expect(screen.queryByText(warning)).toBeNull()
    choose('o2')
    expect(screen.getByText(warning).className).toContain('bg-amber-500/10 text-amber-700')
  })

  it('does not warn for a recurring offer without a live membership', async () => {
    mount()
    await screen.findByRole('combobox', { name: /product/i })
    choose('o2')
    expect(screen.queryByText(/could mean two payments/)).toBeNull()
  })

  it('says why it cannot send when there is no email, and disables the button', async () => {
    getData = base({ can: { send: false, has_email: false, has_phone: true, window_open: true, template_ready: true } })
    mount()
    expect(await screen.findByText(/no email address/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send on WhatsApp' }).disabled).toBe(true)
  })

  it('shows the route\'s reason line (can.reason) when it gives one', async () => {
    getData = base({ can: { send: false, reason: 'This customer has opted out of WhatsApp.', has_email: true, has_phone: true, window_open: true, template_ready: true } })
    mount()
    expect(await screen.findByText('This customer has opted out of WhatsApp.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send on WhatsApp' }).disabled).toBe(true)
  })

  it('says why when the window is closed and no template is ready', async () => {
    getData = base({ can: { send: false, has_email: true, has_phone: true, window_open: false, template_ready: false } })
    mount()
    expect(await screen.findByText(/approved payment-link template/i)).toBeTruthy()
  })

  it('renders the latest link status and paid time', async () => {
    getData = base({ latest: { status: 'paid', product_title: 'x', created_at: '2026-11-10T10:00:00Z', paid_at: '2026-11-11T10:00:00Z', expires_at: null } })
    mount()
    expect(await screen.findByText(/Link sent .* · paid /)).toBeTruthy()
  })

  it('renders nothing when the GET is refused', async () => {
    getStatus = 409
    const { container } = mount()
    await waitFor(() => expect(calls.length).toBe(1))
    await settle()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when it cannot send and there is nothing to explain or show', async () => {
    getData = base({ can: { send: false, has_email: true, has_phone: true, window_open: true, template_ready: true } })
    const { container } = mount()
    await waitFor(() => expect(calls.length).toBe(1))
    await settle()
    expect(container.innerHTML).toBe('')
  })

  it('positive control: the same setup with can.send renders the dropdown', async () => {
    const { container } = mount()
    await waitFor(() => expect(calls.length).toBe(1))
    await settle()
    expect(container.innerHTML).not.toBe('')
    expect(screen.getByRole('combobox', { name: /product/i })).toBeTruthy()
  })

  it('renders times in the studio zone', async () => {
    getData = base({ latest: { status: 'sent', product_title: 'x', created_at: '2026-07-01T23:30:00Z', paid_at: null, expires_at: null } })
    mount({ zone: 'Europe/Dublin' })
    // 23:30Z in July is 00:30 on 2 Jul in Dublin.
    expect(await screen.findByText(/Link sent 2 Jul, 00:30 · not opened yet/)).toBeTruthy()
  })
})
