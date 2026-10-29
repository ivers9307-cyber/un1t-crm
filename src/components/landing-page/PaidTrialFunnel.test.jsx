// @vitest-environment jsdom
//
// TRIALSTUDIO.10 — the /trial card: choose a studio, then the form; a refused
// Stillorgan buyer gets the message and the help button (which files the
// card); a Hatch Street buyer ticks un1t.online's terms and is sent to
// un1t.online's own checkout; a cancelled Hatch checkout comes back to the
// form; an unsellable studio cannot be chosen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

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
import { trackFunnelStep } from '@/lib/funnel-track'

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
let pollState
let fetchMock
beforeEach(() => {
  posts = []
  answers = {}
  pollState = 'pending'
  vi.mocked(fireBrowserLead).mockClear()
  vi.mocked(fireBrowserInitiateCheckout).mockClear()
  fetchMock = vi.fn(async (url, init) => {
    const u = String(url)
    if (init?.method === 'POST') {
      posts.push({ url: u, body: JSON.parse(init.body) })
      const queued = answers[u]
      const a = (Array.isArray(queued) ? queued.shift() : queued) || { status: 500, body: { success: false, error: 'unexpected' } }
      return { ok: a.status < 400, status: a.status, json: async () => a.body }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { state: pollState, amount_cents: 3900, currency: 'EUR', product_name: 'The UN1T Trial' } }) }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

const PURCHASE_ID = '11111111-1111-1111-1111-111111111111'
// The fake clock moves inside act() (CLAUDE.md): React renders on the act queue.
const advance = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

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
    vi.useFakeTimers()
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} initialStudio="hatch" resumePurchaseId={PURCHASE_ID} cancelled hatchTerms={HATCH_TERMS} />)
    expect(screen.getByPlaceholderText('First name')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'The UN1T Trial' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /I accept Hatch Street's/ })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Confirming/)).toBeNull()
    // A cancelled checkout is not polled.
    await advance(5000)
    expect(fetchMock).not.toHaveBeenCalled()
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
  it('Hatch return: pending through the poll budget shows pending_body, then a granted poll shows done_title and fires one Purchase', async () => {
    vi.useFakeTimers()
    const fbq = vi.fn()
    vi.stubGlobal('fbq', fbq)
    const hatch = { ...HATCH, block: { ...HATCH.block, done_title: 'Welcome to Hatch', pending_body: 'Hang tight, un1t.online will email your receipt.' } }
    render(<PaidTrialFunnel studios={[STILLORGAN, hatch]} initialStudio="hatch" resumePurchaseId={PURCHASE_ID} />)
    expect(screen.getByText('Confirming your payment')).toBeTruthy()
    expect(screen.getByText('Hang tight, un1t.online will email your receipt.')).toBeTruthy()

    // 40 polls: the first at 300ms, then every 3s.
    await advance(300 + 39 * 3000)
    expect(fetchMock).toHaveBeenCalledTimes(40)
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/public/trial-purchases/${PURCHASE_ID}`, { cache: 'no-store' })
    expect(screen.getByText('Almost there')).toBeTruthy()
    expect(screen.getByText('Hang tight, un1t.online will email your receipt.')).toBeTruthy()
    expect(screen.queryByText('Confirming your payment')).toBeNull()
    expect(fbq).not.toHaveBeenCalled()

    // The done screen keeps listening; the cron settles the row.
    pollState = 'granted'
    await advance(3000)
    expect(screen.getByText('Welcome to Hatch')).toBeTruthy()
    await advance(30000)
    expect(fbq).toHaveBeenCalledTimes(1)
    expect(fbq).toHaveBeenCalledWith('track', 'Purchase', { value: 39, currency: 'EUR', content_name: 'The UN1T Trial' }, { eventID: `trialpurchase-${PURCHASE_ID}` })
  })

  it('Stillorgan paid poll in confirming fires the Purchase once, and a later granted poll does not fire it again', async () => {
    vi.useFakeTimers()
    const fbq = vi.fn()
    vi.stubGlobal('fbq', fbq)
    pollState = 'paid'
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} resumePurchaseId={PURCHASE_ID} />)
    expect(screen.getByText('One moment while we check with the bank.')).toBeTruthy()
    await advance(300)
    expect(screen.getByText('Payment received')).toBeTruthy()
    await advance(3000) // still paid on the done screen
    pollState = 'granted'
    await advance(3000)
    expect(screen.getByText("You're in")).toBeTruthy()
    await advance(9000)
    expect(fbq).toHaveBeenCalledTimes(1)
    expect(fbq).toHaveBeenCalledWith('track', 'Purchase', expect.objectContaining({ value: 39 }), { eventID: `trialpurchase-${PURCHASE_ID}` })
  })

  it('a poll answering expired goes back to the form with the reason', async () => {
    vi.useFakeTimers()
    pollState = 'expired'
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} initialStudio="hatch" resumePurchaseId={PURCHASE_ID} hatchTerms={HATCH_TERMS} />)
    await advance(300)
    expect(screen.getByPlaceholderText('First name')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('That checkout expired. Nothing was charged; please start again.')
    await advance(9000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('help_filed goes straight to the thanks with the Lead alone', async () => {
    answers['/api/public/trial-purchases'] = { status: 200, body: { success: false, code: 'help_filed', error: 'Thanks, the team at UN1T Hatch Street will be in touch to set up your trial.' } }
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} initialStudio="hatch" hatchTerms={HATCH_TERMS} />)
    fillDetails()
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept Hatch Street's/ }))
    fireEvent.click(submitButton())
    expect(await screen.findByText('Thanks, the team at UN1T Hatch Street will be in touch to set up your trial.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByPlaceholderText('First name')).toBeNull()
    expect(fireBrowserLead).toHaveBeenCalledTimes(1)
    expect(fireBrowserLead).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'lead-id-123' }))
    expect(fireBrowserInitiateCheckout).not.toHaveBeenCalled()
    expect(posts).toHaveLength(1)
  })

  it('a terms_required answer with no page terms shows the tick from the answer and the resubmit sends terms_accepted', async () => {
    answers['/api/public/trial-purchases'] = [
      { status: 400, body: { success: false, code: 'terms_required', error: 'Please tick to accept the terms and waiver.', terms: HATCH_TERMS } },
      { status: 200, body: { success: false, code: 'active_member', error: 'You already have an active membership.', help: { cta_label: 'I need help' } } },
    ]
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} initialStudio="hatch" hatchTerms={null} />)
    expect(screen.queryByRole('checkbox', { name: /I accept/ })).toBeNull()
    fillDetails()
    fireEvent.click(submitButton())
    expect(await screen.findByText('Please tick to accept the terms and waiver.')).toBeTruthy()
    expect(posts[0].body).not.toHaveProperty('terms_accepted')
    expect(screen.getByRole('link', { name: 'liability waiver' }).getAttribute('href')).toBe('/legal/un1t/hatch-street/waiver')
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept Hatch Street's/ }))
    fireEvent.click(submitButton())
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].body).toMatchObject({ studio: 'hatch', terms_accepted: true })
    expect(await screen.findByText('You already have an active membership.')).toBeTruthy()
  })

  it('a refusal without its message falls back to the block\'s words', async () => {
    answers['/api/public/trial-purchases'] = { status: 200, body: { success: false, code: 'trial_used', help: {} } }
    const still = { ...STILLORGAN, block: { ...STILLORGAN.block, trial_used_text: 'You have had a trial here.', help_cta_label: 'Talk to us' } }
    render(<PaidTrialFunnel studios={[still, HATCH]} initialStudio="stillorgan" />)
    fillDetails()
    fireEvent.click(submitButton())
    expect(await screen.findByText('You have had a trial here.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Talk to us' })).toBeTruthy()
  })

  it('coming Back from un1t.online (a back-forward cache restore) gives the button back', async () => {
    vi.stubGlobal('location', { ...window.location, search: '', pathname: '/trial', assign: vi.fn() })
    answers['/api/public/trial-purchases'] = { status: 200, body: { success: true, data: { purchaseId: 'p-1', redirect_url: 'https://checkout.un1t.online/c/abc', amount_cents: 3900, currency: 'EUR', product_name: 'The UN1T Trial' } } }
    render(<PaidTrialFunnel studios={[STILLORGAN, HATCH]} initialStudio="hatch" hatchTerms={HATCH_TERMS} />)
    fillDetails()
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept Hatch Street's/ }))
    fireEvent.click(submitButton())
    expect(await screen.findByRole('button', { name: 'One moment…' })).toBeTruthy()
    const ev = new Event('pageshow')
    Object.defineProperty(ev, 'persisted', { value: true })
    act(() => { window.dispatchEvent(ev) })
    expect(screen.getByRole('button', { name: 'Start my trial · €39' }).disabled).toBe(false)
  })
})

describe('single studio (TRIALFIRST.1)', () => {
  it('opens on the form with no studio picker and no Change studio', () => {
    render(<PaidTrialFunnel studios={[STILLORGAN]} initialStudio="stillorgan" />)
    expect(screen.queryByText('Choose your studio')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change studio' })).toBeNull()
    expect(screen.getByPlaceholderText('First name')).toBeTruthy()
  })
  it('one studio that is not sellable shows the not-available line and no form', () => {
    render(<PaidTrialFunnel studios={[{ ...STILLORGAN, sellable: false }]} initialStudio="stillorgan" />)
    expect(screen.getByText(/not available online right now/)).toBeTruthy()
    expect(screen.queryByPlaceholderText('First name')).toBeNull()
  })
  it('posts return_path with the details', async () => {
    answers['/api/public/trial-purchases'] = { status: 200, body: { success: true, data: { purchaseId: PURCHASE_ID, checkout: {}, amount_cents: 3900, currency: 'EUR', product_name: 'The 14 Day Reset' } } }
    render(<PaidTrialFunnel studios={[STILLORGAN]} initialStudio="stillorgan" returnPath="/stillorgan" />)
    fillDetails()
    fireEvent.click(submitButton())
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body.return_path).toBe('/stillorgan')
  })
  it('sends return_path /trial by default', async () => {
    answers['/api/public/trial-purchases'] = { status: 200, body: { success: true, data: { purchaseId: PURCHASE_ID, checkout: {}, amount_cents: 3900, currency: 'EUR', product_name: 'The 14 Day Reset' } } }
    render(<PaidTrialFunnel studios={[STILLORGAN]} initialStudio="stillorgan" />)
    fillDetails()
    fireEvent.click(submitButton())
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body.return_path).toBe('/trial')
  })
  it('preview renders a disabled form and never posts', () => {
    vi.mocked(trackFunnelStep).mockClear()
    render(<PaidTrialFunnel studios={[STILLORGAN]} initialStudio="stillorgan" preview />)
    expect(screen.getByPlaceholderText('First name').disabled).toBe(true)
    expect(submitButton().disabled).toBe(true)
    fireEvent.click(submitButton())
    expect(posts).toHaveLength(0)
    expect(trackFunnelStep).not.toHaveBeenCalled()
  })
})
