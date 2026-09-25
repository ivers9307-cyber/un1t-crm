// ICSFEED.1 — the caller's OWN calendar link. This runs on the service-role
// client, so `.eq('profile_id', user.id)` IS the gate; no id parameter exists
// and a body that names one is refused.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')
const { GET, POST, DELETE } = await import('./route.js')

const ME = { id: '10000000-0000-0000-0000-00000000000a', email: 'coach@example.test' }
const sha = (t) => createHash('sha256').update(t).digest('hex')
const URL_RE = /^https:\/\/crm\.example\.test\/api\/calendar-feed\/(rcf_[A-Za-z0-9_-]{43})\.ics$/

function makeDb(resolve = () => ({ data: null, error: null })) {
  const db = fakeDb(resolve)
  createServerClient.mockReturnValue(db)
  return db
}
const post = (body) => POST(new Request('http://x/api/me/calendar-feed', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
}))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(ME)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.test')
})
afterEach(() => { vi.unstubAllEnvs() })

describe('auth', () => {
  it('401 on every verb without a session, and nothing is read', async () => {
    getCurrentUser.mockResolvedValue(null)
    const db = makeDb()
    expect((await GET()).status).toBe(401)
    expect((await post({})).status).toBe(401)
    expect((await DELETE()).status).toBe(401)
    expect(db.queries).toEqual([])
  })

  it('POST and DELETE refuse while a master views as someone (their secret would land in the master\'s browser)', async () => {
    for (const u of [
      { ...ME, impersonatingFrom: { id: 'master-1' } },
      { ...ME, supportSession: { mode: 'act_on_behalf', impersonatedUserId: ME.id } },
    ]) {
      getCurrentUser.mockResolvedValue(u)
      const db = makeDb()
      expect((await post({})).status).toBe(403)
      expect((await DELETE()).status).toBe(403)
      expect(db.queries).toEqual([])
    }
  })

  it('a body naming another profile is refused, not obeyed', async () => {
    const db = makeDb()
    expect((await post({ profile_id: 'someone-else' })).status).toBe(400)
    expect(db.queries).toEqual([])
  })
})

describe('GET — status only, never a URL', () => {
  it("reads the caller's own row and returns no hash and no URL", async () => {
    const db = makeDb(() => ({ data: { created_at: '2026-09-01T00:00:00Z', rotated_at: null, last_fetched_at: null, token_hash: 'f'.repeat(64) }, error: null }))
    const res = await GET()
    const body = await res.json()
    expect(body).toEqual({ success: true, data: { active: true, created_at: '2026-09-01T00:00:00Z', rotated_at: null, last_fetched_at: null } })
    expect(queriesOf(db, 'staff_calendar_feeds')[0].eq).toEqual({ profile_id: ME.id })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('500 on a failed read', async () => {
    makeDb(() => ({ data: null, error: { message: 'down' } }))
    expect((await GET()).status).toBe(500)
  })
})

describe('POST — make a link', () => {
  it('creates one and returns the three links ONCE, with no-store', async () => {
    const db = makeDb()
    const res = await post(undefined)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const { data } = await res.json()
    const token = data.url.match(URL_RE)[1]
    expect(data.webcal_url).toBe(data.url.replace('https://', 'webcal://'))
    expect(data.google_url).toBe(`https://calendar.google.com/calendar/render?cid=${encodeURIComponent(data.webcal_url)}`)
    expect(data.replaced).toBe(false)
    const [ins] = queriesOf(db, 'staff_calendar_feeds', 'insert')
    expect(ins.payload).toEqual({ profile_id: ME.id, token_hash: sha(token) })
  })

  it('409 feed_exists when a link already exists and replace was not asked for', async () => {
    makeDb(() => ({ data: null, error: { code: '23505', message: 'duplicate key' } }))
    const res = await post({})
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, code: 'feed_exists' })
    expect(JSON.stringify(body)).not.toContain('rcf_')
  })

  it('replace: true swaps the hash on the caller\'s own row', async () => {
    const db = makeDb((q) => (q.action === 'update' ? { data: [{ profile_id: ME.id }], error: null } : { data: null, error: null }))
    const { data } = await (await post({ replace: true })).json()
    const token = data.url.match(URL_RE)[1]
    expect(data.replaced).toBe(true)
    const [u] = queriesOf(db, 'staff_calendar_feeds', 'update')
    expect(u.eq).toEqual({ profile_id: ME.id })
    expect(u.payload.token_hash).toBe(sha(token))
  })

  it('500 and no link when the write fails', async () => {
    makeDb(() => ({ data: null, error: { code: 'XX000', message: 'down' } }))
    const res = await post({})
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('rcf_')
  })

  it('500 and NO row written when the app URL is not configured (no orphaned link)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const db = makeDb()
    expect((await post({})).status).toBe(500)
    expect(db.queries).toEqual([])
  })
})

describe('DELETE — turn it off', () => {
  it("deletes the caller's own row", async () => {
    const db = makeDb(() => ({ data: [{ profile_id: ME.id }], error: null }))
    const body = await (await DELETE()).json()
    expect(body).toEqual({ success: true, data: { revoked: true } })
    expect(queriesOf(db, 'staff_calendar_feeds', 'delete')[0].eq).toEqual({ profile_id: ME.id })
  })

  it('turning off nothing is still a success (idempotent)', async () => {
    makeDb(() => ({ data: [], error: null }))
    expect(await (await DELETE()).json()).toEqual({ success: true, data: { revoked: false } })
  })
})
