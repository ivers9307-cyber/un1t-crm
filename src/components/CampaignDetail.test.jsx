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

describe('CampaignDetail — cancel / unschedule', () => {
  it('offers no cancel control on a sent campaign', () => {
    renderDetail({ status: 'sent' })
    expect(screen.queryByTestId('campaign-cancel')).toBeNull()
  })

  it('offers no cancel control on a cancelled campaign', () => {
    renderDetail({ status: 'cancelled' })
    expect(screen.queryByTestId('campaign-cancel')).toBeNull()
  })

  it('unschedules a scheduled campaign back to draft', () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderDetail({ status: 'scheduled', scheduled_at: '2026-08-20T09:00:00.000Z' })
    fireEvent.click(screen.getByTestId('campaign-cancel'))
    expect(updates).toEqual([
      { table: 'campaigns', payload: { status: 'draft', scheduled_at: null } },
    ])
    expect(eqSpy).toHaveBeenCalledWith('id', 'camp-1')
  })

  it.each(['queued', 'sending'])('stamps cancel_requested_at on a %s campaign', (status) => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderDetail({ status })
    fireEvent.click(screen.getByTestId('campaign-cancel'))
    expect(updates).toHaveLength(1)
    expect(updates[0].table).toBe('campaigns')
    expect(typeof updates[0].payload.cancel_requested_at).toBe('string')
  })

  it('names the recipient count in the confirm dialog and writes nothing when declined', () => {
    const confirmSpy = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmSpy)
    renderDetail({ status: 'queued', total_recipients: 3053 })
    fireEvent.click(screen.getByTestId('campaign-cancel'))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0][0]).toContain('3,053')
    expect(updates).toHaveLength(0)
  })
})

describe('CampaignDetail — a failed campaign can be re-sent', () => {
  it('offers a re-send control that posts to the send route', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderDetail({ status: 'failed', last_error: 'populate failed' })
    const btn = screen.getByTestId('campaign-resend-failed')
    fireEvent.click(btn)
    await Promise.resolve()
    expect(global.fetch).toHaveBeenCalledWith('/api/campaigns/camp-1/send', { method: 'POST' })
  })

  it('offers no re-send control on a sent campaign', () => {
    renderDetail({ status: 'sent' })
    expect(screen.queryByTestId('campaign-resend-failed')).toBeNull()
  })
})

describe('CampaignDetail — recipient rows label their real status', () => {
  const recipients = [
    { id: 'r1', contact_id: 'c1', status: 'queued', contacts: { name: 'Ann', email: 'ann@x.ie' } },
    { id: 'r2', contact_id: 'c2', status: 'sending', contacts: { name: 'Ben', email: 'ben@x.ie' } },
    { id: 'r3', contact_id: 'c3', status: 'cancelled', contacts: { name: 'Cara', email: 'cara@x.ie' } },
    { id: 'r4', contact_id: 'c4', status: 'skipped_frequency_cap', contacts: { name: 'Dan', email: 'dan@x.ie' } },
    { id: 'r5', contact_id: 'c5', status: 'sent', contacts: { name: 'Eve', email: 'eve@x.ie' } },
  ]

  function renderRecipients() {
    render(<CampaignDetail campaign={{ ...BASE, status: 'sending' }} recipients={recipients} />)
    fireEvent.click(screen.getByRole('button', { name: /^Recipients \(/ }))
  }

  it.each([
    ['r1', /queued/i],
    ['r2', /sending/i],
    ['r3', /cancelled/i],
    ['r4', /frequency cap|capped/i],
    ['r5', /^sent$/i],
  ])('labels %s correctly', (id, label) => {
    renderRecipients()
    expect(screen.getByTestId(`recipient-status-${id}`).textContent).toMatch(label)
  })

  it('no longer renders every unknown status as "Sent"', () => {
    renderRecipients()
    const labels = ['r1', 'r2', 'r3', 'r4'].map(id => screen.getByTestId(`recipient-status-${id}`).textContent.trim())
    expect(labels).not.toContain('Sent')
  })
})

// ABHONEST.1 — the A/B panel used to print "Winner: Subject A" whenever
// ab_winner was stamped, and the sender stamped 'a' for a tie, for a slice
// nobody opened, and for an empty stats set. Zero A/B tests have ever run, so
// nothing live was wrong yet; the first operator to try one would have been
// handed a fabricated result. campaigns.ab_winner records what was SENT (mig
// 398's CHECK allows only 'a'|'b'|NULL), so the panel re-reads the stats.
describe('CampaignDetail — A/B panel refuses to invent a winner', () => {
  const AB = {
    ab_subject_b: 'Or maybe this one',
    ab_winner: 'a',
    ab_test_started_at: '2026-08-08T09:00:00.000Z',
    ab_decided_at: '2026-08-08T13:00:00.000Z',
  }
  const stats = (a, b) => ([
    { ab_variant: 'a', sent_count: a.sent, opened_count: a.opened },
    { ab_variant: 'b', sent_count: b.sent, opened_count: b.opened },
  ])
  const renderAb = (abStats, overrides = {}) => render(
    <CampaignDetail campaign={{ ...BASE, ...AB, ...overrides }} recipients={[]} abStats={abStats} />
  )

  it('says nobody opened either subject instead of crowning A', () => {
    renderAb(stats({ sent: 20, opened: 0 }, { sent: 20, opened: 0 }))
    expect(screen.getByText(/no clear winner/i)).toBeTruthy()
    expect(screen.queryByText(/^Winner: Subject/i)).toBeNull()
    expect(screen.queryByText('Winner')).toBeNull()
    expect(screen.getByText(/nobody opened either subject/i)).toBeTruthy()
  })

  it('says nothing was learned on a tie', () => {
    renderAb(stats({ sent: 20, opened: 4 }, { sent: 20, opened: 4 }))
    expect(screen.getByText(/no clear winner/i)).toBeTruthy()
    expect(screen.queryByText('Winner')).toBeNull()
  })

  it('says nothing was learned when the stats never arrived', () => {
    renderAb(null)
    expect(screen.getByText(/no clear winner/i)).toBeTruthy()
  })

  it('still tells the operator which subject the remainder went out with', () => {
    renderAb(stats({ sent: 20, opened: 0 }, { sent: 20, opened: 0 }))
    expect(screen.getByText(/sent with subject a/i)).toBeTruthy()
  })

  it('does call a genuine, large difference a winner', () => {
    renderAb(stats({ sent: 50, opened: 5 }, { sent: 50, opened: 20 }), { ab_winner: 'b' })
    expect(screen.getByText(/winner: subject b/i)).toBeTruthy()
    expect(screen.getByText('Winner')).toBeTruthy()
    expect(screen.queryByText(/no clear winner/i)).toBeNull()
  })

  it('shows both readings when opens moved past the decision', () => {
    // Stamped A at decide time; B has since pulled clearly ahead.
    renderAb(stats({ sent: 50, opened: 5 }, { sent: 50, opened: 20 }), { ab_winner: 'a' })
    const chip = screen.getByText(/numbers now favour subject b/i)
    expect(chip).toBeTruthy()
    expect(chip.textContent).toMatch(/sent with subject a/i)
  })
})
