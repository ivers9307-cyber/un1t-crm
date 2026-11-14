// APPROVALSQ.5 — undo a quiet clear: { undo_clear: true } puts a request the
// caller cleared in the last two minutes back to the state it was cleared from.
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
import { UNDO_CLEAR_WINDOW_MS } from '@/lib/approvals/undo-clear'

const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const ago = (s) => new Date(NOW - s * 1000).toISOString()

function cleared(over = {}, from = 'pending', previous) {
  return {
    id: 'r1', location_id: 'L1', kind: 'class_booking', status: 'declined',
    contact_id: 'c1', channel: 'whatsapp', conversation_id: 'c1',
    decided_by: 'staff-1', decided_at: ago(30), decision_note: 'oops',
    details: {
      class_name: 'ARENA',
      cleared: { silent: true, from_status: from, ...(previous ? { previous } : {}) },
    },
    ...over,
  }
}

let updates, reads
function makeDb(row, result) {
  return {
    from() {
      let patch = null
      let filters = []
      const b = {
        select: (cols) => { if (!patch) reads.push(cols); return b },
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
const REFUSAL = 'This clear can no longer be undone.'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  updates = []; reads = []
})

function expectNothingSent() {
  expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  expect(createBooking).not.toHaveBeenCalled()
  expect(cancelBooking).not.toHaveBeenCalled()
  expect(sendMembershipOutcomeMessage).not.toHaveBeenCalled()
}

async function expectRefused(row, body = { undo_clear: true }) {
  db = makeDb(row)
  const res = await call(body)
  expect(res.status).toBe(409)
  expect((await res.json())).toEqual({ success: false, error: REFUSAL })
  expect(updates).toHaveLength(0)
  expectNothingSent()
}

describe('undo a quiet clear', () => {
  it('exports a 120 second window', () => {
    expect(UNDO_CLEAR_WINDOW_MS).toBe(120_000)
  })

  it('restores a pending request with null decider fields and no cleared key', async () => {
    const row = cleared({}, 'pending', { decided_by: null, decided_at: null, decision_note: null })
    db = makeDb(row)
    const res = await call({ undo_clear: true })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.undone).toBe(true)
    expect(json.request.status).toBe('pending')
    expect(updates).toHaveLength(1)
    const { patch, filters } = updates[0]
    expect(patch).toMatchObject({ status: 'pending', decided_by: null, decided_at: null, decision_note: null })
    expect(patch.details).toEqual({ class_name: 'ARENA' })
    expect(patch.details).not.toHaveProperty('cleared')
    expect(typeof patch.updated_at).toBe('string')
    expect(filters).toEqual([['id', 'r1'], ['status', 'declined'], ['decided_at', row.decided_at]])
    expectNothingSent()
  })

  it('restores a failed request with its previous decider fields exactly', async () => {
    const previous = { decided_by: 'staff-9', decided_at: '2026-11-10T09:00:00.000Z', decision_note: 'glofox said no' }
    db = makeDb(cleared({}, 'failed', previous))
    const res = await call({ undo_clear: true })
    expect(res.status).toBe(200)
    expect(updates[0].patch).toMatchObject({ status: 'failed', ...previous })
    expect(updates[0].patch.details).not.toHaveProperty('cleared')
    expectNothingSent()
  })

  it('restores a pending request cleared before previous was stored, with nulls', async () => {
    db = makeDb(cleared({}, 'pending'))
    const res = await call({ undo_clear: true })
    expect(res.status).toBe(200)
    expect(updates[0].patch).toMatchObject({ status: 'pending', decided_by: null, decided_at: null, decision_note: null })
  })

  it('does no other read: only the row read at the top', async () => {
    db = makeDb(cleared({}, 'pending', { decided_by: null, decided_at: null, decision_note: null }))
    await call({ undo_clear: true })
    expect(reads).toHaveLength(1)
  })

  it('accepts a clear exactly at the window edge and refuses one second past it', async () => {
    db = makeDb(cleared({ decided_at: ago(120) }, 'pending'))
    expect((await call({ undo_clear: true })).status).toBe(200)
    updates = []
    await expectRefused(cleared({ decided_at: ago(121) }, 'pending'))
  })

  it('refuses a clear by someone else', async () => {
    await expectRefused(cleared({ decided_by: 'staff-2' }))
  })

  it('refuses a normal decline (no details.cleared)', async () => {
    await expectRefused(cleared({ details: { class_name: 'ARENA' } }))
  })

  it('refuses a cleared marker that is not silent or has a bad origin', async () => {
    await expectRefused(cleared({ details: { cleared: { silent: false, from_status: 'pending' } } }))
    await expectRefused(cleared({ details: { cleared: { silent: true, from_status: 'approved' } } }))
  })

  it('refuses a failed-origin row with no previous', async () => {
    await expectRefused(cleared({}, 'failed'))
  })

  it.each(['pending', 'failed', 'approved', 'actioned'])('refuses when status is %s', async (status) => {
    await expectRefused(cleared({ status }))
  })

  it('refuses a missing or unreadable decided_at', async () => {
    await expectRefused(cleared({ decided_at: null }))
    await expectRefused(cleared({ decided_at: 'not a date' }))
  })

  it('tolerates a few seconds of clock skew into the future, not more', async () => {
    db = makeDb(cleared({ decided_at: new Date(NOW + 3000).toISOString() }, 'pending'))
    expect((await call({ undo_clear: true })).status).toBe(200)
    updates = []
    await expectRefused(cleared({ decided_at: new Date(NOW + 60_000).toISOString() }, 'pending'))
  })

  it('answers 409 when the update matches no row', async () => {
    db = makeDb(cleared({}, 'pending'), { data: null, error: null })
    const res = await call({ undo_clear: true })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(REFUSAL)
    expectNothingSent()
  })

  it('answers 500 on a write error', async () => {
    db = makeDb(cleared({}, 'pending'), { data: null, error: { message: 'boom' } })
    const res = await call({ undo_clear: true })
    expect(res.status).toBe(500)
    expectNothingSent()
  })

  it.each([
    [{ undo_clear: true, status: 'approved' }],
    [{ undo_clear: true, status: 'declined', silent: true }],
    [{ undo_clear: false }],
    [{ undo_clear: true, decision_note: 'x' }],
  ])('rejects %j with a 400 and no write', async (body) => {
    db = makeDb(cleared({}, 'pending'))
    const res = await call(body)
    expect(res.status).toBe(400)
    expect(updates).toHaveLength(0)
    expectNothingSent()
  })
})
