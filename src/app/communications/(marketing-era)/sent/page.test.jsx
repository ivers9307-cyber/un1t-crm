// @vitest-environment jsdom
//
// COMMSLAYOUT.1 — the Sends page has listed email campaigns alongside SMS and
// WhatsApp since PILLAR2 Phase 2, but the subtitle still said "One-off SMS &
// WhatsApp sends at this location", so the one channel most likely to be
// looked for was the one the page claimed not to have.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: () => true }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('@/lib/campaign-display-stats', () => ({
  loadCampaignRecipientStats: async () => ({}),
  campaignDisplayStats: () => ({ recipients: 0, sent: 0, bounced: 0 }),
}))

import SendsHistoryPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

// Every builder method returns the same object; awaiting it yields no rows.
function emptyChain() {
  const o = {
    select: () => o, eq: () => o, in: () => o, order: () => o, limit: () => o,
    then: (resolve) => resolve({ data: [], count: 0 }),
  }
  return o
}

// Unmount AFTER each test, so the last test's tree is gone before jsdom is
// torn down (see tests/rtl-cleanup-after-each.test.js).
afterEach(cleanup)

beforeEach(() => {
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: { id: 'loc-1' } })
  createServerClient.mockReturnValue({ from: () => emptyChain() })
})

describe('/communications/sent subtitle (COMMSLAYOUT.1)', () => {
  // TWILIO-RETIRE.1 — SMS left the list with the channel.
  it('names the two channels the page actually lists, and not SMS', async () => {
    render(await SendsHistoryPage())
    const sub = screen.getByText(/sends at this location/i).textContent
    expect(sub).not.toMatch(/SMS/)
    expect(sub).toMatch(/WhatsApp/i)
    expect(sub).toMatch(/email/i)
  })

  it('no longer claims the page is SMS + WhatsApp only', async () => {
    const { container } = render(await SendsHistoryPage())
    expect(container.textContent).not.toContain('One-off SMS & WhatsApp sends at this location.')
  })

  it('keeps the copy free of em-dashes', async () => {
    render(await SendsHistoryPage())
    expect(screen.getByText(/sends at this location/i).textContent).not.toContain('—')
  })
})

describe('"Made in Claude" marker (MCPEMAIL.1)', () => {
  function chainWith(rows) {
    const o = {
      select: (cols) => { o.cols = cols; return o }, eq: () => o, in: () => o, order: () => o, limit: () => o,
      then: (resolve) => resolve({ data: rows, count: rows.length }),
    }
    return o
  }
  const row = (id, name, created_via) => ({
    id, name, status: 'draft', created_via, created_at: '2031-07-01T00:00:00Z',
    total_recipients: 0, total_sent: 0, total_bounced: 0,
  })

  it('shows "Made in Claude" on a campaign with created_via mcp and nothing on a web one', async () => {
    const chains = {}
    createServerClient.mockReturnValue({
      from: (t) => {
        chains[t] = chainWith(t === 'campaigns' ? [row('c1', 'Agent made', 'mcp'), row('c2', 'Web made', 'web')] : [])
        return chains[t]
      },
    })
    const { container } = render(await SendsHistoryPage())
    const badges = screen.getAllByText('Made in Claude')
    expect(badges).toHaveLength(1)
    const agentRow = screen.getByText('Agent made').closest('tr')
    const webRow = screen.getByText('Web made').closest('tr')
    expect(agentRow.textContent).toContain('Made in Claude')
    expect(webRow.textContent).not.toContain('Made in Claude')
    expect(container.textContent).not.toContain('—Made')
    // named columns only: the read must ask for created_via
    expect(chains.campaigns.cols).toMatch(/\bcreated_via\b/)
  })
})
