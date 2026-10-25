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
// WACONFIGFALLBACK.1 — the sync resolves the location's OWN numbers first
// (route.own-number.test.js covers a location without one). WAORGNUMBER.2: it
// walks each WABA of the numbers switched on there; this one is homed here.
vi.mock('@/lib/whatsapp-config', () => ({
  listLocationNumberConfigs: vi.fn(async () => [{ source: 'db', id: 'n1', locationId: 'loc-1', homeLocationId: 'loc-1', phoneNumberId: 'PNI-SYNTH', token: 'tok-synth', businessAccountId: 'WABA-SYNTH' }]),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET } from './route.js'
import { getTemplates as getMetaTemplates } from '@/lib/whatsapp'
import { createServerClient } from '@/lib/supabase'
import { fakeTemplatesDb } from './templates-fake-db.test-helpers.js'

const CACHED = [{ id: 'row-1', name: 'book_first_visit', status: 'APPROVED', location_id: 'loc-1', meta_template_id: 'meta-1' }]
const META = [{ id: 'meta-1', name: 'book_first_visit', language: 'en', category: 'MARKETING', components: [], status: 'APPROVED' }]

// The fake filters for real: the cached row is this studio's, saved before its
// WABA was recorded, so the sync's one Meta template updates it (by Meta's id).
let state
function makeDb(faults = {}) {
  state = { whatsapp_templates: CACHED.map((r) => ({ ...r })), faults }
  return fakeTemplatesDb(state)
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
    // The refreshed row: Meta's fields written over it, stamped with the WABA.
    expect(body.templates).toEqual([expect.objectContaining({ id: 'row-1', business_account_id: 'WABA-SYNTH', category: 'MARKETING' })])
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
    createServerClient.mockReturnValue(makeDb({ 'whatsapp_templates:update': { message: 'permission denied' } }))

    const body = await (await GET(req())).json()

    expect(body.success).toBe(true)
    expect(body.sync_error).toBe('Refreshed from Meta, but 1 of 1 templates could not be saved.')
  })

  it('reports a failed read of the saved templates without attempting a write', async () => {
    createServerClient.mockReturnValue(makeDb({ 'whatsapp_templates:select': (cols) => (cols.includes('meta_template_id') ? { message: 'timeout' } : null) }))

    const body = await (await GET(req())).json()

    expect(body.sync_error).toBe('Could not read the saved templates: timeout')
    expect(state.writes).toEqual([])
  })

  it('omits the key entirely when no refresh was requested, so absent never reads as clean', async () => {
    const body = await (await GET(req({ sync: false }))).json()

    expect(body.success).toBe(true)
    expect('sync_error' in body).toBe(false)
    expect(getMetaTemplates).not.toHaveBeenCalled()
  })
})
