// CHARITY.14 — POST /api/events/[id]/video/signed-upload: gated like the hero
// route (401, 403 without races, 404 for an unknown or off-studio event), refuses
// a non-video type, and mints a signed upload under race-video/<event id>/.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), anyPerm: vi.fn(), locPerm: vi.fn(),
  race: vi.fn(), signed: vi.fn(), publicUrl: vi.fn(),
}))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user, assertLocationAccessOr404: mocks.access }))
vi.mock('@/lib/permissions', () => ({ hasPermissionAtAnyLocation: mocks.anyPerm, hasPermissionForLocation: mocks.locPerm }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      if (table !== 'race_events') throw new Error(`unexpected table ${table}`)
      return { select: () => ({ eq: () => ({ maybeSingle: mocks.race }) }) }
    },
    storage: {
      from: (bucket) => {
        if (bucket !== 'branding') throw new Error(`unexpected bucket ${bucket}`)
        return { createSignedUploadUrl: mocks.signed, getPublicUrl: mocks.publicUrl }
      },
    },
  }),
}))

import { POST } from './route'

const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const req = (body) => new Request(`http://x/api/events/${EVENT_ID}/video/signed-upload`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const call = (body, id = EVENT_ID) => POST(req(body), { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({ id: 'u1' })
  mocks.access.mockReturnValue(null)
  mocks.anyPerm.mockReturnValue(true)
  mocks.locPerm.mockReturnValue(true)
  mocks.race.mockResolvedValue({ data: { id: EVENT_ID, location_id: 'loc1' }, error: null })
  mocks.signed.mockImplementation(async (path) => ({ data: { path, token: 'tok' }, error: null }))
  mocks.publicUrl.mockImplementation((path) => ({ data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/branding/${path}` } }))
})

describe('POST /api/events/[id]/video/signed-upload', () => {
  it('401 signed out, before any read', async () => {
    mocks.user.mockResolvedValue(null)
    const r = await call({ content_type: 'video/mp4' })
    expect(r.status).toBe(401)
    expect(mocks.race).not.toHaveBeenCalled()
  })
  it('403 without the races permission anywhere', async () => {
    mocks.anyPerm.mockReturnValue(false)
    expect((await call({ content_type: 'video/mp4' })).status).toBe(403)
  })
  it('404 for an unknown event and for one at a studio the caller lacks (never 403)', async () => {
    mocks.race.mockResolvedValue({ data: null, error: null })
    expect((await call({ content_type: 'video/mp4' })).status).toBe(404)
    mocks.race.mockResolvedValue({ data: { id: EVENT_ID, location_id: 'other' }, error: null })
    mocks.access.mockReturnValue(new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 }))
    expect((await call({ content_type: 'video/mp4' })).status).toBe(404)
    expect(mocks.signed).not.toHaveBeenCalled()
  })
  it('400 for a type the bucket would refuse, before touching storage', async () => {
    const r = await call({ content_type: 'image/png' })
    expect(r.status).toBe(400)
    expect(mocks.signed).not.toHaveBeenCalled()
  })
  it('mints a signed upload under race-video/<event id>/ with the matching extension and returns the public url', async () => {
    const r = await call({ content_type: 'video/quicktime' })
    expect(r.status).toBe(200)
    const body = await r.json()
    const path = mocks.signed.mock.calls[0][0]
    expect(path).toMatch(new RegExp(`^race-video/${EVENT_ID}/[0-9a-f-]{36}\\.mov$`))
    expect(body).toEqual({ success: true, path, token: 'tok', url: `https://proj.supabase.co/storage/v1/object/public/branding/${path}` })
  })
})
