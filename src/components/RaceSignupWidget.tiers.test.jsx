// @vitest-environment jsdom
// TIERS.1 — the public page prices from the `pricing` block: the price row
// names the current tier and what follows, the group price has its own row,
// and the live total uses the tier for the chosen headcount.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const RACE = {
  id: 'ev-1', name: 'Mobility', slug: 'mob', kind: 'workshop', race_date: '2026-12-05',
  allowed_team_sizes: [1, 2, 3, 4], capacity_mode: 'people',
  waves: [{ id: 'w1', start_time: '10:00:00', label: null, is_full: false }],
  registration_state: 'open', payment_currency: 'EUR', members_only: false, organization_name: 'UN1T',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 3500,
  pricing: {
    base_cents: 3500,
    current: { id: 'early', name: 'Early bird', price_cents: 2500, ends_at: null, limited: true },
    next: { name: 'Standard', price_cents: 3500, starts_at: null },
    group: { min_people: 3, price_cents: 2800 },
  },
}
const jsonRes = (body) => ({ ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => body })
async function renderWidget(data) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonRes({ success: true, data }))))
  render(<RaceSignupWidget slug="mob" />)
  await screen.findByPlaceholderText('Your email *')
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceSignupWidget — pricing tiers', () => {
  it('the price row names the tier, says it is limited and what follows; the group price has its own row', async () => {
    await renderWidget(RACE)
    const text = document.body.textContent
    expect(text).toContain('Early bird €25.00 (limited), then €35.00')
    expect(text).toContain('3+ people: €28.00 each')
    expect(text).not.toContain('€35.00 per person')
  })
  it('the live total uses the tier price, and the group price once the group is big enough', async () => {
    await renderWidget(RACE)
    // The Total card shows the one-person tier price (the price row shows it too).
    expect(screen.getAllByText('€25.00').length).toBeGreaterThanOrEqual(1)
    const pill = screen.getAllByRole('button').find((b) => /^3\b/.test(b.textContent.trim()))
    fireEvent.click(pill)
    // 3 people at the group price
    expect(screen.getAllByText('€84.00').length).toBeGreaterThanOrEqual(1)
  })
  it('without a pricing block the old copy stands', async () => {
    await renderWidget({ ...RACE, pricing: undefined })
    expect(document.body.textContent).toContain('€35.00 per person')
  })
})
