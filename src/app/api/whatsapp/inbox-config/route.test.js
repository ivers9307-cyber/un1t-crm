// INBOXFOLLOW.4 — GET /api/whatsapp/inbox-config?location_id= answers a studio's
// follow-up config (quiet hours, nudge on or off) so the phone, which reads the
// WhatsApp list straight from the database, ranks threads the way the web does.
// Gated exactly like the WhatsApp list route. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/inbox-followup-config', () => ({
  readInboxFollowupConfig: vi.fn(async () => ({ quietHours: 72, nudgeEnabled: true })),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { readInboxFollowupConfig } = await import('@/lib/inbox-followup-config')
const { GET } = await import('./route.js')

const withWhatsApp = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A)
const withoutWhatsApp = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: false } } }, LOC_A)
const get = (qs = '') => GET(new Request(`http://localhost/api/whatsapp/inbox-config${qs}`))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(withWhatsApp)
})

describe('GET /api/whatsapp/inbox-config', () => {
  it("answers the studio's config for a caller who holds the studio", async () => {
    const res = await get(`?location_id=${LOC_A}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { quietHours: 72, nudgeEnabled: true } })
    expect(readInboxFollowupConfig).toHaveBeenCalledWith(expect.anything(), LOC_A)
  })

  it('refuses a studio the caller does not hold, reading nothing', async () => {
    const res = await get(`?location_id=${LOC_B}`)
    expect(res.status).toBe(403)
    expect((await res.json()).success).toBe(false)
    expect(readInboxFollowupConfig).not.toHaveBeenCalled()
  })

  it('refuses a caller without the WhatsApp inbox permission', async () => {
    getCurrentUser.mockResolvedValue(withoutWhatsApp)
    const res = await get(`?location_id=${LOC_A}`)
    expect(res.status).toBe(403)
    expect(readInboxFollowupConfig).not.toHaveBeenCalled()
  })

  it('answers 400 when location_id is missing', async () => {
    const res = await get()
    expect(res.status).toBe(400)
    expect(readInboxFollowupConfig).not.toHaveBeenCalled()
  })

  it('signed out is the 401 withAuth gives', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get(`?location_id=${LOC_A}`)
    expect(res.status).toBe(401)
  })
})
