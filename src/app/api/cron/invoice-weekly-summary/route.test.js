// INVWEEKLY.1 — the weekly invoices cron: the secret, the Monday slot, and
// what it sends. The counting and wording are weekly-summary.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
let db
let gate
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn(async () => ({})) }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.example.com' }))
vi.mock('@/lib/cron-daily-slot', () => ({
  gateDailySlot: vi.fn(async () => gate),
  slotFor: (slots, id) => slots.get(id),
}))

const { GET } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { sendTransactionalEmail } = await import('@/lib/postmark')
const { gateDailySlot } = await import('@/lib/cron-daily-slot')
const { logWarn } = await import('@/lib/log')

const req = (secret = 'shh') => new Request('https://x.test/api/cron/invoice-weekly-summary', { headers: { authorization: `Bearer ${secret}` } })
const slots = (...ids) => new Map(ids.map((id) => [id, { locationId: id, zone: 'Europe/Dublin' }]))
const inv = (id, location_id, over = {}) => ({ id, location_id, status: 'extracted', prepared_at: '2026-11-22T10:00:00Z', review_reasons: [], created_at: '2026-11-22T10:00:00Z', ...over })
const master = (id, email = `${id}@example.com`) => ({ id, email, role: 'master', active: true, deleted_at: null, permissions: {} })
const at = (profile_id, location_id) => ({ id: `pl-${profile_id}-${location_id}`, profile_id, location_id, role: 'owner', permissions: {} })
const seed = (over = {}) => createFakeDb({ tables: {
  locations: [{ id: A, name: 'Studio A', active: true }, { id: B, name: 'Studio B', active: true }],
  invoices_queue: [inv('a1', A), inv('a2', A, { review_reasons: ['new_supplier'] })],
  profiles: [master('m1')],
  profile_locations: [at('m1', A), at('m1', B)],
  ...over,
} })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  gate = { ok: true, faulted: false, slots: slots(A, B), summary: {} }
  db = seed()
})

describe('GET /api/cron/invoice-weekly-summary', () => {
  it('401s without the secret and does nothing', async () => {
    expect((await GET(req('wrong'))).status).toBe(401)
    expect(gateDailySlot).not.toHaveBeenCalled()
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('a tick with no Monday slot sends nothing and does not stamp', async () => {
    gate = { ok: true, faulted: false, slots: new Map(), summary: {} }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('emails the studio with invoices waiting, skips the one with none, and stamps', async () => {
    const res = await GET(req())
    const body = await res.json()
    expect(body.emails_sent).toBe(1)
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(sendTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'm1@example.com', locationId: A, tag: 'invoice-weekly-summary',
      subject: 'Invoices at Studio A: 1 ready to send, 1 need a look',
    }))
    expect(body.perLocation).toEqual(expect.arrayContaining([
      expect.objectContaining({ location_id: A, ok: true, waiting: 2, ready: 1, sent: 1 }),
      expect.objectContaining({ location_id: B, ok: true, skipped: 'nothing_waiting' }),
    ]))
    expect(stampHeartbeat).toHaveBeenCalledWith('invoice-weekly-summary')
  })

  it('only acts for a studio whose slot this tick took', async () => {
    gate = { ok: true, faulted: false, slots: slots(B), summary: {} }
    await GET(req())
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('invoices waiting with nobody to email is logged and skipped', async () => {
    db = seed({ profile_locations: [] })
    const body = await (await GET(req())).json()
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(body.perLocation).toEqual(expect.arrayContaining([expect.objectContaining({ location_id: A, skipped: 'no_recipients' })]))
    expect(logWarn).toHaveBeenCalled()
  })

  it('never emails the address an invoice came from', async () => {
    db = seed({ invoices_queue: [inv('a1', A, { sender_email: 'supplier@example.net' })] })
    await GET(req())
    expect(sendTransactionalEmail.mock.calls.map((c) => c[0].to)).toEqual(['m1@example.com'])
  })

  it('one failed send does not stop the others, and a studio where every send failed is not ok', async () => {
    db = seed({ profiles: [master('m1'), master('m2')], profile_locations: [at('m1', A), at('m2', A)] })
    sendTransactionalEmail.mockRejectedValueOnce(new Error('postmark down'))
    const body = await (await GET(req())).json()
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2)
    expect(body.emails_sent).toBe(1)
  })

  it('unreadable locations is a failed run: no email, no stamp', async () => {
    gate = { ok: false, faulted: true, slots: new Map(), summary: {} }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
