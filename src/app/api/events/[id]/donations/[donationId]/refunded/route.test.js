// CHARITY.10 — POST /api/events/[id]/donations/[donationId]/refunded: the
// record-only "Mark as refunded". Manager+ at the event's location; flips paid
// to refunded stamping the caller; anything not paid is a 409.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ user: null, race: null, donation: null, accessGuard: null, isManager: true, updates: [], reads: [] }))

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => mocks.user),
  assertLocationAccessOr404: vi.fn(() => mocks.accessGuard),
}))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => true),
  hasPermissionForLocation: vi.fn(() => true),
}))
vi.mock('@/lib/role-at-location', () => ({ hasRoleAtLocation: vi.fn(() => mocks.isManager) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      if (table === 'race_events') {
        const c = { select: () => c, eq: () => c, single: async () => ({ data: mocks.race, error: mocks.race ? null : { message: 'none' } }) }
        return c
      }
      if (table === 'donations') {
        const filters = []
        const c = {
          select: () => c,
          eq: (k, v) => { filters.push([k, v]); return c },
          maybeSingle: async () => {
            mocks.reads.push(filters.slice())
            const ok = mocks.donation && filters.every(([k, v]) => k !== 'race_event_id' || v === mocks.donation.race_event_id)
            return { data: ok ? mocks.donation : null, error: null }
          },
          update: (payload) => {
            const f = []
            const u = {
              eq: (k, v) => { f.push([k, v]); return u },
              select: async () => {
                const changed = mocks.donation && mocks.donation.status === 'paid'
                if (changed) { mocks.updates.push({ payload, filters: f }); mocks.donation = { ...mocks.donation, ...payload } }
                return { data: changed ? [{ id: mocks.donation.id }] : [], error: null }
              },
            }
            return u
          },
        }
        return c
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { POST } from './route'

const ctx = { params: Promise.resolve({ id: 'ev-1', donationId: 'd1' }) }
const req = () => new Request('http://x/api/events/ev-1/donations/d1/refunded', { method: 'POST' })

beforeEach(() => {
  mocks.user = { id: 'u1', role: 'manager', activeLocation: { id: 'loc-1' } }
  mocks.race = { id: 'ev-1', location_id: 'loc-1' }
  mocks.donation = { id: 'd1', race_event_id: 'ev-1', status: 'paid' }
  mocks.accessGuard = null
  mocks.isManager = true
  mocks.updates.length = 0
  mocks.reads.length = 0
})

describe('POST /api/events/[id]/donations/[donationId]/refunded', () => {
  it('401s an anonymous caller', async () => {
    mocks.user = null
    expect((await POST(req(), ctx)).status).toBe(401)
  })

  it('404s an event at a studio the caller cannot see, without reading the donation', async () => {
    const { NextResponse } = await import('next/server')
    mocks.accessGuard = NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    expect((await POST(req(), ctx)).status).toBe(404)
    expect(mocks.reads).toHaveLength(0)
  })

  it('403s a caller who is not a manager at the event location', async () => {
    mocks.isManager = false
    expect((await POST(req(), ctx)).status).toBe(403)
    expect(mocks.updates).toHaveLength(0)
  })

  it('404s a donation that belongs to another event', async () => {
    mocks.donation = { id: 'd1', race_event_id: 'ev-OTHER', status: 'paid' }
    expect((await POST(req(), ctx)).status).toBe(404)
    expect(mocks.updates).toHaveLength(0)
  })

  it('flips paid to refunded with refunded_by = the caller; a second call is a 409', async () => {
    const first = await POST(req(), ctx)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ success: true, data: { changed: true } })
    expect(mocks.updates).toHaveLength(1)
    expect(mocks.updates[0].payload.status).toBe('refunded')
    expect(mocks.updates[0].payload.refunded_by).toBe('u1')

    const second = await POST(req(), ctx)
    expect(second.status).toBe(409)
    expect((await second.json()).code).toBe('not_paid')
    expect(mocks.updates).toHaveLength(1)
  })

  it('409s a donation that was never paid', async () => {
    mocks.donation = { id: 'd1', race_event_id: 'ev-1', status: 'awaiting_payment' }
    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect(mocks.updates).toHaveLength(0)
  })
})
