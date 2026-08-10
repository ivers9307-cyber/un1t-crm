// FILTER-B.6 — "show me who matches".
//
// Only a count existed anywhere: no surface listed WHICH contacts a filter
// selects, so the only way to check an audience was to send to it. This route
// is the check. Two properties make it safe rather than dangerous:
//
//  1. It runs the SAME query path as the count and the send
//     (buildEligibleAudienceQuery → the per-channel send builder). A preview
//     that disagrees with the send is worse than no preview: it manufactures
//     false confidence in exactly the moment an operator is checking work.
//
//  2. It returns customer PII, so it is location-guarded with
//     assertLocationAccessOr404 (404, never 403 — ids must not be
//     enumerable), paginated, and masked. Two IDORs shipped in this codebase
//     the same week for precisely this omission (#1307, #1311).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1' })),
  assertLocationAccessOr404: vi.fn(() => null),
}))
vi.mock('@/lib/validate', () => ({
  validateBody: vi.fn(async (req) => ({ ok: true, data: await req.json() })),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/audience-eligibility', () => ({ buildEligibleAudienceQuery: vi.fn() }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { buildEligibleAudienceQuery } from '@/lib/audience-eligibility'

function reqWith(body) { return { json: async () => body } }

const ROWS = [
  { id: 'c1', name: 'Richard Ivers', first_name: 'Richard', last_name: 'Ivers', email: 'richard@example.com', phone: '+353871234567', wa_phone: '+353879999111', pipeline_stage_slug: 'member' },
  { id: 'c2', name: null, first_name: 'Ann', last_name: 'Byrne', email: 'ann@un1tdublin.com', phone: null, wa_phone: null, pipeline_stage_slug: 'dormant' },
]

// Records .order()/.range() so the pagination assertions can read them, then
// resolves like a PostgREST query with { data, count }.
function fakeQuery({ data = ROWS, count = 2, error = null } = {}) {
  const calls = []
  const q = {
    calls,
    order: (...a) => { calls.push(['order', a]); return q },
    range: (...a) => { calls.push(['range', a]); return q },
    then: (resolve) => resolve({ data, count, error }),
  }
  return q
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1' })
  assertLocationAccessOr404.mockReturnValue(null)
  createServerClient.mockReturnValue({ from: vi.fn() })
  buildEligibleAudienceQuery.mockResolvedValue({ query: fakeQuery() })
})

const BODY = { location_id: 'loc-1', audience_filter: { logic: 'and', filters: [] }, channel: 'email' }

describe('audience-preview — tenant boundary (the IDOR the route must not be)', () => {
  it('401s with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(reqWith(BODY))
    expect(res.status).toBe(401)
    expect(buildEligibleAudienceQuery).not.toHaveBeenCalled()
  })

  it('guards the location with assertLocationAccessOr404 BEFORE querying', async () => {
    const denial = { status: 404 }
    assertLocationAccessOr404.mockReturnValue(denial)
    const res = await POST(reqWith(BODY))
    expect(assertLocationAccessOr404).toHaveBeenCalledWith({ id: 'u1' }, 'loc-1')
    expect(res).toBe(denial)
    // No PII was fetched for a location the caller cannot see.
    expect(buildEligibleAudienceQuery).not.toHaveBeenCalled()
  })
})

describe('audience-preview — same query path as the count and the send', () => {
  it('goes through buildEligibleAudienceQuery for the requested channel', async () => {
    await POST(reqWith(BODY))
    const args = buildEligibleAudienceQuery.mock.calls[0][0]
    expect(args.channel).toBe('email')
    expect(args.locationId).toBe('loc-1')
    expect(args.filter).toEqual(BODY.audience_filter)
    expect(args.selectOpts).toEqual({ count: 'exact' })
  })

  it.each(['sms', 'whatsapp'])('asks for the %s send builder, not the email one', async (channel) => {
    await POST(reqWith({ ...BODY, channel }))
    expect(buildEligibleAudienceQuery.mock.calls[0][0].channel).toBe(channel)
  })

  it('with no channel previews the MATCH set and says so', async () => {
    const { channel: _c, ...noChannel } = BODY
    const res = await POST(reqWith(noChannel))
    const json = await res.json()
    expect(buildEligibleAudienceQuery.mock.calls[0][0].channel).toBeNull()
    expect(json.data.basis).toBe('matching')
  })

  it('labels a channel preview as will-receive, not merely matched', async () => {
    const res = await POST(reqWith(BODY))
    const json = await res.json()
    expect(json.data.basis).toBe('will_receive')
  })
})

describe('audience-preview — pagination', () => {
  it('defaults to the first 50, ordered deterministically', async () => {
    const q = fakeQuery()
    buildEligibleAudienceQuery.mockResolvedValue({ query: q })
    await POST(reqWith(BODY))
    expect(q.calls).toContainEqual(['order', ['id', { ascending: true }]])
    expect(q.calls).toContainEqual(['range', [0, 49]])
  })

  it('honours offset for the next page', async () => {
    const q = fakeQuery()
    buildEligibleAudienceQuery.mockResolvedValue({ query: q })
    await POST(reqWith({ ...BODY, offset: 50 }))
    expect(q.calls).toContainEqual(['range', [50, 99]])
  })

  it('clamps an oversized limit — a preview is a spot-check, not an export', async () => {
    const q = fakeQuery()
    buildEligibleAudienceQuery.mockResolvedValue({ query: q })
    await POST(reqWith({ ...BODY, limit: 5000 }))
    expect(q.calls).toContainEqual(['range', [0, 49]])
  })

  it('returns the total alongside the page so the operator sees the whole size', async () => {
    buildEligibleAudienceQuery.mockResolvedValue({ query: fakeQuery({ count: 3195 }) })
    const res = await POST(reqWith(BODY))
    const json = await res.json()
    expect(json.data.total).toBe(3195)
    expect(json.data.offset).toBe(0)
    expect(json.data.limit).toBe(50)
  })
})

describe('audience-preview — masked, and only ever masked', () => {
  it('returns name + one masked identifier and nothing else', async () => {
    const res = await POST(reqWith(BODY))
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.rows).toEqual([
      { id: 'c1', name: 'Richard Ivers', stage: 'member', identifier: 'ri•••@example.com', identifier_kind: 'email' },
      { id: 'c2', name: 'Ann Byrne', stage: 'dormant', identifier: 'an•••@un1tdublin.com', identifier_kind: 'email' },
    ])
  })

  it('never lets a raw email or phone reach the response body', async () => {
    const res = await POST(reqWith({ ...BODY, channel: 'sms' }))
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain('richard@example.com')
    expect(body).not.toContain('353871234567')
  })
})

describe('audience-preview — errors', () => {
  it('surfaces an invalid filter as a 400, not a 500', async () => {
    buildEligibleAudienceQuery.mockRejectedValue(new Error('Unknown audience field: nope'))
    const res = await POST(reqWith(BODY))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Unknown audience field/)
  })

  it('surfaces a query error as a 400', async () => {
    buildEligibleAudienceQuery.mockResolvedValue({ query: fakeQuery({ data: null, error: { message: 'bad range' } }) })
    const res = await POST(reqWith(BODY))
    expect(res.status).toBe(400)
  })
})
