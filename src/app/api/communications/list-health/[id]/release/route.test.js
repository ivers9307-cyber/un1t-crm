// GAPS-P5 — SECURITY + behaviour tests for the escalation release route.
//
// The route runs createServerClient() (service role, RLS bypassed), so the
// application-layer location check is the ONLY thing between a manager at one
// studio and another studio's suppression records. Two IDORs of exactly this
// shape shipped a fortnight apart (#1307, #1311), so the guard is pinned first.
//
// The behaviour that matters after that: releasing a SUPPRESSION clears the
// shared hygiene stamp so the contact rejoins the audience, releasing a REVIEW
// row does not (it never carried a stamp, and clearing one would silently undo
// an unrelated inactivity suppression), and a repeat call never rewrites who
// released the row and when.
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
const USER_AT_A = { id: 'u1', locations: [{ id: LOC_A }] }

const ESC_MINE = '11111111-1111-4111-8111-111111111111'
const ESC_FOREIGN = '22222222-2222-4222-8222-222222222222'
const ESC_REVIEW = '33333333-3333-4333-8333-333333333333'
const ESC_DONE = '44444444-4444-4444-8444-444444444444'
const ESC_MISSING = '55555555-5555-4555-8555-555555555555'

const ROWS = {
  [ESC_MINE]: { id: ESC_MINE, contact_id: 'c1', location_id: LOC_A, decision: 'suppress', released_at: null },
  [ESC_FOREIGN]: { id: ESC_FOREIGN, contact_id: 'c2', location_id: LOC_B, decision: 'suppress', released_at: null },
  [ESC_REVIEW]: { id: ESC_REVIEW, contact_id: 'c3', location_id: LOC_A, decision: 'review', released_at: null },
  [ESC_DONE]: {
    id: ESC_DONE, contact_id: 'c4', location_id: LOC_A, decision: 'suppress',
    released_at: '2026-08-01T00:00:00.000Z',
  },
}

function makeDb() {
  const writes = []
  const db = {
    writes,
    from(table) {
      const state = { table, filters: {}, payload: null, isUpdate: false }
      const b = {
        select: () => b,
        update: (payload) => { state.isUpdate = true; state.payload = payload; writes.push(state); return b },
        eq: (col, val) => { state.filters[col] = val; return b },
        is: () => b,
        not: () => b,
        maybeSingle: () => Promise.resolve({ data: ROWS[state.filters.id] || null, error: null }),
        then: (resolve) => resolve({ data: null, error: null }),
      }
      return b
    },
  }
  return db
}

const req = () => new Request('http://localhost/api/communications/list-health/x/release', { method: 'POST' })
const props = (id) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hasPermission).mockReturnValue(true)
  getCurrentUser.mockResolvedValue(USER_AT_A)
})

describe('POST /api/communications/list-health/[id]/release — access control', () => {
  it('401s when there is no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(makeDb())
    expect((await POST(req(), props(ESC_MINE))).status).toBe(401)
  })

  it('403s without the email permission', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    createServerClient.mockReturnValue(makeDb())
    expect((await POST(req(), props(ESC_MINE))).status).toBe(403)
  })

  it('404s an escalation belonging to another location, and writes nothing', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props(ESC_FOREIGN))
    expect(res.status).toBe(404)
    expect(db.writes).toEqual([])
  })

  it('a foreign escalation is indistinguishable from a missing one', async () => {
    createServerClient.mockReturnValue(makeDb())
    const foreign = await POST(req(), props(ESC_FOREIGN))
    createServerClient.mockReturnValue(makeDb())
    const missing = await POST(req(), props(ESC_MISSING))
    expect(foreign.status).toBe(missing.status)
    expect(await foreign.json()).toEqual(await missing.json())
  })

  it('404s a malformed id rather than surfacing a cast error as a 500', async () => {
    createServerClient.mockReturnValue(makeDb())
    expect((await POST(req(), props('not-a-uuid'))).status).toBe(404)
  })
})

describe('POST /api/communications/list-health/[id]/release — behaviour', () => {
  it('closes the audit row as an operator release and clears the suppression stamp', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props(ESC_MINE))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: { stampCleared: true } })

    const escWrite = db.writes.find((w) => w.table === 'email_bounce_escalations')
    expect(escWrite.payload).toMatchObject({ release_reason: 'operator', released_by: 'u1' })
    expect(escWrite.payload.released_at).toEqual(expect.any(String))

    const contactWrite = db.writes.find((w) => w.table === 'contacts')
    expect(contactWrite.payload).toEqual({ email_suppressed_at: null })
    expect(contactWrite.filters.id).toBe('c1')
  })

  it('dismissing a review row never touches the stamp', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props(ESC_REVIEW))
    expect(await res.json()).toMatchObject({ success: true, data: { stampCleared: false } })
    expect(db.writes.find((w) => w.table === 'contacts')).toBeUndefined()
  })

  it('a repeat release is a no-op that preserves the original audit record', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props(ESC_DONE))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: { alreadyReleased: true } })
    expect(db.writes).toEqual([])
  })
})
