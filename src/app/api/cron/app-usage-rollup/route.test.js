import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn() }))
vi.mock('@/lib/location-time', () => ({ getLocationZones: vi.fn(async () => new Map([['loc1', 'Europe/Dublin']])) }))

const { createServerClient } = await import('@/lib/supabase')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { GET } = await import('./route.js')

const NOW = Date.UTC(2026, 9, 26, 12, 0)
const iso = (ms) => new Date(ms).toISOString()

// Records every terminal call; `failOn` makes one table+op return an error.
function makeDb({ tables = {}, failOn = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      let op = 'select'
      const filters = []
      const b = {
        select() { return b },
        gte(c, v) { filters.push(['gte', c, v]); return b },
        lt(c, v) { filters.push(['lt', c, v]); return b },
        in(c, v) { filters.push(['in', c, v]); return b },
        order() { return b },
        limit() { return b },
        range() { return b },
        upsert(rows, opts) { op = 'upsert'; calls.push({ table, op, rows, opts }); return b },
        delete() { op = 'delete'; return b },
        then(resolve) {
          if (op === 'delete') calls.push({ table, op, filters })
          const error = failOn && failOn.table === table && failOn.op === op ? { code: 'X' } : null
          const data = op === 'select' && !filters.some((f) => f[0] === 'lt') ? (tables[table] || []) : []
          return Promise.resolve({ data: error ? null : data, error }).then(resolve)
        },
      }
      return b
    },
  }
}

const req = (auth = 'Bearer s3cret') => new Request('http://x/api/cron/app-usage-rollup', { headers: { authorization: auth } })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 's3cret'
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

describe('GET /api/cron/app-usage-rollup', () => {
  it('401s without the cron secret', async () => {
    expect((await GET(req('Bearer nope'))).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('upserts the rebuilt days, deletes stale rows for those days, then stamps', async () => {
    const db = makeDb({
      tables: {
        app_usage_sessions: [{ id: 's1', profile_id: 'p1', location_id: 'loc1', platform: 'web', started_at: iso(NOW - 3600_000), ended_at: iso(NOW) }],
        app_usage_visits: [{ id: 'v1', session_id: 's1', profile_id: 'p1', feature: 'contacts', started_at: iso(NOW - 3600_000), ended_at: iso(NOW) }],
      },
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const upsert = db.calls.find((c) => c.op === 'upsert')
    expect(upsert.opts).toEqual({ onConflict: 'profile_id,day,platform,feature,location_key' })
    expect(upsert.rows.map((r) => [r.feature, r.platform, r.seconds])).toEqual(expect.arrayContaining([
      ['_session', 'web', 3600], ['_session', 'all', 3600], ['contacts', 'web', 3600],
    ]))
    const stale = db.calls.find((c) => c.op === 'delete' && c.table === 'app_usage_daily' && c.filters.some((f) => f[1] === 'updated_at'))
    expect(stale.filters).toEqual(expect.arrayContaining([['in', 'day', ['2026-10-25', '2026-10-26']]]))
    expect(stampHeartbeat).toHaveBeenCalledWith('app-usage-rollup', expect.objectContaining({ sessions: 1 }))
  })

  it('500s without stamping when the write fails', async () => {
    const db = makeDb({
      tables: { app_usage_sessions: [{ id: 's1', profile_id: 'p1', location_id: 'loc1', platform: 'web', started_at: iso(NOW - 60_000), ended_at: iso(NOW) }] },
      failOn: { table: 'app_usage_daily', op: 'upsert' },
    })
    createServerClient.mockReturnValue(db)
    expect((await GET(req())).status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('500s without stamping when the read fails', async () => {
    createServerClient.mockReturnValue(makeDb({ failOn: { table: 'app_usage_sessions', op: 'select' } }))
    expect((await GET(req())).status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('stamps on a quiet run with nothing to rebuild', async () => {
    createServerClient.mockReturnValue(makeDb())
    expect((await GET(req())).status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalled()
  })
})
