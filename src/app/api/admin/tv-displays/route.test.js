// MEMBERWRITESWEEP.1f — GET/POST /api/admin/tv-displays: a studio's TVs with
// what each one shows, and registering a TV. They replace the web TV admin's
// and the staff phone's direct reads and inserts on tv_displays/tv_content,
// which ran under nothing but the membership policy (any plain staff member
// could list every TV's cast token and register TVs). Gate: tv_displays, web
// OR mobile, at the studio (the upload routes' gate).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import {
  OWNER_A, STAFF_A, MOBILE_ONLY_A, LOC_A, LOC_B, TV_ID, TV_ID_2,
  makeFakeDb, writesOf, jsonRequest, display,
} from '@/lib/tv-admin.test-helpers.js'

const list = (qs) => GET(new Request(`http://test.local/api/admin/tv-displays${qs}`))
const register = (body) => POST(jsonRequest('/api/admin/tv-displays', 'POST', body))
const CONTENT = { tv_display_id: TV_ID, source_type: 'url', source_ref: 'https://example.invalid/x', label: null, template_values: null, pushed_at: '2026-09-30T10:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER_A)
  db = makeFakeDb((call) => {
    if (call.table === 'tv_displays' && call.op === 'select') return { data: [display(), display({ id: TV_ID_2, label: 'Gym floor' })], error: null }
    if (call.table === 'tv_content' && call.op === 'select') return { data: [CONTENT], error: null }
    if (call.op === 'insert') return { data: display({ id: TV_ID_2, label: 'Gym floor' }), error: null }
    return { data: null, error: null }
  })
})

describe('GET /api/admin/tv-displays', () => {
  it('lists the studio\'s TVs oldest first, each with its content or null when idle', async () => {
    const res = await list(`?location_id=${LOC_A}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((d) => [d.id, d.content?.source_type ?? null])).toEqual([[TV_ID, 'url'], [TV_ID_2, null]])
    const [tvs, contents] = db.calls
    expect(tvs).toMatchObject({ table: 'tv_displays', filters: [['eq', 'location_id', LOC_A]], order: ['created_at', { ascending: true }] })
    expect(tvs.columns).toBe('id, label, token, active, rotation, location_id, created_at')
    expect(contents).toMatchObject({ table: 'tv_content', filters: [['in', 'tv_display_id', [TV_ID, TV_ID_2]]] })
  })

  it('a studio with no TVs: an empty list, and no content read', async () => {
    db = makeFakeDb(() => ({ data: [], error: null }))
    const body = await (await list(`?location_id=${LOC_A}`)).json()
    expect(body).toEqual({ success: true, data: [] })
    expect(db.calls).toHaveLength(1)
  })

  it('no location_id: the active studio', async () => {
    await list('')
    expect(db.calls[0].filters).toEqual([['eq', 'location_id', LOC_A]])
  })

  it('a content read error is a 500, never TVs shown as idle', async () => {
    db = makeFakeDb((call) => (call.table === 'tv_content'
      ? { data: null, error: { message: 'boom' } }
      : { data: [display()], error: null }))
    expect((await list(`?location_id=${LOC_A}`)).status).toBe(500)
  })

  it('a TV read error is a 500', async () => {
    db = makeFakeDb(() => ({ data: null, error: { message: 'boom' } }))
    expect((await list(`?location_id=${LOC_A}`)).status).toBe(500)
  })

  it('401 signed out; 403 for plain staff; 404 at a studio outside theirs; nothing read', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await list(`?location_id=${LOC_A}`)).status).toBe(401)
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await list(`?location_id=${LOC_A}`)).status).toBe(403)
    getCurrentUser.mockResolvedValue(OWNER_A)
    expect((await list(`?location_id=${LOC_B}`)).status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('the phone\'s mobile toggle alone lists', async () => {
    getCurrentUser.mockResolvedValue(MOBILE_ONLY_A)
    expect((await list(`?location_id=${LOC_A}`)).status).toBe(200)
  })
})

describe('POST /api/admin/tv-displays', () => {
  it('registers a TV at the studio with a trimmed label; the token is the database\'s', async () => {
    const res = await register({ location_id: LOC_A, label: '  Gym floor  ' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ id: TV_ID_2, label: 'Gym floor', content: null })
    const [ins] = writesOf(db)
    expect(ins).toMatchObject({ table: 'tv_displays', op: 'insert', payload: { location_id: LOC_A, label: 'Gym floor' } })
  })

  it('ignores a token, id or rotation in the body', async () => {
    await register({ location_id: LOC_A, label: 'Gym floor', token: 'chosen', id: TV_ID, rotation: 90 })
    expect(writesOf(db)[0].payload).toEqual({ location_id: LOC_A, label: 'Gym floor' })
  })

  it('400 on an empty or an over-long label', async () => {
    expect((await register({ location_id: LOC_A, label: '   ' })).status).toBe(400)
    expect((await register({ location_id: LOC_A, label: 'x'.repeat(81) })).status).toBe(400)
    expect(writesOf(db)).toEqual([])
  })

  it('a label already used at the studio: 409 in words', async () => {
    db = makeFakeDb(() => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "tv_displays_location_id_label_key"' } }))
    const res = await register({ location_id: LOC_A, label: 'Lobby TV' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('A TV called "Lobby TV" is already registered here.')
  })

  it('any other insert error is a 500', async () => {
    db = makeFakeDb(() => ({ data: null, error: { message: 'boom' } }))
    expect((await register({ location_id: LOC_A, label: 'Gym floor' })).status).toBe(500)
  })

  it('403 for plain staff, 404 at another studio, 401 signed out; nothing written', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await register({ location_id: LOC_A, label: 'x' })).status).toBe(403)
    getCurrentUser.mockResolvedValue(OWNER_A)
    expect((await register({ location_id: LOC_B, label: 'x' })).status).toBe(404)
    getCurrentUser.mockResolvedValue(null)
    expect((await register({ location_id: LOC_A, label: 'x' })).status).toBe(401)
    expect(writesOf(db)).toEqual([])
  })
})
