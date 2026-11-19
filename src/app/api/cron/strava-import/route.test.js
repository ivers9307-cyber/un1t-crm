// CRONWRAP.1 — a failed read is a failed run, and a backfill that could not be
// recorded is not counted as done.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/strava-import', () => ({
  loadStravaConfig: vi.fn(async () => ({ isEnabled: true })),
  backfillConnection: vi.fn(async () => {}),
}))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'
import { loadStravaConfig, backfillConnection } from '@/lib/strava-import'

const ID = '00000000-0000-4000-8000-000000000001'
const connection = { id: ID, provider: 'strava', disconnected_at: null, import_backfilled_at: null, scopes: ['activity:read'] }
const run = async () => {
  const res = await GET(new Request('https://crm.test/api/cron/strava-import', { headers: { authorization: 'Bearer test-secret' } }))
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  db = createFakeDb({ tables: { contact_external_integrations: [{ ...connection }] } })
})

describe('GET /api/cron/strava-import', () => {
  it('backfills a connection, records it and stamps', async () => {
    expect(await run()).toEqual({ status: 200, body: { backfilled_connections: 1, success: true } })
    expect(db.tables.contact_external_integrations[0].import_backfilled_at).toBeTruthy()
    expect(stampHeartbeat).toHaveBeenCalledWith('strava-import')
  })

  it('a switched-off import is a clean, idle run', async () => {
    loadStravaConfig.mockResolvedValueOnce({ isEnabled: false })
    expect(await run()).toEqual({ status: 200, body: { skipped: 'not_configured', success: true } })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(backfillConnection).not.toHaveBeenCalled()
  })

  it('a failed read fails the run and does not stamp', async () => {
    db = createFakeDb({ tables: { contact_external_integrations: [] }, errors: { contact_external_integrations: { select: { message: 'down' } } } })
    expect(await run()).toEqual({ status: 500, body: { error: 'Could not read connections', success: false } })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a backfill it could not record is not counted, and the run still stamps', async () => {
    db = createFakeDb({ tables: { contact_external_integrations: [{ ...connection }] }, errors: { contact_external_integrations: { update: { message: 'down' } } } })
    expect((await run()).body).toEqual({ backfilled_connections: 0, success: true })
    expect(logWarn).toHaveBeenCalledWith('cron.strava-import', 'backfill failed', expect.objectContaining({ connection_id: ID }))
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })
})
