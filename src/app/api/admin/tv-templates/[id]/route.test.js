// MEMBERWRITESWEEP.1f — GET/PUT/DELETE /api/admin/tv-templates/[id]: one TV
// template for the editors (web and phone). They replace the direct
// tv_templates read, update and delete. Gate: tv_displays, web OR mobile, at
// the TEMPLATE's own studio (not the caller's active one). A new base image
// must sit in that studio's templates folder (C118: the phone used to upload
// it at the active studio while editing another studio's template).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { GET, PUT, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { person } from '../../../../../../tests/helpers/role-sweep-callers.js'
import {
  OWNER_A, STAFF_A, LOC_A, LOC_B, TEMPLATE_ID, makeFakeDb, writesOf, jsonRequest, paramsOf, template,
} from '@/lib/tv-admin.test-helpers.js'

const get = () => GET(new Request(`http://test.local/api/admin/tv-templates/${TEMPLATE_ID}`), paramsOf(TEMPLATE_ID))
const save = (body) => PUT(jsonRequest(`/api/admin/tv-templates/${TEMPLATE_ID}`, 'PUT', body), paramsOf(TEMPLATE_ID))
const remove = () => DELETE(jsonRequest(`/api/admin/tv-templates/${TEMPLATE_ID}`, 'DELETE'), paramsOf(TEMPLATE_ID))

function tplDb(row = template(), write = (call) => ({ data: [{ ...row, ...call.payload }], error: null })) {
  return makeFakeDb((call) => (call.op === 'select' ? { data: row, error: null } : write(call)))
}
const NEW_BASE_A = `${LOC_A}/templates/2c000000-0000-4000-8000-000000000004.png`
const BODY = { name: 'Welcome board v2', base_image_path: NEW_BASE_A, zones: [{ id: 'z1' }, { id: 'z2' }] }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER_A)
  db = tplDb()
})

describe('GET /api/admin/tv-templates/[id]', () => {
  it('returns the template with its studio', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(template())
    expect(db.calls[0].columns).toBe('id, name, base_image_path, zones, location_id')
  })
  it('another studio\'s template: 404; unknown: 404; plain staff: 403', async () => {
    db = tplDb(template({ location_id: LOC_B }))
    expect((await get()).status).toBe(404)
    db = tplDb(null)
    expect((await get()).status).toBe(404)
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await get()).status).toBe(403)
  })
})

describe('PUT /api/admin/tv-templates/[id]', () => {
  it('updates name, base image and zones, stamps updated_at, narrowed to the template\'s studio', async () => {
    const res = await save({ ...BODY, created_by: 'x', location_id: LOC_B })
    expect(res.status).toBe(200)
    const [w] = writesOf(db)
    expect(w).toMatchObject({ table: 'tv_templates', op: 'update', filters: [['eq', 'id', TEMPLATE_ID], ['eq', 'location_id', LOC_A]] })
    expect(Object.keys(w.payload).sort()).toEqual(['base_image_path', 'name', 'updated_at', 'zones'])
    expect(w.payload).toMatchObject({ name: 'Welcome board v2', base_image_path: NEW_BASE_A, zones: BODY.zones })
  })

  it('C118: a new base image uploaded at ANOTHER studio is refused (400), nothing written', async () => {
    const res = await save({ ...BODY, base_image_path: `${LOC_B}/templates/2c000000-0000-4000-8000-000000000004.png` })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("The base image must be uploaded at this template's studio. Pick the image again.")
    expect(writesOf(db)).toEqual([])
  })

  it('an UNCHANGED base image is kept even if it predates the templates-folder rule', async () => {
    const legacy = `${LOC_A}/legacy-base.png`
    db = tplDb(template({ base_image_path: legacy }))
    expect((await save({ ...BODY, base_image_path: legacy })).status).toBe(200)
  })

  it('C118: an owner at both studios, active at A, edits B\'s template with an image under B: 200', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner' } }, LOC_A))
    db = tplDb(template({ location_id: LOC_B, base_image_path: `${LOC_B}/templates/old.png` }))
    const res = await save({ ...BODY, base_image_path: `${LOC_B}/templates/2c000000-0000-4000-8000-000000000004.png` })
    expect(res.status).toBe(200)
    expect(writesOf(db)[0].filters).toEqual([['eq', 'id', TEMPLATE_ID], ['eq', 'location_id', LOC_B]])
  })

  it('a name already used at the studio: 409', async () => {
    db = tplDb(template(), () => ({ data: null, error: { code: '23505', message: 'dup' } }))
    expect((await save(BODY)).status).toBe(409)
  })

  it('deleted between the read and the write: 404; an update error: 500', async () => {
    db = tplDb(template(), () => ({ data: [], error: null }))
    expect((await save(BODY)).status).toBe(404)
    db = tplDb(template(), () => ({ data: null, error: { message: 'boom' } }))
    expect((await save(BODY)).status).toBe(500)
  })

  it('400 with no name; another studio\'s template is 404 and untouched', async () => {
    expect((await save({ ...BODY, name: '' })).status).toBe(400)
    db = tplDb(template({ location_id: LOC_B }))
    expect((await save(BODY)).status).toBe(404)
    expect(writesOf(db)).toEqual([])
  })
})

describe('DELETE /api/admin/tv-templates/[id]', () => {
  it('deletes the template narrowed to its studio', async () => {
    expect((await remove()).status).toBe(200)
    expect(writesOf(db)).toEqual([expect.objectContaining({
      table: 'tv_templates', op: 'delete', filters: [['eq', 'id', TEMPLATE_ID], ['eq', 'location_id', LOC_A]],
    })])
  })
  it('a delete error is a 500; another studio\'s is 404 and untouched', async () => {
    db = tplDb(template(), () => ({ data: null, error: { message: 'boom' } }))
    expect((await remove()).status).toBe(500)
    db = tplDb(template({ location_id: LOC_B }))
    expect((await remove()).status).toBe(404)
    expect(writesOf(db)).toEqual([])
  })
})
