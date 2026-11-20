// FEES.1 — route tests for the hourly class-fees cron on defineCron: the
// secret gate, which runs stamp, and that a failure answers with fixed text.
// The per-studio steps (src/lib/class-fees-run.js, class-fees-member.js) have
// their own tests; here they are stubs.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => h.db) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/membership/locations-for-source', () => ({ locationsWithSource: vi.fn() }))
vi.mock('@/lib/un1t-online-settings', () => ({ readUn1tWriteSettings: vi.fn() }))
vi.mock('@/lib/class-fees-run', () => ({
  readClassFeeContext: vi.fn(),
  detectClassFees: vi.fn(),
  sendReviewEmail: vi.fn(),
  chargeDueClassFees: vi.fn(),
}))
vi.mock('@/lib/class-fees-member', () => ({ sendMemberNotices: vi.fn() }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import { locationsWithSource } from '@/lib/membership/locations-for-source'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { readClassFeeContext, detectClassFees, sendReviewEmail, chargeDueClassFees } from '@/lib/class-fees-run'
import { sendMemberNotices } from '@/lib/class-fees-member'
import { localHourIn } from '@/lib/class-fees'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const HATCH = { id: 'b0000000-0000-0000-0000-000000000002', name: 'Hatch Street' }
const ZONE = 'Europe/Dublin'
const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})
const ZERO = {
  studios: 0, fees_off: 0, detected_runs: 0, inserted: 0, forgiven: 0, notices: 0, emails: 0, charge_runs: 0,
  charged: 0, retry_scheduled: 0, outstanding: 0, in_doubt: 0, failed: 0, deferred_budget: 0,
}
const ctx = (settings) => ({
  location: HATCH, zone: ZONE,
  settings: { enabled: true, chargingPaused: false, detectHour: -1, ...settings },
})

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  h.db = createFakeDb({ tables: { locations: [{ id: HATCH.id, name: HATCH.name }] } })
  locationsWithSource.mockResolvedValue({ eligible: [HATCH], skipped: [], error: null })
  readClassFeeContext.mockResolvedValue(ctx())
  readUn1tWriteSettings.mockResolvedValue({ settings: { writesEnabled: true } })
  chargeDueClassFees.mockResolvedValue({ charged: 2, retry_scheduled: 1, outstanding: 0, in_doubt: 0 })
  detectClassFees.mockResolvedValue({ inserted: 3, forgiven: 1, undecided: [] })
  sendMemberNotices.mockResolvedValue({ sent: 2 })
  sendReviewEmail.mockResolvedValue({ sent: true })
})

describe('GET /api/cron/class-fees', () => {
  it('refuses a caller without the cron secret: no client, nothing read, nothing stamped', async () => {
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(h.db.calls).toEqual([])
    expect(locationsWithSource).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a charging tick stamps its own row once, with the counts as the outcome', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const outcome = { ...ZERO, studios: 1, charge_runs: 1, charged: 2, retry_scheduled: 1 }
    expect(await res.json()).toEqual({ success: true, ...outcome })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('class-fees', outcome)
    expect(detectClassFees).not.toHaveBeenCalled()
  })

  it('the detect hour lists the fees, sends the notices and the review email, then charges', async () => {
    readClassFeeContext.mockResolvedValue(ctx({ detectHour: localHourIn(Date.now(), ZONE) }))
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ success: true, detected_runs: 1, inserted: 3, forgiven: 1, notices: 2, emails: 1, charge_runs: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('class-fees', expect.objectContaining({ detected_runs: 1 }))
  })

  it('fees off, charging paused or writes off: counted or skipped, still a clean stamped run', async () => {
    readClassFeeContext.mockResolvedValueOnce(ctx({ enabled: false }))
    let body = await (await GET(req())).json()
    expect(body).toMatchObject({ success: true, fees_off: 1, charge_runs: 0 })
    readClassFeeContext.mockResolvedValueOnce(ctx({ chargingPaused: true }))
    body = await (await GET(req())).json()
    expect(body).toMatchObject({ success: true, charge_runs: 0 })
    readUn1tWriteSettings.mockResolvedValueOnce({ settings: { writesEnabled: false } })
    body = await (await GET(req())).json()
    expect(body).toMatchObject({ success: true, charge_runs: 0 })
    expect(chargeDueClassFees).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledTimes(3)
  })

  it('one studio failing is counted, logged by code, and the run still stamps', async () => {
    const OTHER = { id: 'b0000000-0000-0000-0000-000000000003', name: 'Other' }
    locationsWithSource.mockResolvedValue({ eligible: [HATCH, OTHER], skipped: [], error: null })
    readClassFeeContext.mockImplementation(async (_db, id) => {
      if (id === HATCH.id) throw Object.assign(new Error('Ada Lovelace card declined'), { code: 'E_CHARGE' })
      return { ...ctx(), location: OTHER }
    })
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ success: true, studios: 2, failed: 1 })
    expect(JSON.stringify(body)).not.toContain('Ada')
    expect(logError).toHaveBeenCalledWith('class-fees', 'studio run failed', { locationId: HATCH.id, code: 'E_CHARGE' })
    expect(stampHeartbeat).toHaveBeenCalledWith('class-fees', expect.objectContaining({ failed: 1 }))
  })

  it('every studio failing is a failed run: 500, a fixed line, nothing stamped', async () => {
    readClassFeeContext.mockRejectedValue(Object.assign(new Error('Ada Lovelace card declined'), { code: 'E_CHARGE' }))
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, studios: 1, failed: 1, error: 'Class fee run failed at every studio' })
    expect(JSON.stringify(body)).not.toContain('Ada')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed locations read answers 500 with a fixed error, logs the detail and stamps nothing', async () => {
    locationsWithSource.mockResolvedValue({ eligible: null, skipped: null, error: { message: 'permission denied for table locations' } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not list locations' })
    expect(JSON.stringify(body)).not.toContain('permission denied')
    expect(logError).toHaveBeenCalledWith('class-fees', 'failed to list locations', { err: { message: 'permission denied for table locations' } })
    expect(readClassFeeContext).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
