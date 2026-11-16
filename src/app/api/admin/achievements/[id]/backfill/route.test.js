// ACHIEVEBACKFILL.1 (October audit A19) — the backfill reads a batch's whole
// session history (paged past 1,000 rows) and awards a rule met on an earlier
// session; a failed write is reported, and the unique key makes a re-run safe.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'm', profileRole: 'master' })) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }))

const RULE = { id: 'r1', slug: 'first_z5', rule_type: 'first_event', rule_config: { event: 'z5_minute' }, is_active: true }
let sessions, upserts, upsertError
function session(i, contact, z5 = 0) {
  return {
    id: `s${String(i).padStart(5, '0')}`, contact_id: contact, location_id: 'loc1',
    started_at: new Date(Date.UTC(2026, 6, 1) + i * 60_000).toISOString(),
    ended_at: new Date(Date.UTC(2026, 6, 1) + i * 60_000 + 30_000).toISOString(),
    zones_seconds: z5 ? { 5: z5 } : {}, bookings: null,
  }
}
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from(table) {
      const q = { range: [0, 999], isFullRead: false }
      for (const m of ['select', 'eq', 'not', 'gte', 'in', 'order']) q[m] = () => q
      q.range = (from, to) => {
        const rows = table === 'heart_rate_sessions' ? sessions.slice(from, to + 1)
          : []
        return Promise.resolve({ data: rows, error: null })
      }
      q.single = async () => ({ data: RULE, error: null })
      q.upsert = async (rows) => { upserts.push(...rows); return { error: upsertError, count: upsertError ? null : rows.length } }
      return q
    },
  }),
}))

const { POST } = await import('./route.js')
const call = () => POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'r1' }) })

beforeEach(() => {
  upserts = []
  upsertError = null
  // 1,500 sessions for one member; only session #200 has a Z5 minute, and the
  // LATEST one does not. A second member with no Z5 ever.
  sessions = Array.from({ length: 1500 }, (_, i) => session(i, 'c1', i === 200 ? 90 : 0))
  sessions.push(session(1600, 'c2'))
})

describe('POST /api/admin/achievements/[id]/backfill', () => {
  it('reads past 1,000 sessions and awards at the earlier session that qualified', async () => {
    const res = await call()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.scanned).toBe(2)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ contact_id: 'c1', rule_id: 'r1', source_session_id: 's00200' })
    expect(upserts[0].metadata).toMatchObject({ z5Seconds: 90, backfilled: true })
  })

  it('a failed write is reported, not counted as granted', async () => {
    upsertError = { message: 'down' }
    const body = await (await call()).json()
    expect(body.granted).toBe(0)
    expect(body.insert_failures).toBe(1)
  })
})
