// @vitest-environment jsdom
//
// UN1TWRITE.18 — the class funnel's terms and waiver tick: shown, with both
// document links, only when /api/public/classes says it is required (a
// un1t.online studio with the funnel on), and sent with the booking.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('@/lib/funnel-track', () => ({ trackFunnelStep: vi.fn() }))
vi.mock('@/lib/meta-pixel-lead', () => ({ newLeadEventId: () => 'lead-id-123', pixelUserData: () => ({}), fireBrowserLead: vi.fn() }))
vi.mock('@/lib/meta-pixel-paths', () => ({ metaPixelIdsForPath: () => [], pageLocationIdFromDocument: () => null }))
vi.mock('@/components/landing-page/ClassFunnelCheckout', () => ({ default: () => null }))

import ClassFunnel from './ClassFunnel'

const CLASS = { event_id: 'un1t:e-1', name: 'BASE', starts_at: '2099-01-01T08:00:00Z', day: '2099-01-01', day_label: 'Thu 1 Jan', time: '08:00' }
const REQUIRED = {
  required: true,
  label: "I accept Hatch Street's {terms} and {waiver}",
  terms_link_label: 'terms and conditions',
  waiver_link_label: 'liability waiver',
  required_message: 'Please tick to accept the terms and waiver.',
  terms_url: '/legal/un1t/hatch-street/terms',
  waiver_url: '/legal/un1t/hatch-street/waiver',
}

let terms
let posts
let refuseOnce = null
beforeEach(() => {
  posts = []
  global.fetch = vi.fn(async (url, init) => {
    if (url === '/api/public/funnel-event') { posts.events = [...(posts.events || []), JSON.parse(init.body)]; return { ok: true, json: async () => ({}) } }
    if (String(url).startsWith('/api/public/classes')) return { json: async () => ({ success: true, data: { classes: [CLASS], terms } }) }
    if (url === '/api/public/class-booking') {
      posts.push(JSON.parse(init.body))
      if (refuseOnce) { const r = refuseOnce; refuseOnce = null; return { ok: false, json: async () => r } }
      return { ok: true, json: async () => ({ success: true, data: { queued: true } }) }
    }
    return { ok: true, json: async () => ({}) }
  })
})
afterEach(() => cleanup())

async function toDetails() {
  render(<ClassFunnel publicPath="hatch-street" consultSlug="" locationName="Hatch Street" />)
  fireEvent.click((await screen.findByText(/BASE/)).closest('button'))
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Sam' } })
  fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Byrne' } })
  fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'sam@example.com' } })
  fireEvent.change(screen.getByPlaceholderText('Phone'), { target: { value: '0871234567' } })
}

describe('UN1TWRITE.18 — ClassFunnel terms tick', () => {
  it('renders the required tick with both links when data.terms.required', async () => {
    terms = REQUIRED
    await toDetails()
    const tick = screen.getByRole('checkbox', { name: /I accept Hatch Street's/ })
    expect(tick.checked).toBe(false)
    expect(screen.getByRole('link', { name: 'terms and conditions' }).getAttribute('href')).toBe('/legal/un1t/hatch-street/terms')
    expect(screen.getByRole('link', { name: 'liability waiver' }).getAttribute('href')).toBe('/legal/un1t/hatch-street/waiver')
  })

  it('refuses to submit until ticked, then sends terms_accepted true', async () => {
    terms = REQUIRED
    await toDetails()
    fireEvent.click(screen.getByText(/Confirm my class/))
    expect(await screen.findByText('Please tick to accept the terms and waiver.')).toBeTruthy()
    expect(posts).toHaveLength(0)
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept Hatch Street's/ }))
    fireEvent.click(screen.getByText(/Confirm my class/))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].terms_accepted).toBe(true)
  })

  it('a terms_required refusal on a page that did not know shows the tick from the refusal', async () => {
    terms = { required: false }
    refuseOnce = { success: false, code: 'terms_required', error: 'Please tick to accept the terms and waiver.', terms: REQUIRED }
    await toDetails()
    fireEvent.click(screen.getByText(/Confirm my class/))
    expect(await screen.findByText('Please tick to accept the terms and waiver.')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept Hatch Street's/ }))
    fireEvent.click(screen.getByText(/Confirm my class/))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].terms_accepted).toBe(true)
  })

  it('shows no tick and sends no terms field otherwise', async () => {
    terms = { required: false }
    await toDetails()
    expect(screen.queryByRole('checkbox', { name: /I accept/ })).toBeNull()
    expect(screen.getAllByRole('checkbox')).toHaveLength(1) // marketing consent only
    fireEvent.click(screen.getByText(/Confirm my class/))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).not.toHaveProperty('terms_accepted')
  })
})

describe('PAGES.1 — ClassFunnel page prop', () => {
  it('with a page it lists, books and reports by page and studio, never path', async () => {
    terms = { required: false }
    render(<ClassFunnel publicPath="hatch-street" page="free-week" consultSlug="" locationName="Hatch Street" />)
    fireEvent.click((await screen.findByText(/BASE/)).closest('button'))
    const listUrl = fetch.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/public/classes'))
    expect(listUrl).toBe('/api/public/classes?page=free-week&studio=hatch-street')
    fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Sam' } })
    fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Byrne' } })
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'sam@example.com' } })
    fireEvent.change(screen.getByPlaceholderText('Phone'), { target: { value: '0871234567' } })
    fireEvent.click(screen.getByText(/Confirm my class/))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({ page: 'free-week', studio: 'hatch-street', event_id: 'un1t:e-1' })
    expect(posts[0]).not.toHaveProperty('path')
    expect(posts.events[0]).toMatchObject({ page: 'free-week', studio: 'hatch-street' })
    expect(posts.events[0]).not.toHaveProperty('location_path')
  })

  it('without a page it sends path and location_path as before', async () => {
    terms = { required: false }
    await toDetails()
    const listUrl = fetch.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/public/classes'))
    expect(listUrl).toBe('/api/public/classes?path=hatch-street')
    fireEvent.click(screen.getByText(/Confirm my class/))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({ path: 'hatch-street' })
    expect(posts[0]).not.toHaveProperty('page')
    expect(posts.events[0]).toMatchObject({ location_path: 'hatch-street' })
  })
})
