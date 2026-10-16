// UN1TSYNC.10 — the daily connection-health sweep never touches un1t_online:
// the un1t.online sync owns that row's status, and grading it here as well
// flapped it against the sync.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn() }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'

const PAST = new Date(Date.now() - 86400000).toISOString()

function fakeDb(rows) {
  const filters = []
  const updates = []
  const builder = {
    select() { return builder },
    eq(col, val) { filters.push(['eq', col, val]); return builder },
    neq(col, val) { filters.push(['neq', col, val]); return builder },
    then(resolve) {
      const out = rows.filter((r) => filters.every(([k, c, v]) => (k === 'eq' ? r[c] === v : r[c] !== v)))
      return resolve({ data: out, error: null })
    },
  }
  const db = {
    from() {
      return {
        select: () => builder.select(),
        update(patch) {
          return { eq: (col, id) => { updates.push({ id, patch }); return Promise.resolve({ error: null }) } }
        },
      }
    },
  }
  return { db, filters, updates }
}

beforeEach(() => {
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
  })
})
