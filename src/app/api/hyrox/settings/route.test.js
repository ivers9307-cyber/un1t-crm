// SETTINGSWIPE.1 — PUT /api/hyrox/settings discarded its read error and wrote
// the WHOLE settings column (found auditing C23; not in the index row).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fakeLocationsDb, BOOM } from '@/lib/location-settings.test-helpers'
import { MAX_STORED_EXAMPLES } from '@/lib/hyrox/constants'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const put = (body) => new Request('http://localhost/api/hyrox/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: LOC, ...body }),
})

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue({ id: 'u1', role: 'head_coach', locations: [{ id: LOC }] }) })

describe('PUT /api/hyrox/settings', () => {
  it('a failed read → 500, NOTHING written', async () => {
    const db = fakeLocationsDb({ reads: { data: null, error: BOOM } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ house_style: 'Relays' }))
    expect(res.status).toBe(500)
    expect(db.writes).toEqual([])
  })
  it('pin: merges only the given hyrox sub-keys and keeps every other key', async () => {
    const db = fakeLocationsDb({ reads: { data: { settings: { glofox: {}, hyrox: { charter: 'C', style_examples: [{ text: 'x' }] } } }, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ house_style: 'Relays' }))
    expect(res.status).toBe(200)
    expect(db.writes[0].patch.settings).toEqual({ glofox: {}, hyrox: { charter: 'C', style_examples: [{ text: 'x' }], house_style: 'Relays' } })
    expect((await res.json()).data.hyrox.house_style).toBe('Relays')
  })

  // C32 HYROXSTAR.1 — "Save as style example" appends to the stored list
  // server-side, but the page's Save PUT the page's own array as a whole: a
  // star followed by a Save in the same page load silently deleted it. The
  // client now sends the ids it has SEEN; a stored example it never saw is
  // kept, one it saw and dropped is removed.
  describe('style_examples merge (C32 HYROXSTAR.1)', () => {
    const A = { id: 'a', source: 'pasted', text: 'A' }
    const B = { id: 'b', source: 'pasted', text: 'B' }
    const STAR = { id: 'session:s1', source: 'generated', text: 'STARRED' }
    const stored = (examples) => fakeLocationsDb({ reads: { data: { settings: { hyrox: { style_examples: examples } } }, error: null } })

    it('keeps a stored example the page never saw (starred after it loaded)', async () => {
      const db = stored([STAR, A])
      createServerClient.mockReturnValue(db)
      const res = await PUT(put({ style_examples: [A], known_example_ids: ['a'] }))
      expect(res.status).toBe(200)
      expect(db.writes[0].patch.settings.hyrox.style_examples).toEqual([STAR, A])
    })

    it('removes a stored example the page saw and dropped', async () => {
      const db = stored([A, B])
      createServerClient.mockReturnValue(db)
      await PUT(put({ style_examples: [A], known_example_ids: ['a', 'b'] }))
      expect(db.writes[0].patch.settings.hyrox.style_examples).toEqual([A])
    })

    it('an example the page sends wins over the stored copy (no duplicate)', async () => {
      const db = stored([STAR, A])
      createServerClient.mockReturnValue(db)
      const edited = { ...A, label: 'Edited' }
      await PUT(put({ style_examples: [STAR, edited], known_example_ids: ['session:s1', 'a'] }))
      expect(db.writes[0].patch.settings.hyrox.style_examples).toEqual([STAR, edited])
    })

    it('the merged list stays capped at MAX_STORED_EXAMPLES', async () => {
      const many = Array.from({ length: MAX_STORED_EXAMPLES }, (_, i) => ({ id: `p${i}`, source: 'pasted', text: `P${i}` }))
      const db = stored([STAR, ...many.slice(0, MAX_STORED_EXAMPLES - 1)])
      createServerClient.mockReturnValue(db)
      await PUT(put({ style_examples: many, known_example_ids: many.map((e) => e.id) }))
      const out = db.writes[0].patch.settings.hyrox.style_examples
      expect(out).toHaveLength(MAX_STORED_EXAMPLES)
      expect(out[0]).toEqual(STAR)
    })

    it('without known_example_ids (an older page) the array still replaces the stored one', async () => {
      const db = stored([STAR, A])
      createServerClient.mockReturnValue(db)
      await PUT(put({ style_examples: [A] }))
      expect(db.writes[0].patch.settings.hyrox.style_examples).toEqual([A])
    })
  })
})
