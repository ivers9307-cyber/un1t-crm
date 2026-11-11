// HOSTPORTAL.4 — GET /api/host/events/[id]/qr: a PNG of the host's own event
// URL tagged utm_source=qr. Another host's event, or one with no slug, is 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentHost: vi.fn(),
  createServerClient: vi.fn(),
  resolveCustomerBaseUrl: vi.fn(),
  toBuffer: vi.fn(),
  logError: vi.fn(),
}))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: mocks.getCurrentHost }))
vi.mock('@/lib/supabase', () => ({ createServerClient: mocks.createServerClient }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: mocks.resolveCustomerBaseUrl }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: mocks.logError }))
vi.mock('qrcode', () => ({ default: { toBuffer: mocks.toBuffer } }))

import { GET } from './route'

const state = { event: null, hostRow: null }
function db() {
  return {
    from: (table) => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: table === 'race_events' ? state.event : state.hostRow, error: null })
      return b
    },
  }
}
const params = { params: Promise.resolve({ id: 'e1' }) }
const req = () => new Request('http://x/api/host/events/e1/qr')

beforeEach(() => {
  vi.clearAllMocks()
  state.event = { id: 'e1', host_id: 'h1', slug: 'summer-run' }
  state.hostRow = { anchor_location_id: 'loc1' }
  mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
  mocks.createServerClient.mockReturnValue(db())
  mocks.resolveCustomerBaseUrl.mockResolvedValue('https://events.example.com/some/path?x=1')
  mocks.toBuffer.mockResolvedValue(Buffer.from('png'))
})

describe('GET /api/host/events/[id]/qr', () => {
  it('401s without a host session', async () => {
    mocks.getCurrentHost.mockResolvedValue(null)
    const res = await GET(req(), params)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it("404s for another host's event", async () => {
    state.event = { id: 'e1', host_id: 'someone-else', slug: 'summer-run' }
    const res = await GET(req(), params)
    expect(res.status).toBe(404)
    expect(mocks.toBuffer).not.toHaveBeenCalled()
  })

  it('404s for a missing event', async () => {
    state.event = null
    expect((await GET(req(), params)).status).toBe(404)
  })

  it('404s with the no-link message for an event with no slug', async () => {
    state.event = { id: 'e1', host_id: 'h1', slug: null }
    const res = await GET(req(), params)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('This event has no public link yet.')
    expect(mocks.toBuffer).not.toHaveBeenCalled()
  })

  it('answers a PNG whose QR text is the origin-only event URL with utm_source=qr', async () => {
    const res = await GET(req(), params)
    expect(res.status).toBe(200)
    expect(mocks.resolveCustomerBaseUrl).toHaveBeenCalledWith(expect.anything(), 'loc1')
    expect(mocks.toBuffer.mock.calls[0][0]).toBe('https://events.example.com/event/summer-run?utm_source=qr')
    expect(mocks.toBuffer.mock.calls[0][1]).toMatchObject({ type: 'png', width: 800, margin: 2, errorCorrectionLevel: 'M' })
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="summer-run-qr.png"')
  })

  it('500s when the public URL cannot be built', async () => {
    mocks.resolveCustomerBaseUrl.mockRejectedValue(new Error('boom'))
    const res = await GET(req(), params)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not build the link for this event. Try again shortly.' })
    expect(mocks.logError).toHaveBeenCalledWith('host-event-qr', 'public url unavailable', expect.objectContaining({ eventId: 'e1' }))
  })
})
