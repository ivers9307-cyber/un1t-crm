// @vitest-environment jsdom
//
// MEMRATE.1 — two operator-reported defects on the public signup widget
// (2026-08-24, the Hyrox Sim page):
//
//   1. The preview total showed a CONCRETE price ("€25.00 · 1 × non-member")
//      before the member check had answered — so a member mid-check (or
//      mid-typing) read the wrong rate as fact.
//   2. A transiently-failed check (network blip, rate limit) was cached as
//      not_member for the page's lifetime — the guard in scheduleMemberCheck
//      never re-checks a resolved email, so one blip froze "Non-member rate"
//      on a verified member until a full page reload.
//
// These tests drive the real component through a stubbed fetch: the price
// must hold ('—') until every entered email's rate is server-confirmed, and
// a failed check must surface as retryable and actually retry.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const RACE = {
  id: 'race-1',
  name: 'Test Race',
  slug: 'test-race',
  kind: 'race',
  race_date: '2026-09-05',
  allowed_team_sizes: [1],
  waves: [{ id: 'w1', label: '09:00', is_full: false }],
  registration_state: 'open',
  member_pricing_enabled: true,
  member_fee_cents: 1000,
  non_member_fee_cents: 2500,
  payment_currency: 'EUR',
  members_only: false,
}

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  }
}

// Per-test hook for the check-member endpoint; the event-load endpoint
// always answers with the RACE fixture.
let checkMember

beforeEach(() => {
  checkMember = vi.fn(() =>
    Promise.resolve(jsonRes({ success: true, data: { is_member: false, first_name: null, applicable: true } }))
  )
  vi.stubGlobal('fetch', vi.fn((url) => {
    const u = String(url)
    if (u.includes('/check-member')) return checkMember(u)
    if (u.includes('/api/public/events/')) return Promise.resolve(jsonRes({ success: true, data: RACE }))
    return Promise.resolve(jsonRes({ success: false, error: 'not found' }, 404))
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function renderLoaded() {
  render(<RaceSignupWidget slug="test-race" />)
  await screen.findByPlaceholderText('Your email *')
}

const bodyText = () => document.body.textContent
// SIDEBAR-TRIM.1 put a static fee line ("€10.00 members · €25.00
// non-members") in the details card, so held-total assertions must scope
// to the Total card rather than the whole page.
const totalCard = () => screen.getByText('Total').parentElement.textContent

describe('RaceSignupWidget — price holds until the rate is confirmed', () => {
  it('shows no concrete total before an email is entered and checked', async () => {
    await renderLoaded()
    // The old behaviour asserted €25.00 as the total immediately.
    expect(totalCard()).not.toContain('€25.00')
    expect(totalCard()).not.toContain('non-member')
    expect(totalCard()).toContain('—')
  })

  it('shows the non-member total only after the check confirms non-member', async () => {
    await renderLoaded()
    fireEvent.change(screen.getByPlaceholderText('Your email *'), {
      target: { value: 'stranger@example.com' },
    })
    await waitFor(() => expect(totalCard()).toContain('€25.00'), { timeout: 2500 })
    expect(totalCard()).toContain('1 × non-member')
  })

  it('shows the member total after the check verifies a member', async () => {
    checkMember.mockImplementation(() =>
      Promise.resolve(jsonRes({ success: true, data: { is_member: true, first_name: 'Anne Marie', applicable: true } }))
    )
    await renderLoaded()
    fireEvent.change(screen.getByPlaceholderText('Your email *'), {
      target: { value: 'annemarie@sourceitpromotions.ie' },
    })
    await waitFor(() => expect(bodyText()).toContain('1 × member'), { timeout: 2500 })
    expect(totalCard()).toContain('€10.00')
    expect(totalCard()).not.toContain('non-member')
  })
})

describe('RaceSignupWidget — a failed check is retryable, never cached as non-member', () => {
  it('surfaces a retry affordance on failure and holds the price', async () => {
    checkMember.mockImplementation(() => Promise.reject(new Error('network blip')))
    await renderLoaded()
    fireEvent.change(screen.getByPlaceholderText('Your email *'), {
      target: { value: 'annemarie@sourceitpromotions.ie' },
    })
    await waitFor(() => expect(bodyText()).toMatch(/check membership/i), { timeout: 2500 })
    // The old bug: the catch path stored not_member, so the page showed
    // "Non-member rate · €25.00" for a real member after one blip.
    expect(bodyText()).not.toContain('Non-member rate')
    expect(totalCard()).not.toContain('€25.00')
  })

  it('re-runs the check on retry and applies the member rate', async () => {
    // First call blips; every later call verifies the member.
    checkMember.mockImplementation(() =>
      Promise.resolve(jsonRes({ success: true, data: { is_member: true, first_name: 'Anne Marie', applicable: true } }))
    )
    checkMember.mockImplementationOnce(() => Promise.reject(new Error('network blip')))
    await renderLoaded()
    const input = screen.getByPlaceholderText('Your email *')
    fireEvent.change(input, { target: { value: 'annemarie@sourceitpromotions.ie' } })
    await waitFor(() => expect(bodyText()).toMatch(/check membership/i), { timeout: 2500 })

    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await waitFor(() => expect(bodyText()).toContain('1 × member'), { timeout: 2500 })
    expect(totalCard()).toContain('€10.00')
    expect(checkMember).toHaveBeenCalledTimes(2)
  })

  it('treats a rate-limit rejection as retryable, not as a non-member verdict', async () => {
    checkMember.mockImplementation(() =>
      Promise.resolve(jsonRes({ success: false, error: 'Too many lookups. Please slow down.' }, 429))
    )
    await renderLoaded()
    fireEvent.change(screen.getByPlaceholderText('Your email *'), {
      target: { value: 'annemarie@sourceitpromotions.ie' },
    })
    await waitFor(() => expect(bodyText()).toMatch(/check membership/i), { timeout: 2500 })
    expect(bodyText()).not.toContain('Non-member rate')
  })
})
