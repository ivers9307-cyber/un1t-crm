// MEMBERWRITESWEEP.1f — GET/POST /api/admin/tv-templates: a studio's TV
// templates, and creating one. They replace the direct tv_templates reads and
// inserts from the web TV admin and the staff phone (created_by was whatever
// the client sent). The base image must sit in the studio's templates folder,
// where the upload routes put it.

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
  OWNER_A, STAFF_A, LOC_A, LOC_B, TEMPLATE_ID, makeFakeDb, writesOf, jsonRequest, template,
} from '@/lib/tv-admin.test-helpers.js'

const list = (qs) => GET(new Request(`http://test.local/api/admin/tv-templates${qs}`))
const create = (body) => POST(jsonRequest('/api/admin/tv-templates', 'POST', body))
const BASE = `${LOC_A}/templates/1c000000-0000-4000-8000-000000000003.png`
const BODY = { location_id: LOC_A, name: ' Welcome board ', base_image_path: BASE, zones: [{ id: 'z1', label: 'Text' }] }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER_A)
  db = makeFakeDb((call) => (call.op === 'select'
    ? { data: [template()], error: null }
    : { data: template(), error: null }))
})

describe('GET /api/admin/tv-templates', () => {
  it('lists the studio\'s templates by name', async () => {
    const res = await list(`?location_id=${LOC_A}`)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([template()])
    expect(db.calls[0]).toMatchObject({
      table: 'tv_templates', columns: 'id, name, base_image_path, zones, location_id',
      filters: [['eq', 'location_id', LOC_A]], order: ['name', { ascending: true }],
    })
  })
  it('a read error is a 500', async () => {
    db = makeFakeDb(() => ({ data: null, error: { message: 'boom' } }))
    expect((await list(`?location_id=${LOC_A}`)).status).toBe(500)
  })
  it('403 plain staff, 404 another studio', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await list(`?location_id=${LOC_A}`)).status).toBe(403)
    getCurrentUser.mockResolvedValue(OWNER_A)
    expect((await list(`?location_id=${LOC_B}`)).status).toBe(404)
    expect(db.calls).toEqual([])
  })
})

describe('POST /api/admin/tv-templates', () => {
  it('creates the template at the studio, created by the caller (never the body\'s created_by)', async () => {
    const res = await create({ ...BODY, created_by: 'someone-else' })
    expect(res.status).toBe(200)
    expect((await res.json()).data.id).toBe(TEMPLATE_ID)
    const [w] = writesOf(db)
    expect(w).toMatchObject({ table: 'tv_templates', op: 'insert' })
    expect(w.payload).toEqual({ location_id: LOC_A, name: 'Welcome board', base_image_path: BASE, zones: BODY.zones, created_by: OWNER_A.id })
  })

  it('zones default to an empty list', async () => {
    const { zones: _z, ...noZones } = BODY
    await create(noZones)
    expect(writesOf(db)[0].payload.zones).toEqual([])
  })

  it('400 on a base image outside the studio\'s templates folder', async () => {
    for (const p of [`${LOC_B}/templates/x.png`, `${LOC_A}/x.png`, `${LOC_A}/templates/../x.png`]) {
      const res = await create({ ...BODY, base_image_path: p })
      expect(res.status, p).toBe(400)
    }
    expect(writesOf(db)).toEqual([])
  })

  it('400 with no name or no base image', async () => {
    expect((await create({ ...BODY, name: '  ' })).status).toBe(400)
    expect((await create({ ...BODY, base_image_path: '' })).status).toBe(400)
    expect(writesOf(db)).toEqual([])
  })

  it('a name already used at the studio: 409 in words', async () => {
    db = makeFakeDb(() => ({ data: null, error: { code: '23505', message: 'duplicate key' } }))
    const res = await create(BODY)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('A template called "Welcome board" already exists here.')
  })

  it('403 plain staff, 404 another studio; nothing written', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await create(BODY)).status).toBe(403)
    getCurrentUser.mockResolvedValue(OWNER_A)
    expect((await create({ ...BODY, location_id: LOC_B, base_image_path: `${LOC_B}/templates/x.png` })).status).toBe(404)
    expect(writesOf(db)).toEqual([])
  })
})
