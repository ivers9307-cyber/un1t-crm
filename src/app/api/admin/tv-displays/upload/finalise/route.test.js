// TVUPLOAD.1 (C93) — POST /api/admin/tv-displays/upload/finalise confirms a
// TV image the phone uploaded against a signed slot: the path must be a slot
// minted for that studio and kind, and the size and type are read back from
// Storage (a client can claim anything). The gate is swept in
// tests/role-sweep/contact-messaging.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC = '0a000000-0000-4000-8000-000000000001'
const OTHER = '0b000000-0000-4000-8000-000000000002'
const UUID = '1c000000-0000-4000-8000-000000000003'
const PATH = `${LOC}/${UUID}.png`
const owner = {
  id: 'u1', role: 'owner',
  activeLocation: { id: LOC, features: {} },
  locations: [{ id: LOC, role: 'owner', features: {} }],
  assignmentsByLocation: { [LOC]: { role: 'owner', permissions: {} } },
}

function storageMock({ listed = [{ name: `${UUID}.png`, metadata: { size: 2048, mimetype: 'image/png' } }], listError = null } = {}) {
  const list = vi.fn(async () => (listError ? { data: null, error: listError } : { data: listed, error: null }))
  const remove = vi.fn(async () => ({ data: null, error: null }))
  const from = vi.fn(() => ({ list, remove }))
  return { db: { storage: { from } }, from, list, remove }
}

const req = (body) => new Request('http://localhost/api/admin/tv-displays/upload/finalise', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const good = { kind: 'content', location_id: LOC, path: PATH }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(owner)
})

describe('POST /api/admin/tv-displays/upload/finalise', () => {
  it('a stored image that fits: 200 with the path (what tv_content / tv_templates store)', async () => {
    const s = storageMock()
    createServerClient.mockReturnValue(s.db)
    const res = await POST(req(good))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, path: PATH })
    expect(s.from).toHaveBeenCalledWith('tv-content')
    expect(s.list).toHaveBeenCalledWith(LOC, { search: `${UUID}.png` })
    expect(s.remove).not.toHaveBeenCalled()
  })

  it('a template base image is read from <location>/templates', async () => {
    const s = storageMock()
    createServerClient.mockReturnValue(s.db)
    const res = await POST(req({ kind: 'template', location_id: LOC, path: `${LOC}/templates/${UUID}.png` }))
    expect(res.status).toBe(200)
    expect(s.list).toHaveBeenCalledWith(`${LOC}/templates`, { search: `${UUID}.png` })
  })

  it('a path that is not a slot for this studio and kind: 400, Storage never read', async () => {
    const s = storageMock()
    createServerClient.mockReturnValue(s.db)
    for (const path of [`${OTHER}/${UUID}.png`, `${LOC}/templates/${UUID}.png`, `${LOC}/../${OTHER}/${UUID}.png`, `${LOC}/x.png`]) {
      const res = await POST(req({ ...good, path }))
      expect(res.status).toBe(400)
    }
    expect(s.list).not.toHaveBeenCalled()
  })

  it('an object that never arrived: 400, try again', async () => {
    createServerClient.mockReturnValue(storageMock({ listed: [] }).db)
    const res = await POST(req(good))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/did not finish uploading/)
  })

  it('the STORED type or size breaks the rules: removed, 400 with the route\'s words', async () => {
    const s = storageMock({ listed: [{ name: `${UUID}.png`, metadata: { size: 2048, mimetype: 'image/svg+xml' } }] })
    createServerClient.mockReturnValue(s.db)
    const res = await POST(req(good))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('File must be a PNG, JPEG, WebP, GIF or AVIF image.')
    expect(s.remove).toHaveBeenCalledWith([PATH])

    const empty = storageMock({ listed: [{ name: `${UUID}.png`, metadata: { size: 0, mimetype: 'image/png' } }] })
    createServerClient.mockReturnValue(empty.db)
    expect((await POST(req(good))).status).toBe(400)
    expect(empty.remove).toHaveBeenCalledWith([PATH])
  })

  it('a failed Storage read is a 500, never "missing"', async () => {
    createServerClient.mockReturnValue(storageMock({ listError: { message: 'timeout' } }).db)
    const res = await POST(req(good))
    expect(res.status).toBe(500)
  })

  it('a studio the caller does not belong to: 403', async () => {
    const s = storageMock()
    createServerClient.mockReturnValue(s.db)
    const res = await POST(req({ ...good, location_id: OTHER, path: `${OTHER}/${UUID}.png` }))
    expect(res.status).toBe(403)
    expect(s.list).not.toHaveBeenCalled()
  })
})
