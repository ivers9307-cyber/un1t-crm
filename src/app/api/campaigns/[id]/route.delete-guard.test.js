// CAMPDEL.1 — DELETE /api/campaigns/[id] must refuse a campaign that has sent.
//
// ─── THE DEFECT ────────────────────────────────────────────────────────────
// The route deleted any campaign the caller could scope to, in any status.
// `campaign_recipients` and `campaign_link_clicks` are both
// `ON DELETE CASCADE`, so deleting one sent campaign silently destroyed every
// per-recipient row (14 timestamp/status columns each) and every click on it.
// Live at the time of writing: 15 sent campaigns carrying 22,337 recipient
// rows and 1,273 clicks, none of it reconstructible.
//
// That record is what the reporting RPCs read (migs 513/517/521), and CAMPHIST.1
// had just established that a sent campaign's CONTENT is immutable. Deleting
// the whole thing is strictly the larger hole: an edit corrupts the creative a
// report describes, a delete removes the report.
//
// ─── THE RULE ──────────────────────────────────────────────────────────────
// Same predicate as the content lock — `isCampaignContentEditable` — and
// deliberately so. A campaign is deletable exactly while it is still a plan
// and not yet a record. Once anything has been queued from it, it is history.
// 409, because the request is well-formed and authorised; it is the campaign's
// state that refuses it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let campaignRow = null
const deletes = []

const fakeDb = {
  from: (table) => {
    const state = { op: 'select', table, filters: {} }
    const b = {}
    b.select = () => b
    b.eq = (col, val) => { state.filters[col] = val; return b }
    b.delete = () => { state.op = 'delete'; return b }
    b.single = () => Promise.resolve(
      campaignRow ? { data: campaignRow, error: null } : { data: null, error: { message: 'not found' } })
    b.maybeSingle = () => Promise.resolve({ data: campaignRow, error: null })
    b.then = (resolve, reject) => {
      if (state.op === 'delete') deletes.push({ table, filters: state.filters })
      return Promise.resolve({ data: null, error: null }).then(resolve, reject)
    }
    return b
  },
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/api-auth', () => ({
  authenticateApiKey: vi.fn(async () => ({ ok: true, orgId: 'org-1' })),
  assertRowInOrg: vi.fn(async () => null),
}))

import { DELETE } from './route.js'
import { authenticateApiKey, assertRowInOrg } from '@/lib/api-auth'

const props = { params: Promise.resolve({ id: 'camp-1' }) }
const call = () => DELETE(new Request('http://test.local/api/campaigns/camp-1', { method: 'DELETE' }), props)

beforeEach(() => {
  vi.clearAllMocks()
  authenticateApiKey.mockResolvedValue({ ok: true, orgId: 'org-1' })
  assertRowInOrg.mockResolvedValue(null)
  campaignRow = { id: 'camp-1', status: 'draft', location_id: 'loc-1' }
  deletes.length = 0
})

describe('DELETE /api/campaigns/[id] — status guard', () => {
  it('deletes a draft', async () => {
    campaignRow = { id: 'camp-1', status: 'draft' }
    const res = await call()
    expect(res.status).toBe(200)
    expect(deletes).toHaveLength(1)
  })

  it('deletes a scheduled campaign that has not gone out', async () => {
    campaignRow = { id: 'camp-1', status: 'scheduled' }
    const res = await call()
    expect(res.status).toBe(200)
    expect(deletes).toHaveLength(1)
  })

  // The whole point.
  for (const status of ['queued', 'sending', 'sent', 'cancelled', 'failed']) {
    it(`refuses to delete a '${status}' campaign with 409 and deletes nothing`, async () => {
      campaignRow = { id: 'camp-1', status }
      const res = await call()
      expect(res.status).toBe(409)
      expect(deletes).toHaveLength(0)
      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.error).toContain(status)
    })
  }

  it('fails closed on an unrecognised status (campaigns.status has no CHECK)', async () => {
    campaignRow = { id: 'camp-1', status: 'something-new' }
    const res = await call()
    expect(res.status).toBe(409)
    expect(deletes).toHaveLength(0)
  })

  it('fails closed on a null status', async () => {
    campaignRow = { id: 'camp-1', status: null }
    const res = await call()
    expect(res.status).toBe(409)
    expect(deletes).toHaveLength(0)
  })

  it('404s a campaign that does not exist rather than reporting success', async () => {
    campaignRow = null
    const res = await call()
    expect(res.status).toBe(404)
    expect(deletes).toHaveLength(0)
  })

  it('explains the refusal in operator language, with no em-dashes', async () => {
    campaignRow = { id: 'camp-1', status: 'sent' }
    const res = await call()
    const { error } = await res.json()
    expect(error).not.toMatch(/—/)
    expect(error.toLowerCase()).toContain('recipients')
  })

  it('still runs auth and org scoping before any of this', async () => {
    authenticateApiKey.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(deletes).toHaveLength(0)
  })

  it('honours the org-scoping guard result', async () => {
    assertRowInOrg.mockResolvedValue(new Response(null, { status: 404 }))
    const res = await call()
    expect(res.status).toBe(404)
    expect(deletes).toHaveLength(0)
  })
})
