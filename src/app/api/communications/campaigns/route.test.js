// MEMBERWRITESWEEP.1e — POST /api/communications/campaigns: the campaign
// editor's "save a new draft", which used to be a browser-direct INSERT into
// campaigns (created_by client-chosen, no audience validation, no email gate).
// Gate (D7): email at the body's studio, the gate of the page that renders
// the editor and of /api/campaigns/[id]/send.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  userWith, hasPermissionForLocationImpl, makeFakeDb, writesOf, jsonRequest, LOC_A, LOC_B,
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

const NEW_ID = 'c0000000-0000-4000-8000-0000000000ff'
const BODY = {
  location_id: LOC_A,
  name: 'Weekend offer',
  subject: 'Last chance',
  preview_text: null,
  from_name: 'UN1T',
  from_email: null,
  reply_to: null,
  design_json: { body: { rows: [] } },
  html_content: '<p>Hi</p>',
  audience_filter: { logic: 'and', filters: [] },
  postmark_stream: 'broadcast',
  ab_subject_b: null,
  ab_test_pct: 10,
  ab_wait_hours: 4,
}
const post = (body) => POST(jsonRequest('/api/communications/campaigns', 'POST', body))

beforeEach(() => {
  vi.clearAllMocks()
  user = userWith()
  db = makeFakeDb((call) => (call.op === 'insert'
    ? { data: { id: NEW_ID, status: 'draft', location_id: LOC_A }, error: null }
    : { data: null, error: null }))
})

describe('POST /api/communications/campaigns', () => {
  it('401 when signed out, and writes nothing', async () => {
    user = null
    const res = await post(BODY)
    expect(res.status).toBe(401)
    expect(writesOf(db)).toEqual([])
  })

  it('403 without email at the body studio', async () => {
    user = userWith({ locations: [LOC_A], emailAt: [] })
    const res = await post(BODY)
    expect(res.status).toBe(403)
    expect(writesOf(db)).toEqual([])
  })

  it('404 at a studio outside the user\'s', async () => {
    user = userWith({ locations: [LOC_A], emailAt: [LOC_A, LOC_B] })
    const res = await post({ ...BODY, location_id: LOC_B })
    expect(res.status).toBe(404)
    expect(writesOf(db)).toEqual([])
  })

  it('400 on an audience filter validateAudienceFilter refuses (an unpicked tag row)', async () => {
    const res = await post({ ...BODY, audience_filter: { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: '' }] } })
    expect(res.status).toBe(400)
    expect(writesOf(db)).toEqual([])
  })

  it('200 inserts the fields as a draft created by the caller, and ignores created_by, status and scheduled_at in the body', async () => {
    const res = await post({ ...BODY, created_by: '10000000-0000-4000-8000-0000000000ee', status: 'queued', scheduled_at: '2030-01-01T00:00:00.000Z' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ success: true, data: { id: NEW_ID, status: 'draft', location_id: LOC_A } })
    const [insert] = writesOf(db)
    expect(insert.table).toBe('campaigns')
    expect(insert.op).toBe('insert')
    const { location_id: _l, ...fields } = BODY
    expect(insert.payload).toEqual({ ...fields, location_id: LOC_A, status: 'draft', created_by: user.id })
    expect(insert.payload).not.toHaveProperty('scheduled_at')
  })

  it('bounds the stream and the A/B settings to the DB CHECKs', async () => {
    for (const bad of [
      { postmark_stream: 'transactional' },
      { ab_test_pct: 4 }, { ab_test_pct: 51 },
      { ab_wait_hours: 0 }, { ab_wait_hours: 25 },
      { from_email: 'not an address' },
      { name: '' },
    ]) {
      const res = await post({ ...BODY, ...bad })
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
    expect(writesOf(db)).toEqual([])
    expect((await post({ ...BODY, postmark_stream: 'outbound', ab_test_pct: 50, ab_wait_hours: 24 })).status).toBe(200)
  })

  it('500 with the database message when the insert fails (the error is read, not discarded)', async () => {
    db = makeFakeDb((call) => (call.op === 'insert' ? { data: null, error: { message: 'boom', code: 'XX000' } } : { data: null, error: null }))
    const res = await post(BODY)
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
