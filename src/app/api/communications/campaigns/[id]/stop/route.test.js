// MEMBERWRITESWEEP.1e — POST /api/communications/campaigns/[id]/stop: the
// editor's "Stop" and the detail page's "Unschedule" / "Stop", which used to
// be browser-direct updates that picked their branch from a status held in
// React state. The server picks it from the CURRENT status and narrows the
// write to it, so a campaign the cron moved in between is never mis-stopped.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  userWith, hasPermissionForLocationImpl, campaignDb, campaignDbSequence, writesOf, jsonRequest, paramsOf,
  LOC_A, LOC_B, CAMPAIGN_ID,
} from '@/lib/campaign-session-access.test-helpers.js'

let db
let user
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async () => {
  const h = await import('@/lib/campaign-session-access.test-helpers.js')
  return { getCurrentUser: vi.fn(async () => user), ...h.authMockImpl() }
})
vi.mock('@/lib/permissions', () => ({
  hasPermissionForLocation: vi.fn((...a) => hasPermissionForLocationImpl(...a)),
}))

import { POST } from './route.js'

const NOW = new Date('2026-10-01T09:00:00.000Z')
const row = (over = {}) => ({ id: CAMPAIGN_ID, location_id: LOC_A, status: 'scheduled', ...over })
const stop = () => POST(jsonRequest(`/api/communications/campaigns/${CAMPAIGN_ID}/stop`, 'POST'), paramsOf())

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  user = userWith()
  db = campaignDb(row())
})
afterEach(() => { vi.useRealTimers() })

describe('POST /api/communications/campaigns/[id]/stop', () => {
  it('401 signed out; 404 unknown or another studio; 403 without email', async () => {
    user = null
    expect((await stop()).status).toBe(401)
    user = userWith()
    db = campaignDb(null)
    expect((await stop()).status).toBe(404)
    db = campaignDb(row({ location_id: LOC_B }))
    expect((await stop()).status).toBe(404)
    db = campaignDb(row())
    user = userWith({ emailAt: [] })
    expect((await stop()).status).toBe(403)
    expect(writesOf(db)).toEqual([])
  })

  it('from scheduled: back to draft with no scheduled_at, guarded by status = scheduled', async () => {
    const res = await stop()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { status: 'draft', cancel_requested_at: null } })
    const [u] = writesOf(db)
    expect(u.payload).toEqual({ status: 'draft', scheduled_at: null })
    expect(u.filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['eq', 'status', 'scheduled']])
    expect(u.columns).toBe('id')
  })

  it('from queued or sending: requests a cancel (the cron stops between chunks), guarded by those statuses', async () => {
    for (const status of ['queued', 'sending']) {
      db = campaignDb(row({ status }))
      const res = await stop()
      expect(res.status, status).toBe(200)
      expect(await res.json()).toEqual({ success: true, data: { status, cancel_requested_at: NOW.toISOString() } })
      const [u] = writesOf(db)
      expect(u.payload).toEqual({ cancel_requested_at: NOW.toISOString() })
      expect(u.filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['in', 'status', ['queued', 'sending']]])
    }
  })

  it('409 from any other status, and writes nothing', async () => {
    for (const status of ['draft', 'sent', 'cancelled', 'failed', null]) {
      db = campaignDb(row({ status }))
      const res = await stop()
      expect(res.status, String(status)).toBe(409)
      expect((await res.json()).data).toEqual({ status })
      expect(writesOf(db)).toEqual([])
    }
  })

  it('409 "The campaign\'s status changed; reload." when zero rows were touched; 500 on a write error', async () => {
    db = campaignDb(row(), () => ({ data: [], error: null }))
    const res = await stop()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("The campaign's status changed; reload.")
    db = campaignDb(row(), () => ({ data: null, error: { message: 'boom' } }))
    expect((await stop()).status).toBe(500)
  })
  it('the cron promoted it between the read and the write: the stop still lands, as a cancel request', async () => {
    // Unschedule clicked as run-campaigns promotes scheduled -> queued. The
    // operator asked to STOP; a 409 "reload" here would leave the send running.
    let n = 0
    db = campaignDbSequence([row(), row({ status: 'queued' })], () => (n++ === 0
      ? { data: [], error: null }
      : { data: [{ id: CAMPAIGN_ID }], error: null }))
    const res = await stop()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { status: 'queued', cancel_requested_at: NOW.toISOString() } })
    const [first, second] = writesOf(db)
    expect(first.filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['eq', 'status', 'scheduled']])
    expect(second.payload).toEqual({ cancel_requested_at: NOW.toISOString() })
    expect(second.filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['in', 'status', ['queued', 'sending']]])
  })

  it('a 409 after zero rows carries the CURRENT status, not the one judged before the write', async () => {
    db = campaignDbSequence([row(), row({ status: 'draft' })], () => ({ data: [], error: null }))
    const res = await stop()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: "The campaign's status changed; reload.", data: { status: 'draft' } })
    expect(writesOf(db)).toHaveLength(1)
  })
})
