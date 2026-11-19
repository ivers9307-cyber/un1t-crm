// CRONSTAMP.1 — audit 2026-11-15 item 12: these jobs stamped their heartbeat
// on a run that failed, so a sustained outage never went stale and nothing
// paged; four of them also accepted "Bearer undefined" when CRON_SECRET was
// unset. Each is pinned here. Fictional ids only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/sonos/reconcile', () => ({ runSonosReconcile: vi.fn() }))
vi.mock('@/lib/class-climate-runner', () => ({ runClassClimate: vi.fn() }))
vi.mock('@/lib/bathroom-climate-runner', () => ({ runBathroomClimate: vi.fn() }))
vi.mock('@/lib/pipeline-reclassify', () => ({ reclassifyAllContacts: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runSonosReconcile } from '@/lib/sonos/reconcile'
import { runClassClimate } from '@/lib/class-climate-runner'
import { runBathroomClimate } from '@/lib/bathroom-climate-runner'
import { reclassifyAllContacts } from '@/lib/pipeline-reclassify'
import * as sonos from './sonos-reconcile/route.js'
import * as climate from './class-climate/route.js'
import * as bathroom from './bathroom-climate/route.js'
import * as classify from './pipeline-classify/route.js'
import * as reminders from './send-class-booking-reminders/route.js'
import * as agentReview from './agent-review/route.js'
import * as stravaImport from './strava-import/route.js'
import * as classKnowledge from './sync-class-knowledge/route.js'
import * as agentFollowups from './agent-followups/route.js'

const req = (auth = 'Bearer shh') => new Request('https://x.test/api/cron/x', { headers: { authorization: auth } })
const LOCATIONS = [{ id: 'l1', name: 'Studio One' }, { id: 'l2', name: 'Studio Two' }]

function readDb(result) {
  const q = { select: () => q, eq: () => q, then: (ok, bad) => Promise.resolve(result).then(ok, bad) }
  return { from: () => q }
}

let saved
beforeEach(() => { vi.clearAllMocks(); saved = process.env.CRON_SECRET; process.env.CRON_SECRET = 'shh' })
afterEach(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved })

describe('sonos-reconcile, class-climate and bathroom-climate stamp only a run that did not fail', () => {
  it.each([
    ['sonos-reconcile', sonos, runSonosReconcile],
    ['class-climate', climate, runClassClimate],
    ['bathroom-climate', bathroom, runBathroomClimate], // CRONWRAP.2
  ])('%s', async (name, route, run) => {
    createServerClient.mockReturnValue({})
    run.mockResolvedValueOnce({ ok: false, error: 'schedules unreadable' })
    await route.GET(req())
    expect(stampHeartbeat).not.toHaveBeenCalled()
    run.mockResolvedValueOnce({ ok: true })
    await route.GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith(name)
    // a dormant deploy (no ok key) is not a failure
    run.mockResolvedValueOnce({ skipped: true, reason: 'unconfigured' })
    await route.GET(req())
    expect(stampHeartbeat).toHaveBeenCalledTimes(2)
  })
})

describe('pipeline-classify', () => {
  beforeEach(() => createServerClient.mockReturnValue(readDb({ data: LOCATIONS, error: null })))
  it('stamps when every studio ran', async () => {
    reclassifyAllContacts.mockResolvedValue({ ok: true, contacts_seen: 1 })
    const res = await classify.GET(req())
    expect(res.status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalledWith('pipeline-classify')
  })
  it('one failed or throwing studio: no stamp, 500, and the other studio still ran', async () => {
    reclassifyAllContacts.mockResolvedValueOnce({ ok: false, error: 'claims unreadable' }).mockRejectedValueOnce(new Error('boom'))
    const res = await classify.GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.failed).toBe(2)
    expect(body.summary.map((r) => r.ok)).toEqual([false, false])
    expect(reclassifyAllContacts).toHaveBeenCalledTimes(2)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

describe('send-class-booking-reminders', () => {
  it('a failed locations read is a 500 with no stamp (not "nothing due")', async () => {
    createServerClient.mockReturnValue(readDb({ data: null, error: { code: '57014', message: 'timeout' } }))
    const res = await reminders.GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

describe('the four jobs that accepted "Bearer undefined" fail closed when CRON_SECRET is unset', () => {
  it.each([
    ['agent-review', agentReview],
    ['strava-import', stravaImport],
    ['sync-class-knowledge', classKnowledge],
    ['agent-followups', agentFollowups],
  ])('%s', async (_name, route) => {
    delete process.env.CRON_SECRET
    const res = await route.GET(req('Bearer undefined'))
    expect(res.status).toBe(401)
  })
})
