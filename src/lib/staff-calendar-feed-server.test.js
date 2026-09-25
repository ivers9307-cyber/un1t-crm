// ICSFEED.1 — the calendar feed's database work.
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { fakeDb, queriesOf } from '@/lib/time-off.test-helpers'
import {
  FEED_SHIFT_SELECT, FEED_TOKEN_RL, TOUCH_INTERVAL_MS,
  resolveCalendarFeed, loadFeedShifts, touchFeedFetched,
  getCalendarFeedStatus, issueCalendarFeed, revokeCalendarFeed,
} from './staff-calendar-feed-server'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const TOKEN = `rcf_${'A'.repeat(43)}`
const HASH = createHash('sha256').update(TOKEN).digest('hex')
const ME = '10000000-0000-0000-0000-00000000000a'
const sha = (t) => createHash('sha256').update(t).digest('hex')

function dbFor({ feed = { profile_id: ME, last_fetched_at: null }, feedError = null, profile = { id: ME, active: true, deleted_at: null }, profileError = null } = {}) {
  return fakeDb((q) => {
    if (q.table === 'staff_calendar_feeds') return { data: feed, error: feedError }
    if (q.table === 'profiles') return { data: profile, error: profileError }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
}

describe('resolveCalendarFeed', () => {
  it('a malformed token is unknown and costs no query', async () => {
    const db = dbFor()
    expect(await resolveCalendarFeed(db, 'nope')).toEqual({ status: 'unknown' })
    expect(db.queries).toEqual([])
  })

  it('looks the HASH up, never the plaintext, then reads only that profile', async () => {
    const db = dbFor()
    const r = await resolveCalendarFeed(db, TOKEN)
    expect(r).toEqual({ status: 'ok', feed: { profile_id: ME, last_fetched_at: null }, tokenHash: HASH })
    const [lookup] = queriesOf(db, 'staff_calendar_feeds')
    expect(lookup.eq).toEqual({ token_hash: HASH })
    expect(JSON.stringify(db.queries)).not.toContain(TOKEN)
    const [p] = queriesOf(db, 'profiles')
    expect(p.eq).toEqual({ id: ME })
    expect(p.columns).toBe('id, active, deleted_at')
  })

  it('an unknown hash is unknown, and no profile is read', async () => {
    const db = dbFor({ feed: null })
    expect(await resolveCalendarFeed(db, TOKEN)).toEqual({ status: 'unknown' })
    expect(queriesOf(db, 'profiles')).toEqual([])
  })

  it('a deactivated person, a tombstone and a missing profile are all inactive (D5)', async () => {
    for (const profile of [
      { id: ME, active: false, deleted_at: null },
      { id: ME, active: false, deleted_at: '2026-09-20T00:00:00Z' },
      null,
    ]) {
      expect(await resolveCalendarFeed(dbFor({ profile }), TOKEN)).toEqual({ status: 'inactive' })
    }
  })

  it('a missing `active` never locks anyone out (the getCurrentUser rule: strictly === false)', async () => {
    const r = await resolveCalendarFeed(dbFor({ profile: { id: ME, deleted_at: null } }), TOKEN)
    expect(r.status).toBe('ok')
  })

  it('a failed read is an error, not an unknown token', async () => {
    expect(await resolveCalendarFeed(dbFor({ feedError: { message: 'boom' } }), TOKEN)).toEqual({ status: 'error' })
    expect(await resolveCalendarFeed(dbFor({ profileError: { message: 'boom' } }), TOKEN)).toEqual({ status: 'error' })
  })
})

describe('loadFeedShifts', () => {
  const ROWS = [
    { id: 'a1', shift_blocks: { location_id: 'loc-1' } },
    { id: 'a2', shift_blocks: { location_id: 'loc-2' } },
    { id: 'a3', shift_blocks: { location_id: 'loc-1' } },
  ]
  const LOCS = [{ id: 'loc-1', name: 'Studio One' }, { id: 'loc-2', name: 'Studio Two' }]
  const shiftsDb = ({ shiftError = null, locError = null, rows = ROWS } = {}) => fakeDb((q) => {
    if (q.table === 'shift_assignments') return { data: shiftError ? null : rows, error: shiftError }
    if (q.table === 'locations') return { data: locError ? null : LOCS, error: locError }
    throw new Error(`unexpected ${q.table}`)
  })

  it("reads only the person's own assignments, inside the window", async () => {
    const db = shiftsDb()
    const r = await loadFeedShifts(db, ME, { from: '2026-09-11', to: '2026-11-20' })
    expect(r.error).toBe(null)
    const [q] = queriesOf(db, 'shift_assignments')
    expect(q.eq).toEqual({ profile_id: ME })
    expect(q.calls).toContainEqual(['gte', 'shift_blocks.block_date', '2026-09-11'])
    expect(q.calls).toContainEqual(['lte', 'shift_blocks.block_date', '2026-11-20'])
    expect(q.columns).toBe(FEED_SHIFT_SELECT)
  })

  it('selects no colleague, no note, no pay', () => {
    expect(FEED_SHIFT_SELECT).not.toMatch(/profiles|notes|partial_reason|rate|salary|min_coaches|max_coaches/)
  })

  it('reads each studio once, and keys them by id', async () => {
    const db = shiftsDb()
    const r = await loadFeedShifts(db, ME, { from: '2026-09-11', to: '2026-11-20' })
    const locQs = queriesOf(db, 'locations')
    expect(locQs).toHaveLength(1)
    expect(locQs[0].columns).toBe('id, name, address, timezone')
    expect(locQs[0].calls).toContainEqual(['in', 'id', ['loc-1', 'loc-2']])
    expect(Object.keys(r.locationsById).sort()).toEqual(['loc-1', 'loc-2'])
    expect(r.rows).toHaveLength(3)
  })

  it('no shifts → no studio read', async () => {
    const db = shiftsDb({ rows: [] })
    const r = await loadFeedShifts(db, ME, { from: '2026-09-11', to: '2026-11-20' })
    expect(r).toEqual({ rows: [], locationsById: {}, error: null })
    expect(queriesOf(db, 'locations')).toEqual([])
  })

  it('either read failing is an error the route turns into 503 (never an empty calendar)', async () => {
    expect((await loadFeedShifts(shiftsDb({ shiftError: { message: 'x' } }), ME, { from: 'a', to: 'b' })).error).toBeTruthy()
    expect((await loadFeedShifts(shiftsDb({ locError: { message: 'x' } }), ME, { from: 'a', to: 'b' })).error).toBeTruthy()
  })
})

describe('touchFeedFetched (D10)', () => {
  const NOW = Date.parse('2026-09-25T10:00:00Z')
  const touchDb = (error = null) => fakeDb(() => ({ data: null, error }))

  it('stamps a feed never fetched, or last fetched 15+ minutes ago', async () => {
    for (const last of [null, new Date(NOW - TOUCH_INTERVAL_MS).toISOString()]) {
      const db = touchDb()
      await touchFeedFetched(db, { profile_id: ME, last_fetched_at: last }, NOW, HASH)
      const [u] = queriesOf(db, 'staff_calendar_feeds', 'update')
      expect(u.payload).toEqual({ last_fetched_at: '2026-09-25T10:00:00.000Z' })
      expect(u.eq).toEqual({ profile_id: ME, token_hash: HASH })
    }
  })

  it('stamps only the link that was fetched: a poll on an OLD token racing a rotation never marks the NEW link as checked', async () => {
    const db = touchDb()
    await touchFeedFetched(db, { profile_id: ME, last_fetched_at: null }, NOW, HASH)
    const [u] = queriesOf(db, 'staff_calendar_feeds', 'update')
    // Pinned by the hash as well as the person: after a rotation this matches
    // zero rows, which is the right answer (the old link was not "checked").
    expect(u.eq.token_hash).toBe(HASH)
  })

  it('with no hash to pin to, stamps nothing rather than stamping by person alone', async () => {
    const db = touchDb()
    await touchFeedFetched(db, { profile_id: ME, last_fetched_at: null }, NOW)
    expect(db.queries).toEqual([])
  })

  it('skips a feed fetched in the last 15 minutes', async () => {
    const db = touchDb()
    await touchFeedFetched(db, { profile_id: ME, last_fetched_at: new Date(NOW - 60_000).toISOString() }, NOW, HASH)
    expect(db.queries).toEqual([])
  })

  it('a failed stamp resolves (logged), it never fails the feed', async () => {
    const { logWarn } = await import('@/lib/log')
    await expect(touchFeedFetched(touchDb({ message: 'boom' }), { profile_id: ME, last_fetched_at: null }, NOW, HASH)).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('management: status, issue, revoke', () => {
  it('status maps the row and never returns the hash', async () => {
    const db = fakeDb(() => ({ data: { created_at: 'c', rotated_at: null, last_fetched_at: 'l', token_hash: HASH }, error: null }))
    const r = await getCalendarFeedStatus(db, ME)
    expect(r).toEqual({ data: { active: true, created_at: 'c', rotated_at: null, last_fetched_at: 'l' }, error: null })
    expect(queriesOf(db, 'staff_calendar_feeds')[0].eq).toEqual({ profile_id: ME })
  })

  it('status with no row is inactive', async () => {
    const r = await getCalendarFeedStatus(fakeDb(() => ({ data: null, error: null })), ME)
    expect(r.data).toEqual({ active: false, created_at: null, rotated_at: null, last_fetched_at: null })
  })

  it('issue (no replace) INSERTS the hash of the token it returns', async () => {
    const db = fakeDb(() => ({ data: null, error: null }))
    const r = await issueCalendarFeed(db, ME)
    expect(r.token).toMatch(/^rcf_[A-Za-z0-9_-]{43}$/)
    expect(r.replaced).toBe(false)
    const [ins] = queriesOf(db, 'staff_calendar_feeds', 'insert')
    expect(ins.payload).toEqual({ profile_id: ME, token_hash: sha(r.token) })
    expect(queriesOf(db, 'staff_calendar_feeds', 'update')).toEqual([])
  })

  it('issue (no replace) over an existing link is a conflict, and no token escapes', async () => {
    const db = fakeDb(() => ({ data: null, error: { code: '23505', message: 'duplicate key' } }))
    expect(await issueCalendarFeed(db, ME)).toEqual({ conflict: true })
  })

  it('issue (replace) is ONE update of the hash: the old link dies in the same statement', async () => {
    const NOW = Date.parse('2026-09-25T10:00:00Z')
    const db = fakeDb((q) => (q.action === 'update' ? { data: [{ profile_id: ME }], error: null } : { data: null, error: null }))
    const r = await issueCalendarFeed(db, ME, { replace: true, nowMs: NOW })
    expect(r.replaced).toBe(true)
    const [u] = queriesOf(db, 'staff_calendar_feeds', 'update')
    expect(u.payload).toEqual({ token_hash: sha(r.token), rotated_at: '2026-09-25T10:00:00.000Z', last_fetched_at: null })
    expect(u.eq).toEqual({ profile_id: ME })
    expect(queriesOf(db, 'staff_calendar_feeds', 'insert')).toEqual([])
  })

  it('issue (replace) with nothing to replace creates one', async () => {
    const db = fakeDb((q) => (q.action === 'update' ? { data: [], error: null } : { data: null, error: null }))
    const r = await issueCalendarFeed(db, ME, { replace: true })
    expect(r.replaced).toBe(false)
    expect(queriesOf(db, 'staff_calendar_feeds', 'insert')).toHaveLength(1)
  })

  it('a failed write returns the error and no token', async () => {
    const db = fakeDb(() => ({ data: null, error: { code: 'XX000', message: 'boom' } }))
    const r = await issueCalendarFeed(db, ME)
    expect(r.token).toBeUndefined()
    expect(r.error).toBeTruthy()
  })

  it("revoke deletes only the caller's row and says whether there was one", async () => {
    const db = fakeDb(() => ({ data: [{ profile_id: ME }], error: null }))
    expect(await revokeCalendarFeed(db, ME)).toEqual({ revoked: true, error: null })
    const [d] = queriesOf(db, 'staff_calendar_feeds', 'delete')
    expect(d.eq).toEqual({ profile_id: ME })
    expect(await revokeCalendarFeed(fakeDb(() => ({ data: [], error: null })), ME)).toEqual({ revoked: false, error: null })
  })
})

describe('FEED_TOKEN_RL (D8)', () => {
  it('is a per-token budget roomy enough for three devices on a 5-minute refresh', () => {
    expect(FEED_TOKEN_RL).toEqual({ max: 30, windowMs: 15 * 60_000 })
  })
})
