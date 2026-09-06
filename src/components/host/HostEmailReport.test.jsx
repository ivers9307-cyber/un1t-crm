// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import HostEmailReport, { statTiles, filterRecipients, FILTERS, outcomeChipClass, formatWhen } from './HostEmailReport.jsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const stats = { queued: 0, sent: 124, delivered: 118, opened: 41, clicked: 9, bounced: 2, complained: 0, unsubscribed: 1, failed: 4 }
describe('statTiles', () => {
  it('seven tiles in order with open/click rates of delivered', () => {
    const t = statTiles(stats)
    expect(t.map((x) => x.label)).toEqual(['Sent', 'Delivered', 'Opened', 'Clicked', 'Bounced', 'Unsubscribed', 'Failed'])
    expect(t.map((x) => x.value)).toEqual([124, 118, 41, 9, 2, 1, 4])
    expect(t[2].sub).toBe('35% of delivered'); expect(t[3].sub).toBe('8% of delivered')
  })
  it('0% when nothing delivered, and missing stats read as zeros', () => {
    expect(statTiles({ ...stats, delivered: 0, opened: 0 })[2].sub).toBe('0% of delivered')
    expect(statTiles(undefined).map((x) => x.value)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })
  it('clamps a rate at 100% when opened outcounts delivered (a click/open racing a later delivered_at recount)', () => {
    expect(statTiles({ ...stats, delivered: 10, opened: 14 })[2].sub).toBe('100% of delivered')
  })
})
describe('filterRecipients', () => {
  // Every row carries the raw columns the recipients API sends. `outcome`
  // stays here too (it drives the per-row chip) but the filters below are
  // predicates on the timestamp columns, matching host_campaign_stats()
  // (mig 591) — a cumulative funnel, not the exclusive `outcome`. Row 'h' is
  // opened AND later unsubscribed: it must appear under BOTH chips.
  const rows = [
    { contact_id: 'a', outcome: 'opened', sent_at: 's', delivered_at: 'd', opened_at: 'o', clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
    { contact_id: 'b', outcome: 'delivered', sent_at: 's', delivered_at: 'd', opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
    { contact_id: 'c', outcome: 'failed', sent_at: null, delivered_at: null, opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null, failed_reason: 'no_email' },
    { contact_id: 'd', outcome: 'clicked', sent_at: 's', delivered_at: 'd', opened_at: 'o', clicked_at: 'c', bounced_at: null, complained_at: null, unsubscribed_at: null },
    { contact_id: 'e', outcome: 'bounced', sent_at: 's', delivered_at: null, opened_at: null, clicked_at: null, bounced_at: 'b', complained_at: null, unsubscribed_at: null },
    { contact_id: 'f', outcome: 'unsubscribed', sent_at: 's', delivered_at: 'd', opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: 'u' },
    { contact_id: 'g', outcome: 'sent', sent_at: 's', delivered_at: null, opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
    { contact_id: 'h', outcome: 'unsubscribed', sent_at: 's', delivered_at: 'd', opened_at: 'o', clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: 'u' },
  ]
  const ids = (f) => filterRecipients(rows, f).map((r) => r.contact_id)
  it('all', () => expect(ids('all')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']))
  it('opened includes clicked', () => expect(ids('opened')).toEqual(['a', 'd', 'h']))
  it('clicked', () => expect(ids('clicked')).toEqual(['d']))
  it('not_opened = delivered but never opened', () => expect(ids('not_opened')).toEqual(['b', 'f']))
  it('bounced / unsubscribed / failed', () => { expect(ids('bounced')).toEqual(['e']); expect(ids('unsubscribed')).toEqual(['f', 'h']); expect(ids('failed')).toEqual(['c']) })
  it('a row that is both opened and unsubscribed appears under BOTH chips', () => {
    expect(ids('opened')).toContain('h')
    expect(ids('unsubscribed')).toContain('h')
  })
  it('FILTERS lists the seven chips in order', () => expect(FILTERS.map((f) => f.key)).toEqual(['all', 'opened', 'clicked', 'not_opened', 'bounced', 'unsubscribed', 'failed']))
})
describe('chip + date', () => {
  it('maps every outcome to a class and never returns undefined', () => {
    for (const o of ['failed', 'bounced', 'complained', 'unsubscribed', 'clicked', 'opened', 'delivered', 'sent', 'queued', 'wat']) expect(typeof outcomeChipClass(o)).toBe('string')
  })
  // en-IE abbreviates September as "Sept" (4 letters) while every other
  // month is 3 — \w{3,4} covers both instead of overfitting to Sept.
  it('formatWhen is short and null-safe', () => { expect(formatWhen(null)).toBe(''); expect(formatWhen('2026-09-04T10:58:14Z')).toMatch(/^\d{1,2} \w{3,4}, \d{2}:\d{2}$/) })
})

describe('HostEmailReport (render)', () => {
  function mockFetchOnce(response) {
    vi.stubGlobal('fetch', vi.fn(async () => response))
  }

  it('ready: renders the seven tile values and the Failed chip filters the rows', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          campaign: {
            id: 'c1',
            subject: 'Race day info',
            status: 'sent',
            audience_kind: 'all',
            sent_at: '2026-09-01T09:00:00Z',
            stats: { sent: 10, delivered: 9, opened: 6, clicked: 3, bounced: 1, complained: 0, unsubscribed: 0, failed: 2 },
          },
          recipients: [
            { contact_id: '1', name: 'Ann', email: 'ann@example.com', outcome: 'opened', outcome_at: null, delivered_at: 'd', opened_at: 'o', clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
            { contact_id: '2', name: 'Bob', email: 'bob@example.com', outcome: 'failed', failure_copy: 'Mailbox blocked', outcome_at: null, delivered_at: null, opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
          ],
        },
      }),
    })

    const { container } = render(<HostEmailReport campaignId="c1" />)
    await screen.findByText('Sent')
    for (const value of ['10', '9', '6', '3', '1', '0', '2']) {
      expect(container.textContent).toContain(value)
    }

    // Both the desktop <table> and the mobile <ul> render at once in jsdom
    // (the sm:table / sm:hidden split is CSS, invisible here) — each name
    // legitimately appears twice.
    expect(screen.getAllByText('Ann').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Bob').length).toBeGreaterThan(0)

    const failedChip = await screen.findByText('Failed (1)')
    fireEvent.click(failedChip)

    expect(screen.queryAllByText('Ann').length).toBe(0)
    expect(screen.getAllByText('Bob').length).toBeGreaterThan(0)
  })

  it('404: renders "This email was not found."', async () => {
    mockFetchOnce({ ok: false, status: 404, json: async () => ({}) })
    render(<HostEmailReport campaignId="missing" />)
    expect(await screen.findByText('This email was not found.')).toBeTruthy()
  })

  it('stats: null renders the unavailable line and no stale-delivery note', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          campaign: { id: 'c1', subject: 'Race day info', status: 'sent', audience_kind: 'all', sent_at: '2026-09-01T09:00:00Z', stats: null },
          recipients: [],
        },
      }),
    })
    render(<HostEmailReport campaignId="c1" />)
    expect(await screen.findByText('Counts are unavailable right now. The recipient list below is still complete.')).toBeTruthy()
    expect(screen.queryByText('Nothing delivered yet. If this persists, contact UN1T.')).toBeNull()
  })

  it('sent >1h ago with zero delivered shows the stale-delivery note', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          campaign: {
            id: 'c1',
            subject: 'Race day info',
            status: 'sent',
            audience_kind: 'all',
            sent_at: twoHoursAgo,
            stats: { sent: 5, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, failed: 0 },
          },
          recipients: [],
        },
      }),
    })
    render(<HostEmailReport campaignId="c1" />)
    expect(await screen.findByText('Nothing delivered yet. If this persists, contact UN1T.')).toBeTruthy()
  })
})
