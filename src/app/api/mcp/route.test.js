import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const authed = vi.fn(async () => new Response('mcp', { status: 200 }))
const withMcpAuth = vi.fn(() => authed)
const inner = vi.fn()
const createMcpHandler = vi.fn(() => inner)
vi.mock('mcp-handler', () => ({
  withMcpAuth: (...a) => withMcpAuth(...a),
  createMcpHandler: (...a) => createMcpHandler(...a),
  protectedResourceHandler: vi.fn(),
  metadataCorsOptionsRequestHandler: vi.fn(),
}))

const verifyMcpToken = vi.fn(async () => null)
vi.mock('@/lib/mcp/auth', () => ({ verifyMcpToken: (...a) => verifyMcpToken(...a) }))

import * as route from './route.js'
import { buildMcpServer } from '@/lib/mcp/server'

beforeEach(() => {
  authed.mockClear()
  verifyMcpToken.mockClear()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.repset.ie')
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/mcp', () => {
  it('exports the segment config and one wrapper for GET, POST and DELETE', () => {
    expect(route.runtime).toBe('nodejs')
    expect(route.dynamic).toBe('force-dynamic')
    expect(route.maxDuration).toBe(60)
    expect(typeof route.POST).toBe('function')
    expect(route.GET).toBe(route.POST)
    expect(route.DELETE).toBe(route.POST)
  })

  it('answers 404 on a non-canonical host before touching auth', async () => {
    for (const host of ['crm.un1tdublin.com', 'un1t-group.repset.ie']) {
      const res = await route.POST(new Request(`https://${host}/api/mcp`, {
        method: 'POST', headers: { authorization: 'Bearer abc.def.ghi' },
      }))
      expect(res.status).toBe(404)
    }
    expect(authed).not.toHaveBeenCalled()
    expect(verifyMcpToken).not.toHaveBeenCalled()
  })

  it('delegates to the auth-wrapped handler on the canonical host', async () => {
    const req = new Request('https://crm.repset.ie/api/mcp', { method: 'POST' })
    const res = await route.POST(req)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('mcp')
    expect(authed).toHaveBeenCalledWith(req)

    expect(createMcpHandler).toHaveBeenCalledWith(buildMcpServer, { serverInfo: { name: 'repset-crm', version: '1' } })
    const [handler, verify, opts] = withMcpAuth.mock.calls[0]
    expect(handler).toBe(inner)
    expect(opts).toEqual({
      required: true,
      resourceMetadataPath: '/.well-known/oauth-protected-resource/api/mcp',
      resourceUrl: 'https://crm.repset.ie',
    })

    // The verify callback hands only the bearer token to verifyMcpToken.
    await verify(req, 'the-token')
    expect(verifyMcpToken).toHaveBeenCalledWith('the-token')
  })
})
