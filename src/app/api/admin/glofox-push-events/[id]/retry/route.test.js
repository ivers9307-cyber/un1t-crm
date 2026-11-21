// PASSCODEREAD.1 — a retry that creates a Glofox member gets the new
// member's initial password back from findOrCreateGlofoxMember. The Review
// tab never displays it, so it must not ride the JSON to the browser: the
// desk Create-in-Glofox button is the one place it is shown.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/glofox-push', async (importOriginal) => ({ ...(await importOriginal()), findOrCreateGlofoxMember: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'

const EVENT = { id: 'ev-1', contact_id: 'c-1', location_id: 'loc-1', source: 'manual_button', status: 'failed', reviewed_at: null }
const CONTACT = { id: 'c-1', name: 'Synth Member', email: 'synth@example.test', first_name: 'Synth', last_name: 'Member', location_id: 'loc-1', glofox_member_id: null }

function mockDb() {
  return {
    from: vi.fn((table) => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({ data: table === 'glofox_push_events' ? EVENT : CONTACT, error: null })),
        })),
      })),
      update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u-1', role: 'master' })
  createServerClient.mockReturnValue(mockDb())
})

describe('POST /api/admin/glofox-push-events/[id]/retry — no password in the response (PASSCODEREAD.1)', () => {
  for (const status of ['created', 'needs_review']) {
    it(`drops passcode from a ${status} result and keeps the rest`, async () => {
      findOrCreateGlofoxMember.mockResolvedValue({
        status, glofox_member_id: 'gx-new', passcode: 'SYNTH-PC-9', push_event_id: 'ev-2', error: null,
      })
      const res = await POST(new Request('http://x.test'), { params: Promise.resolve({ id: 'ev-1' }) })
      const body = await res.json()
      expect(JSON.stringify(body)).not.toContain('SYNTH-PC-9')
      expect(body.result).not.toHaveProperty('passcode')
      expect(body.result).toMatchObject({ status, glofox_member_id: 'gx-new', push_event_id: 'ev-2' })
      expect(body.retried_event_id).toBe('ev-1')
    })
  }
})

// ROUTEWRAP.R15 — withAuth only signs the caller in; the master check and the
// single Glofox call keep their place.
describe('POST /api/admin/glofox-push-events/[id]/retry — the gate', () => {
  const retry = () => POST(new Request('http://x.test', { method: 'POST' }), { params: Promise.resolve({ id: 'ev-1' }) })

  it('401 signed out, Glofox never called', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await retry()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalled()
  })

  it('403 "Master only" for an owner, Glofox never called', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u-2', role: 'owner', profileRole: 'staff' })
    const res = await retry()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalled()
  })

  it('a master retries once, in the original source\'s mode', async () => {
    findOrCreateGlofoxMember.mockResolvedValue({ status: 'matched', glofox_member_id: 'gx-1', error: null })
    const res = await retry()
    expect(res.status).toBe(200)
    expect(findOrCreateGlofoxMember).toHaveBeenCalledTimes(1)
    expect(findOrCreateGlofoxMember.mock.calls[0][0]).toMatchObject({ locationId: 'loc-1', source: 'manual_button', createIfMissing: true, attachTrial: true })
  })
})
