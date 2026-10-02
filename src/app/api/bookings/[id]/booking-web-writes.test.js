// C134 WEBBOOKINGWRITES.1 — the two web booking writes, past the gate
// (the gate itself: tests/role-sweep/gates3-routes.test.js).
//   POST /api/bookings/[id]/status        { status: confirmed | completed | no_show }
//   POST /api/bookings/[id]/skip-reminder { skip_reminder: boolean }
// Every error is read; a zero-row write is not a success; a cancelled
// booking stays cancelled (cancel is one-way, the cancel modal says so).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { person, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'
import { POST as setStatus } from './status/route.js'
import { POST as setSkip } from './skip-reminder/route.js'

const BK = '33333333-3333-4333-8333-333333333333'
const req = (body) => new Request('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const props = { params: Promise.resolve({ id: BK }) }
let tables
const booking = () => tables.bookings[0]

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { bookings: true } } }, LOC_A))
  tables = { bookings: [{ id: BK, status: 'confirmed', location_id: LOC_A, skip_reminder: false }] }
  createServerClient.mockReturnValue(makeFakeDb(tables))
})

// A db whose bookings write fails (or matches nothing) after a good read.
function dbWithWrite(writeAnswer) {
  const real = makeFakeDb(tables)
  return { from: (t) => {
    const b = real.from(t)
    const update = b.update
    b.update = (p) => { update(p); b.then = (res, rej) => Promise.resolve(writeAnswer).then(res, rej); return b }
    return b
  } }
}

describe('POST /api/bookings/[id]/status', () => {
  it.each(['completed', 'no_show', 'confirmed'])('confirmed → %s: 200, written', async (to) => {
    const res = await setStatus(req({ status: to }), props)
    expect(res.status).toBe(200)
    expect(booking().status).toBe(to)
  })

  it('cancelling here is refused (400): it goes through /cancel, which notifies', async () => {
    const res = await setStatus(req({ status: 'cancelled' }), props)
    expect(res.status).toBe(400)
    expect(booking().status).toBe('confirmed')
  })

  it('a cancelled booking is not un-cancelled (409)', async () => {
    booking().status = 'cancelled'
    const res = await setStatus(req({ status: 'confirmed' }), props)
    expect(res.status).toBe(409)
    expect(booking().status).toBe('cancelled')
  })

  it('a missing booking is a 404', async () => {
    tables.bookings = []
    expect((await setStatus(req({ status: 'completed' }), props)).status).toBe(404)
  })

  it('a failed write is a 500 with an error, never a success', async () => {
    createServerClient.mockReturnValue(dbWithWrite({ data: null, error: { code: '57014', message: 'timeout' } }))
    const res = await setStatus(req({ status: 'completed' }), props)
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  it('a write that matched no row (changed underneath) is a 409', async () => {
    createServerClient.mockReturnValue(dbWithWrite({ data: [], error: null }))
    expect((await setStatus(req({ status: 'completed' }), props)).status).toBe(409)
  })

  it('a failed read is a 500, not a 404', async () => {
    createServerClient.mockReturnValue({ from: () => {
      const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: null, error: { code: '57014', message: 'timeout' } }) }
      return b
    } })
    expect((await setStatus(req({ status: 'completed' }), props)).status).toBe(500)
  })
})

describe('POST /api/bookings/[id]/skip-reminder', () => {
  it.each([true, false])('sets skip_reminder to %s', async (v) => {
    booking().skip_reminder = !v
    const res = await setSkip(req({ skip_reminder: v }), props)
    expect(res.status).toBe(200)
    expect(booking().skip_reminder).toBe(v)
  })

  it('a non-boolean is a 400', async () => {
    expect((await setSkip(req({ skip_reminder: 'yes' }), props)).status).toBe(400)
  })

  it('a failed write is a 500', async () => {
    createServerClient.mockReturnValue(dbWithWrite({ data: null, error: { code: '57014', message: 'timeout' } }))
    expect((await setSkip(req({ skip_reminder: true }), props)).status).toBe(500)
  })

  it('a write that matched no row is a 404', async () => {
    createServerClient.mockReturnValue(dbWithWrite({ data: [], error: null }))
    expect((await setSkip(req({ skip_reminder: true }), props)).status).toBe(404)
  })
})
