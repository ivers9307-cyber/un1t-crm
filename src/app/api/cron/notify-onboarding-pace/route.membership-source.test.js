// W1.M3b — the onboarding-pace nudge discovers its live locations through the
// membership seam, not settings->'glofox'.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => h.db) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/onboarding-journey-data', () => ({ loadJourneyLane: vi.fn(async () => ({ lane: [] })) }))
vi.mock('@/lib/customer-nudge-claim', () => ({ sendNudgeOnce: vi.fn(), readReachableContacts: vi.fn(), nudgeFailed: vi.fn() }))
// TZ.6 — this file's subject is discovery, not the daily-slot gate: every location is due.
vi.mock('@/lib/cron-daily-slot', async (importOriginal) => ({
  ...(await importOriginal()),
  gateDailySlot: (await import('@/lib/cron-daily-slot.test-helpers')).openGate,
}))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })),
}))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { loadJourneyLane } from '@/lib/onboarding-journey-data'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { fakeDb } from '@/lib/time-off.test-helpers'
import {
  ESTATE_2026_10, STILLORGAN_ID, SLICE_BUT_NONE, REGISTRY_ONLY, legacyGlofoxDiscovery, locationsResolver,
} from '@/lib/membership/locations-for-source.test-helpers'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const dbFor = (rows, opts) => fakeDb(locationsResolver(rows, opts))
const visited = () => loadJourneyLane.mock.calls.map(([, locationId]) => locationId)

beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks() })

describe('GET /api/cron/notify-onboarding-pace — discovery through the membership seam (W1.M3b)', () => {
  it('the live estate paces exactly the locations the old slice rule paced: Stillorgan only', async () => {
    h.db = dbFor(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(visited()).toEqual(legacyGlofoxDiscovery(ESTATE_2026_10))
    expect(out).toMatchObject({ ok: true, locations: 1, locations_skipped: 0, skipped_unknown: 0 })
    expect(stampHeartbeat).toHaveBeenCalledWith('notify-onboarding-pace', expect.objectContaining({ locations: 1, skipped_unconfigured: 0, skipped_unknown: 0 }))
  })

  it('slice-but-none is NOT paced; registry-only glofox IS', async () => {
    h.db = dbFor([...ESTATE_2026_10, SLICE_BUT_NONE, REGISTRY_ONLY])
    await GET(req())
    expect(visited().sort()).toEqual([STILLORGAN_ID, REGISTRY_ONLY.id].sort())
  })

  it('Stillorgan whose credentials read FAILS at discovery stamps skipped_unknown: 1, never a quiet zero-location tick', async () => {
    glofoxCredentialsForLocation.mockImplementation(async (_db, id) => (
      id === STILLORGAN_ID ? { branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' } : { branchId: 'b', apiKey: 'k', apiToken: 't', readError: null }
    ))
    h.db = dbFor(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([])
    expect(out).toMatchObject({ ok: true, locations: 0, locations_skipped: 1, skipped_unknown: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('notify-onboarding-pace', expect.objectContaining({ locations: 0, skipped_unknown: 1 }))
  })

  it('a failed seam read answers 500 and does NOT stamp', async () => {
    h.db = dbFor(ESTATE_2026_10, { listError: { message: 'membership_source unreadable' } })
    expect((await GET(req())).status).toBe(500)
    expect(visited()).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

describe('notify-onboarding-pace on defineCron (ROUTEWRAP.C8)', () => {
  const noAuth = (value) => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? value : null) } })
  // The discovery block above leaves a failing credentials read installed.
  beforeEach(() => {
    glofoxCredentialsForLocation.mockImplementation(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null }))
  })

  it('401 without the secret: nothing read, nothing paced, nothing stamped', async () => {
    h.db = dbFor(ESTATE_2026_10)
    for (const v of [null, 'Bearer wrong']) expect((await GET(noAuth(v))).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await GET(noAuth('Bearer undefined'))).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(visited()).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean slot tick stamps exactly its own row, with its counts, and answers ok and success', async () => {
    h.db = dbFor(ESTATE_2026_10)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, ok: true, locations: 1, candidates: 0, nudged: 0, failed: 0, reachability_failed: 0 })
    expect(stampHeartbeat.mock.calls).toEqual([['notify-onboarding-pace', {
      locations: 1, skipped_unconfigured: 0, skipped_unknown: 0, skipped_source_changed: 0, candidates: 0, nudged: 0, failed: 0, reachability_failed: 0,
    }]])
  })

  it('a failed seam read answers a fixed line, never the DB text', async () => {
    h.db = dbFor(ESTATE_2026_10, { listError: { message: 'membership_source unreadable at db.internal' } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, ok: false, error: 'Could not list locations' })
    expect(logError).toHaveBeenCalledWith('cron-onboarding-pace', 'membership seam read failed', expect.anything())
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('every paced location failing to load its lane is a 500 with no stamp', async () => {
    loadJourneyLane.mockRejectedValueOnce(new Error('statement timeout at db.internal'))
    h.db = dbFor(ESTATE_2026_10)
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, ok: false, error: 'Every location failed', locations: 1, nudged: 0 })
    expect(JSON.stringify(body)).not.toContain('db.internal')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

