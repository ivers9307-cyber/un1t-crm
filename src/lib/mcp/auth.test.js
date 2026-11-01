import { describe, it, expect, vi, beforeEach } from 'vitest'

const logError = vi.fn()
vi.mock('@/lib/log', () => ({ logError: (...a) => logError(...a) }))
// auth.js defaults to the real getCurrentUser and createServerClient; every
// test injects both, so neither (next/headers, supabase) may ever load.
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(() => { throw new Error('real getCurrentUser called') }) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => { throw new Error('real db created') }) }))

import { verifyMcpToken, mcpEnabledOrgIds } from './auth.js'
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

beforeEach(() => logError.mockReset())

describe('verifyMcpToken', () => {
  it('returns null for a token without client_id', async () => {
    const getUser = vi.fn()
    const r = await verifyMcpToken(jwt({ sub: 'p1' }), { getUser, db: makeFakeDb(fixture()) })
    expect(r).toBeNull()
    expect(getUser).not.toHaveBeenCalled()
  })

  it('verifyMcpToken returns null when auth.getUser answers no user', async () => {
    const getUser = vi.fn(async () => null)
    expect(await verifyMcpToken(TOKEN, { getUser, db: makeFakeDb(fixture()) })).toBeNull()
    expect(logError).not.toHaveBeenCalled()
  })

  it('verifyMcpToken returns null and logs when getCurrentUser throws', async () => {
    const getUser = vi.fn(async () => { throw Object.assign(new Error('network'), { code: 'ECONNRESET' }) })
    expect(await verifyMcpToken(TOKEN, { getUser, db: makeFakeDb(fixture()) })).toBeNull()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][0]).toBe('mcp')
    expect(logError.mock.calls[0][1]).toBe('token verification failed')
    expect(logError.mock.calls[0][2]).toEqual({ code: 'ECONNRESET' })
  })

  it('returns the user, enabled org ids and assistantAnywhere', async () => {
    const user = ownerAt('org1-a', 'org2-a')
    const r = await verifyMcpToken(TOKEN, { getUser: async () => user, db: makeFakeDb(fixture()) })
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
    const r = await verifyMcpToken(TOKEN, { getUser: async () => user, db: makeFakeDb(fixture()) })
    expect(r.extra.assistantAnywhere).toBe(false)
  })

  it('still returns the user (no enabled orgs) when the org_settings read fails', async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: null, error: { code: '57014' } }) }) }) }) }
    const r = await verifyMcpToken(TOKEN, { getUser: async () => ownerAt('org1-a'), db })
    expect(r.extra.enabledOrgIds).toEqual([])
    expect(logError).toHaveBeenCalledTimes(1)
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
