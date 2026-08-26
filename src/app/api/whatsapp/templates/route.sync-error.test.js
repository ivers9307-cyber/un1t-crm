// Route test for the ?sync=true refresh contract on GET /api/whatsapp/templates.
//
// The rows this route serves are a CACHE of Meta's templates, and they are
// returned whether or not the refresh worked. Before this, the sync's only
// failure path was `catch { console.error }`, so a refresh that fetched nothing
// — or wrote nothing — was indistinguishable from a clean one, and the operator
// read months-old copy off a screen that looked healthy. `sync_error` is the
// signal; these tests pin that it cannot go quiet again.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'prof-1' })),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['loc-1']),
}))
vi.mock('@/lib/whatsapp', () => ({
  createTemplate: vi.fn(),
  getTemplates: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getTemplates as getMetaTemplates } from '@/lib/whatsapp'
import { createServerClient } from '@/lib/supabase'

const CACHED = [{ id: 'row-1', name: 'book_first_visit', status: 'APPROVED' }]
const META = [{ id: 'meta-1', name: 'book_first_visit', language: 'en', category: 'MARKETING', components: [], status: 'APPROVED' }]

// One builder per from(); which result it resolves to depends on the verbs used,
// mirroring the three shapes the route actually issues: a maybeSingle() lookup,
// an update()/insert() write, and the final select().order() list.
function makeDb({ find = { data: null, error: null }, write = { error: null }, list = { data: CACHED, error: null } } = {}) {
  return {
    from: () => {
      let mode = 'list'
      const b = {
        select: () => b,
        eq: () => b,
        in: () => b,
        order: () => b,
        update: () => { mode = 'write'; return b },
        insert: () => { mode = 'write'; return b },
        maybeSingle: async () => find,
        // A supabase builder is a THENABLE, not a Promise (see CLAUDE.md).
        then: (res, rej) => Promise.resolve(mode === 'write' ? write : list).then(res, rej),
      }
      return b
    },
  }
}

function req({ sync = true } = {}) {
  const qs = `location_id=loc-1${sync ? '&sync=true' : ''}`
  return { url: `https://crm.test/api/whatsapp/templates?${qs}` }
}

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(makeDb())
  getMetaTemplates.mockResolvedValue(META)
})

describe('GET /api/whatsapp/templates?sync=true — sync_error contract', () => {
  it('reports null when the refresh actually landed', async () => {
    const body = await (await GET(req())).json()
    expect(body.success).toBe(true)
    expect(body.sync_error).toBeNull()
    expect(body.templates).toEqual(CACHED)
  })

  it('surfaces a Meta fetch failure instead of swallowing it, and still serves the cache', async () => {
    getMetaTemplates.mockRejectedValue(new Error('Invalid OAuth access token'))

    const body = await (await GET(req())).json()

    expect(body.success).toBe(true)
    expect(body.sync_error).toBe('Invalid OAuth access token')
    // The cached rows are still returned — the point is that they are LABELLED stale,
    // not withheld.
    expect(body.templates).toEqual(CACHED)
  })

  it('reports a per-row write failure, which supabase-js returns rather than throws', async () => {
    // The case the old catch could never see: nothing throws, the loop completes,
    // and yet not one template was persisted.
    createServerClient.mockReturnValue(makeDb({ write: { error: { message: 'permission denied' } } }))

    const body = await (await GET(req())).json()

    expect(body.success).toBe(true)
    expect(body.sync_error).toBe('Refreshed from Meta, but 1 of 1 templates could not be saved.')
  })

  it('reports a failed lookup without attempting the write', async () => {
    createServerClient.mockReturnValue(makeDb({ find: { data: null, error: { message: 'timeout' } } }))

    const body = await (await GET(req())).json()

    expect(body.sync_error).toBe('Refreshed from Meta, but 1 of 1 templates could not be saved.')
  })

  it('omits the key entirely when no refresh was requested, so absent never reads as clean', async () => {
    const body = await (await GET(req({ sync: false }))).json()

    expect(body.success).toBe(true)
    expect('sync_error' in body).toBe(false)
    expect(getMetaTemplates).not.toHaveBeenCalled()
  })
})
