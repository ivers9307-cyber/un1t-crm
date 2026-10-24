// @vitest-environment jsdom
//
// CHARITY.8 — the donate card on the public event page: amount chips, the
// custom amount with the operator's bounds, the POST, the embedded checkout,
// and the done step that polls the donation until the server has seen it paid
// (the poll is what runs the receipt; the SDK's success callback is not).

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react'
import DonateCard from './DonateCard.jsx'

vi.mock('./landing-page/ClassFunnelCheckout', () => ({
  default: ({ paymentId, onPaid, statusPath }) => (
    <button type="button" data-status-path={statusPath} onClick={onPaid}>Stub pay {paymentId}</button>
  ),
}))

const CHARITY = {
  enabled: true,
  name: 'MS Ireland',
  heading: "Can't race? Give a rep.",
  blurb: 'Every euro goes to {{charity}}.',
  presets_cents: [1000, 2500, 5000, 10000],
  custom_allowed: true,
  min_cents: 500,
  max_cents: 500000,
  match_multiplier: 2,
  match_label: 'Matched by {{brand}}',
  goal_cents: null,
  show_total: true,
  consent_label: '',
  thank_you_title: 'Thank you, {{first_name}}.',
  thank_you_body: 'Your {{amount}} becomes {{matched}} for {{charity}}.',
  thank_you_body_unmatched: 'Thank you for your {{amount}} donation to {{charity}}.',
}

const jsonRes = (body, status = 200) => ({
  ok: status < 400, status,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
})

const DONATE_OK = {
  success: true,
  data: { donation: { id: 'd-1', amount_cents: 2500, currency: 'EUR', checkout: { provider: 'revolut', token: 'tok', url: null, connectedAccountId: null } } },
}
const poll = (state, extra = {}) => ({
  success: true,
  data: { id: 'd-1', state, amount_cents: 2500, currency: 'EUR', match_multiplier: 2, checkout: null, ...extra },
})

// fetch stubbed per URL; `polls` are served in order, the last one repeating.
function stubFetch({ donate = DONATE_OK, donateStatus = 200, polls = [poll('paid')] } = {}) {
  const queue = [...polls]
  const fn = vi.fn((url) => {
    if (String(url).endsWith('/donate')) return Promise.resolve(jsonRes(donate, donateStatus))
    if (String(url).startsWith('/api/public/donations/')) {
      const next = queue.length > 1 ? queue.shift() : queue[0]
      return Promise.resolve(jsonRes(next))
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const donateCalls = (fn) => fn.mock.calls.filter(([u]) => String(u).endsWith('/donate'))
const pollCalls = (fn) => fn.mock.calls.filter(([u]) => String(u).startsWith('/api/public/donations/'))
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

function renderCard(props = {}) {
  return render(<DonateCard slug="charity-day" charity={CHARITY} currency="EUR" brand="UN1T" onRaised={() => {}} {...props} />)
}

function fillDetails() {
  fireEvent.change(screen.getByPlaceholderText('Your name *'), { target: { value: 'Sarah Byrne' } })
  fireEvent.change(screen.getByPlaceholderText('Your email *'), { target: { value: 'sarah@example.com' } })
}

const donateButton = () => screen.getByRole('button', { name: /^Donate/ })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try { window.sessionStorage.clear() } catch { /* none */ }
})
afterEach(() => { vi.useRealTimers(); cleanup(); vi.unstubAllGlobals() })

describe('DonateCard — the form', () => {
  it('renders the four default chips and "Other"', () => {
    stubFetch()
    renderCard()
    for (const label of ['€10', '€25', '€50', '€100', 'Other']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('keeps the operator\'s preset order (no sorting) and preselects the second preset', () => {
    stubFetch()
    renderCard({ charity: { ...CHARITY, presets_cents: [5000, 1000, 2500] } })
    const chips = screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed') && b.textContent !== 'Other')
    expect(chips.map((b) => b.textContent)).toEqual(['€50', '€10', '€25'])
    expect(screen.getByRole('button', { name: '€10' }).getAttribute('aria-pressed')).toBe('true')
    expect(donateButton().textContent).toContain('Donate €10.00')
  })

  it('picking a chip sets the button label', () => {
    stubFetch()
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: '€50' }))
    expect(donateButton().textContent).toContain('Donate €50.00')
    fireEvent.click(screen.getByRole('button', { name: '€25' }))
    expect(donateButton().textContent).toContain('Donate €25.00')
  })

  it('has no "Other" chip when custom amounts are off', () => {
    stubFetch()
    renderCard({ charity: { ...CHARITY, custom_allowed: false } })
    expect(screen.queryByRole('button', { name: 'Other' })).toBeNull()
  })

  it('"Other" shows a number input; below the minimum shows the error and does not POST', async () => {
    const fetchFn = stubFetch()
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    const input = screen.getByLabelText('Other amount')
    expect(input.getAttribute('type')).toBe('number')
    fireEvent.change(input, { target: { value: '3' } })
    fillDetails()
    fireEvent.click(donateButton())
    await advance(0)
    expect(screen.getByText('Minimum €5.00')).toBeTruthy()
    expect(donateCalls(fetchFn)).toHaveLength(0)
  })

  it('above the maximum shows the error and does not POST', async () => {
    const fetchFn = stubFetch()
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    fireEvent.change(screen.getByLabelText('Other amount'), { target: { value: '6000' } })
    fillDetails()
    fireEvent.click(donateButton())
    await advance(0)
    expect(screen.getByText('Maximum €5,000.00')).toBeTruthy()
    expect(donateCalls(fetchFn)).toHaveLength(0)
  })

  it('uses the consent label when set, else the organisation line', () => {
    stubFetch()
    const { unmount } = renderCard()
    expect(document.body.textContent).toContain('Yes, send me UN1T promotional updates and offers')
    unmount()
    renderCard({ charity: { ...CHARITY, consent_label: 'Keep me posted about MS Ireland.' } })
    expect(document.body.textContent).toContain('Keep me posted about MS Ireland.')
  })

  it('submit POSTs the donation and mounts the checkout', async () => {
    window.sessionStorage.setItem('un1t_visit_origin', JSON.stringify({ referrer: 'https://www.google.com/', landing_path: '/event/charity-day' }))
    const fetchFn = stubFetch()
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: '€25' }))
    fillDetails()
    fireEvent.change(screen.getByPlaceholderText('Message (optional)'), { target: { value: 'Go Dave!' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(donateButton())
    await waitFor(() => expect(screen.getByRole('button', { name: /Stub pay d-1/ })).toBeTruthy())

    const [[url, opts]] = donateCalls(fetchFn)
    expect(url).toBe('/api/public/events/charity-day/donate')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({
      amount_cents: 2500,
      name: 'Sarah Byrne',
      email: 'sarah@example.com',
      message: 'Go Dave!',
      marketing_opt_in: true,
      attribution: { referrer: 'https://www.google.com/', landing_path: '/event/charity-day' },
    })
    expect(screen.getByRole('button', { name: /Stub pay d-1/ }).getAttribute('data-status-path')).toBe('/api/public/donations')
  })

  it('caps the visit origin to the route\'s bounds so a long referrer never blocks a gift', async () => {
    window.sessionStorage.setItem('un1t_visit_origin', JSON.stringify({ referrer: `https://x.ie/${'a'.repeat(3000)}`, landing_path: `/${'b'.repeat(900)}` }))
    const fetchFn = stubFetch()
    renderCard()
    fillDetails()
    fireEvent.click(donateButton())
    await waitFor(() => expect(donateCalls(fetchFn)).toHaveLength(1))
    const { attribution } = JSON.parse(donateCalls(fetchFn)[0][1].body)
    expect(attribution.referrer).toHaveLength(2000)
    expect(attribution.landing_path).toHaveLength(500)
  })

  it('shows the server error when the POST is refused', async () => {
    stubFetch({ donate: { success: false, code: 'payments_unavailable', error: 'Card donations are not available right now.' }, donateStatus: 503 })
    renderCard()
    fillDetails()
    fireEvent.click(donateButton())
    await waitFor(() => expect(screen.getByText('Card donations are not available right now.')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Stub pay/ })).toBeNull()
  })
})

describe('DonateCard — done step', () => {
  async function payThrough() {
    fireEvent.click(screen.getByRole('button', { name: '€25' }))
    fillDetails()
    fireEvent.click(donateButton())
    await waitFor(() => expect(screen.getByRole('button', { name: /Stub pay d-1/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Stub pay d-1/ }))
  }

  it('polls the donation until it is paid, then shows the matched thank-you', async () => {
    const onRaised = vi.fn()
    const fetchFn = stubFetch({ polls: [poll('pending'), poll('pending'), poll('paid')] })
    renderCard({ onRaised })
    await payThrough()

    // Not thanked on the SDK callback alone: the server has not seen it paid.
    expect(screen.queryByText('Thank you, Sarah.')).toBeNull()
    await advance(10_000)

    expect(pollCalls(fetchFn).length).toBeGreaterThanOrEqual(3)
    expect(pollCalls(fetchFn)[0][0]).toBe('/api/public/donations/d-1')
    expect(screen.getByText('Thank you, Sarah.')).toBeTruthy()
    expect(screen.getByText('Your €25.00 becomes €50.00 for MS Ireland.')).toBeTruthy()
    expect(onRaised).toHaveBeenCalledTimes(1)

    // Polling stops once paid.
    const n = pollCalls(fetchFn).length
    await advance(10_000)
    expect(pollCalls(fetchFn).length).toBe(n)
  })

  it('uses the unmatched body at multiplier 1', async () => {
    stubFetch({ polls: [poll('paid', { match_multiplier: 1 })] })
    renderCard({ charity: { ...CHARITY, match_multiplier: 1 } })
    await payThrough()
    await advance(5_000)
    expect(screen.getByText('Thank you for your €25.00 donation to MS Ireland.')).toBeTruthy()
  })

  it('a failed payment returns to the form with a message', async () => {
    stubFetch({ polls: [poll('failed')] })
    renderCard()
    await payThrough()
    await advance(5_000)
    expect(donateButton()).toBeTruthy()
    expect(document.body.textContent).toContain('did not go through')
  })
})

describe('DonateCard — return from a redirect checkout', () => {
  it('resumeDonationId mounts straight into confirming and polls that donation', async () => {
    const fetchFn = stubFetch({ polls: [poll('pending', { id: 'd-9' }), poll('paid', { id: 'd-9' })] })
    renderCard({ resumeDonationId: 'd-9' })
    expect(screen.queryByRole('button', { name: /^Donate/ })).toBeNull()
    expect(document.body.textContent).toContain('Confirming your donation')
    await advance(10_000)
    expect(pollCalls(fetchFn)[0][0]).toBe('/api/public/donations/d-9')
    expect(screen.getByText('Your €25.00 becomes €50.00 for MS Ireland.')).toBeTruthy()
  })

  it('stops polling after about two minutes and offers a way back to the form', async () => {
    const fetchFn = stubFetch({ polls: [poll('pending', { id: 'd-9' })] })
    renderCard({ resumeDonationId: 'd-9' })
    await advance(130_000)
    const n = pollCalls(fetchFn).length
    expect(n).toBeLessThanOrEqual(40)
    expect(document.body.textContent).toContain('taking longer than usual')
    await advance(30_000)
    expect(pollCalls(fetchFn).length).toBe(n)
    fireEvent.click(screen.getByRole('button', { name: 'Start a new donation' }))
    expect(donateButton()).toBeTruthy()
  })

  it('strips donation and cancelled from the URL once the poll settles paid, keeping other params', async () => {
    window.history.replaceState(null, '', '/event/charity-day?donation=d-9&ref=ig#donate')
    stubFetch({ polls: [poll('paid', { id: 'd-9' })] })
    renderCard({ resumeDonationId: 'd-9' })
    await advance(5_000)
    expect(screen.getByText('Your €25.00 becomes €50.00 for MS Ireland.')).toBeTruthy()
    expect(window.location.pathname).toBe('/event/charity-day')
    expect(window.location.search).toBe('?ref=ig')
    expect(window.location.hash).toBe('#donate')
    window.history.replaceState(null, '', '/')
  })

  it('strips donation and cancelled from the URL once the poll settles failed', async () => {
    window.history.replaceState(null, '', '/event/charity-day?donation=d-9&cancelled=0')
    stubFetch({ polls: [poll('failed', { id: 'd-9' })] })
    renderCard({ resumeDonationId: 'd-9' })
    await advance(5_000)
    expect(document.body.textContent).toContain('did not go through')
    expect(window.location.search).toBe('')
    window.history.replaceState(null, '', '/')
  })

  it('leaves the URL alone while the poll is still pending', async () => {
    window.history.replaceState(null, '', '/event/charity-day?donation=d-9')
    stubFetch({ polls: [poll('pending', { id: 'd-9' })] })
    renderCard({ resumeDonationId: 'd-9' })
    await advance(5_000)
    expect(window.location.search).toBe('?donation=d-9')
    window.history.replaceState(null, '', '/')
  })

  it('resumeCancelled reopens the form', () => {
    const fetchFn = stubFetch()
    renderCard({ resumeDonationId: 'd-9', resumeCancelled: true })
    expect(donateButton()).toBeTruthy()
    expect(pollCalls(fetchFn)).toHaveLength(0)
  })
})
