// @vitest-environment jsdom
//
// COMMSFIX.D.1 — CampaignDetail is the page the composer's result screen
// steers operators to ("You can cancel it from the details page any time
// before then"), yet it hardcoded a green "Sent" chip for every status and
// carried no cancel control at all. Audit 2026-08-09, composer-ux dimension,
// CONFIRMED high: "No way to cancel a scheduled/queued/sending campaign from
// the page operators are steered to".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

const refresh = vi.fn()
const replace = vi.fn()
const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace, push }),
}))

// Track the browser-client writes CampaignDetail makes (same mechanism
// CampaignEditor's handleCancel uses: a direct campaigns update).
let updates = []
let updateError = null
const eqSpy = vi.fn()
vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    from: (table) => ({
      update: (payload) => {
        updates.push({ table, payload })
        return {
          eq: (col, val) => {
            eqSpy(col, val)
            return Promise.resolve({ error: updateError })
          },
        }
      },
    }),
  }),
}))

import CampaignDetail from './CampaignDetail.jsx'

const BASE = {
  id: 'camp-1',
  name: 'Weekend offer',
  subject: 'Last chance',
  status: 'sent',
  location_id: 'loc-1',
  total_recipients: 3053,
  total_sent: 3053,
  sent_at: '2026-08-08T09:00:00.000Z',
}

beforeEach(() => {
  updates = []
  updateError = null
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderDetail(overrides = {}) {
  return render(<CampaignDetail campaign={{ ...BASE, ...overrides }} recipients={[]} />)
}

describe('CampaignDetail — status chip is driven by the campaign status', () => {
  it('shows Sent for a sent campaign', () => {
    renderDetail({ status: 'sent' })
    const chip = screen.getByTestId('campaign-status-chip')
    expect(chip.textContent).toMatch(/sent/i)
  })

  it.each([
    ['scheduled', /scheduled/i],
    ['queued', /queued/i],
    ['sending', /sending/i],
    ['cancelled', /cancelled/i],
    ['failed', /failed/i],
  ])('does not claim "Sent" for a %s campaign', (status, label) => {
    renderDetail({ status })
    const chip = screen.getByTestId('campaign-status-chip')
    expect(chip.textContent).toMatch(label)
    expect(chip.textContent).not.toMatch(/^\s*Sent\s*$/)
  })

  it('uses the light-theme chip recipe (bg-<c>-500/10 text-<c>-700)', () => {
    for (const status of ['scheduled', 'queued', 'sending', 'sent', 'cancelled', 'failed']) {
      cleanup()
      renderDetail({ status })
      const cls = screen.getByTestId('campaign-status-chip').className
      expect(cls, status).toMatch(/bg-[a-z]+-500\/10/)
      expect(cls, status).toMatch(/text-[a-z]+-700/)
    }
  })

  it('surfaces last_error on a failed campaign when the column is present', () => {
    renderDetail({ status: 'failed', last_error: 'audience filter rejected: unknown field' })
    expect(screen.getByTestId('campaign-status-chip').getAttribute('title')).toContain('unknown field')
  })

  it('renders a failed chip fine when last_error is absent (pre-migration)', () => {
    renderDetail({ status: 'failed' })
    expect(screen.getByTestId('campaign-status-chip').textContent).toMatch(/failed/i)
  })
})
