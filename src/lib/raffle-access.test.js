// RAFFLE.1 — the staff gate: races somewhere (403), the event's studio
// visible (404), races at the event's studio (403), managers for void and
// "not claimed" (403).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
let canRacesAnywhere
let canRacesHere
let visible
let isManager
let race
vi.mock('./auth', () => ({
  assertLocationAccessOr404: vi.fn(() => (visible ? null : new Response('{}', { status: 404 }))),
  hasRoleAtLocation: vi.fn(() => isManager),
}))
vi.mock('./permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => canRacesAnywhere),
  hasPermissionForLocation: vi.fn(() => canRacesHere),
}))
vi.mock('./log', () => ({ logError: vi.fn() }))
vi.mock('./supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: race, error: null }) }
      return q
    },
  }),
}))

const { resolveStaffRaffleEvent } = await import('./raffle.js')

beforeEach(() => {
  canRacesAnywhere = true
  canRacesHere = true
  visible = true
  isManager = false
  race = { id: E1, location_id: 'L1', name: 'Charity Day' }
})

const status = async (opts) => (await resolveStaffRaffleEvent({ id: 'u1' }, E1, opts)).response?.status ?? 200

describe('resolveStaffRaffleEvent', () => {
  it('signed out is a 401', async () => {
    expect((await resolveStaffRaffleEvent(null, E1)).response.status).toBe(401)
  })
  it('no races anywhere is a 403', async () => {
    canRacesAnywhere = false
    expect(await status()).toBe(403)
  })
  it('a bad id or a missing event is a 404', async () => {
    expect((await resolveStaffRaffleEvent({ id: 'u1' }, 'nope')).response.status).toBe(404)
    race = null
    expect(await status()).toBe(404)
  })
  it("another studio's event is a 404", async () => {
    visible = false
    expect(await status()).toBe(404)
  })
  it('no races at the event studio is a 403', async () => {
    canRacesHere = false
    expect(await status()).toBe(403)
  })
  it('staff pass; manager-only actions need a manager', async () => {
    expect(await status()).toBe(200)
    expect(await status({ manager: true })).toBe(403)
    isManager = true
    expect(await status({ manager: true })).toBe(200)
  })
})
