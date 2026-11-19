// OWNERDAILY.1 — the Monday radar digest no longer sends: its churn and
// arrears figures are in the owner's daily briefing. It still claims its slot
// and stamps its heartbeat, and refuses without the cron secret.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/postmark', () => ({ sendEmail: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({}) }))
vi.mock('@/lib/cron-daily-slot', () => ({
  gateDailySlot: vi.fn(async () => ({ ok: true, faulted: false, slots: new Map([['loc-1', { zone: 'Europe/Dublin' }]]), summary: {} })),
  slotTickStampable: () => true,
}))

const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { sendEmail } = await import('@/lib/postmark')
const { GET } = await import('./route.js')
const req = (auth = 'Bearer shh') => new Request('https://x.test/api/cron/churn-radar-digest', { headers: { authorization: auth } })

beforeEach(() => { vi.clearAllMocks(); process.env.CRON_SECRET = 'shh' })

describe('churn-radar-digest after OWNERDAILY.1', () => {
  it('sends nothing at its slot and still stamps', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, emails_sent: 0, merged_into: 'morning-briefing' })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('churn-radar-digest')
  })
  it('refuses without the cron secret', async () => {
    expect((await GET(req('Bearer nope'))).status).toBe(401)
  })
})
