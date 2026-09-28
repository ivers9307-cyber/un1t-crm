// SETTINGSWIPE.1 — POST /api/whatsapp/conversational-automation applies the
// chat openers at Meta, then mirrors them into locations.settings. The mirror
// read's error was discarded and the write was bare: a blip wiped every other
// settings key and still answered success:true.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/whatsapp', () => ({ setConversationalAutomation: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { setConversationalAutomation } from '@/lib/whatsapp'
import { fakeLocationsDb, BOOM } from '@/lib/location-settings.test-helpers'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const USER = { id: 'u1', role: 'manager', locations: [{ id: LOC }], activeLocation: { id: LOC } }
const post = () => new Request('http://localhost/api/whatsapp/conversational-automation', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ location_id: LOC, enable_welcome: true, prompts: ['Book a class'] }),
})

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(USER)
  setConversationalAutomation.mockResolvedValue(undefined)
})

describe('the mirror never wipes locations.settings', () => {
  it('a failed read after Meta applied → 500 applied_at_meta, NOTHING written', async () => {
    const db = fakeLocationsDb({ reads: { data: null, error: BOOM } })
    createServerClient.mockReturnValue(db)
    const res = await POST(post())
    expect(setConversationalAutomation).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.applied_at_meta).toBe(true)
    expect(body.error).toBe('The chat openers are live on WhatsApp, but this screen could not record them just now. Save again so it shows what is live.')
    expect(db.writes).toEqual([])
  })

  it('a failed mirror write → the same 500 (was success:true)', async () => {
    createServerClient.mockReturnValue(fakeLocationsDb({ reads: { data: { settings: {} }, error: null }, write: { data: null, error: BOOM } }))
    const res = await POST(post())
    expect(res.status).toBe(500)
    expect((await res.json()).applied_at_meta).toBe(true)
  })

  it('pin: a good read mirrors the one key and keeps the rest', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: { glofox: { branch_id: 'b1' } } }, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(db.writes[0].patch.settings).toEqual({
      glofox: { branch_id: 'b1' },
      conversational_automation: { enable_welcome: true, prompts: ['Book a class'] },
    })
  })

  it('pin: Meta refusing is still a 502 and nothing is mirrored', async () => {
    setConversationalAutomation.mockRejectedValue(new Error('meta says no'))
    const db = fakeLocationsDb({ reads: { data: { settings: {} }, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await POST(post())
    expect(res.status).toBe(502)
    expect(db.writes).toEqual([])
  })
})
