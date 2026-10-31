// @vitest-environment jsdom
//
// PAGES.1 — the New page form: the path is checked against
// /api/landing-pages/slug-check (debounced), Create waits for a clean answer,
// and a created page opens in its editor.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))

import NewPageDialog from './NewPageDialog'

const HATCH = '11111111-1111-1111-1111-111111111111'
const STILL = '22222222-2222-2222-2222-222222222222'
const STUDIOS = [{ id: HATCH, name: 'UN1T Hatch Street' }, { id: STILL, name: 'UN1T Stillorgan' }]
const PAGES = [{ id: 'p-1', title: 'Trial' }, { id: 'p-2', title: 'Corporate' }]

// What slug-check answers, by slug.
const SLUG_ANSWERS = {
  summer: { available: false, problem: 'taken' },
  settings: { available: false, problem: 'reserved' },
  'summer-26': { available: true, problem: null },
}

let posted
beforeEach(() => {
  vi.useFakeTimers()
  push.mockReset()
  posted = null
  globalThis.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'POST') {
      posted = { url, body: JSON.parse(init.body) }
      return { ok: true, status: 201, json: async () => ({ success: true, data: { id: 'new-page' } }) }
    }
    const slug = new URL(url, 'http://x').searchParams.get('slug')
    return { ok: true, status: 200, json: async () => ({ success: true, data: SLUG_ANSWERS[slug] || { available: true, problem: null } }) }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(300) })
const slugChecks = () => globalThis.fetch.mock.calls.filter(([, init]) => !init?.method)

function renderDialog(props = {}) {
  return render(<NewPageDialog open onClose={vi.fn()} pages={PAGES} studios={STUDIOS} canCreateAll {...props} />)
}

describe('NewPageDialog', () => {
  it('shows taken/reserved from slug-check and disables Create until the slug is clean', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Summer' } })
    const path = screen.getByLabelText('Path')
    const create = screen.getByRole('button', { name: 'Create page' })

    fireEvent.change(path, { target: { value: 'Sum' } })
    fireEvent.change(path, { target: { value: 'Summer' } })
    expect(path.value).toBe('summer')
    expect(create.disabled).toBe(true)
    await settle()
    // A one-studio page (the default) is checked in the chosen studio's organisation.
    expect(slugChecks().map(([u]) => u)).toEqual([`/api/landing-pages/slug-check?slug=summer&location_id=${HATCH}`])
    expect(screen.getByText('That path is already taken.')).toBeTruthy()
    expect(create.disabled).toBe(true)

    fireEvent.change(path, { target: { value: 'settings' } })
    await settle()
    expect(screen.getByText('That path is reserved.')).toBeTruthy()
    expect(create.disabled).toBe(true)

    fireEvent.change(path, { target: { value: 'x' } })
    await settle()
    expect(screen.getByText('Use letters, numbers and dashes only, 2 to 40 characters.')).toBeTruthy()
    expect(create.disabled).toBe(true)

    fireEvent.change(path, { target: { value: 'summer-26' } })
    expect(create.disabled).toBe(true)
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(create.disabled).toBe(false)
  })

  it('checks again when the studio or the scope changes; All studios checks the active organisation', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Summer' } })
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'summer-26' } })
    await settle()
    const create = screen.getByRole('button', { name: 'Create page' })
    expect(create.disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('Studio'), { target: { value: STILL } })
    // The answer was for Hatch Street: Create waits for Stillorgan's.
    expect(create.disabled).toBe(true)
    await settle()
    expect(create.disabled).toBe(false)

    fireEvent.click(screen.getByLabelText('All studios'))
    expect(create.disabled).toBe(true)
    await settle()
    expect(slugChecks().map(([u]) => u)).toEqual([
      `/api/landing-pages/slug-check?slug=summer-26&location_id=${HATCH}`,
      `/api/landing-pages/slug-check?slug=summer-26&location_id=${STILL}`,
      '/api/landing-pages/slug-check?slug=summer-26',
    ])
    expect(create.disabled).toBe(false)
  })

  it('posts the body and navigates to the editor', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Summer 26' } })
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'summer-26' } })
    fireEvent.click(screen.getByLabelText('One studio'))
    fireEvent.change(screen.getByLabelText('Studio'), { target: { value: STILL } })
    fireEvent.change(screen.getByLabelText('Offer'), { target: { value: 'one_class' } })
    fireEvent.change(screen.getByLabelText('Start from'), { target: { value: 'p-2' } })
    await settle()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create page' })) })

    expect(posted).toEqual({
      url: '/api/landing-pages',
      body: {
        title: 'Summer 26', slug: 'summer-26', kind: 'campaign', scope: 'one',
        primary_location_id: STILL, offer_type: 'one_class', start_from_page_id: 'p-2',
      },
    })
    expect(push).toHaveBeenCalledWith('/settings/landing-page/new-page')
  })

  it('posts an all-studios page with no studio and a blank start', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Corporate' } })
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'corp-2' } })
    fireEvent.click(screen.getByLabelText('All studios'))
    expect(screen.queryByLabelText('Studio')).toBeNull()
    fireEvent.change(screen.getByLabelText('Offer'), { target: { value: 'none' } })
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create page' })) })
    expect(posted.body).toEqual({
      title: 'Corporate', slug: 'corp-2', kind: 'campaign', scope: 'all',
      primary_location_id: null, offer_type: 'none', start_from_page_id: null,
    })
  })

  it('describes each offer type in page-level words and offers All studios to an organisation admin only', () => {
    renderDialog({ canCreateAll: false })
    expect(screen.queryByLabelText('All studios')).toBeNull()
    const offer = screen.getByLabelText('Offer')
    expect([...offer.options].map((o) => o.value)).toEqual(['paid_trial', 'class_funnel', 'one_class', 'promo_credits', 'none'])
    expect([...offer.options].map((o) => o.textContent)).toEqual([
      'Paid trial', 'Free class with a timetable', 'One class', 'Free classes (promo code)', 'No offer',
    ])
    const descriptions = {
      paid_trial: 'A trial sold for a price: price card, buyer form, checkout, then the plan or product on their account.',
      class_funnel: "Pick a class from the studio's timetable, leave details, book; optional consult upsell.",
      one_class: 'A booking page for one class and one trial plan: coach video, date tiles, details, booked.',
      promo_credits: 'A corporate or partner promo: a fixed number of free classes claimed with a code.',
      none: 'A page of content blocks only: no booking card or trial for sale.',
    }
    for (const [value, text] of Object.entries(descriptions)) {
      fireEvent.change(offer, { target: { value } })
      expect(screen.getByText(text)).toBeTruthy()
    }
    // Never the block library's words (the old "Campaign funnel (own page)" label).
    expect(screen.queryByText(/Campaign funnel|Edited here, never shown/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/\u2014/)
  })

  it('shows the server refusal and stays open', async () => {
    globalThis.fetch.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') return { ok: false, status: 409, json: async () => ({ success: false, error: 'taken' }) }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { available: true, problem: null } }) }
    })
    renderDialog()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Summer' } })
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'summer-27' } })
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create page' })) })
    expect(screen.getByText('That path is already taken.')).toBeTruthy()
    expect(push).not.toHaveBeenCalled()
  })
})
