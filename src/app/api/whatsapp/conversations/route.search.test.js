// WAMSGSEARCH.1 — GET /api/whatsapp/conversations?q= also matches message TEXT,
// at the studios where the caller holds WhatsApp only, and returns a snippet.
//
// The real permission helpers run; getCurrentUser, the service-role client and
// the two IO search helpers are stubbed (their own behaviour is pinned in
// src/lib/inbox-search-server.test.js). Synthetic ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/inbox-search-server', async (importOriginal) => ({
  ...(await importOriginal()),
  searchInboxContactIds: vi.fn(async () => []),
  searchWhatsAppMessageHits: vi.fn(async () => ({ hits: [], failed: false })),
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { searchInboxContactIds, searchWhatsAppMessageHits } from '@/lib/inbox-search-server'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const ON = { whatsapp: true, mobile: { whatsapp: true } }
const OFF = { whatsapp: false, mobile: { whatsapp: false } }
const MOBILE_ONLY = { whatsapp: false, mobile: { whatsapp: true } }

function caller(atA, atB) {
  return {
    id: 'u1',
    role: 'staff',
    activeLocation: { id: A, features: {} },
    activeAssignment: { role: 'staff', permissions: atA },
    locations: [{ id: A, role: 'staff', features: {} }, { id: B, role: 'staff', features: {} }],
    assignmentsByLocation: { [A]: { role: 'staff', permissions: atA }, [B]: { role: 'staff', permissions: atB } },
    user: { id: 'u1' },
  }
}

function makeDb(conversations) {
  const ors = []
  const ins = []
  const db = {
    from: vi.fn((table) => {
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: () => chain,
        in: (col, vals) => { if (table === 'whatsapp_conversations') ins.push([col, vals]); return chain },
        or: (s) => { ors.push(s); return chain },
        then: (resolve, reject) => Promise.resolve(
          table === 'whatsapp_conversations' ? { data: conversations.map((c) => ({ ...c })), error: null } : { data: [], error: null },
        ).then(resolve, reject),
      }
      return chain
    }),
  }
  return { db, ors, ins }
}

const get = (qs) => GET(new Request(`http://localhost/api/whatsapp/conversations?${qs}`))

beforeEach(() => vi.clearAllMocks())

describe('message text search', () => {
  it('searches message text only at studios where the caller holds WhatsApp (web or mobile)', async () => {
    getCurrentUser.mockResolvedValue(caller(ON, OFF))
    createServerClient.mockReturnValue(makeDb([]).db)
    await get('q=refund')
    expect(searchWhatsAppMessageHits).toHaveBeenCalledWith(expect.anything(), { q: 'refund', locationIds: [A] })
    // The contact lookup keeps its membership scope (unchanged).
    expect(searchInboxContactIds).toHaveBeenCalledWith(expect.anything(), { q: 'refund', locationIds: [A, B] })

    vi.clearAllMocks()
    getCurrentUser.mockResolvedValue(caller(ON, MOBILE_ONLY))
    await get('q=refund')
    expect(searchWhatsAppMessageHits).toHaveBeenCalledWith(expect.anything(), { q: 'refund', locationIds: [A, B] })
  })

  it('narrows to the one studio asked for', async () => {
    getCurrentUser.mockResolvedValue(caller(ON, ON))
    createServerClient.mockReturnValue(makeDb([]).db)
    await get(`location_id=${B}&q=refund`)
    expect(searchWhatsAppMessageHits).toHaveBeenCalledWith(expect.anything(), { q: 'refund', locationIds: [B] })
  })

  it('ORs the matched threads into the list and returns their snippet', async () => {
    getCurrentUser.mockResolvedValue(caller(ON, ON))
    searchWhatsAppMessageHits.mockResolvedValue({
      hits: [{ conversation_id: 'conv-1', snippet: '…can I get a refund…', matched_at: '2026-11-05T10:00:00Z' }],
      failed: false,
    })
    const { db, ors, ins } = makeDb([{ id: 'conv-1', location_id: A }, { id: 'conv-2', location_id: A }])
    createServerClient.mockReturnValue(db)
    const res = await get('q=refund')
    const json = await res.json()
    expect(ors[0]).toContain('id.in.(conv-1)')
    // The list itself is still scoped to the caller's studios.
    expect(ins).toContainEqual(['location_id', [A, B]])
    expect(json.conversations.find((c) => c.id === 'conv-1').search_snippet).toBe('…can I get a refund…')
    expect(json.conversations.find((c) => c.id === 'conv-2').search_snippet).toBeUndefined()
  })

  it('runs no search below two characters', async () => {
    getCurrentUser.mockResolvedValue(caller(ON, ON))
    createServerClient.mockReturnValue(makeDb([]).db)
    await get('q=r')
    expect(searchWhatsAppMessageHits).not.toHaveBeenCalled()
  })
})
