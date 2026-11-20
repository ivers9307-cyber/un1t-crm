// ROUTEWRAP (defineCron batch 1) — the stale push-token sweep on the wrapper:
// 401 without the secret, a clean run stamps, a failed read or delete answers
// 500 with a fixed line and does not stamp, and the ledger prune never fails it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))

import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { GET, POST } from './route.js'

const DAY = 86_400_000
const ago = (d) => new Date(Date.now() - d * DAY).toISOString()
const U = 'u0000000-0000-4000-8000-000000000001'
const req = (secret = 'shh') => new Request('https://x.test/api/cron/sweep-stale-push-tokens', { headers: { authorization: `Bearer ${secret}` } })

let db
function setup(tables, errors) {
  db = createFakeDb({ tables, errors })
  createServerClient.mockImplementation(() => db)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  setup({
    device_tokens: [
      { id: 'd0000000-0000-4000-8000-000000000001', user_id: U, expo_push_token: 'old', platform: 'ios', last_seen_at: ago(120) },
      { id: 'd0000000-0000-4000-8000-000000000002', user_id: U, expo_push_token: 'new', platform: 'ios', last_seen_at: ago(5) },
    ],
    push_event_sends: [],
  })
})

describe('GET /api/cron/sweep-stale-push-tokens', () => {
  it('refuses without the secret, reading nothing', async () => {
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('deletes tokens unseen for 90 days, keeps the rest, and stamps', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, ok: true, deleted: 1 })
    expect(db.tables.device_tokens.map((t) => t.expo_push_token)).toEqual(['new'])
    expect(stampHeartbeat).toHaveBeenCalledWith('sweep-stale-push-tokens')
  })

  it('a failed read answers 500 with a fixed line and does not stamp', async () => {
    setup({ device_tokens: [], push_event_sends: [] }, { device_tokens: { select: { message: 'relation secret_x does not exist' } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'sweep failed: select failed' })
    expect(JSON.stringify(body)).not.toContain('secret_x')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('POST runs the same sweep', async () => {
    expect((await POST(req())).status).toBe(200)
  })
})
