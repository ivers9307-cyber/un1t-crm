// AVAIL.3 — POST /api/admin/availability-move-notice: master only; a
// preview unless `send: true`; the operator may send other words.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ fake: true })) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/availability-move-notice', async (importOriginal) => ({
  ...(await importOriginal()),
  runAvailabilityMoveNotice: vi.fn(async (_db, opts) => ({ ok: true, send: !!opts.send, recipients: 4 })),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { runAvailabilityMoveNotice, AVAILABILITY_MOVE_NOTICE } = await import('@/lib/availability-move-notice')
const { POST } = await import('./route.js')

const req = (body) => ({ json: async () => body, headers: { get: () => '' } })
const MASTER = { id: 'm1', profileRole: 'master' }

beforeEach(() => { vi.clearAllMocks() })

describe('POST /api/admin/availability-move-notice', () => {
  it('401 signed out, 403 for anyone but master, before anything runs', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req({}))).status).toBe(401)
    getCurrentUser.mockResolvedValue({ id: 'o1', profileRole: 'owner' })
    expect((await POST(req({ send: true }))).status).toBe(403)
    expect(runAvailabilityMoveNotice).not.toHaveBeenCalled()
  })

  it('an empty body is a preview with the default words', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST({ json: async () => { throw new Error('no body') }, headers: { get: () => '' } })
    expect(res.status).toBe(200)
    expect(runAvailabilityMoveNotice).toHaveBeenCalledWith({ fake: true }, expect.objectContaining({
      send: false, batchId: null, title: AVAILABILITY_MOVE_NOTICE.title, body: AVAILABILITY_MOVE_NOTICE.body,
    }))
  })

  it('send: true sends, with the operator’s own words when given', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(req({ send: true, title: 'New title', body: 'New body.' }))
    expect(res.status).toBe(200)
    expect(runAvailabilityMoveNotice).toHaveBeenCalledWith({ fake: true }, expect.objectContaining({ send: true, title: 'New title', body: 'New body.' }))
  })

  it('words that break the rules are a 400 before anything runs', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(req({ send: true, title: 'Moved — see app' }))
    expect(res.status).toBe(400)
    expect(runAvailabilityMoveNotice).not.toHaveBeenCalled()
  })

  it('a failed run is a 500 with its words', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    runAvailabilityMoveNotice.mockResolvedValueOnce({ ok: false, error: 'down' })
    const res = await POST(req({ send: true }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('down')
  })
})
