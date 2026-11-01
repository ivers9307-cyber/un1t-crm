// @vitest-environment jsdom
//
// PAGES.1 / CLASSFIRST.1 — CorpPromoFunnel: the class first (the studio's
// timetable by the page and its studio), then the details; with a page it
// names the page and its studio on the claim (the server takes the promo from
// the page's studio row); without one it names the promo alone, as before. A
// page refusal's machine word ('not_found') is never shown to the visitor.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('@/lib/meta-pixel-lead', () => ({ newLeadEventId: () => 'lead-id-123', pixelUserData: () => ({}), fireBrowserLead: vi.fn() }))
vi.mock('@/lib/meta-pixel-paths', () => ({ metaPixelIdsForPath: () => [], pageLocationIdFromDocument: () => null }))
vi.mock('@/lib/visit-origin', () => ({ readVisitOrigin: () => null }))

import CorpPromoFunnel from './CorpPromoFunnel'

const COPY = {
  title: 'Corp', eyebrow: '', heading: '3 free classes', subhead: '', ticks: [], cta_label: 'Claim', consent_label: 'OK?',
  done_title: 'Done', help_text: 'We will call', unavailable_text: 'Not now',
}
const CLASSES = [
  { event_id: 'a', name: 'S&C', starts_at: '2099-01-05T11:00:00.000Z', day: '2099-01-05', day_label: 'Mon, 5 Jan', time: '11:00' },
  { event_id: 'b', name: 'RALLY', starts_at: '2099-01-07T18:00:00.000Z', day: '2099-01-07', day_label: 'Wed, 7 Jan', time: '18:00' },
]
let posts
let answers
let classList
let lists
beforeEach(() => {
  posts = []
  lists = []
  answers = [{ status: 200, body: { success: true, data: { title: 'Done', message: 'On your account' } } }]
  classList = { success: true, data: { classes: CLASSES, campaign: { configured: true, timetable_unavailable: false } } }
  global.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body) })
      const a = answers.shift() || { status: 500, body: { success: false } }
      return { ok: a.status < 400, status: a.status, json: async () => a.body }
    }
    lists.push(String(url))
    return { ok: true, status: 200, json: async () => classList }
  })
})
afterEach(() => cleanup())

async function pickClass(which = 0) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(CLASSES[which].day_label) }))
  fireEvent.click(screen.getByRole('button', { name: /^Choose / }))
}
function fillAndSubmit() {
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Ann' } })
  fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Byrne' } })
  fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'ann@work.ie' } })
  fireEvent.change(screen.getByPlaceholderText('Mobile'), { target: { value: '0871234567' } })
  fireEvent.click(screen.getByRole('button', { name: 'Claim' }))
}

describe('CorpPromoFunnel', () => {
  it('without a page the list and the claim name the studio path and the promo alone', async () => {
    render(<CorpPromoFunnel promoKey="hatch-3-free" copy={COPY} terms={null} studio="hatch-street" />)
    expect(screen.getByRole('heading', { name: 'Pick your first class' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('First name')).toBeNull()
    await pickClass()
    expect(lists).toEqual(['/api/public/classes?path=hatch-street'])
    expect(screen.getByText('Mon, 5 Jan · S&C', { exact: false })).toBeTruthy()
    fillAndSubmit()
    expect(await screen.findByText('On your account')).toBeTruthy()
    expect(posts[0].url).toBe('/api/public/corp-claims')
    expect(posts[0].body).toMatchObject({ promo: 'hatch-3-free', first_name: 'Ann', event_id: 'a' })
    expect(posts[0].body).not.toHaveProperty('page')
    expect(posts[0].body).not.toHaveProperty('studio')
    // The class line, in the default words.
    expect(screen.getByText('Your first class: S&C, Mon, 5 Jan at 11:00. We will confirm it by email.')).toBeTruthy()
  })

  it('with a page the list and the claim name the page and its studio', async () => {
    render(<CorpPromoFunnel promoKey="hatch-3-free" copy={COPY} terms={null} page="corp" studio="hatch-street" />)
    await pickClass(1)
    expect(lists).toEqual(['/api/public/classes?page=corp&studio=hatch-street'])
    fillAndSubmit()
    expect(await screen.findByText('On your account')).toBeTruthy()
    expect(posts[0].body).toMatchObject({ page: 'corp', studio: 'hatch-street', promo: 'hatch-3-free', event_id: 'b' })
  })

  it('a not_found refusal shows the fallback, never the machine word', async () => {
    answers = [{ status: 404, body: { success: false, error: 'not_found' } }]
    render(<CorpPromoFunnel promoKey="hatch-3-free" copy={COPY} terms={null} page="corp" />)
    await pickClass()
    fillAndSubmit()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('not_found')).toBeNull()
    expect(screen.getByRole('alert').textContent).toMatch(/Something went wrong/)
  })

  it('an empty timetable offers to continue without a class in the block words; the claim then carries no event_id and the done screen no class line', async () => {
    classList = { success: true, data: { classes: [], campaign: { configured: true, timetable_unavailable: false } } }
    render(<CorpPromoFunnel promoKey="hatch-3-free" copy={COPY} terms={null} page="corp" studio="hatch-street" stepCopy={{ no_classes_text: 'Nothing on this fortnight.', skip_class_label: 'Claim anyway' }} />)
    expect((await screen.findByRole('status')).textContent).toBe('Nothing on this fortnight.')
    fireEvent.click(screen.getByRole('button', { name: 'Claim anyway' }))
    expect(screen.getByText('Pick one in the app after')).toBeTruthy()
    fillAndSubmit()
    expect(await screen.findByText('On your account')).toBeTruthy()
    expect(posts[0].body).not.toHaveProperty('event_id')
    expect(screen.queryByText(/Your first class/)).toBeNull()
  })

  it('class_unavailable returns to the tiles with the details kept and the list reloaded', async () => {
    answers = [
      { status: 400, body: { success: false, code: 'class_unavailable', error: 'That one just filled.' } },
      { status: 200, body: { success: true, data: { title: 'Done', message: 'On your account' } } },
    ]
    render(<CorpPromoFunnel promoKey="hatch-3-free" copy={COPY} terms={null} page="corp" studio="hatch-street" />)
    await pickClass(0)
    fillAndSubmit()
    expect(await screen.findByRole('heading', { name: 'Pick your first class' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('That one just filled.')
    await waitFor(() => expect(lists).toHaveLength(2))
    await pickClass(1)
    expect(screen.getByPlaceholderText('First name').value).toBe('Ann')
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }))
    expect(await screen.findByText('On your account')).toBeTruthy()
    expect(posts[1].body.event_id).toBe('b')
  })

  it('no live promo shows the unavailable text and fetches nothing', () => {
    render(<CorpPromoFunnel promoKey={null} copy={COPY} terms={null} page="corp" studio="hatch-street" />)
    expect(screen.getByText('Not now')).toBeTruthy()
    expect(lists).toEqual([])
  })
})
