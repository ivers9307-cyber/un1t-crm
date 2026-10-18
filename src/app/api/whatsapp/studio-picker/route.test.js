// WASTUDIOPICK.1 — /api/whatsapp/studio-picker: one studio's picker settings
// (locations.settings.wa_studio_picker). Ids are synthetic.

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
import { DEFAULT_PICKER_QUESTION } from '@/lib/wa-studio-pick/config'
import { LOC_B, person } from '../../../../../tests/helpers/owner-at-location-callers.js'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const OWNER = person({ [LOC]: 'owner' }, LOC)
// WAORGNUMBER.1 — "has a number" is the link table: a row says a number is switched on here.
const ACTIVE_NUMBER = { data: [{ location_id: LOC }], error: null }
const NO_NUMBER = { data: [], error: null }

const get = (loc = LOC) => new Request(`http://localhost/api/whatsapp/studio-picker${loc ? `?location_id=${loc}` : ''}`)
const put = (body, loc = LOC) => new Request('http://localhost/api/whatsapp/studio-picker', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: loc, ...body }),
})
const dbWith = ({ settings = {}, number = ACTIVE_NUMBER, write, readsError } = {}) => {
  const db = fakeLocationsDb({
    reads: readsError ? { data: null, error: readsError } : { data: { settings }, error: null },
    tables: { location_whatsapp_numbers: number },
    ...(write ? { write } : {}),
  })
  createServerClient.mockReturnValue(db)
  return db
}

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(OWNER) })

describe('GET', () => {
  it('returns the studio’s picker settings with defaults and has_number', async () => {
    dbWith({ settings: {}, number: ACTIVE_NUMBER })
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      listed: false, label: '', keywords: [], enabled: false, question: '',
      has_number: true, default_question: DEFAULT_PICKER_QUESTION,
    })
  })

  it('returns stored settings and has_number false when the studio has no active number', async () => {
    dbWith({
      settings: { wa_studio_picker: { listed: true, label: 'Hatch Street', keywords: ['hatch'], enabled: true, question: 'Which one?' } },
      number: NO_NUMBER,
    })
    const res = await GET(get())
    expect((await res.json()).data).toEqual({
      listed: true, label: 'Hatch Street', keywords: ['hatch'], enabled: true, question: 'Which one?',
      has_number: false, default_question: DEFAULT_PICKER_QUESTION,
    })
  })

  it('a non-member gets 404 and nothing is read', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'owner' }, LOC_B))
    const res = await GET(get())
    expect(res.status).toBe(404)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('401 without a session, 400 without location_id', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get())).status).toBe(401)
    getCurrentUser.mockResolvedValue(OWNER)
    expect((await GET(get(null))).status).toBe(400)
  })

  it('a failed settings read is a 500, never defaults', async () => {
    dbWith({ readsError: BOOM })
    const res = await GET(get())
    expect(res.status).toBe(500)
    expect((await res.json()).data).toBeUndefined()
  })

  it('a failed number read is a 500, never has_number false', async () => {
    dbWith({ number: { data: null, error: BOOM } })
    const res = await GET(get())
    expect(res.status).toBe(500)
    expect((await res.json()).data).toBeUndefined()
  })
})

describe('PUT', () => {
  it('saves listed/label/keywords through mergeLocationSettings under wa_studio_picker, keeping other keys', async () => {
    const db = dbWith({ settings: { other: 1 } })
    const res = await PUT(put({ listed: true, label: 'Hatch Street', keywords: ['hatch'] }))
    expect(res.status).toBe(200)
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0].patch.settings).toEqual({
      other: 1,
      wa_studio_picker: { listed: true, label: 'Hatch Street', keywords: ['hatch'], enabled: false, question: '' },
    })
    expect((await res.json()).data).toEqual({
      listed: true, label: 'Hatch Street', keywords: ['hatch'], enabled: false, question: '',
      has_number: true, default_question: DEFAULT_PICKER_QUESTION,
    })
  })

  it('saves enabled and a trimmed question at a studio with a number', async () => {
    const db = dbWith({ settings: {} })
    const res = await PUT(put({ listed: true, label: 'Stillorgan', keywords: [], enabled: true, question: '  Which studio?  ' }))
    expect(res.status).toBe(200)
    expect(db.writes[0].patch.settings.wa_studio_picker).toEqual({
      listed: true, label: 'Stillorgan', keywords: [], enabled: true, question: 'Which studio?',
    })
  })

  it('a studio with no number saves listed/label/keywords with enabled false and no question', async () => {
    const db = dbWith({ settings: {}, number: NO_NUMBER })
    const res = await PUT(put({ listed: true, label: 'Hatch', keywords: ['h'] }))
    expect(res.status).toBe(200)
    expect(db.writes[0].patch.settings.wa_studio_picker).toEqual({
      listed: true, label: 'Hatch', keywords: ['h'], enabled: false, question: '',
    })
    expect((await res.json()).data.has_number).toBe(false)
  })

  describe('validation: nothing is written', () => {
    const bad = {
      'a label over 20 characters': { listed: true, label: 'x'.repeat(21) },
      'a question over 1024 characters': { listed: true, question: 'q'.repeat(1025) },
      '11 keywords': { listed: true, keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) },
      'a keyword over 40 characters': { listed: true, keywords: ['k'.repeat(41)] },
      'an empty keyword': { listed: true, keywords: ['   '] },
      'a missing listed flag': { label: 'Hatch' },
    }
    it.each(Object.entries(bad))('%s -> 400', async (_label, body) => {
      const db = dbWith()
      const res = await PUT(put(body))
      expect(res.status).toBe(400)
      expect(db.writes).toEqual([])
    })

    it('the boundary values (20, 1024, 10, 40) are accepted', async () => {
      const db = dbWith()
      const res = await PUT(put({
        listed: true, label: 'x'.repeat(20), question: 'q'.repeat(1024),
        enabled: true, keywords: Array.from({ length: 10 }, () => 'k'.repeat(40)),
      }))
      expect(res.status).toBe(200)
      expect(db.writes).toHaveLength(1)
    })
  })

  describe('studio with no number', () => {
    it('enabled: true -> 400 with the no-number message, nothing written', async () => {
      const db = dbWith({ number: NO_NUMBER })
      const res = await PUT(put({ listed: true, enabled: true }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('This studio has no WhatsApp number, so it cannot ask the question.')
      expect(db.writes).toEqual([])
    })

    it('a question -> 400, nothing written', async () => {
      const db = dbWith({ number: NO_NUMBER })
      const res = await PUT(put({ listed: true, question: 'Which one?' }))
      expect(res.status).toBe(400)
      expect(db.writes).toEqual([])
    })
  })

  describe('who may save', () => {
    it('a manager, head coach or staff member at the studio is refused (403), nothing written', async () => {
      for (const role of ['manager', 'head_coach', 'staff']) {
        getCurrentUser.mockResolvedValue(person({ [LOC]: role }, LOC))
        const db = dbWith()
        const res = await PUT(put({ listed: true }))
        expect([role, res.status]).toEqual([role, 403])
        expect(db.writes).toEqual([])
      }
    })

    it('someone who is not a member of the studio gets 404, and nothing is opened', async () => {
      getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'owner' }, LOC_B))
      const res = await PUT(put({ listed: true }))
      expect(res.status).toBe(404)
      expect(createServerClient).not.toHaveBeenCalled()
    })

    it('owner at the studio while another studio is active is allowed', async () => {
      getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'staff', [LOC]: 'owner' }, LOC_B))
      const db = dbWith()
      const res = await PUT(put({ listed: true }))
      expect(res.status).toBe(200)
      expect(db.writes).toHaveLength(1)
    })

    it('401 without a session', async () => {
      getCurrentUser.mockResolvedValue(null)
      expect((await PUT(put({ listed: true }))).status).toBe(401)
    })
  })

  describe('failures never claim success', () => {
    it('a failed settings read -> 500 settings_unreadable, nothing written', async () => {
      const db = dbWith({ readsError: BOOM })
      const res = await PUT(put({ listed: true }))
      expect(res.status).toBe(500)
      expect((await res.json()).code).toBe('settings_unreadable')
      expect(db.writes).toEqual([])
    })

    it('a failed settings save -> 500 settings_write_failed', async () => {
      dbWith({ write: { data: null, error: BOOM } })
      const res = await PUT(put({ listed: true }))
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.code).toBe('settings_write_failed')
    })

    it('a failed number read -> 500, nothing written', async () => {
      const db = dbWith({ number: { data: null, error: BOOM } })
      const res = await PUT(put({ listed: true }))
      expect(res.status).toBe(500)
      expect(db.writes).toEqual([])
    })
  })
})
