// @vitest-environment jsdom
//
// COMMSFIX.F.4 — the per-link click report panel.
//
// The headline number is UNIQUE CLICKERS, not total clicks: one enthusiastic
// person clicking a link five times is not five people, and an operator
// deciding which offer worked will read whichever number is biggest. Several
// of these tests exist only to pin that ordering and emphasis, because the
// honest number is the smaller one and it is the easy one to lose.
//
// The share bar is relative to the TOP link, not to the campaign's recipients
// — it answers "which of these links won", which is the question asked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import CampaignLinkReport from './CampaignLinkReport.jsx'

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: () => Promise.resolve(body) }
}

/** Flush the fetch → json → setState microtask chain. */
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

const ROWS = [
  { url: 'https://un1t.ie/offers', clicks: 41, unique_clickers: 30 },
  { url: 'https://un1t.ie/timetable', clicks: 12, unique_clickers: 6 },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ success: true, data: ROWS }))))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CampaignLinkReport', () => {
  it('fetches the report for its campaign', async () => {
    render(<CampaignLinkReport campaignId="camp-1" />)
    await flush()

    expect(fetch).toHaveBeenCalledWith('/api/campaigns/camp-1/links')
  })

  it('shows a loading state before the report arrives', () => {
    render(<CampaignLinkReport campaignId="camp-1" />)

    expect(screen.getByText(/loading link report/i)).toBeTruthy()
  })

  it('renders unique clickers and total clicks for each link', async () => {
    const { container } = render(<CampaignLinkReport campaignId="camp-1" />)
    await flush()

    const rows = container.querySelectorAll('[data-link-row]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('30')
    expect(rows[0].textContent).toContain('41')
    expect(rows[1].textContent).toContain('6')
    expect(rows[1].textContent).toContain('12')
  })

  it('labels the two numbers so unique clickers is not mistaken for total clicks', async () => {
    render(<CampaignLinkReport campaignId="camp-1" />)
    await flush()

    // Column headers, in the order the numbers appear: unique clickers first.
    expect(screen.getAllByText('People')[0]).toBeTruthy()
    expect(screen.getAllByText('Clicks')[0]).toBeTruthy()
    // And the distinction is spelled out, not left to the operator to guess.
    expect(screen.getByText(/how many different contacts clicked/i)).toBeTruthy()
  })

  it('sizes the share bar against the TOP link, not the recipient count', async () => {
    const { container } = render(<CampaignLinkReport campaignId="camp-1" />)
    await flush()

    const bars = container.querySelectorAll('[data-share-bar]')
    expect(bars).toHaveLength(2)
    expect(bars[0].style.width).toBe('100%')
    // 6 unique clickers against a top link of 30.
    expect(bars[1].style.width).toBe('20%')
  })

  it('shortens the displayed URL but keeps the whole thing in title', async () => {
    const long = `https://un1t.ie/offers/${'x'.repeat(120)}`
    fetch.mockResolvedValue(jsonResponse({
      success: true,
      data: [{ url: long, clicks: 1, unique_clickers: 1 }],
    }))

    const { container } = render(<CampaignLinkReport campaignId="camp-1" />)
    await flush()

    const link = container.querySelector('[data-link-row] a')
    expect(link.getAttribute('title')).toBe(long)
    expect(link.textContent.length).toBeLessThan(long.length)
    expect(link.textContent).toMatch(/…$/)
  })

  it('opens links safely — rel="noopener noreferrer" on every outbound anchor', async () => {
    const { container } = render(<CampaignLinkReport campaignId="camp-1" />)
    await flush()

    const links = container.querySelectorAll('[data-link-row] a')
    expect(links).toHaveLength(2)
    for (const a of links) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
      expect(a.getAttribute('target')).toBe('_blank')
    }
  })

  it('shows the empty state when nobody has clicked anything', async () => {
    fetch.mockResolvedValue(jsonResponse({ success: true, data: [] }))

    render(<CampaignLinkReport campaignId="camp-1" />)
    await flush()

    expect(screen.getByText('No link clicks recorded yet.')).toBeTruthy()
  })

  it('shows an error state rather than a permanent spinner when the request fails', async () => {
    fetch.mockResolvedValue(jsonResponse({ success: false, error: 'nope' }, { ok: false, status: 500 }))

    render(<CampaignLinkReport campaignId="camp-1" />)
    await flush()

    expect(screen.queryByText(/loading link report/i)).toBeNull()
    expect(screen.getByText(/couldn.t load the link report/i)).toBeTruthy()
  })

  it('shows the error state when fetch itself rejects', async () => {
    fetch.mockRejectedValue(new Error('offline'))

    render(<CampaignLinkReport campaignId="camp-1" />)
    await flush()

    expect(screen.getByText(/couldn.t load the link report/i)).toBeTruthy()
  })

  it('every button is type="button" — a stray submit inside a form is the repo default', async () => {
    const { container } = render(<CampaignLinkReport campaignId="camp-1" />)
    await flush()

    for (const btn of container.querySelectorAll('button')) {
      expect(btn.getAttribute('type')).toBe('button')
    }
  })
})
