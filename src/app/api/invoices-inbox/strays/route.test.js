// GET /api/invoices-inbox/strays through the real withAuth wrapper: masters
// only, newest first, last 90 days, named columns.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { logError } = await import('@/lib/log')
const { GET } = await import('./route.js')

const MASTER = { id: 'u-master', profileRole: 'master', isMaster: true }
const OWNER = { id: 'u-owner', profileRole: 'owner', isMaster: false }
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString()
const stray = (id, n, extra = {}) => ({
  id, email_message_id: `m-${id}`, to_address: 'a@example.com', from_address: 'b@example.com',
  subject: `Subject ${id}`, reason: 'unknown_slug', slug: 'x', received_at: daysAgo(n), ...extra,
})
const get = () => GET(new Request('http://localhost/api/invoices-inbox/strays'))

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({
    tables: {
      invoice_inbound_strays: [
        stray('00000000-0000-4000-8000-000000000001', 5),
        stray('00000000-0000-4000-8000-000000000002', 1),
        stray('00000000-0000-4000-8000-000000000003', 120),
      ],
    },
  }))
})

describe('GET /api/invoices-inbox/strays', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 for a non-master, with no stray data in the body', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await get()
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
  })

  it('a master gets rows newest first, the 120-day-old one left out, named columns only', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((r) => r.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ])
    expect(Object.keys(body.data[0]).sort()).toEqual(
      ['from_address', 'id', 'reason', 'received_at', 'slug', 'subject', 'to_address'],
    )
  })

  it('500 with the fixed message, and a log, when the read fails', async () => {
    createServerClient.mockReturnValue(createFakeDb({
      tables: { invoice_inbound_strays: [] },
      errors: { invoice_inbound_strays: { select: { message: 'boom' } } },
    }))
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await get()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load unmatched emails.' })
    expect(logError).toHaveBeenCalled()
  })
})
