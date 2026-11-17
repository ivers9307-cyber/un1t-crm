// WAATTACH.1 — POST /api/whatsapp/conversations/[id]/attachments/sign.
//
// The real permission helpers run (src/lib/auth.js, src/lib/permissions.js);
// only getCurrentUser, the service-role client and the window check are
// stubbed. Synthetic ids only (public repo).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({ isWindowOpen: vi.fn(() => true) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { isWindowOpen } from '@/lib/whatsapp'
import { WA_ATTACHMENT_TEXT, parseWaAttachmentPath } from '@/lib/wa-outbound-attachment'

const A = '00000000-0000-4000-8000-00000000000a' // the caller's active studio
const B = '00000000-0000-4000-8000-00000000000b' // the thread's studio
const C = '00000000-0000-4000-8000-00000000000c' // a studio the caller is not in
const CONV = '00000000-0000-4000-8000-0000000000c1'
const MB = 1024 * 1024

const ON = { whatsapp: true, mobile: { whatsapp: true } }
const OFF = { whatsapp: false, mobile: { whatsapp: false } }

function caller(atA, atB) {
  return {
    id: 'u1',
    role: 'staff',
    activeLocation: { id: A, features: {} },
    activeAssignment: { role: 'staff', permissions: atA },
    locations: [{ id: A, role: 'staff', features: {} }, { id: B, role: 'staff', features: {} }],
    assignmentsByLocation: { [A]: { role: 'staff', permissions: atA }, [B]: { role: 'staff', permissions: atB } },
    user: { id: 'u1' },
  }
}

function makeDb({ conversation = { id: CONV, location_id: B, window_expires_at: '2999-01-01T00:00:00Z' }, readError = null, sign = { data: { token: 'tok-1', path: 'x' }, error: null } } = {}) {
  const signSpy = vi.fn(async () => sign)
  const fromStorage = vi.fn(() => ({ createSignedUploadUrl: signSpy }))
  const select = vi.fn()
  const db = {
    from: vi.fn(() => {
      const chain = {
        select: (cols) => { select(cols); return chain },
        eq: () => chain,
        maybeSingle: async () => ({ data: readError ? null : conversation, error: readError }),
      }
      return chain
    }),
    storage: { from: fromStorage },
  }
  return { db, signSpy, fromStorage, select }
}

const req = (body) => new Request(`http://localhost/api/whatsapp/conversations/${CONV}/attachments/sign`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const props = { params: Promise.resolve({ id: CONV }) }
const PDF = { file_name: 'Timetable.pdf', mime: 'application/pdf', size: 2 * MB }

beforeEach(() => {
  vi.clearAllMocks()
  isWindowOpen.mockReturnValue(true)
})

describe('the gate is the thread studio', () => {
  it('signs a slot under the thread studio and conversation for a caller with WhatsApp there', async () => {
    getCurrentUser.mockResolvedValue(caller(OFF, ON))
    const { db, signSpy, fromStorage, select } = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req(PDF), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data).toMatchObject({ token: 'tok-1', content_type: 'application/pdf', kind: 'document' })
    expect(parseWaAttachmentPath(json.data.path, { locationId: B, conversationId: CONV })).toMatchObject({ ext: 'pdf' })
    expect(fromStorage).toHaveBeenCalledWith('whatsapp-media')
    expect(signSpy).toHaveBeenCalledWith(json.data.path)
    expect(select).toHaveBeenCalledWith('id, location_id, window_expires_at')
  })

  it('refuses a caller with WhatsApp at the active studio but not at the thread studio (403)', async () => {
    getCurrentUser.mockResolvedValue(caller(ON, OFF))
    const { db, signSpy } = makeDb()
    createServerClient.mockReturnValue(db)
    expect((await POST(req(PDF), props)).status).toBe(403)
    expect(signSpy).not.toHaveBeenCalled()
  })

  it("answers 404 for another studio's thread, and for a missing one", async () => {
    getCurrentUser.mockResolvedValue(caller(ON, ON))
    let mock = makeDb({ conversation: { id: CONV, location_id: C, window_expires_at: '2999-01-01T00:00:00Z' } })
    createServerClient.mockReturnValue(mock.db)
    expect((await POST(req(PDF), props)).status).toBe(404)
    expect(mock.signSpy).not.toHaveBeenCalled()

    mock = makeDb({ conversation: null })
    createServerClient.mockReturnValue(mock.db)
    expect((await POST(req(PDF), props)).status).toBe(404)
  })

  it('refuses a signed-out caller (401) and one with WhatsApp nowhere (403) before any read', async () => {
    const { db } = makeDb()
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req(PDF), props)).status).toBe(401)
    getCurrentUser.mockResolvedValue(caller(OFF, OFF))
    expect((await POST(req(PDF), props)).status).toBe(403)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('answers 500 when the conversation cannot be read', async () => {
    getCurrentUser.mockResolvedValue(caller(ON, ON))
    const { db } = makeDb({ readError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    expect((await POST(req(PDF), props)).status).toBe(500)
  })
})

describe('what can be signed', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue(caller(ON, ON)))

  it('refuses outside the 24-hour window, before any upload', async () => {
    isWindowOpen.mockReturnValue(false)
    const { db, signSpy } = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req(PDF), props)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ window_expired: true, error: WA_ATTACHMENT_TEXT.windowClosed })
    expect(signSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['a GIF', { file_name: 'a.gif', mime: 'image/gif', size: 100 }, WA_ATTACHMENT_TEXT.type],
    ['a video', { file_name: 'a.mp4', mime: 'video/mp4', size: 100 }, WA_ATTACHMENT_TEXT.type],
    ['a photo over 5 MB', { file_name: 'a.jpg', mime: 'image/jpeg', size: 5 * MB + 1 }, WA_ATTACHMENT_TEXT.imageTooBig],
    ['a PDF over 16 MB', { file_name: 'a.pdf', mime: 'application/pdf', size: 16 * MB + 1 }, WA_ATTACHMENT_TEXT.documentTooBig],
    ['an empty file', { file_name: 'a.png', mime: 'image/png', size: 0 }, WA_ATTACHMENT_TEXT.empty],
  ])('refuses %s with 400 and signs nothing', async (_label, body, error) => {
    const { db, signSpy } = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req(body), props)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(error)
    expect(signSpy).not.toHaveBeenCalled()
  })

  it('signs a PNG as an image slot', async () => {
    const { db } = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ file_name: 'p.png', mime: 'image/png', size: 4 * MB }), props)
    const json = await res.json()
    expect(json.data).toMatchObject({ kind: 'image', content_type: 'image/png' })
    expect(json.data.path.endsWith('.png')).toBe(true)
  })

  it('answers 500 when Storage gives no token', async () => {
    const { db } = makeDb({ sign: { data: null, error: { message: 'down' } } })
    createServerClient.mockReturnValue(db)
    expect((await POST(req(PDF), props)).status).toBe(500)
  })
})
