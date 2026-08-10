// LISTHEALTH-ACT.1 — SECURITY + behaviour tests for suppressing a reviewed
// contact.
//
// Same service-role posture as the release route beside it: createServerClient
// bypasses RLS, so the application-layer location check is the only thing
// between a manager at one studio and another studio's records. Pinned first.
//
// After that, the things that make this an audit action rather than an UPDATE:
//   • an email_bounce_escalations row with decision='suppress' and a reason is
//     written for every suppression, and it is written BEFORE the stamp;
//   • the review row is CLOSED, not edited, so the record that the rule said
//     review survives;
//   • it closes with 'operator_suppressed', NOT 'operator' — the latter is the
//     sweep's permanent do-not-touch flag and means the opposite of this;
//   • what it creates is an ordinary suppression the existing release route
//     can undo;
//   • it refuses anything that is not an open review row.
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

const ESC_REVIEW = '11111111-1111-4111-8111-111111111111'
const ESC_FOREIGN = '22222222-2222-4222-8222-222222222222'
const ESC_SUPPRESS = '33333333-3333-4333-8333-333333333333'
const ESC_DONE = '44444444-4444-4444-8444-444444444444'
const ESC_MISSING = '55555555-5555-4555-8555-555555555555'

const EVIDENCE = {
  bounced_campaign_count: 4,
  bounced_campaign_ids: ['camp-1', 'camp-2', 'camp-3', 'camp-4'],
  bounce_types: ['soft', 'transient'],
  bounce_events: 9,
  successful_deliveries: 2,
  first_bounce_at: '2026-04-01T00:00:00.000Z',
  last_bounce_at: '2026-08-01T00:00:00.000Z',
}

const ROWS = {
  [ESC_REVIEW]: { id: ESC_REVIEW, contact_id: 'c1', location_id: LOC_A, decision: 'review', released_at: null, ...EVIDENCE },
  [ESC_FOREIGN]: { id: ESC_FOREIGN, contact_id: 'c2', location_id: LOC_B, decision: 'review', released_at: null, ...EVIDENCE },
  [ESC_SUPPRESS]: { id: ESC_SUPPRESS, contact_id: 'c3', location_id: LOC_A, decision: 'suppress', released_at: null, ...EVIDENCE },
  [ESC_DONE]: { id: ESC_DONE, contact_id: 'c4', location_id: LOC_A, decision: 'review', released_at: '2026-08-01T00:00:00.000Z', ...EVIDENCE },
}

/**
 * Records every statement in order, so "the audit row was written before the
 * stamp" is testable rather than asserted in a comment.
 */
function makeDb({ contactStamp = null, closeGranted = true, insertError = null } = {}) {
  const writes = []
  const db = {
    writes,
    from(table) {
      const state = { table, method: null, filters: {}, payload: null }
      const b = {
        select: () => b,
        update: (payload) => { state.method = 'update'; state.payload = payload; writes.push(state); return b },
        insert: (payload) => { state.method = 'insert'; state.payload = payload; writes.push(state); return b },
        eq: (col, val) => { state.filters[col] = val; return b },
        is: (col, val) => { state.filters[`is:${col}`] = val; return b },
        not: () => b,
        maybeSingle: () => {
          if (state.method === 'insert') {
            return Promise.resolve(insertError ? { data: null, error: insertError } : { data: { id: 'new-esc' }, error: null })
          }
          if (table === 'contacts') {
            return Promise.resolve({ data: { id: state.filters.id, email_suppressed_at: contactStamp }, error: null })
          }
          return Promise.resolve({ data: ROWS[state.filters.id] || null, error: null })
        },
        // The close CAS resolves as an awaited builder returning rows.
        then: (resolve) => resolve(
          state.method === 'update' && state.table === 'email_bounce_escalations'
            ? { data: closeGranted ? [{ id: state.filters.id }] : [], error: null }
            : { data: null, error: null },
        ),
      }
      return b
    },
  }
  return db
}

const req = () => new Request('http://localhost/api/communications/list-health/x/suppress', { method: 'POST' })
const props = (id) => ({ params: Promise.resolve({ id }) })

const escWrites = (db) => db.writes.filter((w) => w.table === 'email_bounce_escalations')
const contactWrites = (db) => db.writes.filter((w) => w.table === 'contacts' && w.method === 'update')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hasPermission).mockReturnValue(true)
  getCurrentUser.mockResolvedValue(USER_AT_A)
})

describe('POST …/[id]/suppress — access control', () => {
  it('401s when there is no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(makeDb())
    expect((await POST(req(), props(ESC_REVIEW))).status).toBe(401)
  })

  it('403s without the email permission', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    createServerClient.mockReturnValue(makeDb())
    expect((await POST(req(), props(ESC_REVIEW))).status).toBe(403)
  })

  it('404s a row belonging to another location, and writes nothing', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props(ESC_FOREIGN))
    expect(res.status).toBe(404)
    expect(db.writes).toEqual([])
  })

  it('a foreign row is indistinguishable from a missing one', async () => {
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

describe('POST …/[id]/suppress — the audit row is never bypassed', () => {
  it('writes a decision=suppress escalation with a reason, then stamps the contact', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props(ESC_REVIEW))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: { suppressed: true, decision: 'suppress' } })

    const insert = escWrites(db).find((w) => w.method === 'insert')
    expect(insert).toBeTruthy()
    expect(insert.payload).toMatchObject({
      contact_id: 'c1',
      location_id: LOC_A,
      decision: 'suppress',
      reason: 'operator_suppressed_after_review',
    })
    expect(insert.payload.suppressed_at).toEqual(expect.any(String))

    // ORDER: audit first, stamp second. A stamp with no explanation is the one
    // state this table exists to prevent.
    const stamp = contactWrites(db)[0]
    expect(stamp).toBeTruthy()
    expect(db.writes.indexOf(insert)).toBeLessThan(db.writes.indexOf(stamp))
  })

  it('carries the evidence forward so the new row explains itself', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req(), props(ESC_REVIEW))

    const insert = escWrites(db).find((w) => w.method === 'insert')
    expect(insert.payload).toMatchObject(EVIDENCE)
    expect(insert.payload.evaluated_at).toEqual(expect.any(String))
  })

  it('stamps the shared hygiene column, only when it is not already set', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req(), props(ESC_REVIEW))

    const stamp = contactWrites(db)[0]
    expect(stamp.filters.id).toBe('c1')
    expect(stamp.payload.email_suppressed_at).toEqual(expect.any(String))
    expect(stamp.filters['is:email_suppressed_at']).toBeNull()
  })

  it('records that the stamp was already there, so a later Restore is not misread', async () => {
    const db = makeDb({ contactStamp: '2026-07-01T00:00:00.000Z' })
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props(ESC_REVIEW))

    expect(await res.json()).toMatchObject({ data: { stamp_was_already_set: true } })
    const insert = escWrites(db).find((w) => w.method === 'insert')
    expect(insert.payload.stamp_was_already_set).toBe(true)
  })

  it('does NOT stamp when the audit row failed to land', async () => {
    const db = makeDb({ insertError: { message: 'insert exploded' } })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props(ESC_REVIEW))
    expect(res.status).toBe(500)
    expect(contactWrites(db)).toEqual([])
  })
})

describe('POST …/[id]/suppress — the review row is closed, not edited', () => {
  it('closes the review row rather than flipping its decision', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req(), props(ESC_REVIEW))

    const close = escWrites(db).find((w) => w.method === 'update')
    expect(close.filters.id).toBe(ESC_REVIEW)
    expect(close.payload.released_at).toEqual(expect.any(String))
    expect(close.payload.released_by).toBe('u1')
    expect('decision' in close.payload).toBe(false)
  })

  it("closes it as 'operator_suppressed', NOT 'operator'", async () => {
    // 'operator' is the sweep's permanent do-not-touch flag and means a human
    // said NO. Recording it here would say the opposite of what happened and
    // would stop the sweep refreshing the suppression just created.
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req(), props(ESC_REVIEW))

    const close = escWrites(db).find((w) => w.method === 'update')
    expect(close.payload.release_reason).toBe('operator_suppressed')
    expect(close.payload.release_reason).not.toBe('operator')
  })

  it('CASes the close on released_at IS NULL so two clicks cannot both proceed', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req(), props(ESC_REVIEW))

    const close = escWrites(db).find((w) => w.method === 'update')
    expect(close.filters['is:released_at']).toBeNull()
  })

  it('a tick that loses the close CAS writes nothing further', async () => {
    const db = makeDb({ closeGranted: false })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props(ESC_REVIEW))
    expect(await res.json()).toMatchObject({ success: true, data: { alreadyActioned: true, suppressed: false } })
    expect(escWrites(db).some((w) => w.method === 'insert')).toBe(false)
    expect(contactWrites(db)).toEqual([])
  })
})

describe('POST …/[id]/suppress — refuses anything but an open review row', () => {
  it('refuses a row that is already a suppression', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props(ESC_SUPPRESS))
    expect(res.status).toBe(400)
    expect(db.writes).toEqual([])
  })

  it('reports an already-released row instead of opening a second one', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props(ESC_DONE))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: { alreadyActioned: true, suppressed: false } })
    expect(db.writes).toEqual([])
  })
})
