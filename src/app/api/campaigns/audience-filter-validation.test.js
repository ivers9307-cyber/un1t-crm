// FILTER-P1.5 — /api/campaigns POST and /api/campaigns/[id] PUT validate the
// audience filter at SAVE time.
//
// Both accepted the loose `audienceFilterSchema` (shape only) and never called
// validateAudienceFilter, so an OR+tag combination, an unpicked segment-tag row
// (value: '') or a blank numeric could be persisted onto a campaign that can
// then never resolve — it wedges 'queued' instead of failing where the operator
// could see it. COMMSFIX.B.7 closed this for email-draft, the SMS/WA broadcast
// creates and the sequences PUT; these two routes were missed.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GLOBAL_KEY } from '@/lib/api-auth.test-helpers.js'

let inserted = []
let updated = []

const fakeDb = {
  from: () => ({
    insert: (row) => {
      inserted.push(row)
      return { select: () => ({ single: () => Promise.resolve({ data: { id: 'cam-new', ...row }, error: null }) }) }
    },
    select: () => ({
      eq: () => ({ single: () => Promise.resolve({ data: { status: 'draft' }, error: null }) }),
    }),
    update: (row) => {
      updated.push(row)
      return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'cam-1', ...row }, error: null }) }) }) }
    },
  }),
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null) }))
vi.mock('@/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    authenticateApiKey: vi.fn(async () => ({ ok: true, orgId: null })),
    assertCreateInOrg: vi.fn(async () => null),
    assertRowInOrg: vi.fn(async () => null),
  }
})

import { POST } from './route.js'
import { PUT } from './[id]/route.js'

const LOCATION = 'a0000000-0000-0000-0000-000000000001'

const post = (audience_filter) => POST(new Request('http://localhost/api/campaigns', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${GLOBAL_KEY}` },
  body: JSON.stringify({ location_id: LOCATION, name: 'Sale', audience_filter }),
}))

const put = (audience_filter) => PUT(new Request('http://localhost/api/campaigns/cam-1', {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${GLOBAL_KEY}` },
  body: JSON.stringify({ audience_filter }),
}), { params: Promise.resolve({ id: 'cam-1' }) })

const OR_PLUS_TAG = {
  logic: 'or',
  filters: [
    { field: 'tag', op: 'eq', value: 'glofox_trial_engaged' },
    { field: 'pipeline_stage_slug', op: 'eq', value: 'member' },
  ],
}
const UNPICKED_TAG = { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: '' }] }
const BLANK_NUMERIC = { logic: 'and', filters: [{ field: 'total_emails_sent', op: 'gt', value: '' }] }
const UNKNOWN_FIELD = { logic: 'and', filters: [{ field: 'password', op: 'eq', value: 'x' }] }
const VALID = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }

beforeEach(() => { inserted = []; updated = [] })

describe('POST /api/campaigns — audience filter validated at save time (P1.5)', () => {
  it('rejects an OR + tag combination with the library message', async () => {
    const res = await post(OR_PLUS_TAG)
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
    expect((await res.json()).error).toMatch(/OR logic is not supported together with tag, event or studio-list filters/)
  })

  it('rejects an unpicked segment-tag row', async () => {
    const res = await post(UNPICKED_TAG)
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
    expect((await res.json()).error).toMatch(/tag filter requires a non-empty string value/)
  })

  it('rejects a blank numeric', async () => {
    const res = await post(BLANK_NUMERIC)
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
    expect((await res.json()).error).toMatch(/requires a numeric value/)
  })

  it('rejects an unknown field', async () => {
    const res = await post(UNKNOWN_FIELD)
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('still saves a valid filter', async () => {
    const res = await post(VALID)
    expect(res.status).toBe(200)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].audience_filter).toEqual(VALID)
  })

  it('still accepts an omitted filter as "everyone"', async () => {
    const res = await post(undefined)
    expect(res.status).toBe(200)
    expect(inserted[0].audience_filter).toEqual({ filters: [], logic: 'and' })
  })
})

describe('PUT /api/campaigns/[id] — audience filter validated at save time (P1.5)', () => {
  it('rejects an OR + tag combination with the library message', async () => {
    const res = await put(OR_PLUS_TAG)
    expect(res.status).toBe(400)
    expect(updated).toHaveLength(0)
    expect((await res.json()).error).toMatch(/OR logic is not supported together with tag, event or studio-list filters/)
  })

  it('rejects a blank numeric', async () => {
    const res = await put(BLANK_NUMERIC)
    expect(res.status).toBe(400)
    expect(updated).toHaveLength(0)
  })

  it('still saves a valid filter', async () => {
    const res = await put(VALID)
    expect(res.status).toBe(200)
    expect(updated).toHaveLength(1)
    expect(updated[0].audience_filter).toEqual(VALID)
  })
})
