// C21 PUSHDONE.1 — a WhatsApp health alert that reached nobody is said at
// error level and counted; `alerted` counts only alerts that reached someone.
// The state (rating, token_invalid_at) is still written: other surfaces read it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const updates = []
let numbers = []
let updateError = null
function makeBuilder(table) {
  const state = {}
  const b = {}
  for (const m of ['select', 'eq']) b[m] = () => b
  b.update = (patch) => { state.patch = patch; updates.push({ table, patch }); return b }
  b.then = (res, rej) => Promise.resolve(state.patch ? { data: null, error: updateError } : { data: numbers, error: null }).then(res, rej)
  return b
}
const fakeDb = { from: (t) => makeBuilder(t) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/whatsapp-number-events', () => ({ pauseLocationDrips: vi.fn(async () => []), dripPauseNote: vi.fn(() => '') }))
vi.mock('@/lib/whatsapp-number-health', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchNumberHealth: vi.fn(),
}))

const { GET } = await import('./route.js')
const { sendPushToRolesAtLocation } = await import('@/lib/push')
const { fetchNumberHealth } = await import('@/lib/whatsapp-number-health')
const { logWarn, logError } = await import('@/lib/log')

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const NUMBER = { id: 'n1', location_id: 'loc-1', label: 'Studio line', access_token: 'tok', phone_number_id: 'pn1', quality_rating: 'GREEN', messaging_limit_tier: null, token_invalid_at: null }

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  updates.length = 0
  updateError = null
  numbers = [NUMBER]
  fetchNumberHealth.mockResolvedValue({ quality_rating: 'YELLOW', messaging_limit_tier: null, name_status: 'APPROVED' })
})

describe('refresh-whatsapp-health — alerts that reached nobody (C21 PUSHDONE.1)', () => {
  it('a delivered downgrade alert counts as alerted', async () => {
    sendPushToRolesAtLocation.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ ok: true, checked: 1, alerted: 1, alert_failed: 0 })
    expect(logError).not.toHaveBeenCalled()
  })

  it('a failed alert is logged at error level, counted, and NOT reported as alerted; the state is still written', async () => {
    sendPushToRolesAtLocation.mockResolvedValue({ sent: 0, skipped: 0, invalidated: 0, failed: 2 })
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ alerted: 0, alert_failed: 1 })
    expect(logError).toHaveBeenCalledWith('wa-health', 'health alert reached nobody; the new state is recorded, the alert is not retried',
      { number_id: 'n1', alert: 'wa_quality', read_failed: false })
    expect(updates[0].patch).toMatchObject({ quality_rating: 'YELLOW' })
  })

  it('a throwing push is a failed alert', async () => {
    sendPushToRolesAtLocation.mockRejectedValue(new Error('boom'))
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ alerted: 0, alert_failed: 1 })
    expect(logWarn).toHaveBeenCalledWith('wa-health', 'alert push threw', { number_id: 'n1', err: 'boom' })
  })

  it('nobody to tell is neither alerted nor failed', async () => {
    sendPushToRolesAtLocation.mockResolvedValue({ sent: 0, skipped: 2, invalidated: 0, failed: 0 })
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ alerted: 0, alert_failed: 0 })
  })

  it('a failed state write is logged, and the poll carries on', async () => {
    updateError = { message: 'down' }
    sendPushToRolesAtLocation.mockResolvedValue({ sent: 1 })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(logWarn).toHaveBeenCalledWith('wa-health', 'health state write failed', { number_id: 'n1', err: 'down' })
  })
})
