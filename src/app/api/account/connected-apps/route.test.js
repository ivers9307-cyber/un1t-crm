// MCP.1 — GET /api/account/connected-apps: the caller's OWN usage of each
// connected client, from mcp_tool_calls (service role, so `.eq('profile_id')`
// IS the gate). The grant list itself is read in the browser.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')
const { GET } = await import('./route.js')

const ME = { id: '10000000-0000-0000-0000-00000000000a', email: 'coach@example.test' }
const C1 = '20000000-0000-4000-8000-000000000001'
const C2 = '20000000-0000-4000-8000-000000000002'

function makeDb(resolve) {
  const db = fakeDb(resolve)
  createServerClient.mockReturnValue(db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(ME)
})

describe('GET /api/account/connected-apps', () => {
  it('401 without a session, and nothing is read', async () => {
    getCurrentUser.mockResolvedValue(null)
    const db = makeDb(() => ({ data: [], error: null }))
    const res = await GET()
    expect(res.status).toBe(401)
    expect(db.queries).toEqual([])
  })

  it("only the caller's own rows, grouped by client with last_used_at and calls_7d", async () => {
    const db = makeDb(() => ({
      data: [
        { client_id: C1, created_at: '2026-10-30T10:00:00.000Z' },
        { client_id: C1, created_at: '2026-10-31T09:30:00.000Z' },
        { client_id: C2, created_at: '2026-10-29T08:00:00.000Z' },
        { client_id: C1, created_at: '2026-10-28T08:00:00.000Z' },
        { client_id: null, created_at: '2026-10-28T08:00:00.000Z' },
      ],
      error: null,
    }))
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    const byId = Object.fromEntries(body.data.clients.map((c) => [c.client_id, c]))
    expect(byId[C1]).toEqual({ client_id: C1, last_used_at: '2026-10-31T09:30:00.000Z', calls_7d: 3 })
    expect(byId[C2]).toEqual({ client_id: C2, last_used_at: '2026-10-29T08:00:00.000Z', calls_7d: 1 })
    expect(body.data.clients).toHaveLength(2)

    const qs = queriesOf(db, 'mcp_tool_calls')
    expect(qs.length).toBeGreaterThan(0)
    for (const q of qs) {
      expect(q.eq.profile_id).toBe(ME.id)
      expect(q.columns).toBe('client_id, created_at')
      expect(q.calls.some(([op, col]) => op === 'gte' && col === 'created_at')).toBe(true)
    }
  })

  it('500 on a failed read, not an empty list', async () => {
    makeDb(() => ({ data: null, error: { message: 'boom' } }))
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
