// @vitest-environment jsdom
//
// FIFTYPLUS.1 — CampaignFunnel: the booking card on a campaign page
// (/50plus). Date tiles for the campaign's slots, details, booked; the
// server's refusals shown in the operator's words.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/lib/funnel-track', () => ({ trackFunnelStep: vi.fn() }))
vi.mock('@/lib/meta-pixel-lead', () => ({ newLeadEventId: () => 'lead-id-123', pixelUserData: () => ({}), fireBrowserLead: vi.fn() }))
vi.mock('@/lib/meta-pixel-paths', () => ({ metaPixelIdsForPath: () => [] }))
vi.mock('@/lib/visit-origin', () => ({ readVisitOrigin: () => null }))

import CampaignFunnel, { cadenceGroups, ctaLabelFor } from './CampaignFunnel'
import { VALID_STEPS } from '@/lib/funnel-events'

const COPY = {
  eyebrow: 'E', heading: 'H', subhead: 'S', pick_title: 'Pick your first morning', pick_body: 'B',
  cta_label: 'Book {day} {time}', reassurance: 'Free', consent_label: 'OK?', details_title: 'Last step',
  details_body: 'D', done_title: 'Booked', done_body: 'See you', no_classes_text: 'Nothing open',
  not_configured_text: 'Not open online', timetable_unavailable_text: 'Try later', sound_label: 'Tap for sound',
  expect_eyebrow: '', expect_heading: '', expect_cards: [], show_sections: [],
}
const CLASSES = [
  { event_id: 'a', name: 'THE 50+ CLUB', starts_at: '2099-01-05T11:00:00.000Z', day: '2099-01-05', day_label: 'Mon, 5 Jan', time: '11:00' },
  { event_id: 'b', name: 'THE 50+ CLUB', starts_at: '2099-01-07T11:00:00.000Z', day: '2099-01-07', day_label: 'Wed, 7 Jan', time: '11:00' },
  { event_id: 'c', name: 'THE 50+ CLUB', starts_at: '2099-01-09T11:00:00.000Z', day: '2099-01-09', day_label: 'Fri, 9 Jan', time: '11:00' },
  { event_id: 'd', name: 'THE 50+ CLUB', starts_at: '2099-01-12T11:00:00.000Z', day: '2099-01-12', day_label: 'Mon, 12 Jan', time: '11:00' },
]

let posts
let steps
let listResponse
let bookResponse
let listFails = false
beforeEach(() => {
  posts = []
  steps = []
  listFails = false
  listResponse = { success: true, data: { classes: CLASSES, terms: { required: false }, campaign: { configured: true } } }
  bookResponse = { ok: true, body: { success: true, data: { queued: true } } }
  global.fetch = vi.fn(async (url, init) => {
    if (String(url).startsWith('/api/public/classes')) {
      if (listFails) throw new Error('offline')
      return { ok: true, json: async () => listResponse }
    }
    if (url === '/api/public/funnel-event') { steps.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) } }
    if (url === '/api/public/class-booking') {
      posts.push(JSON.parse(init.body))
      return { ok: bookResponse.ok, json: async () => bookResponse.body }
    }
    return { ok: true, json: async () => ({}) }
  })
})
afterEach(() => cleanup())

const mount = () => render(<CampaignFunnel publicPath="stillorgan" campaign="50plus" copy={COPY} locationName="UN1T Stillorgan" />)

async function fillDetails() {
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Mary' } })
  fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Byrne' } })
  fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'mary@example.com' } })
  fireEvent.change(screen.getByPlaceholderText('Phone'), { target: { value: '0871234567' } })
}

describe('CampaignFunnel', () => {
  it('asks the classes route for the campaign', async () => {
    mount()
    await screen.findByText('Mon, 5 Jan')
    const listCall = fetch.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/public/classes'))
    expect(listCall).toBe('/api/public/classes?path=stillorgan&campaign=50plus')
  })

  it('renders one tile per slot, preselects the first, and the CTA names the chosen slot', async () => {
    mount()
    expect(await screen.findByText('Mon, 5 Jan')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Book Mon 11:00' })).toBeTruthy()
    fireEvent.click(screen.getByText('Wed, 7 Jan'))
    expect(screen.getByRole('button', { name: 'Book Wed 11:00' })).toBeTruthy()
  })

  it('shows three tiles, then the rest behind More dates', async () => {
    mount()
    await screen.findByText('Mon, 5 Jan')
    const fourth = screen.getByText('Mon, 12 Jan').closest('[data-tile]')
    expect(fourth.className).toMatch(/\bhidden\b/)
    fireEvent.click(screen.getByRole('button', { name: /More dates/ }))
    expect(screen.getByText('Mon, 12 Jan').closest('[data-tile]').className).not.toMatch(/\bhidden\b/)
  })

  it('empty list shows no_classes_text and no CTA', async () => {
    listResponse = { success: true, data: { classes: [], campaign: { configured: true } } }
    mount()
    expect(await screen.findByText('Nothing open')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Book/ })).toBe(null)
  })

  it('shows the not configured message when the server says so', async () => {
    listResponse = { success: true, data: { classes: CLASSES, campaign: { configured: false } } }
    mount()
    expect(await screen.findByText('Not open online')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Book/ })).toBe(null)
  })

  it('details keeps the slot visible, Change returns to the tiles, booking posts the campaign and shows done copy', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Book Mon 11:00' }))
    expect(screen.getByText('Last step')).toBeTruthy()
    expect(screen.getByText(/Mon, 5 Jan/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    expect(screen.getByText('Pick your first morning')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Book Mon 11:00' }))
    await fillDetails()
    fireEvent.click(screen.getByRole('button', { name: 'Book Mon 11:00' }))
    expect(await screen.findByText('Booked')).toBeTruthy()
    expect(screen.getByText('See you')).toBeTruthy()
    expect(posts[0]).toMatchObject({ path: 'stillorgan', campaign: '50plus', event_id: 'a', first_name: 'Mary', consent: true, lead_event_id: 'lead-id-123' })
  })

  it('class_unavailable returns to the tiles with details kept', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Book Mon 11:00' }))
    await fillDetails()
    bookResponse = { ok: false, body: { success: false, code: 'class_unavailable', error: 'gone' } }
    listResponse = { success: true, data: { classes: CLASSES.slice(1), campaign: { configured: true } } }
    fireEvent.click(screen.getByRole('button', { name: 'Book Mon 11:00' }))
    expect(await screen.findByText('Pick your first morning')).toBeTruthy()
    expect(screen.getByText(/filled up while you were typing/)).toBeTruthy()
    // The failed slot is gone and nothing is selected until they pick again.
    expect(await screen.findByText('Wed, 7 Jan')).toBeTruthy()
    expect(screen.queryByText('Mon, 5 Jan')).toBe(null)
    expect(screen.queryByRole('button', { name: /^Book (Mon|Wed|Fri)/ })).toBe(null)
    fireEvent.click(screen.getByText('Wed, 7 Jan'))
    fireEvent.click(screen.getByRole('button', { name: 'Book Wed 11:00' }))
    expect(screen.getByPlaceholderText('First name').value).toBe('Mary')
  })

  it('a failed timetable read shows timetable_unavailable_text, not "no classes"', async () => {
    listResponse = { success: true, data: { classes: [], campaign: { configured: true, timetable_unavailable: true } } }
    mount()
    expect(await screen.findByText('Try later')).toBeTruthy()
    expect(screen.queryByText('Nothing open')).toBe(null)
  })

  it('a failed fetch shows timetable_unavailable_text too', async () => {
    listFails = true
    mount()
    expect(await screen.findByText('Try later')).toBeTruthy()
    expect(screen.queryByText('Nothing open')).toBe(null)
  })

  it('every funnel step posted to the CRM is a valid step, and booking posts booked_class', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Book Mon 11:00' }))
    await fillDetails()
    fireEvent.click(screen.getByRole('button', { name: 'Book Mon 11:00' }))
    await screen.findByText('Booked')
    expect(steps.length).toBeGreaterThan(0)
    for (const e of steps) {
      expect(VALID_STEPS, e.step).toContain(e.step)
      expect(e.funnel).toBe('50plus')
    }
    expect(steps.map((e) => e.step)).toEqual(['view', 'path_class', 'details', 'booked_class'])
  })

  it('on a wide screen the second week is visible without More dates', async () => {
    const { container } = mount()
    await screen.findByText('Mon, 5 Jan')
    const tiles = container.querySelectorAll('[data-tile]')
    expect(tiles.length).toBe(4)
    expect(tiles[3].className).toMatch(/\bhidden\b/)
    expect(tiles[3].className).toMatch(/lg:block/)
    expect(screen.getByRole('button', { name: /More dates/ }).className).toMatch(/lg:hidden/)
  })

  it("a refusal shows the server's words in the card", async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Book Mon 11:00' }))
    await fillDetails()
    bookResponse = { ok: false, body: { success: false, code: 'not_configured', error: 'Ring us.' } }
    fireEvent.click(screen.getByRole('button', { name: 'Book Mon 11:00' }))
    expect(await screen.findByText('Ring us.')).toBeTruthy()
  })

  it('every button inside the form has a type', async () => {
    const { container } = mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Book Mon 11:00' }))
    const buttons = container.querySelectorAll('form button')
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect(b.getAttribute('type')).toBeTruthy()
  })
})

describe('cadenceGroups / ctaLabelFor', () => {
  it('groups by day in order', () => {
    expect(cadenceGroups(CLASSES).map((g) => g.day)).toEqual(['2099-01-05', '2099-01-07', '2099-01-09', '2099-01-12'])
    expect(cadenceGroups(CLASSES)[0]).toMatchObject({ day_label: 'Mon, 5 Jan', classes: [CLASSES[0]] })
  })
  it('fills the template', () => {
    expect(ctaLabelFor('Book {day} {time}', CLASSES[0])).toBe('Book Mon 11:00')
    expect(ctaLabelFor('', CLASSES[0])).toBe('Book Mon 11:00')
    expect(ctaLabelFor('Book {day} {time}', { day_label: 'Mon 5 Jan', time: '11:00' })).toBe('Book Mon 11:00')
  })
})
