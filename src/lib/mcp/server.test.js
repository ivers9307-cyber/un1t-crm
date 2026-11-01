import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const fakeDb = { from: vi.fn() }
vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))

const runTool = vi.fn()
vi.mock('@/lib/agent-tools/registry', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, runTool: (...a) => runTool(...a) }
})

import { TOOLS } from '@/lib/agent-tools'
import {
  buildAuthedHandler, buildMcpServer, isCanonicalHost, protectedResourceGET, protectedResourceOPTIONS,
} from './server.js'

function fakeServer() {
  const registered = []
  return { registered, registerTool: vi.fn((name, config, cb) => registered.push({ name, config, cb })) }
}

beforeEach(() => {
  runTool.mockReset()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.repset.ie')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co')
})
afterEach(() => vi.unstubAllEnvs())

describe('buildMcpServer', () => {
  it('registers every tool in TOOLS by name with its schema', () => {
    const server = fakeServer()
    buildMcpServer(server)
    expect(server.registered.map((r) => r.name)).toEqual(TOOLS.map((t) => t.name))
    server.registered.forEach((r, i) => {
      expect(r.config).toEqual({ title: TOOLS[i].title, description: TOOLS[i].description, inputSchema: TOOLS[i].inputSchema })
      expect(r.config.inputSchema).toBe(TOOLS[i].inputSchema)
    })
  })

  it('runs the tool for the verified caller (ctx.http.authInfo) and answers a CallToolResult', async () => {
    const server = fakeServer()
    buildMcpServer(server)
    const authInfo = { token: 't', clientId: 'c', scopes: [], extra: { user: { id: 'u1' }, enabledOrgIds: [] } }
    runTool.mockResolvedValue({ ok: true, data: { hello: 'world' } })

    const out = await server.registered[0].cb({ studio_id: undefined }, { http: { authInfo } })

    expect(runTool).toHaveBeenCalledWith(TOOLS[0], { studio_id: undefined }, authInfo, { db: fakeDb })
    expect(out).toEqual({ content: [{ type: 'text', text: JSON.stringify({ hello: 'world' }) }] })
  })

  it('refuses without running anything when no verified caller reached the tool', async () => {
    const server = fakeServer()
    buildMcpServer(server)
    const out = await server.registered[0].cb({}, {})
    expect(runTool).not.toHaveBeenCalled()
    expect(out.isError).toBe(true)
    expect(JSON.parse(out.content[0].text).error).toBe('unauthenticated')
  })
})

describe('buildMcpServer under the real mcp-handler', () => {
  async function rpc(body, auth) {
    const { createMcpHandler } = await import('mcp-handler')
    const handler = createMcpHandler(buildMcpServer, { serverInfo: { name: 'repset-crm', version: '1' } })
    const req = new Request('https://crm.repset.ie/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    })
    if (auth) req.auth = auth
    const res = await handler(req)
    const text = await res.text()
    const line = text.split('\n').find((l) => l.startsWith('data: '))
    return JSON.parse(line ? line.slice(6) : text)
  }

  it('lists every tool with a JSON input schema', async () => {
    const out = await rpc({ method: 'tools/list', params: {} })
    expect(out.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
    expect(out.result.tools[0].inputSchema.type).toBe('object')
  })

  it('passes withMcpAuth\'s req.auth through to runTool', async () => {
    const authInfo = { token: 't', clientId: 'c', scopes: [], extra: { user: { id: 'u1' }, enabledOrgIds: [] } }
    runTool.mockResolvedValue({ ok: true, data: { n: 1 } })
    const out = await rpc({ method: 'tools/call', params: { name: TOOLS[0].name, arguments: {} } }, authInfo)
    expect(runTool).toHaveBeenCalledTimes(1)
    expect(runTool.mock.calls[0][2]).toEqual(authInfo)
    expect(out.result.content[0].text).toBe(JSON.stringify({ n: 1 }))
  })
})

describe('buildAuthedHandler under the real withMcpAuth (the route\'s only door)', () => {
  function call(body, headers = {}) {
    return new Request('https://crm.repset.ie/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    })
  }

  it('answers 401 with the RFC 9728 challenge when the verifier refuses the token', async () => {
    const verify = vi.fn(async () => null)
    const handler = buildAuthedHandler(verify)
    const res = await handler(call(
      { method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      { authorization: 'Bearer not-a-real-token' },
    ))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate'))
      .toContain('resource_metadata="https://crm.repset.ie/.well-known/oauth-protected-resource/api/mcp"')
    expect(verify).toHaveBeenCalledWith(expect.any(Request), 'not-a-real-token')
    expect(runTool).not.toHaveBeenCalled()
  })

  it('answers 401 when no bearer is sent at all', async () => {
    const res = await buildAuthedHandler(async () => null)(call({ method: 'tools/list', params: {} }))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  it('hands the verified AuthInfo to runTool for a whoami call', async () => {
    const authInfo = { token: 'tok', clientId: 'client-x', scopes: [], extra: { user: { id: 'u1' }, enabledOrgIds: [] } }
    runTool.mockResolvedValue({ ok: true, data: { name: 'Pat' } })
    const res = await buildAuthedHandler(async () => authInfo)(call(
      { method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      { authorization: 'Bearer tok' },
    ))
    expect(res.status).toBe(200)
    expect(runTool).toHaveBeenCalledTimes(1)
    const [tool, , auth] = runTool.mock.calls[0]
    expect(tool.name).toBe('whoami')
    expect(auth).toBe(authInfo)
    const text = await res.text()
    const line = text.split('\n').find((l) => l.startsWith('data: '))
    const out = JSON.parse(line ? line.slice(6) : text)
    expect(out.result.content[0].text).toBe(JSON.stringify({ name: 'Pat' }))
  })
})

describe('isCanonicalHost', () => {
  it('isCanonicalHost compares against NEXT_PUBLIC_APP_URL', () => {
    expect(isCanonicalHost(new Request('https://crm.repset.ie/api/mcp'))).toBe(true)
    expect(isCanonicalHost(new Request('https://crm.un1tdublin.com/api/mcp'))).toBe(false)
    expect(isCanonicalHost(new Request('https://un1t-group.repset.ie/api/mcp'))).toBe(false)
    expect(isCanonicalHost(new Request('https://crm.repset.ie:8443/api/mcp'))).toBe(false)
  })

  it('throws (no silent fallback) when NEXT_PUBLIC_APP_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(() => isCanonicalHost(new Request('https://crm.repset.ie/api/mcp'))).toThrow(/NEXT_PUBLIC_APP_URL/)
  })
})

describe('protected-resource metadata', () => {
  it('names the canonical /api/mcp resource and the Supabase auth server, whichever path or host asked', async () => {
    const paths = [
      'https://crm.repset.ie/.well-known/oauth-protected-resource',
      'https://crm.repset.ie/.well-known/oauth-protected-resource/api/mcp',
      'https://crm.un1tdublin.com/.well-known/oauth-protected-resource/api/mcp',
    ]
    const docs = await Promise.all(paths.map(async (p) => (await protectedResourceGET(new Request(p))).json()))
    for (const doc of docs) {
      expect(doc.resource).toBe('https://crm.repset.ie/api/mcp')
      expect(doc.authorization_servers).toEqual(['https://ref.supabase.co/auth/v1'])
    }
  })

  it('throws (no silent fallback) when NEXT_PUBLIC_SUPABASE_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    expect(() => protectedResourceGET(new Request('https://crm.repset.ie/.well-known/oauth-protected-resource')))
      .toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
  })

  it('answers the CORS preflight', () => {
    const res = protectedResourceOPTIONS(new Request('https://crm.repset.ie/.well-known/oauth-protected-resource', { method: 'OPTIONS' }))
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})
