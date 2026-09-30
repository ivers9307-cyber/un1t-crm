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
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Save settings/ })).toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('a network error is the same unknown state', async () => {
    mockFetch([new TypeError('Failed to fetch')])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Save settings/ })).toBeNull()
  })

  it('Try again re-reads, and a good read shows the editor with Save', async () => {
    mockFetch([reply(500, { success: false }), GOOD])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  it('a failed KNOWLEDGE read does not hide a good settings read', async () => {
    mockFetch([GOOD], { knowledgeFails: true })
    render(<CustomerAgentClient canEdit />)
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
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText(/^30 Sep: 5 daytime runs/)).toBeTruthy())
    expect(screen.getByText('30 Sep: 5 daytime runs · 8 candidate checks · 1 sent · 7 skipped (human active ×5, too soon ×2)')).toBeTruthy()
    expect(screen.getByText('29 Sep: 44 daytime runs · 30 candidate checks · 0 sent · 30 skipped (human active ×30) · 1 failed run (partial: an earlier run could not be read)')).toBeTruthy()
  })
})

describe('CustomerAgentClient — check-in day line plurals (CHECKINSTALL.1)', () => {
  const dayLine = (over) => ({ ticks: 1, failed_ticks: 0, freeform: 0, templates: 0, previous: null, ...over })
  function renderDay(day) {
    mockFetch([reply(200, {
      success: true,
      settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false, first_class_checkin: { enabled: true, daily_cap: 20 } },
      location: { id: 'loc1', name: 'Test Studio' },
      checkin_stats: { sent_today: 0, total: 0, last: null, last_run: { at: '2026-10-01T09:00:00Z', checkins: null, day } },
    })])
    render(<CustomerAgentClient canEdit />)
  }

  it('one run and one candidate read in the singular', async () => {
    renderDay(dayLine({ day: '2026-10-01', daytime_ticks: 1, candidates: 1, skipped: 1, reasons: { too_soon: 1 } }))
    await waitFor(() => expect(screen.getByText(/^1 Oct:/)).toBeTruthy())
    expect(screen.getByText('1 Oct: 1 daytime run · 1 candidate check · 0 sent · 1 skipped (too soon ×1)')).toBeTruthy()
  })

  it('two runs and two candidates read in the plural', async () => {
    renderDay(dayLine({ day: '2026-10-01', daytime_ticks: 2, candidates: 2, skipped: 2, reasons: { too_soon: 2 } }))
    await waitFor(() => expect(screen.getByText(/^1 Oct:/)).toBeTruthy())
    expect(screen.getByText('1 Oct: 2 daytime runs · 2 candidate checks · 0 sent · 2 skipped (too soon ×2)')).toBeTruthy()
  })
})

// MIAROLE.1 (C80) — only an owner at the studio (or a master) may change Mia's
// settings. Everyone else who can open the page still reads them, with every
// settings control disabled and no Save. The knowledge editor is not part of
// this rule and stays as it was. `:disabled` (not `.disabled`, which reads only
// the element's own attribute) is what sees the disabled <fieldset> around it.
describe('CustomerAgentClient — read-only for a non-owner (MIAROLE.1)', () => {
  it('a non-owner sees the settings with no Save, every control disabled, and says why', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit={false} />)
    await waitFor(() => expect(screen.getByText(/Live — reply to all customers/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Save settings/ })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /Live — reply to all customers/ }).matches(':disabled')).toBe(true)
    expect(screen.getByText('Only an owner can change these settings.')).toBeTruthy()
  })

  it('omitting canEdit fails closed (read-only)', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient />)
    await waitFor(() => expect(screen.getByText(/Live — reply to all customers/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Save settings/ })).toBeNull()
  })

  it('an owner gets the working editor', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
    expect(screen.getByRole('checkbox', { name: /Live — reply to all customers/ }).matches(':disabled')).toBe(false)
    expect(screen.queryByText('Only an owner can change these settings.')).toBeNull()
  })
})

// CHECKINRISKS.1 (C106 c) — the counts are SENDS; a failed read (null) says
// so and is never shown as 0.
describe('CustomerAgentClient — check-in counts (CHECKINRISKS.1)', () => {
  const withStats = (checkin_stats) => reply(200, {
    success: true,
    settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false, first_class_checkin: { enabled: true, daily_cap: 20 } },
    location: { id: 'loc1', name: 'Test Studio' },
    checkin_stats,
  })

  it('shows the sends', async () => {
    mockFetch([withStats({ sent_today: 2, total: 7, last: null, last_run: null })])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText('Sent today 2/20')).toBeTruthy())
    expect(screen.getByText(/Sent all time 7/)).toBeTruthy()
  })

  it('an unreadable count reads "could not be read", never 0', async () => {
    mockFetch([withStats({ sent_today: null, total: null, last: null, last_unreadable: true, last_run: null })])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText('Sent today: could not be read')).toBeTruthy())
    expect(screen.getByText(/Sent all time could not be read/)).toBeTruthy()
    expect(screen.queryByText(/none yet/)).toBeNull()
  })
})
