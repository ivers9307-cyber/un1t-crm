// Tests for /api/sequences/[id]/graph (FLOW-GRAPH draft surface)
//
// Coverage:
//   - DELETE clears draft_graph (discard an unpublished draft) → { discarded: true }
//   - DELETE without auth → 401
//   - DELETE missing sequence → 404
//   - DELETE cross-tenant → 404 (no existence leak)
//   - DELETE surfaces a DB failure as 500
//   - GET reports has_draft / is_published (the flags the discard UI keys off)

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

// ─── IDs / fixtures ──────────────────────────────────────────────────────────

const SEQ_ID  = 'a0000000-0000-0000-0000-000000000001'
const USER_ID = 'b0000000-0000-0000-0000-000000000002'
const LOC_ID  = 'c0000000-0000-0000-0000-000000000003'

const OWNER    = { id: USER_ID, role: 'owner', locations: [{ id: LOC_ID }] }
const OUTSIDER = { id: USER_ID, role: 'owner', locations: [{ id: 'd0000000-0000-0000-0000-000000000004' }] }

const publishedGraph = {
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [{ id: 'n1', type: 'sms', config: { body: 'published' } }],
  edges: [{ from: 'trigger', to: 'n1' }],
}
const draftGraph = {
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [{ id: 'n1', type: 'sms', config: { body: 'draft edit' } }],
  edges: [{ from: 'trigger', to: 'n1' }],
}

// ─── DB mock helpers ─────────────────────────────────────────────────────────

// GET loads the full row; DELETE loads location_id then updates.
function mockDb({ row, updateError = null } = {}) {
  const updateSpy = vi.fn(() => ({
    eq: vi.fn(() => Promise.resolve({ error: updateError })),
  }))
  const db = {
    from: vi.fn((table) => {
      if (table !== 'email_sequences') throw new Error(`unexpected table: ${table}`)
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(() => Promise.resolve({ data: row ?? null, error: row ? null : { message: 'not found' } })),
          })),
        })),
        update: updateSpy,
      }
    }),
  }
  return { db, updateSpy }
}

const BASE_URL = `http://localhost/api/sequences/${SEQ_ID}/graph`
const props = { params: { id: SEQ_ID } }
const deleteReq = () => new Request(BASE_URL, { method: 'DELETE' })
const getReq = () => new Request(BASE_URL)

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER)
})

// ─── DELETE — discard an unpublished draft ───────────────────────────────────

describe('DELETE /api/sequences/[id]/graph', () => {
  it('clears draft_graph and reports the discard', async () => {
    const { db, updateSpy } = mockDb({ row: { id: SEQ_ID, location_id: LOC_ID } })
    createServerClient.mockReturnValue(db)

    const res = await DELETE(deleteReq(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ success: true, discarded: true })
    expect(updateSpy).toHaveBeenCalledWith({ draft_graph: null })
  })

  it('returns 401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const { db, updateSpy } = mockDb({ row: { id: SEQ_ID, location_id: LOC_ID } })
    createServerClient.mockReturnValue(db)

    const res = await DELETE(deleteReq(), props)
    expect(res.status).toBe(401)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('returns 404 when the sequence does not exist', async () => {
    const { db, updateSpy } = mockDb({ row: null })
    createServerClient.mockReturnValue(db)

    const res = await DELETE(deleteReq(), props)
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('returns 404 for a sequence in another tenant (no existence leak)', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    const { db, updateSpy } = mockDb({ row: { id: SEQ_ID, location_id: LOC_ID } })
    createServerClient.mockReturnValue(db)

    const res = await DELETE(deleteReq(), props)
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('surfaces a DB failure as 500', async () => {
    const { db } = mockDb({ row: { id: SEQ_ID, location_id: LOC_ID }, updateError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)

    const res = await DELETE(deleteReq(), props)
    expect(res.status).toBe(500)
  })
})

// ─── GET — the flags the discard UI keys off ─────────────────────────────────

describe('GET /api/sequences/[id]/graph — draft/published flags', () => {
  it('reports has_draft + is_published when a draft masks a published graph', async () => {
    const { db } = mockDb({ row: {
      id: SEQ_ID, location_id: LOC_ID,
      graph: publishedGraph, draft_graph: draftGraph, graph_version: 1, sequence_steps: [],
    } })
    createServerClient.mockReturnValue(db)

    const res = await GET(getReq(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.has_draft).toBe(true)
    expect(json.is_published).toBe(true)
    expect(json.graph).toEqual(draftGraph)          // editor opens the draft…
    expect(json.published_graph).toEqual(publishedGraph) // …but production is still visible
  })

  it('reports draft-only for a never-published sequence', async () => {
    const { db } = mockDb({ row: {
      id: SEQ_ID, location_id: LOC_ID,
      graph: null, draft_graph: draftGraph, graph_version: 1, sequence_steps: [],
    } })
    createServerClient.mockReturnValue(db)

    const res = await GET(getReq(), props)
    const json = await res.json()
    expect(json.has_draft).toBe(true)
    expect(json.is_published).toBe(false)
    expect(json.published_graph).toBeNull()
  })
})
