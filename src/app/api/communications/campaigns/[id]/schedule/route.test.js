// MEMBERWRITESWEEP.1e — POST /api/communications/campaigns/[id]/schedule: the
// editor's "Schedule", which used to be a browser-direct
// `update({ status: 'scheduled', scheduled_at, cancel_requested_at: null })`
// with no server check at all. Scheduling is a send the run-campaigns cron
// promotes later, so it runs /api/campaigns/[id]/send's status rule and its
// subject/body guard (verbatim messages), under the same email gate.

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
const LATER = '2026-10-02T09:00:00.000Z'
const row = (over = {}) => ({
  id: CAMPAIGN_ID, location_id: LOC_A, status: 'draft', subject: 'Last chance', html_content: '<p>Hi</p>', ...over,
})
const schedule = (body) => POST(jsonRequest(`/api/communications/campaigns/${CAMPAIGN_ID}/schedule`, 'POST', body), paramsOf())

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  user = userWith()
  db = campaignDb(row())
})
afterEach(() => { vi.useRealTimers() })

describe('POST /api/communications/campaigns/[id]/schedule', () => {
  it('401 signed out; 404 unknown or another studio; 403 without email', async () => {
    user = null
    expect((await schedule({ scheduled_at: LATER })).status).toBe(401)
    user = userWith()
    db = campaignDb(null)
    expect((await schedule({ scheduled_at: LATER })).status).toBe(404)
    db = campaignDb(row({ location_id: LOC_B }))
    expect((await schedule({ scheduled_at: LATER })).status).toBe(404)
    db = campaignDb(row())
    user = userWith({ emailAt: [] })
    expect((await schedule({ scheduled_at: LATER })).status).toBe(403)
    expect(writesOf(db)).toEqual([])
  })

  it('400 when scheduled_at is missing, not an ISO instant, or not in the future', async () => {
    for (const scheduled_at of [undefined, 'tomorrow', '2026-10-02 10:00', '2026-09-30T09:00:00.000Z', NOW.toISOString()]) {
      const res = await schedule({ scheduled_at })
      expect(res.status, String(scheduled_at)).toBe(400)
    }
    expect(writesOf(db)).toEqual([])
  })

  it('400 with the send route\'s messages when there is no subject or no body', async () => {
    db = campaignDb(row({ subject: '  ' }))
    let res = await schedule({ scheduled_at: LATER })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('This campaign has no subject — add one before sending.')
    db = campaignDb(row({ html_content: null }))
    res = await schedule({ scheduled_at: LATER })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('This campaign has no email body — nothing was queued. Open it in the editor and add content.')
    expect(writesOf(db)).toEqual([])
  })

  it('409 when the status is not draft, scheduled or failed', async () => {
    for (const status of ['queued', 'sending', 'sent', 'cancelled', null]) {
      db = campaignDb(row({ status }))
      const res = await schedule({ scheduled_at: LATER })
      expect(res.status, String(status)).toBe(409)
      expect((await res.json()).data).toEqual({ status })
      expect(writesOf(db)).toEqual([])
    }
  })

  it('200 sets status, scheduled_at and clears cancel_requested_at, narrowed to the schedulable statuses', async () => {
    for (const status of ['draft', 'scheduled', 'failed']) {
      db = campaignDb(row({ status }))
      const res = await schedule({ scheduled_at: LATER })
      expect(res.status, status).toBe(200)
      expect(await res.json()).toEqual({ success: true, data: { status: 'scheduled', scheduled_at: LATER } })
      const [u] = writesOf(db)
      expect(u.op).toBe('update')
      expect(u.payload).toEqual({ status: 'scheduled', scheduled_at: LATER, cancel_requested_at: null })
      expect(u.filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['in', 'status', ['draft', 'scheduled', 'failed']]])
      expect(u.columns).toBe('id')
    }
  })

  it('normalises an offset instant to UTC', async () => {
    await schedule({ scheduled_at: '2026-10-02T10:00:00+01:00' })
    expect(writesOf(db)[0].payload.scheduled_at).toBe(LATER)
  })

  it('a 409 after zero rows carries the CURRENT status', async () => {
    db = campaignDbSequence([row(), row({ status: 'sending' })], () => ({ data: [], error: null }))
    const res = await schedule({ scheduled_at: LATER })
    expect(res.status).toBe(409)
    expect((await res.json()).data).toEqual({ status: 'sending' })
  })

  it('409 when zero rows were updated (the status changed under it); 500 on a write error', async () => {
    db = campaignDb(row(), () => ({ data: [], error: null }))
    const res = await schedule({ scheduled_at: LATER })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/status changed/i)
    db = campaignDb(row(), () => ({ data: null, error: { message: 'boom' } }))
    expect((await schedule({ scheduled_at: LATER })).status).toBe(500)
  })
})
