import { describe, it, expect, vi, beforeEach } from 'vitest'

const logError = vi.fn()
vi.mock('@/lib/log', () => ({ logError: (...a) => logError(...a) }))
// auth.js defaults to the real getCurrentUser and createServerClient; every
// test injects both, so neither (next/headers, supabase) may ever load.
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(() => { throw new Error('real getCurrentUser called') }) }))
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => { throw new Error('real db created') }) }))

import { createClient } from '@supabase/supabase-js'
import { verifyMcpToken, mcpEnabledOrgIds, defaultVerifyToken } from './auth.js'
import { makeFakeDb } from '../api-auth.test-helpers.js'

function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'ES256' })}.${b64(payload)}.sig`
}
const TOKEN = jwt({ client_id: 'client-x', sub: 'p1' })

const ownerAt = (...ids) => ({
  id: 'p1',
  isMaster: false,
  locations: ids.map((id) => ({ id, name: id, timezone: 'Europe/London', organization_id: id.split('-')[0] })),
  activeLocation: null,
  rolesByLocation: Object.fromEntries(ids.map((id) => [id, 'owner'])),
  assignmentsByLocation: Object.fromEntries(ids.map((id) => [id, { role: 'owner', permissions: {} }])),
  orgAdminOrgIds: [],
})

const fixture = () => ({
  org_settings: [
    { organization_id: 'org1', mcp_enabled: true },
    { organization_id: 'org2', mcp_enabled: false },
    { organization_id: 'org3', mcp_enabled: true },
  ],
})

const verifyAs = (id = 'p1') => vi.fn(async () => ({ id }))

beforeEach(() => { logError.mockReset(); createClient.mockReset() })

describe('verifyMcpToken', () => {
  it('returns null for a token without client_id', async () => {
    const getUser = vi.fn()
    const r = await verifyMcpToken(jwt({ sub: 'p1' }), { getUser, verifyToken: verifyAs(), db: makeFakeDb(fixture()) })
    expect(r).toBeNull()
    expect(getUser).not.toHaveBeenCalled()
  })

  it('verifyMcpToken returns null when auth.getUser answers no user', async () => {
    const getUser = vi.fn(async () => null)
    expect(await verifyMcpToken(TOKEN, { getUser, verifyToken: verifyAs(), db: makeFakeDb(fixture()) })).toBeNull()
    expect(logError).not.toHaveBeenCalled()
  })

  it('verifyMcpToken returns null and logs when getCurrentUser throws', async () => {
    const getUser = vi.fn(async () => { throw Object.assign(new Error('network'), { code: 'ECONNRESET' }) })
    expect(await verifyMcpToken(TOKEN, { getUser, verifyToken: verifyAs(), db: makeFakeDb(fixture()) })).toBeNull()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][0]).toBe('mcp')
    expect(logError.mock.calls[0][1]).toBe('token verification failed')
    expect(logError.mock.calls[0][2]).toEqual({ code: 'ECONNRESET' })
  })

  it('returns the user, enabled org ids and assistantAnywhere', async () => {
    const user = ownerAt('org1-a', 'org2-a')
    const r = await verifyMcpToken(TOKEN, { getUser: async () => user, verifyToken: verifyAs(), db: makeFakeDb(fixture()) })
    expect(r).toEqual({
      token: TOKEN,
      clientId: 'client-x',
      scopes: [],
      extra: { user, enabledOrgIds: ['org1'], assistantAnywhere: true },
    })
  })

  it('reports assistantAnywhere false for someone holding assistant nowhere', async () => {
    const user = ownerAt('org1-a')
    user.assignmentsByLocation['org1-a'].role = 'staff'
    const r = await verifyMcpToken(TOKEN, { getUser: async () => user, verifyToken: verifyAs(), db: makeFakeDb(fixture()) })
    expect(r.extra.assistantAnywhere).toBe(false)
  })

  it('still returns the user (no enabled orgs) when the org_settings read fails', async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: null, error: { code: '57014' } }) }) }) }) }
    const r = await verifyMcpToken(TOKEN, { getUser: async () => ownerAt('org1-a'), verifyToken: verifyAs(), db })
    expect(r.extra.enabledOrgIds).toEqual([])
    expect(logError).toHaveBeenCalledTimes(1)
  })
})

describe('verifyMcpToken binds the token to the resolved user', () => {
  it('returns null without asking getUser when the token does not verify', async () => {
    const getUser = vi.fn(async () => ownerAt('org1-a'))
    const verifyToken = vi.fn(async () => null)
    expect(await verifyMcpToken(TOKEN, { getUser, verifyToken, db: makeFakeDb(fixture()) })).toBeNull()
    expect(verifyToken).toHaveBeenCalledWith(TOKEN)
    expect(getUser).not.toHaveBeenCalled()
  })

  it('returns null when the verified token belongs to someone other than the resolved user (cookie fallback)', async () => {
    const getUser = vi.fn(async () => ownerAt('org1-a'))
    const r = await verifyMcpToken(TOKEN, { getUser, verifyToken: verifyAs('someone-else'), db: makeFakeDb(fixture()) })
    expect(r).toBeNull()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][1]).toBe('token not bound to the resolved session')
    expect(JSON.stringify(logError.mock.calls[0])).not.toContain('someone-else')
  })

  it('returns null for an impersonated (View as) session even when the ids match', async () => {
    const user = { ...ownerAt('org1-a'), impersonatingFrom: { id: 'master-1' } }
    const r = await verifyMcpToken(TOKEN, { getUser: async () => user, verifyToken: verifyAs('p1'), db: makeFakeDb(fixture()) })
    expect(r).toBeNull()
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('passes when the verified id matches the resolved user', async () => {
    const user = ownerAt('org1-a')
    const r = await verifyMcpToken(TOKEN, { getUser: async () => user, verifyToken: verifyAs('p1'), db: makeFakeDb(fixture()) })
    expect(r?.extra.user).toBe(user)
    expect(logError).not.toHaveBeenCalled()
  })
})

describe('defaultVerifyToken', () => {
  it('returns the auth user for a token Supabase accepts', async () => {
    const getUser = vi.fn(async () => ({ data: { user: { id: 'p1' } }, error: null }))
    createClient.mockReturnValue({ auth: { getUser } })
    expect(await defaultVerifyToken(TOKEN)).toEqual({ id: 'p1' })
    expect(getUser).toHaveBeenCalledWith(TOKEN)
    expect(logError).not.toHaveBeenCalled()
  })

  it('returns null quietly for a token Supabase rejects', async () => {
    createClient.mockReturnValue({ auth: { getUser: async () => ({ data: { user: null }, error: { message: 'expired' } }) } })
    expect(await defaultVerifyToken(TOKEN)).toBeNull()
    expect(logError).not.toHaveBeenCalled()
  })

  it('logs once and returns null when Supabase is unreachable, and verifyMcpToken never reaches getUser', async () => {
    createClient.mockReturnValue({ auth: { getUser: async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }) } } })
    const getUser = vi.fn()
    expect(await verifyMcpToken(TOKEN, { getUser, db: makeFakeDb(fixture()) })).toBeNull()
    expect(getUser).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('mcp', 'token did not verify', { code: 'ECONNRESET' })
  })
})

describe('mcpEnabledOrgIds', () => {
  it('reads only the orgs of the user locations plus orgAdminOrgIds, deduplicated', async () => {
    const user = { ...ownerAt('org1-a', 'org1-b'), orgAdminOrgIds: ['org3', 'org1'] }
    const ids = await mcpEnabledOrgIds(makeFakeDb(fixture()), user)
    expect(ids.sort()).toEqual(['org1', 'org3'])
  })

  it('answers [] without a query when the user has no organisations', async () => {
    const from = vi.fn()
    expect(await mcpEnabledOrgIds({ from }, { locations: [], orgAdminOrgIds: [] })).toEqual([])
    expect(from).not.toHaveBeenCalled()
  })
})
