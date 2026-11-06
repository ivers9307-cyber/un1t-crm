// PIPEBUILD.1c — the sync's approval hook: onTemplateApproved fires only for an
// update whose write succeeded, whose new status is APPROVED and whose stored
// status was not. (Header of the sibling sync-error test follows.)
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
vi.mock('@/lib/sequences/template-wait', () => ({ onTemplateApproved: vi.fn(async () => ({ woken: 0, resumed: 0, leftPaused: 0 })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET } from './route.js'
import { getTemplates as getMetaTemplates } from '@/lib/whatsapp'
import { createServerClient } from '@/lib/supabase'
import { onTemplateApproved } from '@/lib/sequences/template-wait'
import { fakeTemplatesDb } from './templates-fake-db.test-helpers.js'


const META = [{ id: 'meta-1', name: 'book_first_visit', language: 'en', category: 'MARKETING', components: [], status: 'APPROVED' }]
const req = () => ({ url: 'https://crm.test/api/whatsapp/templates?location_id=loc-1&sync=true' })

// Row is stamped (on the WABA) so it is read by templateRowsOnWaba, with its stored status.
function setup(storedStatus, faults = {}) {
  const state = {
    whatsapp_templates: [{ id: 'row-1', name: 'book_first_visit', language: 'en', status: storedStatus, location_id: 'loc-1', meta_template_id: 'meta-1', business_account_id: 'WABA-SYNTH' }],
    faults,
  }
  createServerClient.mockReturnValue(fakeTemplatesDb(state))
}

beforeEach(() => {
  vi.clearAllMocks()
  getMetaTemplates.mockResolvedValue(META)
})

describe('sync approval hook', () => {
  it('calls the hook for a PENDING -> APPROVED update', async () => {
    setup('PENDING')
    await GET(req())
    expect(onTemplateApproved).toHaveBeenCalledTimes(1)
    expect(onTemplateApproved).toHaveBeenCalledWith(expect.anything(), { id: 'row-1', location_id: 'loc-1' })
  })
  it('does not call the hook for an already APPROVED row', async () => {
    setup('APPROVED')
    await GET(req())
    expect(onTemplateApproved).not.toHaveBeenCalled()
  })
  it('does not call the hook when the write fails', async () => {
    setup('PENDING', { 'whatsapp_templates:update': { message: 'permission denied' } })
    await GET(req())
    expect(onTemplateApproved).not.toHaveBeenCalled()
  })
  it('does not call the hook when Meta still says PENDING', async () => {
    setup('PENDING')
    getMetaTemplates.mockResolvedValue([{ ...META[0], status: 'PENDING' }])
    await GET(req())
    expect(onTemplateApproved).not.toHaveBeenCalled()
  })
})
