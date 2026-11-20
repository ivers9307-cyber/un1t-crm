// AUDITCSV.1 (October audit A21) — the audit CSV pages past PostgREST's
// 1,000-row cap, and says so when more rows matched than its export limit.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

vi.mock('@/lib/auth', async (orig) => ({ ...(await orig()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (orig) => ({ ...(await orig()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, CSV_MAX_ROWS } = await import('./route.js')

const L = 'a0000000-0000-0000-0000-000000000001'
const MASTER = { id: 'm1', role: 'master', profileRole: 'master', activeLocation: { id: L }, locations: [{ id: L, role: 'owner' }], rolesByLocation: { [L]: 'owner' } }
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const events = (n) => Array.from({ length: n }, (_, i) => ({
  id: uid(i + 1),
  occurred_at: new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString(),
  category: 'business', action: `act_${i}`, location_id: L,
}))
const csv = (qs = '') => GET(new Request(`http://localhost/api/admin/audit-log?format=csv${qs}`))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('GET /api/admin/audit-log?format=csv', () => {
  it('a 1,500-event set exports every row under a 1,000-row read cap', async () => {
    createServerClient.mockReturnValue(createFakeDb({ tables: { audit_events: events(1500), locations: [{ id: L, name: 'Studio' }] } }))
    const res = await csv()
    expect(res.status).toBe(200)
    expect(res.headers.get('x-export-rows')).toBe('1500')
    expect(res.headers.get('x-export-truncated')).toBe('false')
    const text = await res.text()
    expect(text.startsWith('#')).toBe(false)
    expect(new Set(text.match(/act_\d+/g)).size).toBe(1500)
  })

  it('more matches than the export limit: the file and the headers say it is incomplete', async () => {
    const rows = events(CSV_MAX_ROWS + 5)
    createServerClient.mockReturnValue(createFakeDb({ tables: { audit_events: rows, locations: [{ id: L, name: 'Studio' }] } }))
    const res = await csv()
    expect(res.headers.get('x-export-truncated')).toBe('true')
    expect(res.headers.get('x-export-total')).toBe(String(CSV_MAX_ROWS + 5))
    expect(res.headers.get('x-export-rows')).toBe(String(CSV_MAX_ROWS))
    expect((await res.text()).split('\n')[0]).toMatch(/^# Export incomplete: 20000 of 20005/)
  })

  it('a failed read answers 500 without database text', async () => {
    createServerClient.mockReturnValue(createFakeDb({ tables: { audit_events: [] }, errors: { audit_events: { select: { message: 'relation secret_r does not exist' } } } }))
    const res = await csv()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret_r')
  })
})
