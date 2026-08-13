// HYGREL.1 — SECURITY + behaviour tests for the hygiene release route.
//
// The route runs createServerClient() (service role, RLS bypassed), so the
// application-layer location check is the ONLY thing between a manager at one
// studio and another studio's contacts. Two IDORs of exactly this shape shipped
// a fortnight apart (#1307, #1311), so the guard is pinned first — and this
// route is keyed on a CONTACT id, the most guessable id surface in the product.
//
// After that, the three behaviours the feature depends on:
//   • the release writes BOTH columns. Clearing email_suppressed_at without
//     stamping email_hygiene_released_at is a release with a seven-hour
//     half-life, undone by the 05:15 sweep, and looks identical from the UI.
//   • a repeat call is a success that writes NOTHING, so the audit trail keeps
//     the original decision rather than the most recent double-click.
//   • a bounce-owned stamp is refused, not stolen. Clearing it here would leave
//     an open email_bounce_escalations row asserting a suppression that no
//     longer exists — the state mig 515 exists to make impossible.
//
// @/lib/auth is mocked with a real-equivalent assertLocationAccessOr404
// (inlined to keep its next/headers import out of the node test env).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

const LOC_A = '00000000-0000-4000-8000-00000000000a'
const LOC_B = '00000000-0000-4000-8000-00000000000b'
const USER_AT_A = { id: 'u1', locations: [{ id: LOC_A }], activeLocation: { id: LOC_A } }

const C_SUPPRESSED = '11111111-1111-4111-8111-111111111111'
const C_FOREIGN = '22222222-2222-4222-8222-222222222222'
const C_RELEASED = '33333333-3333-4333-8333-333333333333'
const C_BOUNCED = '44444444-4444-4444-8444-444444444444'
const C_MISSING = '55555555-5555-4555-8555-555555555555'

// The view is (contact, location) keyed, so a foreign contact simply has no row
// at LOC_A — the same shape the real query produces, not a special case.
const AUDIENCE = {
  [`${C_SUPPRESSED}|${LOC_A}`]: {
    id: C_SUPPRESSED, email_suppressed_at: '2026-08-12T05:15:00.000Z',
    email_hygiene_released_at: null, pipeline_stage_slug: 'member', audience_location_id: LOC_A,
  },
  [`${C_FOREIGN}|${LOC_B}`]: {
    id: C_FOREIGN, email_suppressed_at: '2026-08-12T05:15:00.000Z',
    email_hygiene_released_at: null, pipeline_stage_slug: 'member', audience_location_id: LOC_B,
  },
  [`${C_RELEASED}|${LOC_A}`]: {
    id: C_RELEASED, email_suppressed_at: null,
    email_hygiene_released_at: '2026-08-12T11:00:00.000Z', pipeline_stage_slug: 'member', audience_location_id: LOC_A,
  },
  [`${C_BOUNCED}|${LOC_A}`]: {
    id: C_BOUNCED, email_suppressed_at: '2026-08-11T05:45:00.000Z',
    email_hygiene_released_at: null, pipeline_stage_slug: 'pack_member', audience_location_id: LOC_A,
  },
}

function makeDb() {
  const writes = []
  const db = {
    writes,
    from(table) {
      const state = { table, op: 'select', filters: {}, payload: null }
      const b = {
        select: () => b,
        insert: (payload) => { state.op = 'insert'; state.payload = payload; writes.push(state); return b },
        update: (payload) => { state.op = 'update'; state.payload = payload; writes.push(state); return b },
        eq: (col, val) => { state.filters[col] = val; return b },
        is: () => b,
        not: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: () => {
          if (state.table === 'contact_location_audience') {
            return Promise.resolve({
              data: AUDIENCE[`${state.filters.id}|${state.filters.audience_location_id}`] || null,
              error: null,
            })
          }
          if (state.table === 'email_bounce_escalations') {
            // Only C_BOUNCED carries an active bounce suppression.
            return Promise.resolve({
              data: state.filters.contact_id === C_BOUNCED ? { id: 'esc-1' } : null,
              error: null,
            })
          }
          return Promise.resolve({ data: { id: 'rel-1' }, error: null })
        },
        then: (resolve) => resolve({ data: null, error: null }),
      }
      return b
    },
  }
  return db
}

const req = () => new Request('http://localhost/api/communications/hygiene-suppressions/x/release', { method: 'POST' })
const props = (contactId) => ({ params: Promise.resolve({ contactId }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hasPermission).mockReturnValue(true)
  getCurrentUser.mockResolvedValue(USER_AT_A)
})

describe('POST /api/communications/hygiene-suppressions/[contactId]/release — access control', () => {
  it('401s when there is no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(makeDb())
    expect((await POST(req(), props(C_SUPPRESSED))).status).toBe(401)
  })

  it('403s without the email permission', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    createServerClient.mockReturnValue(makeDb())
    expect((await POST(req(), props(C_SUPPRESSED))).status).toBe(403)
  })

  it('404s a contact outside the caller\'s locations, and writes nothing', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props(C_FOREIGN))
    expect(res.status).toBe(404)
    expect(db.writes).toEqual([])
  })

  it('a foreign contact is indistinguishable from a missing one', async () => {
    createServerClient.mockReturnValue(makeDb())
    const foreign = await POST(req(), props(C_FOREIGN))
    createServerClient.mockReturnValue(makeDb())
    const missing = await POST(req(), props(C_MISSING))
    expect(foreign.status).toBe(missing.status)
    expect(await foreign.json()).toEqual(await missing.json())
  })

  it('404s a malformed id rather than surfacing a cast error as a 500', async () => {
    createServerClient.mockReturnValue(makeDb())
    expect((await POST(req(), props('not-a-uuid'))).status).toBe(404)
  })
})

describe('POST /api/communications/hygiene-suppressions/[contactId]/release — behaviour', () => {
  it('clears the stamp AND records the release, so the 05:15 sweep cannot undo it', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props(C_SUPPRESSED))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: { alreadyReleased: false } })

    const contactWrite = db.writes.find((w) => w.table === 'contacts')
    expect(contactWrite.payload.email_suppressed_at).toBeNull()
    // The half of the pair that makes it permanent. Without it the release
    // survives until 05:15 and the operator is never told.
    expect(contactWrite.payload.email_hygiene_released_at).toEqual(expect.any(String))
    expect(contactWrite.filters.id).toBe(C_SUPPRESSED)
  })

  it('writes the audit row BEFORE the stamp, naming the operator and the list', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req(), props(C_SUPPRESSED))

    expect(db.writes.map((w) => w.table)).toEqual(['email_hygiene_releases', 'contacts'])
    const audit = db.writes[0]
    expect(audit.payload).toMatchObject({
      contact_id: C_SUPPRESSED,
      location_id: LOC_A,
      released_by: 'u1',
      pipeline_stage_slug: 'member',
      suppressed_at: '2026-08-12T05:15:00.000Z',
    })
    expect(audit.payload.note).toEqual(expect.any(String))
  })

  it('is idempotent — a repeat release succeeds and writes nothing', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props(C_RELEASED))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      success: true,
      data: { alreadyReleased: true, released_at: '2026-08-12T11:00:00.000Z' },
    })
    // The original audit row keeps the original decision.
    expect(db.writes).toEqual([])
  })

  it('refuses a stamp owned by a repeat-bounce escalation rather than stealing it', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props(C_BOUNCED))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/repeat bounces/i)
    expect(db.writes).toEqual([])
  })
})
