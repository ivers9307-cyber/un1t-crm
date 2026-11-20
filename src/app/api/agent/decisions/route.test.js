// FEAT-AGENT-TRACE.1 — GET /api/agent/decisions through the real withAuth
// wrapper: `whatsapp` at the active studio, rows scoped to that studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const CONV = 'c0000000-0000-4000-8000-0000000000c1'
const get = (qs = `?conversation_id=${CONV}`) => GET(new Request(`http://localhost/api/agent/decisions${qs}`))
const rows = () => [
  { id: 'a1000000-0000-4000-8000-000000000001', conversation_id: CONV, location_id: LOC_A, channel: 'whatsapp', decision: 'reply', reason: 'asked', created_at: '2026-11-20T09:00:00Z' },
  { id: 'a1000000-0000-4000-8000-000000000002', conversation_id: CONV, location_id: LOC_B, channel: 'whatsapp', decision: 'silent', reason: 'other', created_at: '2026-11-20T09:01:00Z' },
]
const withWa = (on) => person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: on } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { agent_decisions: rows() } }))
})

describe('GET /api/agent/decisions', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Forbidden" without whatsapp at the active studio', async () => {
    getCurrentUser.mockResolvedValue(withWa(false))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('reads only the active studio’s decisions for the conversation', async () => {
    getCurrentUser.mockResolvedValue(withWa(true))
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.decisions.map((d) => d.id)).toEqual(['a1000000-0000-4000-8000-000000000001'])
  })

  it('400 without a conversation_id', async () => {
    getCurrentUser.mockResolvedValue(withWa(true))
    expect((await get('')).status).toBe(400)
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(withWa(true))
    createServerClient.mockReturnValue(createFakeDb({ tables: { agent_decisions: rows() }, errors: { agent_decisions: { select: { message: 'secret detail' } } } }))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
