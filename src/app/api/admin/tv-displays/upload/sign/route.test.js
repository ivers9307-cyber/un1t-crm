// TVUPLOAD.1 (C93) — POST /api/admin/tv-displays/upload/sign mints a signed
// upload slot for a TV image. The gate (tv_displays, web OR mobile, at the
// TV's studio) is swept in tests/role-sweep/contact-messaging.test.js; this
// file pins what the route does once through it.
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
const owner = {
  id: 'u1', role: 'owner',
  activeLocation: { id: LOC, features: {} },
  locations: [{ id: LOC, role: 'owner', features: {} }],
  assignmentsByLocation: { [LOC]: { role: 'owner', permissions: {} } },
}

function storageMock({ error = null, token = 'signed-token' } = {}) {
  const createSignedUploadUrl = vi.fn(async (path) => (error ? { data: null, error } : { data: { token, path, signedUrl: 'x' }, error: null }))
  const from = vi.fn(() => ({ createSignedUploadUrl }))
  return { db: { storage: { from } }, from, createSignedUploadUrl }
}

const req = (body) => new Request('http://localhost/api/admin/tv-displays/upload/sign', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const good = { kind: 'content', location_id: LOC, file_name: 'art.PNG', mime: 'image/png', size: 2048 }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(owner)
})

describe('POST /api/admin/tv-displays/upload/sign', () => {
  it('mints a push-image slot under <location>/ in tv-content and returns path + token', async () => {
    const s = storageMock()
    createServerClient.mockReturnValue(s.db)
    const res = await POST(req(good))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.token).toBe('signed-token')
    expect(body.path).toMatch(new RegExp(`^${LOC}/[0-9a-f-]{36}\\.png$`))
    expect(s.from).toHaveBeenCalledWith('tv-content')
    expect(s.createSignedUploadUrl).toHaveBeenCalledWith(body.path)
  })

  it('a template base image goes under <location>/templates/', async () => {
    const s = storageMock()
    createServerClient.mockReturnValue(s.db)
    const body = await (await POST(req({ ...good, kind: 'template' }))).json()
    expect(body.path).toMatch(new RegExp(`^${LOC}/templates/[0-9a-f-]{36}\\.png$`))
  })

  it('no location_id: the active studio (the multipart route\'s default)', async () => {
    const s = storageMock()
    createServerClient.mockReturnValue(s.db)
    const { location_id: _drop, ...rest } = good
    const body = await (await POST(req(rest))).json()
    expect(body.path.startsWith(`${LOC}/`)).toBe(true)
  })

  it('refuses a type or size the bucket refuses, before minting anything', async () => {
    const s = storageMock()
    createServerClient.mockReturnValue(s.db)
    const heic = await POST(req({ ...good, mime: 'image/heic' }))
    expect(heic.status).toBe(400)
    expect((await heic.json()).error).toBe('File must be a PNG, JPEG, WebP, GIF or AVIF image.')
    const big = await POST(req({ ...good, size: 15 * 1024 * 1024 + 1 }))
    expect(big.status).toBe(400)
    expect((await big.json()).error).toBe('Image must be under 15MB.')
    expect(s.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('refuses a malformed body (bad kind, missing size) with the validation 400', async () => {
    createServerClient.mockReturnValue(storageMock().db)
    expect((await POST(req({ ...good, kind: 'poster' }))).status).toBe(400)
    const { size: _s, ...noSize } = good
    expect((await POST(req(noSize))).status).toBe(400)
  })

  it('a studio the caller does not belong to: 403, nothing minted', async () => {
    const s = storageMock()
    createServerClient.mockReturnValue(s.db)
    const res = await POST(req({ ...good, location_id: OTHER }))
    expect(res.status).toBe(403)
    expect(s.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('a Storage refusal is a 500 that says so', async () => {
    createServerClient.mockReturnValue(storageMock({ error: { message: 'bucket down' } }).db)
    const res = await POST(req(good))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/Could not start the upload/)
  })

  it('no session: 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(storageMock().db)
    expect((await POST(req(good))).status).toBe(401)
  })
})
