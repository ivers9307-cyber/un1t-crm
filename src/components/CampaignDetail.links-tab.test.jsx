// @vitest-environment jsdom
//
// COMMSFIX.F.4 — the click report has to be REACHABLE, not merely written.
// The panel itself is covered by CampaignLinkReport.test.jsx; these two tests
// pin the wiring on CampaignDetail, which is the part a rebase can quietly
// drop (there is an open PR rewriting this file's header and controls, and the
// tab list sits between them).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

// COMMSFIX.D.1b (#1314) gave CampaignDetail stop/unschedule controls that write
// through the browser Supabase client, so the component now needs one to render
// at all. This file only cares about the Links tab; the cancel path has its own
// coverage in CampaignDetail.test.jsx. Added during the #1314/#1315 rebase.
vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    from: () => ({
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  }),
}))

import CampaignDetail from './CampaignDetail.jsx'

const CAMPAIGN = {
  id: 'camp-1',
  name: 'August lock-in sale',
  subject: 'Two weeks free',
  status: 'sent',
  sent_at: '2026-08-08T10:00:00Z',
  total_sent: 2059,
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, data: [] }),
  })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CampaignDetail — Links tab', () => {
  it('offers a Links tab beside Recipients', () => {
    render(<CampaignDetail campaign={CAMPAIGN} />)

    const tabs = [...document.querySelectorAll('button')].map((b) => b.textContent)
    expect(tabs).toContain('Links')
    expect(tabs.indexOf('Links')).toBe(tabs.findIndex((t) => t.startsWith('Recipients')) + 1)
  })

  it('renders the click report for this campaign once the tab is opened', async () => {
    render(<CampaignDetail campaign={CAMPAIGN} />)

    // Nothing is fetched until the operator asks for it.
    expect(fetch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Links'))
    await flush()

    expect(fetch).toHaveBeenCalledWith('/api/campaigns/camp-1/links')
    expect(screen.getByText('No link clicks recorded yet.')).toBeTruthy()
  })
})
