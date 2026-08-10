// @vitest-environment jsdom
//
// GAPS-P2 — the outcome panel. What is tested here is honesty, not layout:
// the control cohort is always on screen, the window is always stated, a
// no-difference result is NOT allowed to read as a win, and recurring revenue
// is nowhere.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import CampaignOutcomeReport, { readOutcome } from './CampaignOutcomeReport.jsx'

// The real Nutrable figures: a genuine effect on event registrations
// (11.1% vs 0%) sitting next to noise on class attendance (11.1% vs 9.2%).
const REAL = {
  window_days: 7,
  clicked: {
    contacts: 45, event_registrations: 5, class_attendances: 5, purchases: 0, purchase_cents: 0,
    rates: { event_registrations: 5 / 45, class_attendances: 5 / 45, purchases: 0 },
  },
  not_opened: {
    contacts: 348, event_registrations: 0, class_attendances: 32, purchases: 0, purchase_cents: 0,
    rates: { event_registrations: 0, class_attendances: 32 / 348, purchases: 0 },
  },
}

let payload = REAL
beforeEach(() => {
  payload = REAL
  global.fetch = vi.fn(async () => ({ json: async () => ({ success: true, data: payload }) }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('CampaignOutcomeReport', () => {
  it('shows the control cohort beside the attributed number', async () => {
    render(<CampaignOutcomeReport campaignId="c1" />)
    await screen.findByText(/what happened next/i)
    expect(screen.getByText('45')).toBeTruthy()
    expect(screen.getByText('348')).toBeTruthy()
    expect(screen.getAllByText(/never opened it/i).length).toBeGreaterThan(0)
  })

  it('does NOT let a no-difference outcome read as a win', async () => {
    render(<CampaignOutcomeReport campaignId="c1" />)
    await screen.findByText(/what happened next/i)
    // 11.1% vs 9.2% on class attendance is noise and must say so.
    expect(screen.getAllByText(/no measurable difference/i).length).toBeGreaterThan(0)
  })

  it('calls the genuine effect what it is', async () => {
    render(<CampaignOutcomeReport campaignId="c1" />)
    await screen.findByText(/what happened next/i)
    expect(screen.getByText(/only clickers did this/i)).toBeTruthy()
  })

  it('states the attribution window and refetches when it changes', async () => {
    render(<CampaignOutcomeReport campaignId="c1" />)
    await screen.findByText(/what happened next/i)
    expect(global.fetch.mock.calls[0][0]).toMatch(/window_days=7/)
    fireEvent.click(screen.getByRole('button', { name: /30 days/i }))
    await waitFor(() => expect(global.fetch.mock.calls.at(-1)[0]).toMatch(/window_days=30/))
  })

  it('never mentions recurring revenue, and says why it is absent', async () => {
    render(<CampaignOutcomeReport campaignId="c1" />)
    await screen.findByText(/what happened next/i)
    expect(screen.getByText(/direct debit/i)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/recurring revenue|membership revenue/i)
  })

  it('says so plainly when nobody clicked, rather than rendering zeroes', async () => {
    payload = { ...REAL, clicked: { ...REAL.clicked, contacts: 0, rates: { event_registrations: null, class_attendances: null, purchases: null } } }
    render(<CampaignOutcomeReport campaignId="c1" />)
    await screen.findByText(/nobody clicked a link/i)
  })

  it('labels the numbers as attributed, not caused', async () => {
    render(<CampaignOutcomeReport campaignId="c1" />)
    await screen.findByText(/what happened next/i)
    // The copy must explicitly disown causation rather than merely avoid the
    // word — "attributed to the campaign, not caused by it".
    expect(document.body.textContent).toMatch(/attributed to the campaign, not caused by it/i)
  })

  it('every control is a real button (repo form invariant)', async () => {
    const { container } = render(<CampaignOutcomeReport campaignId="c1" />)
    await screen.findByText(/what happened next/i)
    for (const b of container.querySelectorAll('button')) expect(b.getAttribute('type')).toBe('button')
  })
})

describe('readOutcome', () => {
  it('refuses to call parity a result', () => {
    expect(readOutcome(0.111, 0.092).tone).toBe('none')
    expect(readOutcome(0.111, 0.092).text).toMatch(/no measurable difference/i)
  })
  it('calls a clear lift a lift', () => {
    expect(readOutcome(0.2, 0.05).tone).toBe('good')
  })
  it('handles a zero control without dividing by it', () => {
    expect(readOutcome(0.111, 0).text).toMatch(/only clickers/i)
    expect(readOutcome(0, 0).tone).toBe('none')
  })
  it('says nothing when there is nothing to measure', () => {
    expect(readOutcome(null, 0.1).text).toMatch(/no clickers/i)
  })
})
