// @vitest-environment jsdom
//
// CHANNELREAD.1 — GET /api/sonos/household answers `connected: false,
// reason: 'db_error'` when OUR read of sonos_connections fails. The page
// worded that honestly but still showed Connect Sonos under it (a fresh
// OAuth round trip over a live connection). It is now a load error: Try
// again, no Connect.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}))

import SonosScheduleClient from './SonosScheduleClient.jsx'

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
function mockHousehold(body) {
  global.fetch = vi.fn(async (url) => (String(url) === '/api/sonos/household' ? reply(200, body) : reply(200, { success: true, schedules: [] })))
}

afterEach(() => { cleanup(); delete global.fetch })

describe('SonosScheduleClient — a failed connection read (CHANNELREAD.1)', () => {
  it('db_error shows Try again and no Connect Sonos', async () => {
    mockHousehold({ success: true, connected: false, reason: 'db_error' })
    render(<SonosScheduleClient locationName="Test Studio" />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Connect Sonos/ })).toBeNull()
  })

  it('pin: genuinely not connected still offers Connect Sonos', async () => {
    mockHousehold({ success: true, connected: false, reason: 'not_connected' })
    render(<SonosScheduleClient locationName="Test Studio" />)
    expect(await screen.findByRole('link', { name: /Connect Sonos/ })).toBeTruthy()
  })
})
