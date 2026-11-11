// @vitest-environment jsdom
//
// CHARITYENTRY.1 — a charity day where entrants choose their entry amount:
// the box starts on the suggested amount, the total follows what is typed,
// a sum below the minimum is refused before posting, and the chosen amount
// travels to /register as entry_amount_cents.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}))

const RACE = {
  id: 'ev-1', name: 'Charity Day', slug: 'charity-day', kind: 'race', race_date: '2026-11-21',
  allowed_team_sizes: [1], waves: [{ id: 'w1', start_time: '08:00:00', label: null, is_full: false }],
  registration_state: 'open', payment_currency: 'EUR', members_only: false, organization_name: 'UN1T',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 5000,
  charity: {
    enabled: true, name: 'MS Ireland', heading: 'Give', blurb: 'x', presets_cents: [1000], custom_allowed: true,
    min_cents: 500, max_cents: 500000, match_multiplier: 1, match_label: '', goal_cents: null, show_total: false,
    consent_label: '', thank_you_title: 't', thank_you_body: 'b', thank_you_body_unmatched: 'u',
    entry_amount: { enabled: true, min_cents: 2000, max_cents: 500000, suggested_cents: 5000 },
  },
}

const jsonRes = (body, status = 200) => ({
  ok: status < 400, status,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
})

let registerBodies
async function renderPage() {
  registerBodies = []
  vi.stubGlobal('fetch', vi.fn((url, init) => {
    if (String(url).endsWith('/register')) {
      registerBodies.push(JSON.parse(init.body))
      return Promise.resolve(jsonRes({ success: false, error: 'stop here' }, 500))
    }
    return Promise.resolve(jsonRes({ success: true, data: RACE }))
  }))
  render(<RaceSignupWidget slug="charity-day" embedded />)
  return screen.findByLabelText('Your entry amount, per person')
}

const form = () => document.getElementById('event-signup-form-charity-day')
function fillCaptain() {
  for (const el of form().querySelectorAll('input')) {
    if (el.id === 'entry-amount') continue
    if (el.type === 'email') fireEvent.change(el, { target: { value: 'ann@example.test' } })
    else if (el.type === 'tel') fireEvent.change(el, { target: { value: '0870000000' } })
    else if (el.type === 'text' && !el.value && !/code/i.test(el.placeholder)) fireEvent.change(el, { target: { value: 'Ann Example' } })
  }
}

const submit = () => fireEvent.submit(form())
const payButton = () => screen.getAllByRole('button', { name: /pay/i })[0]

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('choose-your-entry-amount', () => {
  it('starts on the suggested amount and prices the total from it', async () => {
    const box = await renderPage()
    expect(box.value).toBe('50')
    expect(payButton().textContent).toContain('€50.00')
    fireEvent.change(box, { target: { value: '75' } })
    expect(payButton().textContent).toContain('€75.00')
    fireEvent.change(box, { target: { value: '' } })
    expect(screen.queryAllByRole('button', { name: /pay €/i })).toHaveLength(0)
  })

  it('refuses an amount under the minimum without posting', async () => {
    const box = await renderPage()
    fillCaptain()
    fireEvent.change(box, { target: { value: '10' } })
    submit()
    expect(await screen.findByText('The minimum entry is €20.00 per person.')).toBeTruthy()
    expect(registerBodies).toHaveLength(0)
  })

  it('sends the chosen amount in cents', async () => {
    const box = await renderPage()
    fillCaptain()
    fireEvent.change(box, { target: { value: '35.50' } })
    submit()
    await waitFor(() => expect(registerBodies).toHaveLength(1))
    expect(registerBodies[0].entry_amount_cents).toBe(3550)
  })
})
