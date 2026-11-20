import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const db = { marker: 'db' }
const createServerClient = vi.fn(() => db)
vi.mock('@/lib/supabase', () => ({ createServerClient: () => createServerClient() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { defineCron } from './define-cron.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logWarn } from '@/lib/log'

const request = (authorization = 'Bearer test-secret') => new Request('https://crm.test/api/cron/job', { headers: authorization ? { authorization } : {} })
const call = async (run, req = request()) => {
  const res = await defineCron({ heartbeat: 'job' }, run)(req)
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'test-secret'
})
afterEach(() => { delete process.env.CRON_SECRET })

describe('defineCron', () => {
  it.each([
    ['a wrong secret', 'Bearer nope'],
    ['no header', ''],
  ])('refuses %s without running the job', async (_label, header) => {
    const run = vi.fn()
    expect(await call(run, request(header))).toEqual({ status: 401, body: { success: false, error: 'Unauthorized' } })
    expect(run).not.toHaveBeenCalled()
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('refuses every request when the secret is unset, even "Bearer undefined"', async () => {
    delete process.env.CRON_SECRET
    const run = vi.fn()
    expect((await call(run, request('Bearer undefined'))).status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  it('a clean run gets the client, answers 200 and stamps', async () => {
    const run = vi.fn(async () => ({ body: { moved: 3 } }))
    expect(await call(run)).toEqual({ status: 200, body: { moved: 3, success: true } })
    expect(run.mock.calls[0][0].db).toBe(db)
    expect(stampHeartbeat.mock.calls).toEqual([['job']])
  })

  it('a job that returns nothing is a clean run', async () => {
    expect(await call(async () => {})).toEqual({ status: 200, body: { success: true } })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('stores the outcome on the heartbeat', async () => {
    await call(async () => ({ outcome: { sent: 2 } }))
    expect(stampHeartbeat.mock.calls).toEqual([['job', { sent: 2 }]])
  })

  it('a failed run answers 500 and does not stamp', async () => {
    expect(await call(async () => ({ ok: false, body: { failed: 1 } }))).toEqual({ status: 500, body: { failed: 1, success: false } })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a job can keep its existing status for a failed run', async () => {
    expect((await call(async () => ({ ok: false, status: 200 }))).status).toBe(200)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('the body cannot claim success for a failed run', async () => {
    expect((await call(async () => ({ ok: false, body: { success: true } }))).body.success).toBe(false)
  })

  it('a throw is logged, keeps its text out of the response and does not stamp', async () => {
    const err = new Error('secret table detail')
    expect(await call(async () => { throw err })).toEqual({ status: 500, body: { success: false, error: 'Cron run failed' } })
    expect(logError).toHaveBeenCalledWith('cron.job', 'run failed', { err })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed stamp never fails a run that worked', async () => {
    const err = new Error('stamp down')
    stampHeartbeat.mockRejectedValueOnce(err)
    expect((await call(async () => ({ body: { done: 1 } }))).status).toBe(200)
    expect(logWarn).toHaveBeenCalledWith('cron.job', 'heartbeat failed', { err })
  })

  it('stamp: false is a clean run that leaves the job\'s own row alone', async () => {
    expect(await call(async () => ({ stamp: false, body: { skipped: 'no_slot' } }))).toEqual({ status: 200, body: { skipped: 'no_slot', success: true } })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('stamp: true with ok: false answers failure AND stamps the job\'s own row with its outcome', async () => {
    expect(await call(async () => ({ ok: false, stamp: true, outcome: { guardTripped: true }, body: { guardTripped: true } })))
      .toEqual({ status: 500, body: { guardTripped: true, success: false } })
    expect(stampHeartbeat.mock.calls).toEqual([['job', { guardTripped: true }]])
  })

  it('stamp: true with ok: false keeps the job\'s status and stamps with no outcome when none is given', async () => {
    expect(await call(async () => ({ ok: false, stamp: true, status: 200 }))).toEqual({ status: 200, body: { success: false } })
    expect(stampHeartbeat.mock.calls).toEqual([['job']])
  })

  it('only stamp: true itself records a failed run (a truthy look-alike does not)', async () => {
    await call(async () => ({ ok: false, stamp: 'yes' }))
    await call(async () => ({ ok: false, stamp: 1 }))
    await call(async () => ({ ok: false, stamp: false }))
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('stamp: true on a clean run is the default: one stamp', async () => {
    expect((await call(async () => ({ stamp: true, outcome: { n: 1 } }))).status).toBe(200)
    expect(stampHeartbeat.mock.calls).toEqual([['job', { n: 1 }]])
  })

  it('a failed run that stamps still stamps its arms after its own row; a failed own stamp is logged', async () => {
    const err = new Error('stamp down')
    stampHeartbeat.mockRejectedValueOnce(err)
    const res = await call(async () => ({ ok: false, stamp: true, outcome: { n: 1 }, arms: [{ heartbeat: 'arm-a' }] }))
    expect(res.status).toBe(500)
    expect(stampHeartbeat.mock.calls).toEqual([['job', { n: 1 }], ['arm-a']])
    expect(logWarn).toHaveBeenCalledWith('cron.job', 'heartbeat failed', { err })
  })

  it('stamps each listed arm row, with or without an outcome, beside the job row', async () => {
    await call(async () => ({ outcome: { n: 1 }, arms: [{ heartbeat: 'arm-a', outcome: { sent: 2 } }, { heartbeat: 'arm-b' }] }))
    expect(stampHeartbeat.mock.calls).toEqual([['job', { n: 1 }], ['arm-a', { sent: 2 }], ['arm-b']])
  })

  it('an arm is stamped even when the parent run failed or stays quiet (the job vouches for the arm)', async () => {
    await call(async () => ({ ok: false, arms: [{ heartbeat: 'arm-a' }] }))
    await call(async () => ({ stamp: false, arms: [{ heartbeat: 'arm-b' }] }))
    expect(stampHeartbeat.mock.calls).toEqual([['arm-a'], ['arm-b']])
  })

  it('a failed arm stamp is logged and never fails the run; a nameless arm is skipped', async () => {
    const err = new Error('arm down')
    stampHeartbeat.mockImplementation(async (name) => { if (name === 'arm-a') throw err })
    const res = await call(async () => ({ arms: [{ heartbeat: 'arm-a' }, { heartbeat: '' }, { heartbeat: 'job' }, { heartbeat: 'arm-c' }] }))
    expect(res.status).toBe(200)
    expect(logWarn).toHaveBeenCalledWith('cron.job', 'arm heartbeat failed', { arm: 'arm-a', err })
    expect(stampHeartbeat.mock.calls.map((c) => c[0])).toEqual(['job', 'arm-a', 'arm-c'])
    stampHeartbeat.mockImplementation(async () => {})
  })

  it('refuses a job with no heartbeat name when the file loads', () => {
    expect(() => defineCron({}, async () => {})).toThrow(/heartbeat/)
    expect(() => defineCron({ heartbeat: 'job' })).toThrow(/run/)
  })
})
