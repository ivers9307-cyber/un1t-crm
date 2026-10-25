// REGISTRYREAD.1b — the knowledge import answers a failed Glofox settings
// read with reason glofox_settings_unreadable, not glofox_not_connected: the
// weekly sync-class-knowledge cron skips not-connected locations SILENTLY, so
// the old reason hid a blip as "this studio has no Glofox".
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  fetchUpcomingEvents: vi.fn(async () => { throw new Error('fetchUpcomingEvents must not be called') }),
}))

import { glofoxCredentialsForLocation, fetchUpcomingEvents } from '@/lib/glofox'
import { importClassKnowledge } from './knowledge-import'

const db = { from: () => { throw new Error('no db read expected') } }

beforeEach(() => vi.clearAllMocks())

describe('importClassKnowledge — REGISTRYREAD.1b', () => {
  it('an unreadable settings row is glofox_settings_unreadable and never calls Glofox', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    expect(await importClassKnowledge(db, 'loc-1')).toEqual({ ok: false, reason: 'glofox_settings_unreadable' })
    expect(fetchUpcomingEvents).not.toHaveBeenCalled()
  })

  it('a studio with no Glofox is still glofox_not_connected', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: null })
    expect(await importClassKnowledge(db, 'loc-1')).toEqual({ ok: false, reason: 'glofox_not_connected' })
  })
})
