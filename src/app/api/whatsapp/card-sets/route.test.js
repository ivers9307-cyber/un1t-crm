// SETTINGSWIPE.1 — /api/whatsapp/card-sets. The PUT read locations.settings,
// discarded the error, spread `loc?.settings || {}` and BARE-wrote the whole
// column: a blip wiped every other key and still answered success:true. The
// GET answered a failed read as `sets: []`. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET, PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fakeLocationsDb, BOOM } from '@/lib/location-settings.test-helpers'
import { LOC_B, person, ownerAtTargetCases } from '../../../../../tests/helpers/owner-at-location-callers.js'

const LOC = 'a0000000-0000-4000-8000-000000000001'
// WAROLE.1 — the PUT is master/owner at the location written, so the default
// caller is an OWNER there (it was a manager, which the PUT now refuses).
const USER = person({ [LOC]: 'owner' }, LOC)
const SET = {
  id: 'b0000000-0000-4000-8000-000000000001', name: 'Intro',
  cards: [{ image_url: 'https://example.test/a.jpg', title: 'A' }, { image_url: 'https://example.test/b.jpg', title: 'B' }],
}
const get = () => new Request(`http://localhost/api/whatsapp/card-sets?location_id=${LOC}`)
const put = (sets) => new Request('http://localhost/api/whatsapp/card-sets', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: LOC, sets }),
})

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(USER) })

describe('GET — a failed read is a 500, never "no card sets"', () => {
  it('500, no sets', async () => {
    createServerClient.mockReturnValue(fakeLocationsDb({ reads: { data: null, error: BOOM } }))
    const res = await GET(get())
    expect(res.status).toBe(500)
    expect((await res.json()).sets).toBeUndefined()
  })
  it('pin: a good read lists the stored sets', async () => {
    createServerClient.mockReturnValue(fakeLocationsDb({ reads: { data: { settings: { wa_card_sets: [SET] } }, error: null } }))
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect((await res.json()).sets).toEqual([SET])
  })
})

describe('PUT — never wipes locations.settings', () => {
  it('a failed read → 500 settings_unreadable, NOTHING written', async () => {
    const db = fakeLocationsDb({ reads: { data: null, error: BOOM } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put([SET]))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('settings_unreadable')
    expect(db.writes).toEqual([])
  })
  it('a failed write → 500 (was success:true)', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: {} }, error: null }, write: { data: null, error: BOOM } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put([SET]))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
  it('pin: a good read replaces wa_card_sets and keeps every other key', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: { glofox: { branch_id: 'b1' }, wa_card_sets: [] } }, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put([SET]))
    expect(res.status).toBe(200)
    expect(db.writes[0].patch.settings).toEqual({ glofox: { branch_id: 'b1' }, wa_card_sets: [SET] })
  })
})

// WAROLE.1 — the PUT decided on membership alone, so any staff member at a
// studio could replace the card sets its staff and Mia send. It is now the
// rule of the settings page the editor lives on (and of the number routes on
// the same tab): master, or owner AT the location written. The GET stays
// membership: the inbox composer and the phone read it to SEND a set.
const REFUSAL = {
  forbidden: { status: 403, body: { success: false, error: 'Master or owner role required.' } },
  hidden: { status: 404, body: { success: false, error: 'Not found' } },
}
const putAt = (loc) => new Request('http://localhost/api/whatsapp/card-sets', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: loc, sets: [SET] }),
})

describe('PUT — WAROLE.1: master or owner AT the location written', () => {
  it.each(ownerAtTargetCases())('%s', async (_label, caller, outcome) => {
    getCurrentUser.mockResolvedValue(caller)
    const db = fakeLocationsDb({ reads: { data: { settings: {} }, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(putAt(LOC_B))
    const body = await res.json()
    if (outcome === 'pass') {
      expect(res.status).toBe(200)
      expect(db.writes).toHaveLength(1)
      expect(db.writes[0].patch.settings.wa_card_sets).toEqual([SET])
      return
    }
    expect({ status: res.status, body }).toEqual(REFUSAL[outcome])
    expect(createServerClient).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })

  it('a manager, head coach or staff member AT the location is refused (403), nothing written', async () => {
    for (const role of ['manager', 'head_coach', 'staff']) {
      getCurrentUser.mockResolvedValue(person({ [LOC_B]: role }, LOC_B))
      const db = fakeLocationsDb({ reads: { data: { settings: {} }, error: null } })
      createServerClient.mockReturnValue(db)
      const res = await PUT(putAt(LOC_B))
      expect([role, res.status, await res.json()]).toEqual([role, 403, REFUSAL.forbidden.body])
      expect(db.writes).toEqual([])
    }
  })

  it('GET is unchanged: plain staff at the location still list the sets (the composer sends them)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'staff' }, LOC_B))
    createServerClient.mockReturnValue(fakeLocationsDb({ reads: { data: { settings: { wa_card_sets: [SET] } }, error: null } }))
    const res = await GET(new Request(`http://localhost/api/whatsapp/card-sets?location_id=${LOC_B}`))
    expect(res.status).toBe(200)
    expect((await res.json()).sets).toEqual([SET])
  })
})
