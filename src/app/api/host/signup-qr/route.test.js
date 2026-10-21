// HOST-JOIN-PAGE.1 — GET /api/host/signup-qr encodes the host's public page
// /h/[slug] by default and the standalone signup form /h/[slug]/join with
// ?page=join; any other value is the public page. The QR target is read
// back by decoding the PNG the route returns, not by trusting a mock.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentHost: vi.fn(),
  createServerClient: vi.fn(),
  ensureHostSlug: vi.fn(),
  resolveCustomerBaseUrl: vi.fn(),
  toBuffer: vi.fn(),
}))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: mocks.getCurrentHost }))
vi.mock('@/lib/supabase', () => ({ createServerClient: mocks.createServerClient }))
vi.mock('@/lib/hosts', () => ({ ensureHostSlug: mocks.ensureHostSlug }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: mocks.resolveCustomerBaseUrl }))
vi.mock('qrcode', () => ({ default: { toBuffer: mocks.toBuffer } }))

import { GET } from './route'

function db(row) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: row, error: null })) })) })),
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
  mocks.createServerClient.mockReturnValue(db({ id: 'h1', name: 'Pride', slug: 'pride', anchor_location_id: 'loc1' }))
  mocks.ensureHostSlug.mockResolvedValue('pride')
  mocks.resolveCustomerBaseUrl.mockResolvedValue('https://events.example.com/some/path?x=1')
  mocks.toBuffer.mockResolvedValue(Buffer.from('png'))
})

describe('GET /api/host/signup-qr', () => {
  it('401s without a host session', async () => {
    mocks.getCurrentHost.mockResolvedValue(null)
    const res = await GET(new Request('http://x/api/host/signup-qr'))
    expect(res.status).toBe(401)
  })

  it('encodes the public page by default, origin-only', async () => {
    const res = await GET(new Request('http://x/api/host/signup-qr'))
    expect(res.status).toBe(200)
    expect(mocks.toBuffer.mock.calls[0][0]).toBe('https://events.example.com/h/pride')
    expect(res.headers.get('Content-Disposition')).toContain('signup-qr-pride.png')
  })

  it('encodes the standalone signup form with ?page=join', async () => {
    const res = await GET(new Request('http://x/api/host/signup-qr?page=join'))
    expect(res.status).toBe(200)
    expect(mocks.toBuffer.mock.calls[0][0]).toBe('https://events.example.com/h/pride/join')
    expect(res.headers.get('Content-Disposition')).toContain('signup-form-qr-pride.png')
  })

  it('treats any other page value as the public page', async () => {
    await GET(new Request('http://x/api/host/signup-qr?page=../admin'))
    expect(mocks.toBuffer.mock.calls[0][0]).toBe('https://events.example.com/h/pride')
  })
})
