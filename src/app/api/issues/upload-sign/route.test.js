// REPORT-ISSUE.3 — the upload slots this route mints must be exactly the
// ones POST /api/issues will accept. Both sides use the same pure helpers
// (buildAttachmentPath / isIssuePhotoPath / validatePhotos), so the contract
// test below is the one that matters: every path handed to a device passes
// the finalise gate for that same location.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  locationId: 'a0000000-0000-0000-0000-000000000001',
  signError: null,
}))

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => async (request, ctx) =>
    handler({
      user: { id: 'prof-1', full_name: 'Sam Staff' },
      db: {
        storage: {
          from: () => ({
            createSignedUploadUrl: async (path) =>
              h.signError
                ? { data: null, error: { message: h.signError } }
                : { data: { path, token: `token-for-${path}` }, error: null },
          }),
        },
      },
      locationId: h.locationId,
      request,
      params: ctx?.params ? await ctx.params : undefined,
    }),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { POST } from './route.js'
import { isIssuePhotoPath } from '@/lib/issues'

function req(body) {
  return { headers: { get: () => 'application/json' }, json: async () => body }
}

const jpeg = (name = 'IMG_0001.JPG', size = 2_000_000) => ({ file_name: name, size, mime: 'image/jpeg' })

beforeEach(() => {
  h.locationId = 'a0000000-0000-0000-0000-000000000001'
  h.signError = null
})

describe('POST /api/issues/upload-sign', () => {
  it('mints one slot per photo, at a path the finalise route will accept', async () => {
    const res = await POST(req({ photos: [jpeg(), jpeg('IMG_0002.JPG')] }), {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.slots).toHaveLength(2)
    for (const slot of body.slots) {
      expect(slot.token).toBe(`token-for-${slot.path}`)
      // The contract: what we hand out is what POST /api/issues honours.
      expect(isIssuePhotoPath(slot.path, h.locationId)).toBe(true)
    }
    // Both photos of one submission share the draft folder.
    const folder = (p) => p.split('/').slice(0, 2).join('/')
    expect(folder(body.slots[0].path)).toBe(folder(body.slots[1].path))
    // ...and are still distinct objects.
    expect(body.slots[0].path).not.toBe(body.slots[1].path)
  })

  it('takes the list under `files` or the older `photos` key', async () => {
    const viaFiles = await POST(req({ files: [jpeg()] }), {})
    expect((await viaFiles.json()).slots).toHaveLength(1)
    const viaPhotos = await POST(req({ photos: [jpeg()] }), {})
    expect((await viaPhotos.json()).slots).toHaveLength(1)
  })

  it('refuses when there is no active location', async () => {
    h.locationId = null
    const res = await POST(req({ photos: [jpeg()] }), {})
    expect(res.status).toBe(400)
  })

  it('refuses an empty photo list — nothing to sign', async () => {
    const res = await POST(req({ photos: [] }), {})
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('no_photos')
  })

  it('refuses a photo over the 10 MB cap before the device wastes an upload', async () => {
    const res = await POST(req({ photos: [jpeg('big.jpg', 11 * 1024 * 1024)] }), {})
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('photo_too_large')
  })

  it('refuses a type the bucket does not take', async () => {
    const res = await POST(req({ photos: [{ file_name: 'notes.pdf', size: 1000, mime: 'application/pdf' }] }), {})
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('photo_bad_type')
  })

  it('refuses a fourth photo', async () => {
    const res = await POST(req({ photos: [jpeg(), jpeg(), jpeg(), jpeg()] }), {})
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('too_many_photos')
  })

  it('refuses a body that is not JSON', async () => {
    const res = await POST({
      headers: { get: () => 'application/json' },
      json: async () => { throw new SyntaxError('bad json') },
    }, {})
    expect(res.status).toBe(400)
  })

  it('surfaces a storage failure as a 500 rather than a half-signed batch', async () => {
    h.signError = 'bucket not found'
    const res = await POST(req({ photos: [jpeg()] }), {})
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/bucket not found/)
  })
})
