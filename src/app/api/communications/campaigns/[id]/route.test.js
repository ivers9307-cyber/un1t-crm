// MEMBERWRITESWEEP.1e — GET / PUT / DELETE /api/communications/campaigns/[id]:
// the campaign editor's progress poll, "save" of an existing campaign and
// "delete", which used to be browser-direct reads and writes on campaigns.
// Gate (D7), in order: session (401) → the campaign by id (404) → the
// caller's studios (404, not 403: ids are not enumerable) → email at the
// campaign's studio (403).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  userWith, hasPermissionForLocationImpl, campaignDb, makeFakeDb, writesOf, jsonRequest, paramsOf,
  LOC_A, LOC_B, CAMPAIGN_ID,
} from '@/lib/campaign-session-access.test-helpers.js'
import { campaignLockedReason, campaignUndeletableReason } from '@/lib/campaign-editability'

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

import { GET, PUT, DELETE } from './route.js'

const URL_ = `/api/communications/campaigns/${CAMPAIGN_ID}`
const row = (over = {}) => ({
  id: CAMPAIGN_ID, location_id: LOC_A, status: 'draft',
  total_sent: 12, total_recipients: 40, cancel_requested_at: null, ...over,
})
const get = (id = CAMPAIGN_ID) => GET(jsonRequest(URL_, 'GET'), paramsOf(id))
const put = (body, id = CAMPAIGN_ID) => PUT(jsonRequest(URL_, 'PUT', body), paramsOf(id))
const del = (id = CAMPAIGN_ID) => DELETE(jsonRequest(URL_, 'DELETE'), paramsOf(id))

const CONTENT = {
  name: 'Weekend offer', subject: 'Last chance', preview_text: 'Ends Sunday',
  from_name: 'UN1T', from_email: null, reply_to: null,
  design_json: { body: { rows: [] } }, html_content: '<p>Hi</p>',
  audience_filter: { logic: 'and', filters: [] }, postmark_stream: 'broadcast',
  ab_subject_b: null, ab_test_pct: 10, ab_wait_hours: 4,
}

beforeEach(() => {
  vi.clearAllMocks()
  user = userWith()
  db = campaignDb(row())
})

describe('the gate, on every method', () => {
  it.each([['GET', get], ['PUT', () => put(CONTENT)], ['DELETE', del]])('%s: 401 signed out', async (_m, call) => {
    user = null
    expect((await call()).status).toBe(401)
    expect(writesOf(db)).toEqual([])
  })

  it.each([['GET', get], ['PUT', () => put(CONTENT)], ['DELETE', del]])('%s: 404 for an unknown id', async (_m, call) => {
    db = campaignDb(null)
    expect((await call()).status).toBe(404)
    expect(writesOf(db)).toEqual([])
  })

  it.each([['GET', get], ['PUT', () => put(CONTENT)], ['DELETE', del]])('%s: 404 for a campaign at another studio, even with email there', async (_m, call) => {
    user = userWith({ locations: [LOC_A], emailAt: [LOC_A, LOC_B] })
    db = campaignDb(row({ location_id: LOC_B }))
    expect((await call()).status).toBe(404)
    expect(writesOf(db)).toEqual([])
  })

  it.each([['GET', get], ['PUT', () => put(CONTENT)], ['DELETE', del]])('%s: 403 without email at the campaign\'s studio', async (_m, call) => {
    user = userWith({ locations: [LOC_A, LOC_B], emailAt: [LOC_B] })
    expect((await call()).status).toBe(403)
    expect(writesOf(db)).toEqual([])
  })

  it('404 for an id that is not uuid-shaped, without querying', async () => {
    expect((await get('not-a-uuid')).status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('500 when the by-id read fails (the error is read, not treated as "not found")', async () => {
    db = makeFakeDb(() => ({ data: null, error: { message: 'boom' } }))
    expect((await get()).status).toBe(500)
  })
})

describe('GET [id] — the progress poll', () => {
  it('200 returns only status, total_sent, total_recipients and cancel_requested_at', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: { status: 'draft', total_sent: 12, total_recipients: 40, cancel_requested_at: null },
    })
  })
})

describe('PUT [id] — save an existing campaign', () => {
  it('409 with campaignLockedReason when the content is not editable', async () => {
    for (const status of ['queued', 'sending', 'sent', 'cancelled', 'failed', null]) {
      db = campaignDb(row({ status }))
      const res = await put(CONTENT)
      expect(res.status, String(status)).toBe(409)
      const json = await res.json()
      expect(json.error).toBe(campaignLockedReason(status))
      expect(json.data).toEqual({ status })
      expect(writesOf(db)).toEqual([])
    }
  })

  it('200 updates the content fields only, narrowed to an editable status, and never writes created_by, status, scheduled_at or location_id', async () => {
    db = campaignDb(row({ status: 'scheduled' }), () => ({ data: [{ id: CAMPAIGN_ID, status: 'scheduled' }], error: null }))
    const res = await put({
      ...CONTENT, created_by: '10000000-0000-4000-8000-0000000000ee', status: 'sent',
      scheduled_at: '2030-01-01T00:00:00.000Z', location_id: LOC_B,
    })
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    const [update] = writesOf(db)
    expect(update.op).toBe('update')
    expect(update.payload).toEqual(CONTENT)
    for (const k of ['created_by', 'status', 'scheduled_at', 'location_id']) expect(update.payload).not.toHaveProperty(k)
    expect(update.filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['in', 'status', ['draft', 'scheduled']]])
  })

  it('writes only the fields the body carries (a partial save never blanks the rest)', async () => {
    await put({ name: 'Renamed' })
    expect(writesOf(db)[0].payload).toEqual({ name: 'Renamed' })
  })

  it('400 on an audience filter validateAudienceFilter refuses', async () => {
    const res = await put({ ...CONTENT, audience_filter: { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: '' }] } })
    expect(res.status).toBe(400)
    expect(writesOf(db)).toEqual([])
  })

  it('409 when the status changed between the read and the write (zero rows)', async () => {
    db = campaignDb(row(), () => ({ data: [], error: null }))
    const res = await put(CONTENT)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/status changed/i)
  })

  it('409 when the content-lock trigger refuses the write (check_violation)', async () => {
    db = campaignDb(row(), () => ({ data: null, error: { code: '23514', message: 'Campaign is sent' } }))
    expect((await put(CONTENT)).status).toBe(409)
  })

  it('500 on any other write error', async () => {
    db = campaignDb(row(), () => ({ data: null, error: { code: 'XX000', message: 'boom' } }))
    expect((await put(CONTENT)).status).toBe(500)
  })
})

describe('DELETE [id]', () => {
  it('re-reads the status and refuses a sending campaign with the editor\'s text', async () => {
    for (const status of ['queued', 'sending']) {
      db = campaignDb(row({ status }))
      const res = await del()
      expect(res.status).toBe(409)
      const json = await res.json()
      expect(json.error).toBe('This campaign is sending. Cancel the send first, then delete.')
      expect(json.data).toEqual({ status })
      expect(writesOf(db)).toEqual([])
    }
  })

  it('refuses the other non-editable statuses with campaignUndeletableReason', async () => {
    for (const status of ['sent', 'cancelled', 'failed', 'weird']) {
      db = campaignDb(row({ status }))
      const res = await del()
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe(campaignUndeletableReason(status))
      expect(writesOf(db)).toEqual([])
    }
  })

  it('200 deletes a draft, narrowed to an editable status', async () => {
    const res = await del()
    expect(res.status).toBe(200)
    const [d] = writesOf(db)
    expect(d.op).toBe('delete')
    expect(d.filters).toEqual([['eq', 'id', CAMPAIGN_ID], ['in', 'status', ['draft', 'scheduled']]])
  })

  it('409 when nothing was deleted (the status changed under it)', async () => {
    db = campaignDb(row(), () => ({ data: [], error: null }))
    expect((await del()).status).toBe(409)
  })

  it('409 when the block-sent-delete trigger refuses it; 500 on another error', async () => {
    db = campaignDb(row(), () => ({ data: null, error: { code: '23514', message: 'cannot be deleted' } }))
    expect((await del()).status).toBe(409)
    db = campaignDb(row(), () => ({ data: null, error: { code: 'XX000', message: 'boom' } }))
    expect((await del()).status).toBe(500)
  })
})
