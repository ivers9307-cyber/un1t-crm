// SECRETTAILS.1 — GET /api/xero/debug (owner/master diagnostic).
//
// It returned the first 4 and last 4 characters of XERO_CLIENT_SECRET (and of
// XERO_CLIENT_ID) "so we can verify it's not blank or a whitespace-padded
// copy/paste". Presence, length and a whitespace flag answer that without a
// single character. Fictional values only (public repo).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/xero/client', () => ({
  buildAuthorizeUrl: vi.fn(() => 'https://login.xero.example/authorize?client_id=SYNTHCLIENTIDabcdefWXYZ'),
  XERO_SCOPES: 'openid offline_access',
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'

const SECRET = 'SYNTsecret-0123456789-QRST' // 26 chars; head 'SYNT', tail 'QRST'
const CLIENT_ID = 'SYNTHCLIENTIDabcdefWXYZ'    // 23 chars
const req = () => new Request('https://crm.example.test/api/xero/debug')
const saved = {}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of ['XERO_CLIENT_SECRET', 'XERO_CLIENT_ID']) saved[k] = process.env[k]
  process.env.XERO_CLIENT_SECRET = SECRET
  process.env.XERO_CLIENT_ID = CLIENT_ID
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: { id: 'loc-1' } })
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('GET /api/xero/debug — no character of the secret (SECRETTAILS.1)', () => {
  it('returns presence and length, never the first or last characters', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.env.XERO_CLIENT_SECRET).toEqual({ present: true, length: SECRET.length, surrounding_whitespace: false })
    const envJson = JSON.stringify(body.env)
    expect(envJson).not.toContain('SYNT')
    expect(envJson).not.toContain('QRST')
  })

  it('the client id gets the same shape (the full id is in authorizeUrl by OAuth design)', async () => {
    const body = await (await GET(req())).json()
    expect(body.env.XERO_CLIENT_ID).toEqual({ present: true, length: CLIENT_ID.length, surrounding_whitespace: false })
  })

  it('flags a whitespace-padded paste, the thing the route exists to catch', async () => {
    process.env.XERO_CLIENT_SECRET = `  ${SECRET}\n`
    const body = await (await GET(req())).json()
    expect(body.env.XERO_CLIENT_SECRET).toEqual({ present: true, length: SECRET.length + 3, surrounding_whitespace: true })
  })

  it('an unset or short value is presence and length too', async () => {
    delete process.env.XERO_CLIENT_SECRET
    let body = await (await GET(req())).json()
    expect(body.env.XERO_CLIENT_SECRET).toEqual({ present: false, length: 0, surrounding_whitespace: false })
    process.env.XERO_CLIENT_SECRET = 'SYNTS'
    body = await (await GET(req())).json()
    expect(body.env.XERO_CLIENT_SECRET).toEqual({ present: true, length: 5, surrounding_whitespace: false })
  })

  it('the gate is unchanged: 401 without a user, 403 below owner', async () => {
    getCurrentUser.mockResolvedValueOnce(null)
    expect((await GET(req())).status).toBe(401)
    getCurrentUser.mockResolvedValueOnce({ id: 'u2', role: 'manager', activeLocation: { id: 'loc-1' } })
    expect((await GET(req())).status).toBe(403)
  })
})
