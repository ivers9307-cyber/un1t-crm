// LEAVECANCEL.1 — deciding (POST) and withdrawing (DELETE) a request to cancel
// APPROVED leave. Who decides is ROLE-based by the owner's explicit rule: an
// owner at a studio the request belongs to, or a master, never the requester,
// and never the time-off approval permission.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The decision notice runs inside after() (next/server), the SWAPNOTIFY.1
// pattern: keep the real NextResponse, run the callback at once.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, after: vi.fn((fn) => fn()) }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: vi.fn((u) => (u.locations || []).map((l) => l.id)),
    hasRoleAtLocation: real.hasRoleAtLocation,
  }
})
// Permission says YES to everyone: the gate under test must not be reading it.
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn(() => Promise.resolve()) }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { notifyUsersOnce } = await import('@/lib/push-dedup')
const { after } = await import('next/server')
const { POST, DELETE } = await import('./route.js')
const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')

const PROPS = { params: Promise.resolve({ id: 'a0000000-0000-4000-8000-00000000000e' }) }
const req = (body) => ({ json: () => Promise.resolve(body), headers: { get: () => '' } })

const at = (id, roles, profileRole = 'staff') => ({
  id, profileRole, full_name: `User ${id}`,
  locations: Object.keys(roles).map((l) => ({ id: l })), rolesByLocation: roles,
})
const OWNER = at('own', { 'loc-1': 'owner' })
const MANAGER = at('mgr-2', { 'loc-1': 'manager' })
const HEAD_COACH = at('hc', { 'loc-1': 'head_coach' })
const REQUESTER = at('me', { 'loc-1': 'manager' })
const MASTER = at('boss', {}, 'master')

const asked = (over = {}) => ({
  id: 'a0000000-0000-4000-8000-00000000000e', profile_id: 'me', location_id: 'loc-1', status: 'approved', type: 'holiday',
  start_date: '2026-06-01', end_date: '2026-06-02', total_days: 2,
  cancel_requested_at: '2026-05-19T09:00:00.000Z', cancel_requested_by: 'me', cancel_request_note: 'Trip fell through',
  cancel_decided_at: null, cancel_decided_by: null, cancel_decision: null, cancel_decision_note: null,
  ...over,
})

function buildDb({ existing, requesterLocations = ['loc-1'], matches = true, readError = null }) {
  const updateSpy = vi.fn()
  const db = fakeDb((q) => {
    if (q.table === 'time_off_requests' && q.action === 'select') return { data: readError ? null : existing, error: readError }
    if (q.table === 'time_off_requests' && q.action === 'update') {
      updateSpy(q.payload)
      return { data: matches ? [{ ...existing, ...q.payload }] : [], error: null }
    }
    if (q.table === 'profile_locations') return { data: requesterLocations.map((location_id) => ({ location_id })), error: null }
    throw new Error(`unexpected ${q.table}/${q.action}`)
  })
  return { db, updateSpy }
}

function arrange(user, opts) {
  getCurrentUser.mockResolvedValue(user)
  const built = buildDb(opts)
  createServerClient.mockReturnValue(built.db)
  return built
}

beforeEach(() => {
  createServerClient.mockReset(); getCurrentUser.mockReset(); notifyUsersOnce.mockClear(); after.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-05-20T10:00:00Z'))
})
afterEach(() => { vi.useRealTimers() })

describe('POST /api/schedule/time-off/[id]/cancel-request — deciding', () => {
  it('401 without a session; 400 on a decision it does not know', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req({ decision: 'approve' }), PROPS)).status).toBe(401)
    arrange(OWNER, { existing: asked() })
    expect((await POST(req({ decision: 'maybe' }), PROPS)).status).toBe(400)
  })

  it('an owner APPROVES: one guarded UPDATE cancels the leave and stamps the decision together', async () => {
    const { db, updateSpy } = arrange(OWNER, { existing: asked() })
    const res = await POST(req({ decision: 'approve', note: 'No problem' }), PROPS)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, cancellation: 'approved', data: { status: 'cancelled' } })

    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0][0]).toMatchObject({
      status: 'cancelled', cancel_decision: 'approved', cancel_decided_by: 'own',
      cancel_decided_at: '2026-05-20T10:00:00.000Z', cancel_decision_note: 'No problem',
    })
    // It cannot half-apply or land twice: still approved, still asked, still undecided.
    const write = queriesOf(db, 'time_off_requests', 'update')[0]
    expect(write.calls).toContainEqual(['eq', 'id', 'a0000000-0000-4000-8000-00000000000e'])
    expect(write.calls).toContainEqual(['eq', 'status', 'approved'])
    expect(write.calls).toContainEqual(['not', 'cancel_requested_at', 'is', null])
    expect(write.calls).toContainEqual(['is', 'cancel_decided_at', null])

    const [, key, recipients, notice] = notifyUsersOnce.mock.calls[0]
    expect(key).toBe('time_off_cancel_decision:a0000000-0000-4000-8000-00000000000e:2026-05-19T09:00:00.000Z:approved')
    expect(recipients).toEqual(['me'])
    expect(notice).toMatchObject({ category: 'time_off', data: { type: 'time_off_decision', request_id: 'a0000000-0000-4000-8000-00000000000e', status: 'cancelled', start_date: '2026-06-01' } })
    expect(`${notice.title} ${notice.body}`).not.toMatch(/—/)
    // Inside after(): notifyUsersOnce claims before it sends, so a promise
    // Vercel froze after the response would never tell the requester.
    expect(after).toHaveBeenCalledTimes(1)
    expect(after.mock.calls[0][0]).toBeInstanceOf(Function)
  })

  it('an owner REJECTS: the decision is stamped and the leave STAYS APPROVED', async () => {
    const { updateSpy } = arrange(OWNER, { existing: asked() })
    const res = await POST(req({ decision: 'reject', note: 'We are short that week' }), PROPS)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ cancellation: 'rejected', data: { status: 'approved' } })
    const payload = updateSpy.mock.calls[0][0]
    expect(payload).not.toHaveProperty('status')
    expect(payload).toMatchObject({ cancel_decision: 'rejected', cancel_decided_by: 'own', cancel_decision_note: 'We are short that week' })
    expect(notifyUsersOnce.mock.calls[0][3].data).toMatchObject({ status: 'approved' })
  })

  it('a master decides with no studio rows at all', async () => {
    const { updateSpy } = arrange(MASTER, { existing: asked() })
    expect((await POST(req({ decision: 'approve' }), PROPS)).status).toBe(200)
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ cancel_decided_by: 'boss' })
  })

  it('an owner at the requester\'s OTHER studio decides leave filed at the first', async () => {
    const { updateSpy } = arrange(at('own-2', { 'loc-2': 'owner' }), { existing: asked(), requesterLocations: ['loc-1', 'loc-2'] })
    expect((await POST(req({ decision: 'approve' }), PROPS)).status).toBe(200)
    expect(updateSpy).toHaveBeenCalled()
  })

  it('a manager or head coach who CAN see the request cannot decide it (403), time-off permission or not', async () => {
    for (const user of [MANAGER, HEAD_COACH]) {
      const { updateSpy } = arrange(user, { existing: asked() })
      const res = await POST(req({ decision: 'approve' }), PROPS)
      expect(res.status).toBe(403)
      expect((await res.json()).error).toMatch(/owner/i)
      expect(updateSpy).not.toHaveBeenCalled()
    }
  })

  it('the requester cannot decide their own, even as an owner', async () => {
    const { updateSpy } = arrange(at('me', { 'loc-1': 'owner' }), { existing: asked() })
    expect((await POST(req({ decision: 'approve' }), PROPS)).status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a cross-tenant id looks missing (404): an owner elsewhere, and a plain coach here', async () => {
    let built = arrange(at('own-x', { 'loc-x': 'owner' }), { existing: asked() })
    expect((await POST(req({ decision: 'approve' }), PROPS)).status).toBe(404)
    expect(built.updateSpy).not.toHaveBeenCalled()
    built = arrange(at('coach', { 'loc-1': 'staff' }), { existing: asked() })
    expect((await POST(req({ decision: 'approve' }), PROPS)).status).toBe(404)
    built = arrange(OWNER, { existing: null })
    expect((await POST(req({ decision: 'approve' }), PROPS)).status).toBe(404)
  })

  it('409 when there is no open ask: never asked, already decided, or the leave is no longer approved', async () => {
    for (const existing of [
      asked({ cancel_requested_at: null, cancel_requested_by: null }),
      asked({ cancel_decided_at: '2026-05-19T12:00:00.000Z', cancel_decided_by: 'own', cancel_decision: 'rejected' }),
      asked({ status: 'cancelled' }),
    ]) {
      const { updateSpy } = arrange(OWNER, { existing })
      expect((await POST(req({ decision: 'approve' }), PROPS)).status).toBe(409)
      expect(updateSpy).not.toHaveBeenCalled()
    }
  })

  it('409 once the leave has ended: there is nothing left to give back', async () => {
    vi.setSystemTime(new Date('2026-06-03T10:00:00Z'))
    const { updateSpy } = arrange(OWNER, { existing: asked() })
    const res = await POST(req({ decision: 'approve' }), PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/ended/)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('two owners at once: the one whose UPDATE touches no row gets a 409 and sends no notice', async () => {
    const { updateSpy } = arrange(OWNER, { existing: asked(), matches: false })
    const res = await POST(req({ decision: 'approve' }), PROPS)
    expect(res.status).toBe(409)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it('a malformed id is the same 404 as a missing one, on POST and DELETE, and nothing is read', async () => {
    for (const handler of [POST, DELETE]) {
      const { db } = arrange(OWNER, { existing: asked() })
      for (const id of ['not-a-uuid', "1' or '1'='1"]) {
        const res = await handler(req({ decision: 'approve' }), { params: Promise.resolve({ id }) })
        expect(res.status).toBe(404)
        expect((await res.json()).error).toBe('Request not found')
      }
      expect(db.queries).toHaveLength(0)
    }
  })

  it('a failed read is a 500, not a 404; a failed notice never fails the decision', async () => {
    arrange(OWNER, { existing: asked(), readError: { message: 'boom' } })
    expect((await POST(req({ decision: 'approve' }), PROPS)).status).toBe(500)
    arrange(OWNER, { existing: asked() })
    notifyUsersOnce.mockImplementationOnce(() => Promise.reject(new Error('expo down')))
    expect((await POST(req({ decision: 'approve' }), PROPS)).status).toBe(200)
  })
})

describe('DELETE /api/schedule/time-off/[id]/cancel-request — withdrawing', () => {
  it('the requester withdraws: all seven columns cleared, the leave untouched, nobody notified', async () => {
    const { db, updateSpy } = arrange(REQUESTER, { existing: asked() })
    const res = await DELETE(req(), PROPS)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, cancellation: 'withdrawn', data: { status: 'approved' } })
    const payload = updateSpy.mock.calls[0][0]
    expect(payload).not.toHaveProperty('status')
    expect(payload).toMatchObject({
      cancel_requested_at: null, cancel_requested_by: null, cancel_request_note: null,
      cancel_decided_at: null, cancel_decided_by: null, cancel_decision: null, cancel_decision_note: null,
    })
    const write = queriesOf(db, 'time_off_requests', 'update')[0]
    expect(write.calls).toContainEqual(['eq', 'profile_id', 'me'])
    expect(write.calls).toContainEqual(['eq', 'status', 'approved'])
    expect(write.calls).toContainEqual(['is', 'cancel_decided_at', null])
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it('nobody else withdraws it: 403 for someone who can see it, 404 for someone who cannot', async () => {
    let built = arrange(OWNER, { existing: asked() })
    expect((await DELETE(req(), PROPS)).status).toBe(403)
    expect(built.updateSpy).not.toHaveBeenCalled()
    built = arrange(at('own-x', { 'loc-x': 'owner' }), { existing: asked() })
    expect((await DELETE(req(), PROPS)).status).toBe(404)
  })

  it('409 when there is nothing open to withdraw, or an owner decided it a moment ago', async () => {
    let built = arrange(REQUESTER, { existing: asked({ cancel_requested_at: null, cancel_requested_by: null }) })
    expect((await DELETE(req(), PROPS)).status).toBe(409)
    expect(built.updateSpy).not.toHaveBeenCalled()
    built = arrange(REQUESTER, { existing: asked(), matches: false })
    expect((await DELETE(req(), PROPS)).status).toBe(409)
  })
})
