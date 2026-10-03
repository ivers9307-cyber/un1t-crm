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
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { setConversationalAutomation } from '@/lib/whatsapp'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { fakeLocationsDb, BOOM } from '@/lib/location-settings.test-helpers'
import { LOC_B, person, ownerAtTargetCases } from '../../../../../tests/helpers/owner-at-location-callers.js'

const LOC = 'a0000000-0000-4000-8000-000000000001'
// WAROLE.1 — the POST is master/owner at the location written, so the default
// caller is an OWNER there (it was a manager, which the POST now refuses).
const USER = person({ [LOC]: 'owner' }, LOC)
const post = () => new Request('http://localhost/api/whatsapp/conversational-automation', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ location_id: LOC, enable_welcome: true, prompts: ['Book a class'] }),
})

// The location's own number (synthetic): the openers are applied to THIS
// config, never re-resolved (which would fall back to the global env number).
const NUMBER = { source: 'db', id: 'n0000000-0000-4000-8000-000000000001', phoneNumberId: 'PNI-SYNTH', token: 'tok-synth' }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(USER)
  setConversationalAutomation.mockResolvedValue(undefined)
  getLocationWhatsAppNumberConfig.mockResolvedValue(NUMBER)
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

// WAROLE.1 — the POST decided on membership alone, so any staff member at a
// studio could change what Meta shows a customer opening a chat with the
// studio's number (the greeting event and the ice breakers). It is now the
// rule of the settings page the card lives on (and of the number routes on
// the same tab): master, or owner AT the location. A refused caller never
// reaches Meta.
const REFUSAL = {
  forbidden: { status: 403, body: { success: false, error: 'Master or owner role required.' } },
  hidden: { status: 404, body: { success: false, error: 'Not found' } },
}
const postAt = (loc) => new Request('http://localhost/api/whatsapp/conversational-automation', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ location_id: loc, enable_welcome: true, prompts: ['Book a class'] }),
})

describe('POST — WAROLE.1: master or owner AT the location', () => {
  it.each(ownerAtTargetCases())('%s', async (_label, caller, outcome) => {
    getCurrentUser.mockResolvedValue(caller)
    const db = fakeLocationsDb({ reads: { data: { settings: {} }, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await POST(postAt(LOC_B))
    const body = await res.json()
    if (outcome === 'pass') {
      expect(res.status).toBe(200)
      expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(LOC_B)
      expect(setConversationalAutomation).toHaveBeenCalledWith({ enableWelcome: true, prompts: ['Book a class'] }, { config: NUMBER })
      expect(db.writes).toHaveLength(1)
      return
    }
    expect({ status: res.status, body }).toEqual(REFUSAL[outcome])
    expect(setConversationalAutomation).not.toHaveBeenCalled()
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('a manager, head coach or staff member AT the location is refused before Meta', async () => {
    for (const role of ['manager', 'head_coach', 'staff']) {
      vi.clearAllMocks()
      getCurrentUser.mockResolvedValue(person({ [LOC_B]: role }, LOC_B))
      const res = await POST(postAt(LOC_B))
      expect([role, res.status, await res.json()]).toEqual([role, 403, REFUSAL.forbidden.body])
      expect(setConversationalAutomation).not.toHaveBeenCalled()
      expect(createServerClient).not.toHaveBeenCalled()
    }
  })
})

// WAROLE.1 (review) — setConversationalAutomation re-resolved the number from
// the location id, and getWhatsAppConfig falls back to the GLOBAL env number
// when the location has no active whatsapp_numbers row. So an owner of a
// studio with no number of its own passed the role guard and rewrote the
// openers AT META on the legacy global number (another studio's), while the
// mirror went to their own location. The route now requires the location's
// own number and hands exactly that config to Meta.
describe("POST — WAROLE.1: only the location's OWN number, never the env fallback", () => {
  it('owner at a location with no number → 409, Meta never called, nothing read or written', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(null)
    const res = await POST(post())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'No WhatsApp number is connected at this location.' })
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(LOC)
    expect(setConversationalAutomation).not.toHaveBeenCalled()
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it("owner with a number → Meta gets THAT number's config (not a location id to re-resolve)", async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: {} }, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(setConversationalAutomation).toHaveBeenCalledTimes(1)
    expect(setConversationalAutomation.mock.calls[0][1]).toEqual({ config: NUMBER })
    expect(db.writes).toHaveLength(1)
  })

  it('a failed number lookup → 500, Meta never called (never read as "no number" or as the env number)', async () => {
    getLocationWhatsAppNumberConfig.mockRejectedValue(new Error('db down'))
    const res = await POST(post())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: "Could not check this location's WhatsApp number just now." })
    expect(setConversationalAutomation).not.toHaveBeenCalled()
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('a refused caller is refused before the number lookup', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC]: 'manager' }, LOC))
    const res = await POST(post())
    expect(res.status).toBe(403)
    expect(getLocationWhatsAppNumberConfig).not.toHaveBeenCalled()
  })
})
