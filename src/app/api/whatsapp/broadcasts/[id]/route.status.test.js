// C123 GATES-4 (a) — PUT /api/whatsapp/broadcasts/[id] accepted
// status 'sending' | 'sent', which starts (or ends) a send without any of
// /send's checks (template approved, quality gate, tier budget, consent
// audience). Only /send may start sending; PUT refuses both. The web editor
// PUTs only 'draft' (unschedule), 'cancelled', or no status.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'

const BC = '11111111-1111-4111-8111-111111111111'
const put = (body) => PUT(
  new Request('http://localhost/api/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: BC }) },
)

let tables
const row = () => tables.whatsapp_broadcasts[0]
beforeEach(() => {
  tables = {
    whatsapp_broadcasts: [{ id: BC, location_id: LOC_A, status: 'draft', scheduled_at: null, name: 'Spring' }],
  }
  db = makeFakeDb(tables)
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
})

describe('PUT /api/whatsapp/broadcasts/[id] status (C123 a)', () => {
  it.each(['sending', 'sent'])("refuses status '%s' and writes nothing (main: 200, written)", async (status) => {
    const res = await put({ status, name: 'Renamed' })
    expect(res.status).toBe(400)
    expect(row().status).toBe('draft')
    expect(row().name).toBe('Spring')
  })

  it("still accepts 'cancelled' (the editor's Cancel)", async () => {
    const res = await put({ status: 'cancelled' })
    expect(res.status).toBe(200)
    expect(row().status).toBe('cancelled')
  })

  it("still accepts 'draft' with scheduled_at cleared (the editor's unschedule)", async () => {
    row().status = 'scheduled'
    row().scheduled_at = '2099-01-01T09:00:00.000Z'
    const res = await put({ status: 'draft', scheduled_at: null })
    expect(res.status).toBe(200)
    expect(row().status).toBe('draft')
    expect(row().scheduled_at).toBeNull()
  })

  it("still accepts 'scheduled' with a future time", async () => {
    const res = await put({ status: 'scheduled', scheduled_at: '2099-01-01T09:00:00.000Z' })
    expect(res.status).toBe(200)
    expect(row().status).toBe('scheduled')
  })

  it('an update with no status is unchanged', async () => {
    const res = await put({ name: 'Autumn' })
    expect(res.status).toBe(200)
    expect(row().name).toBe('Autumn')
  })
})

// C120 GATES-3 (f) — a status change is judged against the row's CURRENT
// state: 'draft' only un-schedules (no un-cancel, no reset of a sending or
// sent row); 'cancelled' stops a draft, a scheduled row or a running send
// (the editor's Cancel on a drip), never a finished or cancelled one. And the
// write is a compare-and-swap on the state it was judged against, so a cron
// flip in between is never overwritten.
describe('PUT /api/whatsapp/broadcasts/[id] status transitions (GATES-3 f)', () => {
  it.each([
    ['draft', 'draft', 200],
    ['scheduled', 'draft', 200],
    ['sending', 'draft', 409],
    ['sent', 'draft', 409],
    ['cancelled', 'draft', 409],
    ['draft', 'cancelled', 200],
    ['scheduled', 'cancelled', 200],
    ['sending', 'cancelled', 200],
    ['sent', 'cancelled', 409],
    ['cancelled', 'cancelled', 409],
  ])("from '%s' to '%s': %i", async (from, to, expected) => {
    row().status = from
    const res = await put({ status: to })
    expect(res.status).toBe(expected)
    expect(row().status).toBe(expected === 200 ? to : from)
    if (expected === 409) expect((await res.json()).error).toMatch(new RegExp(`'${from}'`))
  })

  it('a state change raced by the cron is a 409, never an overwrite', async () => {
    row().status = 'scheduled'
    row().scheduled_at = '2099-01-01T09:00:00.000Z'
    // The route reads 'scheduled'; the cron promotes it before the write lands.
    const real = db.from
    let reads = 0
    db = { from: (t) => {
      const b = real(t)
      const single = b.single
      b.single = async () => { const r = await single(); if (t === 'whatsapp_broadcasts' && ++reads === 1) row().status = 'sending'; return r }
      return b
    } }
    const res = await put({ status: 'draft', scheduled_at: null })
    expect(res.status).toBe(409)
    expect(row().status).toBe('sending')
  })

  it('a failed read of the broadcast is a 500, not a 404', async () => {
    db = { from: () => {
      const b = { select: () => b, eq: () => b, single: async () => ({ data: null, error: { code: '57014', message: 'timeout' } }) }
      return b
    } }
    const res = await put({ name: 'x' })
    expect(res.status).toBe(500)
  })
})

