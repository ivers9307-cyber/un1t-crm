// @vitest-environment jsdom
//
// SETTINGSWIPE.1 — the customer agent editor rendered whatever the GET said.
// The GET used to answer a failed read with the DEFAULTS (enabled:false), so
// Save switched Mia off. The GET now 500s; the editor must say "Could not
// load" with Try again and render NO Save (before this PR a 500 left it on
// "Loading…" forever).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { DEFAULTS } from '@/lib/agent/settings-contract'
import CustomerAgentClient from './CustomerAgentClient.jsx'

const NOTE = 'Could not load the customer agent settings just now, so nothing is shown and nothing can be changed here until it loads.'
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const GOOD = reply(200, {
  success: true,
  settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false },
  location: { id: 'loc1', name: 'Test Studio' },
  checkin_stats: { sent_today: 0, total: 0, last: null, last_run: null },
})

function mockFetch(settingsAnswers, { knowledgeFails = false } = {}) {
  let i = 0
  global.fetch = vi.fn(async (url) => {
    if (String(url).startsWith('/api/settings/customer-agent')) {
      const a = settingsAnswers[Math.min(i++, settingsAnswers.length - 1)]
      if (a instanceof Error) throw a
      return a
    }
    if (String(url).startsWith('/api/agent/knowledge')) {
      if (knowledgeFails) throw new TypeError('Failed to fetch')
      return reply(200, { success: true, entries: [] })
    }
    return reply(200, { success: true, templates: [] })
  })
}

afterEach(() => { cleanup(); delete global.fetch })

describe('CustomerAgentClient — a failed read (SETTINGSWIPE.1)', () => {
  it('a 500 shows Could not load + Try again, and NO Save', async () => {
    mockFetch([reply(500, { success: false, code: 'settings_unreadable', error: 'x' })])
    render(<CustomerAgentClient />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Save settings/ })).toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('a network error is the same unknown state', async () => {
    mockFetch([new TypeError('Failed to fetch')])
    render(<CustomerAgentClient />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Save settings/ })).toBeNull()
  })

  it('Try again re-reads, and a good read shows the editor with Save', async () => {
    mockFetch([reply(500, { success: false }), GOOD])
    render(<CustomerAgentClient />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  it('a failed KNOWLEDGE read does not hide a good settings read', async () => {
    mockFetch([GOOD], { knowledgeFails: true })
    render(<CustomerAgentClient />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
    expect(screen.queryByText(NOTE)).toBeNull()
  })
})

describe('CustomerAgentClient — check-in day rollup (CHECKINSTALL.1)', () => {
  it('shows the day tally and the day before, by reason', async () => {
    const day = {
      day: '2026-09-30', ticks: 8, daytime_ticks: 5, failed_ticks: 0, candidates: 8, freeform: 0, templates: 1, skipped: 7,
      reasons: { human_active: 5, too_soon: 2 },
      previous: { day: '2026-09-29', ticks: 96, daytime_ticks: 44, failed_ticks: 1, candidates: 30, freeform: 0, templates: 0, skipped: 30, reasons: { human_active: 30 }, carry_failed: true },
    }
    mockFetch([reply(200, {
      success: true,
      settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false, first_class_checkin: { enabled: true, daily_cap: 20 } },
      location: { id: 'loc1', name: 'Test Studio' },
      checkin_stats: { sent_today: 1, total: 12, last: null, last_run: { at: '2026-09-30T09:00:00Z', checkins: null, day } },
    })])
    render(<CustomerAgentClient />)
    await waitFor(() => expect(screen.getByText(/^30 Sep: 5 daytime runs/)).toBeTruthy())
    expect(screen.getByText('30 Sep: 5 daytime runs · 8 candidate checks · 1 sent · 7 skipped (human active ×5, too soon ×2)')).toBeTruthy()
    expect(screen.getByText('29 Sep: 44 daytime runs · 30 candidate checks · 0 sent · 30 skipped (human active ×30) · 1 failed run (partial: an earlier run could not be read)')).toBeTruthy()
  })
})
