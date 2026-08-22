// mobile/lib/sonos-api.test.js
// `./api` is mocked BEFORE import: it pulls the React-Native runtime, which
// must never load under vitest's Node environment.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn() }))

import { api } from './api'
import {
  listSonosSchedules,
  getSonosHousehold,
  getSonosNowPlaying,
  sendSonosAction,
} from './sonos-api'

beforeEach(() => {
  vi.clearAllMocks()
  api.mockResolvedValue({ success: true })
})

describe('listSonosSchedules', () => {
  it('GETs the schedules list for the location', async () => {
    await listSonosSchedules('loc-1')
    expect(api).toHaveBeenCalledWith('/api/sonos/schedules', { locationId: 'loc-1' })
  })
})

describe('getSonosHousehold', () => {
  it('GETs the household (favourites live there)', async () => {
    await getSonosHousehold('loc-1')
    expect(api).toHaveBeenCalledWith('/api/sonos/household', { locationId: 'loc-1' })
  })
})

describe('getSonosNowPlaying', () => {
  it('GETs now-playing with the schedule id as a query param', async () => {
    await getSonosNowPlaying('11111111-1111-1111-1111-111111111111', 'loc-1')
    expect(api).toHaveBeenCalledWith(
      '/api/sonos/now-playing?schedule_id=11111111-1111-1111-1111-111111111111',
      { locationId: 'loc-1' },
    )
  })

  it('URL-encodes the schedule id rather than trusting it', async () => {
    await getSonosNowPlaying('a b&c', 'loc-1')
    expect(api.mock.calls[0][0]).toBe('/api/sonos/now-playing?schedule_id=a%20b%26c')
  })
})

describe('sendSonosAction', () => {
  it('POSTs the action with a value', async () => {
    await sendSonosAction('s1', 'set_volume', 40, 'loc-1')
    expect(api).toHaveBeenCalledWith('/api/sonos/control', {
      method: 'POST',
      locationId: 'loc-1',
      body: { schedule_id: 's1', action: 'set_volume', value: 40 },
    })
  })

  it('sends a value of 0 — volume-to-zero is a real request, not an absent one', async () => {
    // A future tidy to `if (value)` would drop 0 and turn it into a 400.
    await sendSonosAction('s1', 'set_volume', 0, 'loc-1')
    expect(api.mock.calls[0][1].body.value).toBe(0)
  })

  it('omits `value` entirely when there is none — not null, not undefined', async () => {
    // The route's Zod schema has value optional; a null would fail
    // z.union([number, string]) and turn every play/pause into a 400.
    await sendSonosAction('s1', 'pause', undefined, 'loc-1')
    const body = api.mock.calls[0][1].body
    expect(body).toEqual({ schedule_id: 's1', action: 'pause' })
    expect('value' in body).toBe(false)
  })

  it('returns the server envelope as-is so the card can read code/applied/failedGroups', async () => {
    api.mockResolvedValue({ success: false, error: 'nope', code: 'failed', applied: ['G1'], failedGroups: ['G2'] })
    const r = await sendSonosAction('s1', 'volume_up', 5, 'loc-1')
    expect(r).toEqual({ success: false, error: 'nope', code: 'failed', applied: ['G1'], failedGroups: ['G2'] })
  })
})
