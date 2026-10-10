// W1.M3b — the churn digest skips locations with NO membership source
// (counted skipped_no_source) through the seam, even when they have digest
// recipients; a failed seam read is a 500 with no heartbeat.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/postmark', () => ({ sendEmail: vi.fn(async () => ({})) }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/churn-radar-data', () => ({ loadRadar: vi.fn(async () => ({ summary: { activeBase: 3 } })) }))
vi.mock('@/lib/lead-radar-data', () => ({ loadFunnel: vi.fn(async () => ({ summary: { funnelTotal: 2, funnel: {} } })) }))
vi.mock('@/lib/churn-radar-digest', () => ({ buildDigestEmail: vi.fn(() => ({ subject: 'Digest', html: '<p>x</p>' })) }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { sendEmail } from '@/lib/postmark'
import { loadRadar } from '@/lib/churn-radar-data'
import { fakeDb } from '@/lib/time-off.test-helpers'
import { ESTATE_2026_10, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
// Every location has a digest recipient, so only the seam decides who is skipped.
const ROWS = ESTATE_2026_10.map((r) => ({ ...r, churn_digest_recipients: ['ops@example.test'] }))
const dbFor = (rows, opts) => { const loc = locationsResolver(rows, opts); return fakeDb((q) => (q.table === 'locations' ? loc(q) : { data: [], error: null })) }
const visited = () => loadRadar.mock.calls.map(([, id]) => id)
beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks() })

describe('GET /api/cron/churn-radar-digest — skips locations with no membership source (W1.M3b)', () => {
  it('emails Stillorgan only, counts the five skips, stamps', async () => {
    h.db = dbFor(ROWS)
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ success: true, emails_sent: 1, skipped_no_source: 5 })
    expect(stampHeartbeat).toHaveBeenCalledWith('churn-radar-digest')
  })
  it('a failed seam read answers 500, sends nothing and does NOT stamp', async () => {
    h.db = dbFor(ROWS, { listError: { message: 'down' } })
    expect((await GET(req())).status).toBe(500)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
