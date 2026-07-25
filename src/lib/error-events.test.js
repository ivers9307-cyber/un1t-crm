// OBS-HANDLED.1 — error_events writes for HANDLED failures.
//
// instrumentation.js onRequestError only fires for errors that escape
// Next entirely; a route that catches and returns 500/502 itself never
// registers (the 2026-07-25 external review found five real prod 5xx —
// Xero contacts + invoice approval — with ZERO error_events rows).
// recordErrorEvent is the extracted, storm-guarded persist that both
// instrumentation.js and catch-sites share; serverErrorResponse is the
// route-facing wrapper: log + persist + standard { success:false } body.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const insert = vi.fn(async () => ({ error: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ from: () => ({ insert }) })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))

import { recordErrorEvent, serverErrorResponse, _resetStormGuardForTests } from './error-events.js'
import { logError } from '@/lib/log'

beforeEach(() => {
  vi.clearAllMocks()
  insert.mockResolvedValue({ error: null })
  _resetStormGuardForTests()
})
afterEach(() => { vi.useRealTimers() })

describe('recordErrorEvent', () => {
  it('inserts a row with the given fields', async () => {
    await recordErrorEvent({ route_path: '/api/x', route_type: 'handled', method: 'POST', name: 'Error', message: 'boom' })
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][0]).toMatchObject({
      route_path: '/api/x', route_type: 'handled', method: 'POST', name: 'Error', message: 'boom',
    })
  })

  it('never throws when the insert fails', async () => {
    insert.mockRejectedValueOnce(new Error('db down'))
    await expect(recordErrorEvent({ message: 'x' })).resolves.toBeUndefined()
  })

  it('storm guard caps inserts per minute, then reopens after the window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    for (let i = 0; i < 40; i++) await recordErrorEvent({ message: `e${i}` })
    expect(insert).toHaveBeenCalledTimes(30)
    vi.setSystemTime(1_000_000 + 61_000)
    await recordErrorEvent({ message: 'after window' })
    expect(insert).toHaveBeenCalledTimes(31)
  })
})

describe('serverErrorResponse', () => {
  const req = () => new Request('http://localhost/api/locations/loc-1/xero/contacts', {
    method: 'GET',
    headers: { 'x-vercel-id': 'dub1::r-abc' },
  })

  it('returns the standard { success:false, error } shape at the given status', async () => {
    const res = await serverErrorResponse({ module: 'xero', error: new Error('upstream sad'), request: req(), status: 502 })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'upstream sad' })
  })

  it('defaults to 500 and lets publicMessage override the client-visible error', async () => {
    const res = await serverErrorResponse({ module: 'xero', error: new Error('secret detail'), request: req(), publicMessage: 'Xero push failed' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Xero push failed')
  })

  it("persists an error_events row stamped route_type 'handled' with request correlation", async () => {
    await serverErrorResponse({ module: 'xero', error: new Error('boom'), request: req(), status: 502 })
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][0]).toMatchObject({
      route_type: 'handled',
      route_path: '/api/locations/loc-1/xero/contacts',
      method: 'GET',
      vercel_id: 'dub1::r-abc',
      name: 'Error',
      message: 'boom',
    })
  })

  it('logs through the existing log.js pipeline with the module name', async () => {
    const err = new Error('boom')
    await serverErrorResponse({ module: 'invoice-approve', error: err, request: req() })
    expect(logError).toHaveBeenCalledTimes(1)
    const [mod, , meta] = logError.mock.calls[0]
    expect(mod).toBe('invoice-approve')
    expect(meta.error).toBe(err)
    expect(meta.status).toBe(500)
  })

  it('tolerates a PostgREST-style non-Error object and a missing request', async () => {
    const res = await serverErrorResponse({ module: 'xero', error: { message: 'pg says no' } })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('pg says no')
    expect(insert.mock.calls[0][0]).toMatchObject({ message: 'pg says no', vercel_id: null })
  })

  it('still responds when the persist fails (observability never worsens an incident)', async () => {
    insert.mockRejectedValueOnce(new Error('db down'))
    const res = await serverErrorResponse({ module: 'xero', error: new Error('boom'), request: req() })
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  it('truncates an over-long message before persisting', async () => {
    await serverErrorResponse({ module: 'xero', error: new Error('z'.repeat(1000)), request: req() })
    expect(insert.mock.calls[0][0].message.length).toBeLessThanOrEqual(500)
  })
})
