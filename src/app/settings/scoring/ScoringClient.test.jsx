// @vitest-environment jsdom
//
// SETTINGSWIPE.1 — a failed scoring GET left this screen on "Loading…"
// forever (error set but never rendered); before the route fix it showed the
// DEFAULTS and Save wrote them back. Now: Could not load + Try again, no Save.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ScoringClient from './ScoringClient.jsx'

const NOTE = 'Could not load the scoring settings just now, so nothing is shown and nothing can be changed here until it loads.'
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const GOOD = reply(200, {
  success: true,
  scoring: { zone_points: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }, participation_points: 50, tier_window_months: null },
  defaults: { zone_points: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }, participation_points: 50 },
  location: { id: 'loc1', name: 'Test Studio' },
})
function mockFetch(...answers) {
  let i = 0
  global.fetch = vi.fn(async () => {
    const a = answers[Math.min(i++, answers.length - 1)]
    if (a instanceof Error) throw a
    return a
  })
}
afterEach(() => { cleanup(); delete global.fetch })

describe('ScoringClient — a failed read (SETTINGSWIPE.1)', () => {
  it('a 500 shows Could not load + Try again, no Save', async () => {
    mockFetch(reply(500, { success: false, code: 'settings_unreadable' }))
    render(<ScoringClient />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('Try again with a good read shows the editor', async () => {
    mockFetch(new TypeError('Failed to fetch'), GOOD)
    render(<ScoringClient />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy())
  })
})
