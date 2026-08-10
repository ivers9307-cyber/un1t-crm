// @vitest-environment jsdom
//
// COMMSLAYOUT.1 — the Sends page has listed email campaigns alongside SMS and
// WhatsApp since PILLAR2 Phase 2, but the subtitle still said "One-off SMS &
// WhatsApp sends at this location", so the one channel most likely to be
// looked for was the one the page claimed not to have.

import { describe, it, expect, vi, beforeEach } from 'vitest'
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

beforeEach(() => {
  cleanup()
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: { id: 'loc-1' } })
  createServerClient.mockReturnValue({ from: () => emptyChain() })
})

describe('/communications/sent subtitle (COMMSLAYOUT.1)', () => {
  it('names all three channels the page actually lists', async () => {
    render(await SendsHistoryPage())
    const sub = screen.getByText(/sends at this location/i).textContent
    expect(sub).toMatch(/SMS/)
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
