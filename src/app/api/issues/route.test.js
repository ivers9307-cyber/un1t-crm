// Route test for issue submission.
//
// Focus: the issue.submitted audit event must NOT pass the issue UUID as
// target.id — audit_events.target_profile_id has an FK to profiles, so a
// non-profile UUID there violates audit_events_target_profile_id_fkey and
// the audit row is silently dropped. The issue identity rides in
// target.resource ('issue/<id>').

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'prof-owner', full_name: 'Olive Owner', email: 'olive@un1t.ie', role: 'owner' },
  locationId: 'loc-1',
  db: {},
}))

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => async (request, ctx) =>
    handler({
      user: h.user,
      db: h.db,
      locationId: h.locationId,
      request,
      params: ctx?.params ? await ctx.params : undefined,
    }),
}))
// The pure helpers (isIssuePhotoPath, validatePhotos) run for real — they
// ARE the JSON-mode gate, so mocking them would test nothing.
vi.mock('@/lib/issues', async (importOriginal) => ({
  ...(await importOriginal()),
  insertIssueWithAttachments: vi.fn(),
  listMyIssues: vi.fn(async () => []),
  buildAttachmentPath: vi.fn(() => 'path'),
  validateSubmission: vi.fn(),
}))
vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn(async () => ({ sent: 0 })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { POST } from './route.js'
import { insertIssueWithAttachments, validateSubmission } from '@/lib/issues'
import { logAuditEvent } from '@/lib/audit'

const DESC = 'Treadmill 3 squeaks at speed'

function req() {
  return {
    formData: async () => ({ get: (k) => (k === 'description' ? DESC : null) }),
    headers: { get: () => null },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.locationId = 'loc-1'
  h.db = {}
  validateSubmission.mockReturnValue({ ok: true, normalised: { description: DESC } })
  insertIssueWithAttachments.mockResolvedValue({
    ok: true,
    issue: { id: 'issue-1', description: DESC },
    attachments: [],
  })
})

// REPORT-ISSUE.3 — JSON mode. The photos are already in the bucket (the
// device uploaded them against a signed slot from /api/issues/upload-sign),
// so the body carries paths and this route's job is to prove them.
const LOC = 'a0000000-0000-0000-0000-000000000001'
const DRAFT = '11111111-1111-1111-1111-111111111111'
const ATT = '22222222-2222-2222-2222-222222222222'
const PHOTO_PATH = `${LOC}/${DRAFT}/${ATT}-img_0001.jpg`

function jsonReq(body) {
  return {
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  }
}

/** db double: the attachment-claim lookup + the storage listing. */
function dbFor({ claimed = [], listed = [], listError = null, claimError = null } = {}) {
  return {
    from: () => ({
      select: () => ({
        in: () => ({ limit: async () => ({ data: claimed, error: claimError }) }),
      }),
    }),
    storage: {
      from: () => ({
        list: async () => ({ data: listed, error: listError }),
        remove: async () => ({ data: null, error: null }),
      }),
    },
  }
}

const storedPhoto = (size = 4096, mimetype = 'image/jpeg') => ([
  { name: `${ATT}-img_0001.jpg`, metadata: { size, mimetype } },
])

describe('POST /api/issues — JSON mode (direct-to-storage photos)', () => {
  beforeEach(() => {
    h.locationId = LOC
    h.db = dbFor({ listed: storedPhoto() })
  })

  it('accepts a text-only report with no photos', async () => {
    const res = await POST(jsonReq({ description: DESC, photos: [] }), {})
    expect(res.status).toBe(201)
    expect(insertIssueWithAttachments.mock.calls.at(-1)[1].attachments).toEqual([])
  })

  it('attaches the photo using the size + type STORAGE reports, not the ones the client claimed', async () => {
    h.db = dbFor({ listed: storedPhoto(4096, 'image/png') })
    const res = await POST(jsonReq({
      description: DESC,
      // A client is free to lie here; nothing below may read these.
      photos: [{ path: PHOTO_PATH, file_name: 'img_0001.jpg', size: 12, mime: 'image/jpeg' }],
    }), {})
    expect(res.status).toBe(201)
    expect(insertIssueWithAttachments.mock.calls.at(-1)[1].attachments).toEqual([{
      storage_path: PHOTO_PATH,
      bucket: 'issue-photos',
      size_bytes: 4096,
      mime_type: 'image/png',
    }])
  })

  it('refuses a path belonging to another studio', async () => {
    const other = 'b0000000-0000-0000-0000-000000000002'
    const res = await POST(jsonReq({
      description: DESC,
      photos: [{ path: `${other}/${DRAFT}/${ATT}-img_0001.jpg`, file_name: 'x.jpg', size: 10, mime: 'image/jpeg' }],
    }), {})
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('photo_bad_path')
    expect(insertIssueWithAttachments).not.toHaveBeenCalled()
  })

  it('refuses a path that is not an upload slot at all', async () => {
    const res = await POST(jsonReq({
      description: DESC,
      photos: [{ path: `${LOC}/../../secrets.jpg`, file_name: 'x.jpg', size: 10, mime: 'image/jpeg' }],
    }), {})
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('photo_bad_path')
  })

  it('refuses a photo another report already owns', async () => {
    h.db = dbFor({ claimed: [{ id: 'att-1' }], listed: storedPhoto() })
    const res = await POST(jsonReq({
      description: DESC,
      photos: [{ path: PHOTO_PATH, file_name: 'img_0001.jpg', size: 4096, mime: 'image/jpeg' }],
    }), {})
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('photo_already_used')
    expect(insertIssueWithAttachments).not.toHaveBeenCalled()
  })

  it('refuses the same photo attached twice', async () => {
    const twice = [1, 2].map(() => ({ path: PHOTO_PATH, file_name: 'img_0001.jpg', size: 4096, mime: 'image/jpeg' }))
    const res = await POST(jsonReq({ description: DESC, photos: twice }), {})
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('photo_duplicate')
    expect(insertIssueWithAttachments).not.toHaveBeenCalled()
  })

  it('refuses when the object never made it into the bucket', async () => {
    h.db = dbFor({ listed: [] })
    const res = await POST(jsonReq({
      description: DESC,
      photos: [{ path: PHOTO_PATH, file_name: 'img_0001.jpg', size: 4096, mime: 'image/jpeg' }],
    }), {})
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('photo_missing')
  })

  it('refuses an oversized object even when the client declared it small', async () => {
    h.db = dbFor({ listed: storedPhoto(11 * 1024 * 1024) })
    const res = await POST(jsonReq({
      description: DESC,
      photos: [{ path: PHOTO_PATH, file_name: 'img_0001.jpg', size: 2048, mime: 'image/jpeg' }],
    }), {})
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('photo_too_large')
  })

  it('refuses a stored object whose real type is not an image', async () => {
    h.db = dbFor({ listed: storedPhoto(4096, 'application/pdf') })
    const res = await POST(jsonReq({
      description: DESC,
      photos: [{ path: PHOTO_PATH, file_name: 'img_0001.jpg', size: 4096, mime: 'image/jpeg' }],
    }), {})
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('photo_bad_type')
  })

  it('rejects a fourth photo rather than silently dropping it', async () => {
    validateSubmission.mockReturnValue({ ok: false, code: 'too_many_photos', error: 'Attach at most 3 photos per issue.' })
    const four = [1, 2, 3, 4].map(() => ({ path: PHOTO_PATH, file_name: 'x.jpg', size: 10, mime: 'image/jpeg' }))
    const res = await POST(jsonReq({ description: DESC, photos: four }), {})
    expect(res.status).toBe(400)
    // The cap is applied to what reaches validation, not to what we keep.
    expect(validateSubmission.mock.calls.at(-1)[0].photos).toHaveLength(4)
  })

  it('answers 400 on a body that is not JSON at all', async () => {
    const res = await POST({
      headers: { get: () => 'application/json' },
      json: async () => { throw new SyntaxError('Unexpected end of JSON input') },
    }, {})
    expect(res.status).toBe(400)
  })
})

describe('POST /api/issues', () => {
  it('audits issue.submitted with an issue resource target and no target.id', async () => {
    const res = await POST(req(), {})
    expect(res.status).toBe(201)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'issue.submitted',
      actor: expect.objectContaining({ id: 'prof-owner' }),
      target: expect.objectContaining({ label: DESC, resource: 'issue/issue-1' }),
      locationId: 'loc-1',
    }))
    // Issue ids are NOT profiles ids — a target.id here lands in
    // audit_events.target_profile_id and violates its FK to profiles.
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })
})
