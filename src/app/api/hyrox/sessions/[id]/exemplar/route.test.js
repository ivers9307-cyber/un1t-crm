// SETTINGSWIPE.1 — "star as style example" read locations.settings with the
// error discarded and wrote the WHOLE column back.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/hyrox/example-text', () => ({ sessionToExampleText: () => 'SESSION TEXT' }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fakeLocationsDb, BOOM } from '@/lib/location-settings.test-helpers'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const SID = 'c0000000-0000-4000-8000-000000000001'
const SESSION = { id: SID, location_id: LOC, week_no: 1, slot: 1, focus: null }
const call = () => POST(new Request(`http://localhost/api/hyrox/sessions/${SID}/exemplar`, { method: 'POST' }), { params: Promise.resolve({ id: SID }) })
const db = (locRead, write) => fakeLocationsDb({ reads: locRead, write, tables: { hyrox_sessions: { data: SESSION, error: null } } })

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue({ id: 'u1', role: 'head_coach', locations: [{ id: LOC }] }) })

describe('POST …/exemplar', () => {
  it('a failed settings read → 500, NOTHING written', async () => {
    const d = db({ data: null, error: BOOM })
    createServerClient.mockReturnValue(d)
    const res = await call()
    expect(res.status).toBe(500)
    expect(d.writes).toEqual([])
  })
  it('already saved → 200 added:false, nothing written', async () => {
    const d = db({ data: { settings: { hyrox: { style_examples: [{ id: `session:${SID}`, text: 't' }] } } }, error: null })
    createServerClient.mockReturnValue(d)
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ added: false, reason: 'already_saved' })
    expect(d.writes).toEqual([])
  })
  it('pin: prepends the example and keeps every other key', async () => {
    const d = db({ data: { settings: { glofox: {}, hyrox: { charter: 'C', style_examples: [] } } }, error: null })
    createServerClient.mockReturnValue(d)
    const res = await call()
    expect(res.status).toBe(200)
    const s = d.writes[0].patch.settings
    expect(s.glofox).toEqual({})
    expect(s.hyrox.charter).toBe('C')
    expect(s.hyrox.style_examples[0]).toMatchObject({ id: `session:${SID}`, source: 'generated', text: 'SESSION TEXT' })
  })
})
