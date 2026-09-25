// ICSFEED.1 — the anonymous calendar feed. The token in the path is the only
// credential (calendar apps cannot hold a session), so this suite pins every
// refusal to one indistinguishable 404, and pins that a read failure is a 503
// and NEVER an empty 200 (a subscribed calendar replaces its whole copy).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response('{"success":false}', { status: 429 })),
}))
vi.mock('@/lib/dublin-time', async (importOriginal) => ({
  ...(await importOriginal()),
  dublinTodayStr: () => '2026-09-25',
}))

const { createServerClient } = await import('@/lib/supabase')
const { checkRateLimit, rateLimitResponse } = await import('@/lib/rate-limit')
const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')
const { GET } = await import('./route.js')

const TOKEN = `rcf_${'A'.repeat(43)}`
const HASH = createHash('sha256').update(TOKEN).digest('hex')
const ME = '10000000-0000-0000-0000-00000000000a'
const LOC = { id: 'loc-1', name: 'Studio One', address: null, timezone: 'Europe/Dublin' }

function row(id, block = {}, over = {}) {
  return {
    id, status: 'scheduled', start_time_override: null, end_time_override: null, updated_at: '2026-09-20T10:00:00Z',
    ...over,
    shift_blocks: {
      location_id: 'loc-1', block_date: '2026-09-28', start_time: '06:00:00', end_time: '07:00:00',
      updated_at: '2026-09-20T10:00:00Z', rosters: { status: 'published' }, shift_templates: { name: 'Morning' },
      ...block,
    },
  }
}

function makeDb({
  feed = { profile_id: ME, last_fetched_at: null }, feedError = null,
  profile = { id: ME, active: true, deleted_at: null },
  rows = [row('a1'), row('draft', { rosters: { status: 'draft' } }), row('gone', {}, { status: 'cancelled' })],
  shiftError = null,
} = {}) {
  const db = fakeDb((q) => {
    if (q.table === 'staff_calendar_feeds' && q.action === 'select') return { data: feed, error: feedError }
    if (q.table === 'staff_calendar_feeds' && q.action === 'update') return { data: null, error: null }
    if (q.table === 'profiles') return { data: profile, error: null }
    if (q.table === 'shift_assignments') return { data: shiftError ? null : rows, error: shiftError }
    if (q.table === 'locations') return { data: [LOC], error: null }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
  createServerClient.mockReturnValue(db)
  return db
}

const call = (file) => GET(
  new Request(`https://crm.example.test/api/calendar-feed/${file}`),
  { params: Promise.resolve({ file }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date(), retryAfterSec: 0 })
})

describe('GET /api/calendar-feed/[file] — refusals', () => {
  it('404s a file that is not a feed token, and reads nothing', async () => {
    for (const file of ['feed.ics', `${TOKEN}.txt`, 'rcf_short.ics', `${TOKEN}.ics.ics`]) {
      const db = makeDb()
      const res = await call(file)
      expect(res.status, file).toBe(404)
      expect(db.queries).toEqual([])
    }
  })

  it('an unknown, a deactivated and a tombstoned link get the SAME 404, and no shift is read', async () => {
    const answers = []
    for (const opts of [
      { feed: null },
      { profile: { id: ME, active: false, deleted_at: null } },
      { profile: { id: ME, active: false, deleted_at: '2026-09-20T00:00:00Z' } },
    ]) {
      const db = makeDb(opts)
      const res = await call(`${TOKEN}.ics`)
      answers.push([res.status, await res.text(), res.headers.get('cache-control')])
      expect(queriesOf(db, 'shift_assignments')).toEqual([])
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1)
    expect(answers[0]).toEqual([404, 'Not found', 'no-store'])
  })

  it('looks the token up by its sha256', async () => {
    const db = makeDb()
    await call(`${TOKEN}.ics`)
    expect(queriesOf(db, 'staff_calendar_feeds')[0].eq).toEqual({ token_hash: HASH })
  })

  it('a failed lookup is 503 + Retry-After, not a 404 that would read as "link revoked"', async () => {
    makeDb({ feedError: { message: 'down' } })
    const res = await call(`${TOKEN}.ics`)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('900')
  })

  it('a failed shift read is 503, NEVER an empty 200 (that would wipe every subscriber\'s shifts)', async () => {
    makeDb({ shiftError: { message: 'down' } })
    const res = await call(`${TOKEN}.ics`)
    expect(res.status).toBe(503)
    expect(await res.text()).not.toContain('BEGIN:VCALENDAR')
  })

  it('rate-limits per TOKEN (never per IP) and reads no shift when refused', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(), retryAfterSec: 60 })
    const db = makeDb()
    const res = await call(`${TOKEN}.ics`)
    expect(res.status).toBe(429)
    expect(rateLimitResponse).toHaveBeenCalled()
    const [, key, budget] = checkRateLimit.mock.calls[0]
    expect(key).toBe(`calfeed:token:${HASH.slice(0, 32)}`)
    expect(budget).toEqual({ max: 30, windowMs: 900_000 })
    expect(queriesOf(db, 'shift_assignments')).toEqual([])
  })
})

describe('GET /api/calendar-feed/[file] — the feed', () => {
  it('answers text/calendar with the published live shifts only', async () => {
    makeDb()
    const res = await call(`${TOKEN}.ics`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('private, max-age=900')
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    const body = await res.text()
    expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(body).toContain('UID:shift-a1@repset.ie')
    expect(body).toContain('DTSTART:20260928T050000Z')
    expect(body).not.toContain('shift-draft')
    expect(body).not.toContain('shift-gone')
  })

  it('also answers without the .ics suffix', async () => {
    makeDb()
    expect((await call(TOKEN)).status).toBe(200)
  })

  it("reads the resolved person's own shifts, two weeks back to eight ahead of Dublin today", async () => {
    const db = makeDb()
    await call(`${TOKEN}.ics`)
    const [q] = queriesOf(db, 'shift_assignments')
    expect(q.eq).toEqual({ profile_id: ME })
    expect(q.calls).toContainEqual(['gte', 'shift_blocks.block_date', '2026-09-11'])
    expect(q.calls).toContainEqual(['lte', 'shift_blocks.block_date', '2026-11-20'])
  })

  it('stamps last_fetched_at when stale, and not when fresh', async () => {
    let db = makeDb()
    await call(`${TOKEN}.ics`)
    expect(queriesOf(db, 'staff_calendar_feeds', 'update')).toHaveLength(1)
    db = makeDb({ feed: { profile_id: ME, last_fetched_at: new Date(Date.now() - 60_000).toISOString() } })
    await call(`${TOKEN}.ics`)
    expect(queriesOf(db, 'staff_calendar_feeds', 'update')).toEqual([])
  })
})
