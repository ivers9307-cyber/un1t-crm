// REGISTRYREAD.1b — "Import classes from Glofox" answers a failed settings
// read with 503 "couldn't read the settings", not 400 "Glofox is not
// connected for this location". The real importClassKnowledge runs; only the
// Glofox credential read is stubbed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ from: () => { throw new Error('no db read expected') } })) }))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  fetchUpcomingEvents: vi.fn(async () => { throw new Error('fetchUpcomingEvents must not be called') }),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { glofoxCredentialsForLocation, fetchUpcomingEvents } from '@/lib/glofox'
import { GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'

const MANAGER = { id: 'u-1', role: 'manager', activeLocation: { id: 'loc-1' } }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MANAGER)
})

describe('POST /api/agent/knowledge/import-classes — REGISTRYREAD.1b', () => {
  it('an unreadable settings row answers 503 with the one message', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    const res = await POST()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ success: false, error: GLOFOX_SETTINGS_UNREADABLE_MESSAGE })
    expect(fetchUpcomingEvents).not.toHaveBeenCalled()
  })

  it('a studio with no Glofox still answers 400 "not connected"', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: null })
    const res = await POST()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Glofox is not connected for this location.' })
  })
})
