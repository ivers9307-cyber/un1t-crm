// APPROVALSQ.1 — a quiet clear: { status:'declined', silent:true } closes a
// pending or failed request and sends nothing to anyone.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'staff-1' })) }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  createBooking: vi.fn(),
  cancelBooking: vi.fn(),
}))
vi.mock('@/lib/agent/notify', () => ({
  sendAgentThreadMessage: vi.fn(async () => ({ sent: true })),
  buildDeclineNoticeText: vi.fn(() => 'Sorry.'),
  agentConfirmationTemplates: vi.fn(async () => ({})),
}))
vi.mock('@/lib/cancellation-form/confirm', () => ({
  sendMembershipOutcomeMessage: vi.fn(async () => ({ sent: true, channel: 'email' })),
}))

import { createBooking, cancelBooking } from '@/lib/glofox'
import { sendAgentThreadMessage } from '@/lib/agent/notify'
import { sendMembershipOutcomeMessage } from '@/lib/cancellation-form/confirm'
import { PATCH } from './route.js'

const BASE = {
  id: 'r1', location_id: 'L1', kind: 'class_booking', status: 'pending',
  details: { class_name: 'ARENA' }, contact_id: 'c1', channel: 'whatsapp', conversation_id: 'c1',
}

// Records every update patch and its .eq filters. `result` is what the update
// chain resolves to.
function makeDb(row, updates, result) {
  return {
    from() {
      let patch = null
      let filters = []
      const b = {
        select: () => b,
        eq: (col, val) => { filters.push([col, val]); return b },
        update: (p) => { patch = p; filters = []; return b },
        maybeSingle: async () => {
          if (patch) {
            updates.push({ patch, filters: [...filters] })
            return result ?? { data: { id: row.id, status: patch.status, decided_at: patch.decided_at, decision_note: patch.decision_note, details: patch.details }, error: null }
          }
          return { data: row, error: null }
        },
      }
      return b
    },
  }
}

const call = (body) => PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'r1' }) })

let updates
beforeEach(() => { vi.clearAllMocks(); updates = [] })

function expectNothingSent() {
  expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  expect(createBooking).not.toHaveBeenCalled()
  expect(cancelBooking).not.toHaveBeenCalled()
  expect(sendMembershipOutcomeMessage).not.toHaveBeenCalled()
}

describe('quiet clear', () => {
  it('clears a pending request and sends nothing', async () => {
    db = makeDb(BASE, updates)
    const res = await call({ status: 'declined', silent: true, decision_note: 'duplicate' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(updates).toHaveLength(1)
    expect(updates[0].patch).toMatchObject({ status: 'declined', decided_by: 'staff-1', decision_note: 'duplicate' })
    expect(updates[0].patch.details.cleared).toEqual({ silent: true, from_status: 'pending' })
    expect(updates[0].filters).toContainEqual(['status', 'pending'])
    expect(json.customer_notified).toEqual({ sent: false, channel: null, reason: 'cleared' })
    expect(json.executed).toBeNull()
    expect(json.planned_end_date).toBeNull()
    expectNothingSent()
  })

  it('clears a failed request (any failed row, retry window not consulted)', async () => {
    const old = new Date(Date.now() - 40 * 86400000).toISOString()
    db = makeDb({ ...BASE, status: 'failed', decided_at: old }, updates)
    const res = await call({ status: 'declined', silent: true })
    expect(res.status).toBe(200)
    expect(updates[0].patch.details.cleared.from_status).toBe('failed')
    expect(updates[0].filters).toContainEqual(['status', 'failed'])
    expectNothingSent()
  })

  it('sends no email for an email-delivered cancellation', async () => {
    db = makeDb({ ...BASE, kind: 'cancellation', channel: 'email', conversation_id: null }, updates)
    const res = await call({ status: 'declined', silent: true })
    expect(res.status).toBe(200)
    expectNothingSent()
  })

  it.each(['approved', 'saved'])('refuses silent with %s', async (status) => {
    db = makeDb(BASE, updates)
    const res = await call({ status, silent: true })
    expect(res.status).toBe(400)
    expect(updates).toHaveLength(0)
  })

  it('refuses a stuck approved row', async () => {
    const stale = new Date(Date.now() - 3600000).toISOString()
    db = makeDb({ ...BASE, status: 'approved', details: { execution: { stage: 'executing', started_at: stale } } }, updates)
    const res = await call({ status: 'declined', silent: true })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Already decided')
    expect(updates).toHaveLength(0)
  })

  it.each(['declined', 'actioned'])('refuses an already %s row', async (status) => {
    db = makeDb({ ...BASE, status }, updates)
    const res = await call({ status: 'declined', silent: true })
    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })

  it('answers 409 when the claim matches no row', async () => {
    db = makeDb(BASE, updates, { data: null, error: null })
    const res = await call({ status: 'declined', silent: true })
    expect(res.status).toBe(409)
  })

  it('answers 500 when the claim write errors', async () => {
    db = makeDb(BASE, updates, { data: null, error: { message: 'boom' } })
    const res = await call({ status: 'declined', silent: true })
    expect(res.status).toBe(500)
  })

  it('a plain decline still sends the in-thread notice', async () => {
    db = {
      from() {
        let patch = null
        const b = {
          select: () => b, eq: () => b, neq: () => b, is: () => b, in: () => b, order: () => b, limit: () => b,
          update: (p) => { patch = p; return b },
          maybeSingle: async () => (patch ? { data: { id: 'r1' }, error: null } : { data: BASE, error: null }),
          single: async () => ({ data: { id: 'r1', status: 'declined', details: {} }, error: null }),
          then: (res) => res({ data: [], error: null }),
        }
        return b
      },
    }
    const res = await call({ status: 'declined' })
    expect(res.status).toBe(200)
    expect(sendAgentThreadMessage).toHaveBeenCalledTimes(1)
  })
})
