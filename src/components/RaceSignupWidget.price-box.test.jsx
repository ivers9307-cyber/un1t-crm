// @vitest-environment jsdom
//
// EVENT-PRICEBOX.1 — the details box on the public event page. With member
// pricing on and no member fee (members free), it used to read "€25.00 per
// person", so members thought they'd be charged (Sean Noble workshop,
// 12 Oct 2026). It now shows both rates and reminds members which email to use.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const BASE = {
  id: 'ev-1', name: 'Workshop', slug: 'hatch-oct24-1000', kind: 'workshop', race_date: '2026-10-24',
  allowed_team_sizes: [1], waves: [{ id: 'w1', start_time: '10:00:00', label: null, is_full: false }],
  registration_state: 'open', payment_currency: 'EUR', members_only: false, organization_name: 'UN1T',
}

const jsonRes = (body) => ({
  ok: true, status: 200,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
})

async function renderWith(race) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonRes({ success: true, data: { ...BASE, ...race } }))))
  render(<RaceSignupWidget slug="hatch-oct24-1000" />)
  await screen.findByPlaceholderText('Your email *')
  return document.body.textContent
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('event details box — price line', () => {
  it('members free: shows both rates, never "per person"', async () => {
    const text = await renderWith({ member_pricing_enabled: true, member_fee_cents: null, non_member_fee_cents: 2500 })
    expect(text).toContain('Members free · Non-members €25.00')
    expect(text).not.toContain('per person')
  })

  it('a paid member rate shows both amounts', async () => {
    const text = await renderWith({ member_pricing_enabled: true, member_fee_cents: 1000, non_member_fee_cents: 2500 })
    expect(text).toContain('Members €10.00 · Non-members €25.00')
  })

  it('no member pricing: one price per person and no member reminder', async () => {
    const text = await renderWith({ member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 2500 })
    expect(text).toContain('€25.00 per person')
    expect(text).not.toContain('to get the member rate')
  })

  it('reminds members to use the email on their account', async () => {
    const text = await renderWith({ member_pricing_enabled: true, member_fee_cents: null, non_member_fee_cents: 2500 })
    expect(text).toContain('UN1T members: sign up with the email on your UN1T account to get the member rate.')
  })
})
