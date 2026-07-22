// OBSERVABILITY — onRequestError captures unhandled server errors into log.js
// (existing Sentinel pipeline) + a best-effort error_events row for correlation
// and alerting. It must NEVER throw (observability can't worsen an incident).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const insert = vi.fn(async () => ({ error: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ from: () => ({ insert }) })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))

import { onRequestError } from './instrumentation.js'
import { logError } from '@/lib/log'

const req = (extra) => ({ path: '/x', method: 'POST', headers: { 'x-vercel-id': 'iad1::abc' }, ...extra })
const ctx = (extra) => ({ routerKind: 'App Router', routePath: '/api/pay', routeType: 'route', ...extra })

beforeEach(() => { vi.clearAllMocks(); insert.mockResolvedValue({ error: null }) })

describe('onRequestError', () => {
  it('logs the error with correlation meta (module "unhandled")', async () => {
    const err = new Error('kaboom')
    await onRequestError(err, req(), ctx())
    expect(logError).toHaveBeenCalledTimes(1)
    const [mod, , meta] = logError.mock.calls[0]
    expect(mod).toBe('unhandled')
    expect(meta.vercel_id).toBe('iad1::abc')
    expect(meta.route).toBe('/api/pay')
    expect(meta.error).toBe(err) // log.js flattens name/message/stack
  })

  it('best-effort inserts an error_events row with the right shape', async () => {
    const err = Object.assign(new Error('boom'), { digest: 'dg1' })
    await onRequestError(err, req(), ctx({ routePath: '/api/pay' }))
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][0]).toMatchObject({
      vercel_id: 'iad1::abc', route_path: '/api/pay', route_type: 'route',
      method: 'POST', name: 'Error', message: 'boom', digest: 'dg1',
    })
  })

  it('never throws when the DB insert fails, but still logs', async () => {
    insert.mockRejectedValueOnce(new Error('db down'))
    await expect(onRequestError(new Error('x'), req(), ctx())).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalled()
  })

  it('truncates an over-long message before persisting', async () => {
    await onRequestError(new Error('z'.repeat(1000)), req(), ctx())
    expect(insert.mock.calls[0][0].message.length).toBeLessThanOrEqual(500)
  })

  it('tolerates a missing x-vercel-id / context', async () => {
    await expect(onRequestError(new Error('x'), { method: 'GET', headers: {} }, undefined)).resolves.toBeUndefined()
    expect(insert.mock.calls[0][0].vercel_id).toBeNull()
  })
})
