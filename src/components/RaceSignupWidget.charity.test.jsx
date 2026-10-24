// @vitest-environment jsdom
//
// CHARITY.8 — the public event page with donations on: the raised-so-far
// strip, the donate card and the signup card side by side with an OR between
// them, and the event description full width below. With donations off the
// page is as before; the paste-anywhere embed never shows the donate card.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}))

const BASE = {
  id: 'ev-1', name: 'Charity Day', slug: 'charity-day', kind: 'race', race_date: '2026-11-21',
  description: 'About 11,000 people in Ireland live with MS.',
  allowed_team_sizes: [1], waves: [{ id: 'w1', start_time: '08:00:00', label: null, is_full: false }],
  registration_state: 'open', payment_currency: 'EUR', members_only: false, organization_name: 'UN1T',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 2500,
}

const CHARITY = {
  enabled: true, name: 'MS Ireland', heading: "Can't race? Give a rep.", blurb: 'Every euro goes to {{charity}}.',
  presets_cents: [1000, 2500, 5000, 10000], custom_allowed: true, min_cents: 500, max_cents: 500000,
  match_multiplier: 2, match_label: 'Matched by {{brand}}', goal_cents: 1000000, show_total: true,
  consent_label: '', thank_you_title: 'Thank you, {{first_name}}.', thank_you_body: 'x', thank_you_body_unmatched: 'y',
  raised_cents: 16000, donation_count: 3, team_count: 2,
}

const jsonRes = (body) => ({
  ok: true, status: 200,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
})

async function renderWith(race, props = {}) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonRes({ success: true, data: { ...BASE, ...race } }))))
  render(<RaceSignupWidget slug="charity-day" {...props} />)
  // Both cards ask for an email when donations are on.
  await screen.findAllByPlaceholderText('Your email *')
}

const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
// The form's own submit (the mobile sticky bar repeats the label later in the DOM).
const registerButton = () => screen.getAllByRole('button', { name: /Register and pay/ })[0]

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('event page — donations off', () => {
  it('has no donate card, and the description sits in the left column before the form', async () => {
    await renderWith({})
    expect(screen.queryByRole('button', { name: /^Donate/ })).toBeNull()
    expect(screen.queryByText('OR')).toBeNull()
    const desc = screen.getByText(BASE.description)
    expect(follows(desc, registerButton())).toBe(true)
    expect(desc.closest('.md\\:grid-cols-\\[1fr_420px\\]')).toBeTruthy()
  })
})

describe('event page — donations on', () => {
  it('puts OR between the Donate button and the signup button, the description after both', async () => {
    await renderWith({ charity: CHARITY })
    const donate = screen.getByRole('button', { name: /^Donate/ })
    const or = screen.getByText('OR')
    const register = registerButton()
    expect(follows(donate, or)).toBe(true)
    expect(follows(or, register)).toBe(true)
    expect(screen.getByRole('separator', { name: 'or' })).toBeTruthy()
    const desc = screen.getByText(BASE.description)
    expect(follows(donate, desc)).toBe(true)
    expect(follows(register, desc)).toBe(true)
  })

  it('shows the raised-so-far strip', async () => {
    await renderWith({ charity: CHARITY })
    const text = document.body.textContent
    expect(text).toContain('€160.00 raised')
    expect(text).toContain('Goal €10,000.00')
    expect(text).toContain('3 donors · 2 teams')
  })

  it('no strip when the totals are hidden', async () => {
    const { raised_cents: _r, donation_count: _d, team_count: _t, ...rest } = CHARITY
    await renderWith({ charity: { ...rest, show_total: false } })
    expect(document.body.textContent).not.toContain('raised so far')
    expect(screen.getByRole('button', { name: /^Donate/ })).toBeTruthy()
  })

  it('the embed never renders the donate card', async () => {
    await renderWith({ charity: CHARITY }, { embedded: true })
    expect(screen.queryByRole('button', { name: /^Donate/ })).toBeNull()
    expect(screen.queryByText('OR')).toBeNull()
    expect(document.body.textContent).not.toContain('raised so far')
  })
})
