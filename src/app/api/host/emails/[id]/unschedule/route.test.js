// src/app/api/host/emails/[id]/unschedule/route.test.js
// HOST-SCHEDULE.1 — POST /api/host/emails/[id]/unschedule: CAS scheduled →
// draft, scheduled_for cleared. Host session + .eq('host_id'). 409 when the
// campaign is no longer scheduled (it fired, or was never scheduled).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'

function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? {})
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
  }
  return { db, statements }
}
const op = (state, method) => state.ops.find((o) => o.method === method)
const hasEq = (state, col, val) => state.ops.some((o) => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

const props = { params: Promise.resolve({ id: CAMPAIGN_ID }) }
const req = () => new Request(`http://localhost/api/host/emails/${CAMPAIGN_ID}/unschedule`, { method: 'POST' })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
})

describe('POST /api/host/emails/[id]/unschedule', () => {
  it('401s without a host session', async () => {
    getCurrentHost.mockResolvedValue(null)
    expect((await POST(req(), props)).status).toBe(401)
  })

  it('CAS scheduled → draft with scheduled_for cleared, scoped to the host', async () => {
    const { db, statements } = makeDb(() => ({ data: [{ id: CAMPAIGN_ID, status: 'draft', scheduled_for: null }], error: null }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data.status).toBe('draft')
    const cas = statements[0]
    expect(cas.table).toBe('host_campaigns')
    expect(op(cas, 'update').args[0]).toEqual({ status: 'draft', scheduled_for: null })
    expect(hasEq(cas, 'id', CAMPAIGN_ID)).toBe(true)
    expect(hasEq(cas, 'host_id', HOST_ID)).toBe(true)
    expect(hasEq(cas, 'status', 'scheduled')).toBe(true)
  })

  it('409s when nothing matched (already fired, not scheduled, or not this host\'s)', async () => {
    const { db } = makeDb(() => ({ data: [], error: null }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This email is no longer scheduled.')
  })

  it('500s with the db message on a failed update', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'kaboom' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(500)
  })
})
