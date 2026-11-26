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
  campaignDisplayStats: vi.fn(() => ({ recipients: 0, sent: 0, bounced: 0 })),
  pct: (r) => `${(Number(r) * 100).toFixed(1)}%`,
}))

import SendsHistoryPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { campaignDisplayStats } from '@/lib/campaign-display-stats'

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

describe('delivered and clicked columns (MKTSHELL.2)', () => {
  function chainWith(rows) {
    const o = {
      select: () => o, eq: () => o, in: () => o, order: () => o, limit: () => o,
      then: (resolve) => resolve({ data: rows, count: rows.length }),
    }
    return o
  }
  const sentRow = { id: 'c1', name: 'Autumn offer', status: 'sent', created_at: '2031-07-01T00:00:00Z', sent_at: '2031-07-01T00:00:00Z' }
  const useRows = () => createServerClient.mockReturnValue({
    from: (t) => chainWith(t === 'campaigns' ? [sentRow] : []),
  })
  afterEach(() => campaignDisplayStats.mockImplementation(() => ({ recipients: 0, sent: 0, bounced: 0 })))

  it('shows delivered and clicked for a sent email, from the recipient figures', async () => {
    useRows()
    campaignDisplayStats.mockImplementation(() => ({
      source: 'recipients', recipients: 200, sent: 200, bounced: 2, delivered: 196, clicked: 8, click_rate: 0.04,
    }))
    render(await SendsHistoryPage())
    const cells = [...screen.getByText('Autumn offer').closest('tr').querySelectorAll('td')].map((td) => td.textContent)
    expect(cells[3]).toBe('196')
    expect(cells[4]).toBe('8 · 4.0%')
  })

  it('shows a dash, not a zero, when the figures fell back to the stored counters', async () => {
    useRows()
    campaignDisplayStats.mockImplementation(() => ({
      source: 'counters', recipients: 200, sent: 200, bounced: 2, delivered: 0, clicked: 0, click_rate: 0,
    }))
    render(await SendsHistoryPage())
    const cells = [...screen.getByText('Autumn offer').closest('tr').querySelectorAll('td')].map((td) => td.textContent)
    expect(cells[3]).toBe('—')
    expect(cells[4]).toBe('—')
  })

  it('shows a dash for delivered when the delivered count is incomplete', async () => {
    useRows()
    campaignDisplayStats.mockImplementation(() => ({
      source: 'recipients', recipients: 200, sent: 200, bounced: 0, delivered: null, clicked: 5, click_rate: 0.025,
    }))
    render(await SendsHistoryPage())
    const cells = [...screen.getByText('Autumn offer').closest('tr').querySelectorAll('td')].map((td) => td.textContent)
    expect(cells[3]).toBe('—')
    expect(cells[4]).toBe('5 · 2.5%')
  })
})

describe('search, status filter and Show more (SENTSEARCH.1)', () => {
  function recordingChain(rows, log) {
    const o = {
      select: () => o, eq: () => o, order: () => o,
      ilike: (...a) => { log.push(['ilike', ...a]); return o },
      in: (...a) => { log.push(['in', ...a]); return o },
      limit: (n) => { log.push(['limit', n]); return o },
      then: (resolve) => resolve({ data: rows, count: rows.length }),
    }
    return o
  }
  const row = (i) => ({ id: `c${i}`, name: `Send ${i}`, status: 'draft', created_at: new Date(Date.UTC(2031, 0, 1, 0, i)).toISOString() })

  it('searches by name with the pattern escaped, and filters by status', async () => {
    const log = []
    createServerClient.mockReturnValue({ from: (t) => recordingChain(t === 'campaigns' ? [row(1)] : [], log) })
    render(await SendsHistoryPage({ searchParams: Promise.resolve({ q: '50%_off', status: 'drafts' }) }))
    expect(log).toContainEqual(['ilike', 'name', '%50\\%\\_off%'])
    expect(log).toContainEqual(['in', 'status', ['draft']])
    expect(screen.getByText('Send 1')).toBeTruthy()
  })

  it('shows 50 by default and offers Show more when there are more', async () => {
    const log = []
    const many = Array.from({ length: 51 }, (_, i) => row(i))
    createServerClient.mockReturnValue({ from: (t) => recordingChain(t === 'campaigns' ? many : [], log) })
    const { container } = render(await SendsHistoryPage({ searchParams: Promise.resolve({}) }))
    expect(log).toContainEqual(['limit', 51])
    expect(container.querySelectorAll('tbody tr')).toHaveLength(50)
    expect(screen.getByRole('link', { name: 'Show more' }).getAttribute('href')).toBe('/communications/sent?limit=100')
  })

  it('says nothing matches when a search finds nothing', async () => {
    createServerClient.mockReturnValue({ from: () => recordingChain([], []) })
    render(await SendsHistoryPage({ searchParams: Promise.resolve({ q: 'zzz' }) }))
    expect(screen.getByText(/Nothing matches/)).toBeTruthy()
  })
})
