import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/bounce-escalation-sweep', () => ({ runRepeatBounceSweep: vi.fn() }))

import { runRepeatBounceSweep } from '@/lib/bounce-escalation-sweep'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { GET, POST } from './route'

const req = (url = 'https://x.test/api/cron/repeat-bounce-sweep', secret = 'shh') =>
  new Request(url, { headers: { authorization: `Bearer ${secret}` } })

const okResult = { ok: true, dry: false, suppressed: 2, review: 3, autoReleased: 0, errors: [] }

beforeEach(() => {
  process.env.CRON_SECRET = 'shh'
  vi.mocked(runRepeatBounceSweep).mockClear()
  vi.mocked(runRepeatBounceSweep).mockResolvedValue(okResult)
  vi.mocked(stampHeartbeat).mockClear()
})

describe('GET /api/cron/repeat-bounce-sweep', () => {
  it('401s without the cron secret', async () => {
    const res = await GET(req('https://x.test/', 'wrong'))
    expect(res.status).toBe(401)
    expect(runRepeatBounceSweep).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401s when CRON_SECRET is unset rather than running open', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(runRepeatBounceSweep).not.toHaveBeenCalled()
  })

  it('runs the sweep and stamps the heartbeat', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, suppressed: 2, review: 3 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('repeat-bounce-sweep', okResult)
  })

  it('does not stamp the heartbeat when the sweep reported errors, and answers no error text', async () => {
    vi.mocked(runRepeatBounceSweep).mockResolvedValue({ ...okResult, ok: false, errors: ['suppression stamp failed: relation secret_y'] })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'Repeat-bounce sweep failed', errorCount: 1, suppressed: 2 })
    expect(JSON.stringify(body)).not.toContain('secret_y')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a sweep that throws answers 500 with a fixed line and no stamp', async () => {
    vi.mocked(runRepeatBounceSweep).mockRejectedValue(new Error('relation secret_y does not exist'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret_y')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('POST runs the same sweep', async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('passes ?dry=1 through and never stamps on a dry probe', async () => {
    vi.mocked(runRepeatBounceSweep).mockResolvedValue({ ...okResult, dry: true })
    const res = await GET(req('https://x.test/api/cron/repeat-bounce-sweep?dry=1'))
    expect(res.status).toBe(200)
    expect(vi.mocked(runRepeatBounceSweep).mock.calls[0][0].dry).toBe(true)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('is not dry by default', async () => {
    await GET(req())
    expect(vi.mocked(runRepeatBounceSweep).mock.calls[0][0].dry).toBe(false)
  })
})
