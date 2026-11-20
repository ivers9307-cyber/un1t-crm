// ROUTEWRAP.C8 — run-sequences on defineCron: the secret, the one stamp after
// runSequences() completes, and fixed error text in the answer.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', async () => {
  const { createFakeDb } = await import('../../../../../tests/helpers/fake-db.js')
  return { createServerClient: vi.fn(() => createFakeDb()) }
})
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/sequences', () => ({
  runSequences: vi.fn(async () => ({ processed: 2 })),
  runEventReminderTriggers: vi.fn(async () => ({ enrolled: 1, errored: 1 })),
  runAnniversaryTriggers: vi.fn(async () => ({ enrolled: 0, errored: 0 })),
  runInactivityTriggers: vi.fn(async () => ({ enrolled: 0, errored: 2 })),
  runAudienceMatchTriggers: vi.fn(async () => ({ enrolled: 3, errored: 0 })),
}))
vi.mock('@/lib/event-reminders', () => ({ runEventReminderSends: vi.fn(async () => ({ sent: 4 })) }))

const { GET } = await import('./route.js')
const { createServerClient } = await import('@/lib/supabase')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError, logWarn } = await import('@/lib/log')
const seq = await import('@/lib/sequences')
const { runEventReminderSends } = await import('@/lib/event-reminders')

const req = (auth = 'Bearer shh') => new Request('https://x.test/api/cron/run-sequences', { headers: auth ? { authorization: auth } : {} })
const SENDERS = [seq.runSequences, seq.runEventReminderTriggers, seq.runAnniversaryTriggers, seq.runInactivityTriggers, seq.runAudienceMatchTriggers, runEventReminderSends]

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
})

describe('GET /api/cron/run-sequences', () => {
  it('401 without the secret: nothing read, nothing sent, nothing stamped', async () => {
    for (const auth of [null, 'Bearer wrong']) expect((await GET(req(auth))).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await GET(req('Bearer undefined'))).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    for (const fn of SENDERS) expect(fn).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean tick runs every phase, stamps only run-sequences, and answers the same fields', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      trigger_errors: 3,
      stats: { processed: 2 },
      triggers: { enrolled: 1, errored: 1 }, trigger_error: null,
      anniversary: { enrolled: 0, errored: 0 }, anniversary_error: null,
      inactivity: { enrolled: 0, errored: 2 }, inactivity_error: null,
      audience_match: { enrolled: 3, errored: 0 }, audience_match_error: null,
      reminder_sends: { sent: 4 }, reminder_sends_error: null,
    })
    for (const fn of SENDERS) expect(fn).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat.mock.calls).toEqual([['run-sequences']])
  })

  it('a phase dying wholesale is a fixed error field (detail logged) and the tick still stamps', async () => {
    seq.runAnniversaryTriggers.mockRejectedValueOnce(new Error('relation "secret_table" does not exist'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, anniversary: null, anniversary_error: 'phase failed' })
    expect(JSON.stringify(body)).not.toContain('secret_table')
    expect(seq.runSequences).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith('cron-run-sequences', 'anniversary triggers failed', expect.objectContaining({ err: expect.any(Error) }))
    expect(stampHeartbeat.mock.calls).toEqual([['run-sequences']])
  })

  it('runSequences throwing is a 500 with a fixed line and no stamp', async () => {
    seq.runSequences.mockRejectedValueOnce(new Error('connection to db.internal refused'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Sequence run failed' })
    expect(logError).toHaveBeenCalledWith('cron-run-sequences', 'runSequences failed', expect.objectContaining({ err: expect.any(Error) }))
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
