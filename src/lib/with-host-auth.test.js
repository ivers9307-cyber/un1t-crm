// HOSTCHECKIN.1 — withHostAuth: 401 without a host, resolved params, and a
// fixed 500 (logged) when the handler throws.
import { describe, it, expect, vi } from 'vitest'

let session = null
vi.mock('./host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('./supabase', () => ({ createServerClient: () => ({ fake: true }) }))
vi.mock('./log', () => ({ logError: vi.fn() }))
const { logError } = await import('./log')
const { withHostAuth } = await import('./with-host-auth.js')

describe('withHostAuth', () => {
  it('401s without a host session and never runs the handler', async () => {
    const handler = vi.fn()
    const res = await withHostAuth(handler)(new Request('https://crm.test/a'), { params: Promise.resolve({ id: 'e1' }) })
    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('hands the host, db and resolved params to the handler', async () => {
    session = { host: { id: 'h1' } }
    const handler = vi.fn(async (ctx) => Response.json({ host: ctx.host.id, id: ctx.params.id, db: ctx.db.fake }))
    const res = await withHostAuth(handler)(new Request('https://crm.test/a'), { params: Promise.resolve({ id: 'e1' }) })
    expect(await res.json()).toEqual({ host: 'h1', id: 'e1', db: true })
  })

  it('a throwing handler answers a fixed 500 and is logged', async () => {
    session = { host: { id: 'h1' } }
    const res = await withHostAuth(async () => { throw new Error('relation "x" does not exist') })(new Request('https://crm.test/a'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/relation/)
    expect(logError).toHaveBeenCalled()
  })
})
