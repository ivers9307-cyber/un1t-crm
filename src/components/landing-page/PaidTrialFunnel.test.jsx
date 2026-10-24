// @vitest-environment jsdom
//
// TRIALSTUDIO.10 — the /trial card: choose a studio, then the form; a refused
// Stillorgan buyer gets the message and the help button (which files the
// card); a Hatch Street buyer ticks un1t.online's terms and is sent to
// un1t.online's own checkout; a cancelled Hatch checkout comes back to the
// form; an unsellable studio cannot be chosen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('@/lib/funnel-track', () => ({ trackFunnelStep: vi.fn() }))
vi.mock('@/lib/meta-pixel-lead', () => ({
  newLeadEventId: () => 'lead-id-123',
  pixelUserData: () => ({}),
  fireBrowserLead: vi.fn(),
  fireBrowserInitiateCheckout: vi.fn(),
  checkoutEventIdFor: (id) => `trialcheckout-${id}`,
}))
vi.mock('@/lib/meta-pixel-paths', () => ({ metaPixelIdsForPath: () => [] }))
vi.mock('@/lib/visit-origin', () => ({ readVisitOrigin: () => null }))
vi.mock('@/components/landing-page/ClassFunnelCheckout', () => ({ default: () => null }))

import PaidTrialFunnel from './PaidTrialFunnel'
import { fireBrowserLead, fireBrowserInitiateCheckout } from '@/lib/meta-pixel-lead'

const STILLORGAN = {
  key: 'stillorgan', label: 'Stillorgan Village', sellable: true,
  block: { heading: 'The 14 Day Reset', ticks: ['Unlimited classes for 14 days'], cta_label: 'Start my 14 Day Reset', consent_label: 'Keep me posted.' },
  priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'The 14 Day Reset',
}
const HATCH = {
  key: 'hatch', label: 'Hatch Street', sellable: true,
  block: { heading: 'The UN1T Trial', ticks: [], cta_label: 'Start my trial', consent_label: 'Keep me posted.' },
  priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'The UN1T Trial',
}
const HATCH_TERMS = {
  required: true,
  label: "I accept Hatch Street's {terms} and {waiver}",
  terms_link_label: 'terms and conditions',
  waiver_link_label: 'liability waiver',
  required_message: 'Please tick to accept the terms and waiver.',
  terms_url: '/legal/un1t/hatch-street/terms',
  waiver_url: '/legal/un1t/hatch-street/waiver',
}

let posts
let answers
beforeEach(() => {
  posts = []
  answers = {}
  vi.mocked(fireBrowserLead).mockClear()
  vi.mocked(fireBrowserInitiateCheckout).mockClear()
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url)
    if (init?.method === 'POST') {
      posts.push({ url: u, body: JSON.parse(init.body) })
      const a = answers[u] || { status: 500, body: { success: false, error: 'unexpected' } }
      return { ok: a.status < 400, status: a.status, json: async () => a.body }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { state: 'pending' } }) }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fillDetails() {
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Sam' } })
  fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Byrne' } })
  fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'sam@example.com' } })
  fireEvent.change(screen.getByPlaceholderText('Phone'), { target: { value: '0871234567' } })
}
const submitButton = () => screen.getByRole('button', { name: /Start my/ })

describe('TRIALSTUDIO.10 — PaidTrialFunnel', () => {
  it('shows the two studios and the form only after one is chosen', () => {
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} />)
    const still = screen.getByRole('button', { name: /Stillorgan Village/ })
    const hatch = screen.getByRole('button', { name: /Hatch Street/ })
    expect(still.getAttribute('type')).toBe('button')
    expect(hatch.getAttribute('type')).toBe('button')
    expect(still.textContent).toContain('€39')
    expect(still.textContent).toContain('14 days')
    expect(screen.queryByPlaceholderText('First name')).toBeNull()

    fireEvent.click(still)
    expect(screen.getByPlaceholderText('First name')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'The 14 Day Reset' })).toBeTruthy()
    const change = screen.getByRole('button', { name: 'Change studio' })
    expect(change.getAttribute('type')).toBe('button')
    fireEvent.click(change)
    expect(screen.queryByPlaceholderText('First name')).toBeNull()
    expect(screen.getByRole('button', { name: /Hatch Street/ })).toBeTruthy()
  })

  it('Stillorgan trial_used answer shows the message and the help button; pressing it posts to /help and shows help_sent_text', async () => {
    answers['/api/public/trial-purchases'] = { status: 200, body: { success: false, code: 'trial_used', error: "It looks like you've already had a trial with us at Stillorgan.", help: { cta_label: 'I need help' } } }
    answers['/api/public/trial-purchases/help'] = { status: 200, body: { success: true, data: { message: 'Thanks. The team at UN1T Stillorgan will be in touch shortly.', purchaseId: 'p-help' } } }
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} initialStudio="stillorgan" />)
    fillDetails()
    fireEvent.click(submitButton())

    expect(await screen.findByText("It looks like you've already had a trial with us at Stillorgan.")).toBeTruthy()
    expect(posts[0].body).toMatchObject({ studio: 'stillorgan', first_name: 'Sam', email: 'sam@example.com', consent: true, lead_event_id: 'lead-id-123' })
    expect(posts[0].body).not.toHaveProperty('terms_accepted')
    expect(posts[0].body).not.toHaveProperty('path')
    // The server sent its Lead; the browser shares its id. No checkout opened.
    expect(fireBrowserLead).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'lead-id-123' }))
    expect(fireBrowserInitiateCheckout).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('First name')).toBeNull()

    const help = screen.getByRole('button', { name: 'I need help' })
    expect(help.getAttribute('type')).toBe('button')
    fireEvent.click(help)
    expect(await screen.findByText('Thanks. The team at UN1T Stillorgan will be in touch shortly.')).toBeTruthy()
    expect(posts[1]).toEqual({
      url: '/api/public/trial-purchases/help',
      body: { studio: 'stillorgan', first_name: 'Sam', last_name: 'Byrne', email: 'sam@example.com', phone: '0871234567' },
    })
    expect(screen.queryByRole('button', { name: 'I need help' })).toBeNull()
  })

  it('Hatch success redirects the browser to redirect_url', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, search: '', pathname: '/trial', assign })
    answers['/api/public/trial-purchases'] = { status: 200, body: { success: true, data: { purchaseId: 'p-1', redirect_url: 'https://checkout.un1t.online/c/abc', amount_cents: 3900, currency: 'EUR', product_name: 'The UN1T Trial' } } }
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} initialStudio="hatch" hatchTerms={HATCH_TERMS} />)
    fillDetails()
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept Hatch Street's/ }))
    fireEvent.click(submitButton())

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.un1t.online/c/abc'))
    expect(posts[0].body.studio).toBe('hatch')
    expect(fireBrowserLead).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'lead-id-123' }))
    expect(fireBrowserInitiateCheckout).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'trialcheckout-lead-id-123', value: 39, currency: 'EUR' }))
  })

  it('Hatch posts terms_accepted and shows the terms tick', async () => {
    answers['/api/public/trial-purchases'] = { status: 200, body: { success: false, code: 'active_member', error: 'You already have an active membership.', help: { cta_label: 'I need help' } } }
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} initialStudio="hatch" hatchTerms={HATCH_TERMS} />)
    const tick = screen.getByRole('checkbox', { name: /I accept Hatch Street's/ })
    expect(tick.checked).toBe(false)
    expect(screen.getByRole('link', { name: 'terms and conditions' }).getAttribute('href')).toBe('/legal/un1t/hatch-street/terms')
    expect(screen.getByRole('link', { name: 'liability waiver' }).getAttribute('href')).toBe('/legal/un1t/hatch-street/waiver')

    fillDetails()
    fireEvent.click(submitButton())
    expect(await screen.findByText('Please tick to accept the terms and waiver.')).toBeTruthy()
    expect(posts).toHaveLength(0)

    fireEvent.click(tick)
    fireEvent.click(submitButton())
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toMatchObject({ studio: 'hatch', terms_accepted: true })
    expect(await screen.findByText('You already have an active membership.')).toBeTruthy()

    // Stillorgan never shows or sends the un1t.online tick.
    cleanup()
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} initialStudio="stillorgan" hatchTerms={HATCH_TERMS} />)
    expect(screen.queryByRole('checkbox', { name: /I accept/ })).toBeNull()
  })

  it('cancelled return shows the form with Hatch preselected and no error', async () => {
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} initialStudio="hatch" resumePurchaseId="11111111-1111-1111-1111-111111111111" cancelled hatchTerms={HATCH_TERMS} />)
    expect(screen.getByPlaceholderText('First name')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'The UN1T Trial' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /I accept Hatch Street's/ })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Confirming/)).toBeNull()
    // A cancelled checkout is not polled.
    await new Promise((r) => setTimeout(r, 400))
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('an unsellable studio tile is disabled', () => {
    render(<PaidTrialFunnel studios={[STILLORGAN, { ...HATCH, sellable: false }]} initialStudio="hatch" />)
    const hatch = screen.getByRole('button', { name: /Hatch Street/ })
    expect(hatch.disabled).toBe(true)
    expect(hatch.textContent).toContain('Not available online')
    // ?studio=hatch cannot preselect it: the buyer still chooses.
    expect(screen.queryByPlaceholderText('First name')).toBeNull()
    fireEvent.click(hatch)
    expect(screen.queryByPlaceholderText('First name')).toBeNull()
    expect(screen.getByRole('button', { name: /Stillorgan Village/ }).disabled).toBe(false)
  })
})
