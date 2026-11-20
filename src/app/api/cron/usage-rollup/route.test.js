// ROUTEWRAP (defineCron batch 2) — the nightly usage rollup on the wrapper:
// 401 without the secret, a clean run rolls up yesterday and today and stamps,
// and a failed day rollup answers 500 with a fixed line and does not stamp.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/ops-alerts', () => ({ sendOpsAlert: vi.fn(async () => {}) }))

import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { GET } from './route.js'

const req = (secret = 'shh') => new Request('https://x.test/api/cron/usage-rollup', { headers: { authorization: `Bearer ${secret}` } })

let db
function setup(errors) {
  db = createFakeDb({ tables: { org_settings: [] }, rpc: { rollup_usage_for_day: () => null }, errors })
  createServerClient.mockImplementation(() => db)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-11-20T02:40:00Z'))
  process.env.CRON_SECRET = 'shh'
  setup()
})

describe('GET /api/cron/usage-rollup', () => {
  it('refuses without the secret, reading nothing and stamping nothing', async () => {
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    expect(db.calls).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('rolls up yesterday and today, then stamps', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, days: ['2026-11-19', '2026-11-20'], notices: 0 })
    expect(db.calls.filter((c) => c.rpc === 'rollup_usage_for_day').map((c) => c.args)).toEqual([
      { p_day: '2026-11-19' }, { p_day: '2026-11-20' },
    ])
    expect(stampHeartbeat).toHaveBeenCalledWith('usage-rollup', { days: ['2026-11-19', '2026-11-20'], notices: 0 })
  })

  it('a failed day rollup answers 500 with a fixed line, no database text, and no stamp', async () => {
    setup({ rpc: { rollup_usage_for_day: { message: 'relation usage_events raw db text' } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Usage rollup failed', day: '2026-11-19' })
    expect(JSON.stringify(body)).not.toContain('raw db text')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
