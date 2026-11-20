// UN1TSYNC.10 — the daily connection-health sweep never touches un1t_online:
// the un1t.online sync owns that row's status, and grading it here as well
// flapped it against the sync.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn() }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

const PAST = new Date(Date.now() - 86400000).toISOString()

function fakeDb(rows, { readError = null, updateError = null } = {}) {
  const filters = []
  const updates = []
  const builder = {
    select() { return builder },
    eq(col, val) { filters.push(['eq', col, val]); return builder },
    neq(col, val) { filters.push(['neq', col, val]); return builder },
    then(resolve) {
      const out = rows.filter((r) => filters.every(([k, c, v]) => (k === 'eq' ? r[c] === v : r[c] !== v)))
      return resolve(readError ? { data: null, error: readError } : { data: out, error: null })
    },
  }
  const db = {
    from() {
      return {
        select: () => builder.select(),
        update(patch) {
          return { eq: (col, id) => { updates.push({ id, patch }); return Promise.resolve({ error: updateError }) } }
        },
      }
    },
  }
  return { db, filters, updates }
}

const req = (secret = 's3cret') => new Request('http://x/api/cron/connection-health', { headers: { authorization: `Bearer ${secret}` } })
const expiredInstagram = { id: 'b', platform: 'instagram', is_active: true, status: 'connected', last_error: null, token_expires_at: PAST }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 's3cret'
})

describe('GET /api/cron/connection-health', () => {
  it('skips un1t_online rows entirely (the sync owns their status)', async () => {
    const { db, filters, updates } = fakeDb([
      { id: 'a', platform: 'un1t_online', is_active: true, status: 'connected', last_error: null, token_expires_at: PAST },
      { id: 'b', platform: 'instagram', is_active: true, status: 'connected', last_error: null, token_expires_at: PAST },
    ])
    createServerClient.mockReturnValue(db)
    const res = await GET(new Request('http://x/api/cron/connection-health', { headers: { authorization: 'Bearer s3cret' } }))
    expect(res.status).toBe(200)
    expect(filters).toContainEqual(['neq', 'platform', 'un1t_online'])
    expect(updates.map((u) => u.id)).toEqual(['b'])
    expect(stampHeartbeat).toHaveBeenCalledWith('connection-health', { checked: 1, updated: 1 })
  })

  it('refuses without the secret, reading nothing and stamping nothing', async () => {
    expect((await GET(req('nope'))).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed read answers 500 with a fixed line, no database text, and no stamp', async () => {
    createServerClient.mockReturnValue(fakeDb([], { readError: { message: 'raw db text' } }).db)
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not read connections' })
    expect(JSON.stringify(body)).not.toContain('raw db text')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a persist failure answers 200 with the counts but does not stamp', async () => {
    createServerClient.mockReturnValue(fakeDb([expiredInstagram], { updateError: { message: 'raw db text' } }).db)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: false, checked: 1, updated: 0, failed: 1 })
    expect(JSON.stringify(body)).not.toContain('raw db text')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
