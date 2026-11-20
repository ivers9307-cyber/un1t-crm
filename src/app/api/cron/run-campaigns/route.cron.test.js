// ROUTEWRAP.C12 — the campaign send cron on defineCron. The wrapper owns the
// secret check and the 'run-campaigns' stamp; the job's promote and send steps
// are unchanged. These tests pin who is refused, when the row is stamped, and
// that error text from a tick or the database never reaches the response.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const h = vi.hoisted(() => ({ db: null, clients: 0 }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => { h.clients++; return h.db } }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/campaign-sender', () => ({ tickCampaignSend: vi.fn(async () => ({ sent: 2, bounced: 0 })) }))
vi.mock('@/lib/campaign-resend', () => ({ spawnDueResends: vi.fn(async () => ({ spawned: 0, errors: [] })) }))
vi.mock('@/lib/usage-caps', () => ({ getEmailCapStatus: vi.fn(async () => ({ capped: false })) }))

const { GET } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError } = await import('@/lib/log')
const { tickCampaignSend } = await import('@/lib/campaign-sender')
const { spawnDueResends } = await import('@/lib/campaign-resend')

const LOC = { id: 'l0000000-0000-0000-0000-000000000001', name: 'Studio', slug: 'studio' }
const PAST = new Date(Date.now() - 60_000).toISOString()
const SCHEDULED = {
  id: 'c0000000-0000-0000-0000-000000000001', location_id: LOC.id, name: 'Offer', status: 'scheduled',
  subject: 'Weekend offer', html_content: '<p>Hi</p>', scheduled_at: PAST, updated_at: PAST, created_at: PAST,
}
const QUEUED = {
  id: 'c0000000-0000-0000-0000-000000000002', location_id: LOC.id, name: 'Queued', status: 'queued',
  subject: 'Hello', html_content: '<p>Hi</p>', updated_at: PAST, created_at: PAST, last_error: null, send_started_at: null,
}

const req = (authorization = 'Bearer shh') =>
  new Request('https://x.test/api/cron/run-campaigns', { headers: authorization ? { authorization } : {} })

const seed = (campaigns = [SCHEDULED, QUEUED]) => createFakeDb({ tables: { locations: [LOC], campaigns } })

/** Fail the Nth select on `campaigns` (0 = the due read, 1 = the pick). */
function failCampaignSelect(db, nth, error) {
  const from = db.from.bind(db)
  let seen = 0
  db.from = (table) => {
    const b = from(table)
    if (table !== 'campaigns') return b
    const run = b.run.bind(b)
    b.run = () => {
      if (b.op === 'select' && seen++ === nth) { db.calls.push({ table, op: 'select', failed: true }); return { data: null, error, count: null } }
      return run()
    }
    return b
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  h.clients = 0
  h.db = seed()
})

describe('GET /api/cron/run-campaigns on defineCron', () => {
  it('refuses a missing or wrong secret, and an unset one: nothing read, sent or stamped', async () => {
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await GET(req())).status).toBe(401)
    expect(h.clients).toBe(0)
    expect(h.db.calls).toHaveLength(0)
    expect(tickCampaignSend).not.toHaveBeenCalled()
    expect(spawnDueResends).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run promotes, ticks and stamps exactly its own row', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, promoted: 1, ticks: 2, sent: 4, errors: [] })
    expect(h.db.tables.campaigns.find((c) => c.id === SCHEDULED.id).status).toBe('queued')
    expect(tickCampaignSend).toHaveBeenCalledTimes(2)
    expect(stampHeartbeat.mock.calls).toEqual([['run-campaigns']])
  })

  it('nothing due is still a clean run: stamped', async () => {
    h.db = seed([])
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(tickCampaignSend).not.toHaveBeenCalled()
    expect(stampHeartbeat.mock.calls).toEqual([['run-campaigns']])
  })

  it('a failing tick is one campaign, not the run: stamped, with a fixed line and no provider text', async () => {
    tickCampaignSend.mockResolvedValueOnce({ phase: 'send', error: 'Postmark 422: recipient pat@example.com inactive' })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.errors).toEqual([{ campaign_id: expect.any(String), phase: 'send', error: 'Tick failed' }])
    expect(JSON.stringify(body)).not.toContain('example.com')
    // The detail still lands on the campaign row for the operator.
    expect(h.db.tables.campaigns.some((c) => String(c.last_error).includes('Postmark 422'))).toBe(true)
    expect(stampHeartbeat.mock.calls).toEqual([['run-campaigns']])
  })

  it('a thrown tick and a tick warning carry no error text either', async () => {
    tickCampaignSend
      .mockRejectedValueOnce(new Error('relation "x" does not exist'))
      .mockResolvedValueOnce({ phase: 'bundle_disabled', warning: 'rotation bump failed: connection reset' })
    const body = await (await GET(req())).json()
    expect(body.errors).toEqual([{ campaign_id: expect.any(String), error: 'Tick failed' }])
    expect(body.warnings).toEqual([{ campaign_id: expect.any(String), phase: 'bundle_disabled', warning: 'Tick warning' }])
    expect(JSON.stringify(body)).not.toMatch(/does not exist|connection reset/)
    expect(stampHeartbeat.mock.calls).toEqual([['run-campaigns']])
  })

  it('CHANGED: an unreadable due list still ticks the queued campaigns, then answers 500 and does not stamp', async () => {
    failCampaignSelect(h.db, 0, { message: 'permission denied for table campaigns' })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'Could not read the scheduled campaigns', promoted: 0, ticks: 1 })
    expect(JSON.stringify(body)).not.toContain('permission denied')
    expect(tickCampaignSend).toHaveBeenCalledTimes(1) // the queued one: sends are unchanged
    expect(spawnDueResends).toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('cron.run-campaigns', expect.any(String), expect.objectContaining({ err: expect.any(Object) }))
  })

  it('an unreadable pick: 500, fixed line, no database text, nothing ticked or stamped', async () => {
    failCampaignSelect(h.db, 1, { message: 'column campaigns.secret_col does not exist' })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'Could not read the campaigns to send' })
    expect(JSON.stringify(body)).not.toContain('secret_col')
    expect(tickCampaignSend).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a throw outside the per-campaign catch answers the fixed 500 and stamps nothing', async () => {
    const { getEmailCapStatus } = await import('@/lib/usage-caps')
    getEmailCapStatus.mockRejectedValueOnce(new Error('cap read failed for pat@example.com'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Cron run failed' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
