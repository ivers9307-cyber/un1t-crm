// @vitest-environment jsdom
//
// CHANNELREAD.1 — GET /api/sonos/household answers `connected: false,
// reason: 'db_error'` when OUR read of sonos_connections fails. The page
// worded that honestly but still showed Connect Sonos under it (a fresh
// OAuth round trip over a live connection). It is now a load error: Try
// again, no Connect.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}))

import SonosScheduleClient from './SonosScheduleClient.jsx'

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
// One body, or a list answered in order (the last repeats).
function mockHousehold(body) {
  const bodies = Array.isArray(body) ? body : [body]
  let i = 0
  global.fetch = vi.fn(async (url) => {
    if (String(url) !== '/api/sonos/household') return reply(200, { success: true, schedules: [] })
    const b = bodies[Math.min(i++, bodies.length - 1)]
    return b instanceof Error ? Promise.reject(b) : reply(b.__status || 200, b)
  })
}
const DB_ERROR = { success: true, connected: false, reason: 'db_error' }

afterEach(() => { cleanup(); delete global.fetch })

describe('SonosScheduleClient — a failed connection read (CHANNELREAD.1)', () => {
  it('db_error shows Try again and no Connect Sonos', async () => {
    mockHousehold({ success: true, connected: false, reason: 'db_error' })
    render(<SonosScheduleClient locationName="Test Studio" />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Connect Sonos/ })).toBeNull()
  })

  it('db_error uses the shared note: "Could not load" wording', async () => {
    mockHousehold(DB_ERROR)
    render(<SonosScheduleClient locationName="Test Studio" />)
    expect(await screen.findByText('Could not load the Sonos connection just now, so nothing is shown and nothing can be changed here until it loads.')).toBeTruthy()
  })

  it('a failed household request (500) is the same note', async () => {
    mockHousehold({ __status: 500, success: false, error: 'canceling statement due to statement timeout' })
    render(<SonosScheduleClient locationName="Test Studio" />)
    expect(await screen.findByText(/Could not load the Sonos connection just now/)).toBeTruthy()
    expect(screen.queryByText(/statement timeout/)).toBeNull()
    expect(screen.queryByRole('link', { name: /Connect Sonos/ })).toBeNull()
  })

  it('Try again that fails again says "Still could not load"', async () => {
    mockHousehold([DB_ERROR, DB_ERROR])
    render(<SonosScheduleClient locationName="Test Studio" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Still could not load. Try again in a minute.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Connect Sonos/ })).toBeNull()
  })

  it('Try again that succeeds drops the note', async () => {
    mockHousehold([DB_ERROR, { success: true, connected: false, reason: 'not_connected' }])
    render(<SonosScheduleClient locationName="Test Studio" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: /Connect Sonos/ })).toBeTruthy()
    expect(screen.queryByText(/Could not load/)).toBeNull()
  })

  it('pin: genuinely not connected still offers Connect Sonos', async () => {
    mockHousehold({ success: true, connected: false, reason: 'not_connected' })
    render(<SonosScheduleClient locationName="Test Studio" />)
    expect(await screen.findByRole('link', { name: /Connect Sonos/ })).toBeTruthy()
  })
})
