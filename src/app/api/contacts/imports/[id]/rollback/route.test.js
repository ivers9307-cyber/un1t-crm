// C9 — POST /api/contacts/imports/[id]/rollback: the two stamps at the end
// of the route (steps 3 and 4) used to be bare `await`s with the error
// discarded. supabase-js does NOT throw on a failed write — it resolves with
// `{ error }` — so a failed stamp was invisible: the route returned
// `success: true` while the batch sat at `status='rolling_back'` forever.
// Nothing retries a stuck batch and no surface showed it was stuck.
//
// The restores genuinely happened by that point, so a bare 500 would be a
// worse lie than the silent success: it would tell the operator nothing was
// reversed when in fact everything was. The route therefore still returns 200
// with the real counts, and reports the failure as `stamp_failed` — a list of
// which stamps did not land. The UI turns that into an instruction to run the
// rollback again (which is idempotent: the deletes/restores find nothing left
// to do and the stamps are re-attempted).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/contact-merge', () => ({ redactWhatsAppForContact: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: vi.fn(() => null),
}))

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { logError } from '@/lib/log'

const MASTER = { id: 'user-1', isMaster: true, role: 'master' }
const BATCH = { id: 'imp-1', location_id: 'loc-1', status: 'completed' }

const ERR = { message: 'could not serialize access due to concurrent update' }

// Minimal chainable stand-in for the supabase builder. Every terminal await
// resolves through resolveOp(), which is what the fixture configures.
function makeDb({
  createdContacts = [],
  updatedRows = [],
  batch = BATCH,
  rowStampError = null,
  batchStampError = null,
} = {}) {
  const calls = []
  function resolveOp(ctx) {
    calls.push(ctx)
    if (ctx.table === 'contact_imports' && ctx.op === 'select') return { data: batch, error: null }
    if (ctx.table === 'contact_imports' && ctx.op === 'update') {
      // The in-progress marker (status: 'rolling_back') is step 0, not the
      // final stamp — only the 'rolled_back' write is step 4.
      if (ctx.payload?.status === 'rolled_back') return { data: null, error: batchStampError }
      return { data: null, error: null }
    }
    if (ctx.table === 'contact_import_rows' && ctx.op === 'update') return { data: null, error: rowStampError }
    if (ctx.table === 'contact_import_rows' && ctx.op === 'select') return { data: updatedRows, error: null }
    if (ctx.table === 'contacts' && ctx.op === 'select') return { data: createdContacts, error: null }
    return { data: null, error: null }
  }
  function chain(table) {
    const ctx = { table, op: 'select', payload: null }
    const settle = () => Promise.resolve(resolveOp(ctx))
    const b = {
      select() { ctx.op = 'select'; return b },
      update(payload) { ctx.op = 'update'; ctx.payload = payload; return b },
      delete() { ctx.op = 'delete'; return b },
      eq() { return b },
      in() { return b },
      not() { return b },
      order() { return b },
      // First page returns the fixture; selectAll stops on the short page.
      range() { return b },
      single: settle,
      then: (onOk, onErr) => settle().then(onOk, onErr),
    }
    return b
  }
  return { from: (t) => chain(t), _calls: calls }
}

const props = { params: Promise.resolve({ id: 'imp-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('the happy path is unchanged', () => {
  it('reports the counts and an empty stamp_failed', async () => {
    db = makeDb({
      createdContacts: [{ id: 'c1' }],
      updatedRows: [{ id: 'r1', contact_id: 'c9', before_snapshot: { first_name: 'Ann' } }],
    })
    const res = await POST(new Request('http://localhost/x', { method: 'POST' }), props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.deleted).toBe(1)
    expect(body.data.restored).toBe(1)
    expect(body.data.failed).toBe(0)
    expect(body.data.stamp_failed).toEqual([])
  })
})

describe('a failed batch stamp is no longer silent (C9)', () => {
  it('does not claim an unqualified success when the batch stamp fails', async () => {
    db = makeDb({ createdContacts: [{ id: 'c1' }], batchStampError: ERR })
    const res = await POST(new Request('http://localhost/x', { method: 'POST' }), props)
    const body = await res.json()
    expect(body.data.stamp_failed).toContain('batch')
  })

  it('still returns 200 with the real counts — the restores genuinely happened', async () => {
    db = makeDb({
      createdContacts: [{ id: 'c1' }, { id: 'c2' }],
      updatedRows: [{ id: 'r1', contact_id: 'c9', before_snapshot: { last_name: 'Byrne' } }],
      batchStampError: ERR,
    })
    const res = await POST(new Request('http://localhost/x', { method: 'POST' }), props)
    // A bare 500 here would tell the operator nothing was reversed, which is
    // the opposite of the truth — two contacts are already deleted.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.deleted).toBe(2)
    expect(body.data.restored).toBe(1)
  })

  it('logs the stranded batch at error level so it is greppable', async () => {
    db = makeDb({ batchStampError: ERR })
    await POST(new Request('http://localhost/x', { method: 'POST' }), props)
    expect(logError).toHaveBeenCalled()
    const meta = logError.mock.calls.at(-1)[2]
    expect(JSON.stringify(meta)).toContain('imp-1')
  })
})

describe('a failed per-row stamp is no longer silent (C9)', () => {
  it('reports the row stamp separately from the batch stamp', async () => {
    db = makeDb({ rowStampError: ERR })
    const res = await POST(new Request('http://localhost/x', { method: 'POST' }), props)
    const body = await res.json()
    expect(body.data.stamp_failed).toEqual(['rows'])
  })

  it('still attempts the batch stamp after the row stamp fails', async () => {
    // The two stamps are independent: giving up on the batch stamp because
    // the row stamp failed would strand the batch for a second reason.
    db = makeDb({ rowStampError: ERR })
    await POST(new Request('http://localhost/x', { method: 'POST' }), props)
    const stamped = db._calls.some(
      (c) => c.table === 'contact_imports' && c.op === 'update' && c.payload?.status === 'rolled_back',
    )
    expect(stamped).toBe(true)
  })

  it('reports both when both stamps fail', async () => {
    db = makeDb({ rowStampError: ERR, batchStampError: ERR })
    const res = await POST(new Request('http://localhost/x', { method: 'POST' }), props)
    const body = await res.json()
    expect([...body.data.stamp_failed].sort()).toEqual(['batch', 'rows'])
  })
})
