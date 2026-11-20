// ROUTEWRAP (defineCron batch 1) — the HR sample downsample on the wrapper:
// 401 without the secret, a clean run stamps, a failed candidate scan answers
// 500 with a fixed line and does not stamp, and only samples older than the
// retention cutoff are ever deleted.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))

import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { GET } from './route.js'

const req = (secret = 'shh') => new Request('https://x.test/api/cron/prune-hr-samples', { headers: { authorization: `Bearer ${secret}` } })

let db
function setup(tables, errors) {
  db = createFakeDb({ tables, errors })
  createServerClient.mockImplementation(() => db)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
})

describe('GET /api/cron/prune-hr-samples', () => {
  it('refuses without the secret', async () => {
    setup({ heart_rate_sessions: [], hr_samples: [] })
    expect((await GET(req('nope'))).status).toBe(401)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('nothing past retention: a clean run that stamps', async () => {
    setup({ heart_rate_sessions: [], hr_samples: [] })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(stampHeartbeat).toHaveBeenCalledWith('prune-hr-samples', expect.anything())
  })

  it('a failed candidate scan answers 500 with a fixed line and does not stamp', async () => {
    setup({ heart_rate_sessions: [], hr_samples: [] }, { heart_rate_sessions: { select: { message: 'relation secret_y does not exist' } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'prune failed: candidate scan failed' })
    expect(JSON.stringify(body)).not.toContain('secret_y')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
