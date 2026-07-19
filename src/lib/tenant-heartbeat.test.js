import { describe, it, expect, vi } from 'vitest'
import { stampTenantHeartbeat } from './tenant-heartbeat.js'

function stubDb({ parent = { expected_interval_seconds: 86400, grace_seconds: 3600 } } = {}) {
  const upserts = []
  const heartbeatsQuery = {
    select: vi.fn(() => heartbeatsQuery),
    eq: vi.fn(() => heartbeatsQuery),
    maybeSingle: vi.fn(async () => ({ data: parent, error: null })),
  }
  const tenantTable = {
    upsert: vi.fn(async (row, opts) => {
      upserts.push({ row, opts })
      return { error: null }
    }),
  }
  const db = {
    from: vi.fn((table) => (table === 'cron_heartbeats' ? heartbeatsQuery : tenantTable)),
  }
  return { db, upserts, heartbeatsQuery }
}

describe('stampTenantHeartbeat', () => {
  it('upserts (name, location_id) with last_ok_at and the parent cron cadence', async () => {
    const { db, upserts } = stubDb()
    await stampTenantHeartbeat('glofox-data-quality', 'loc-1', { db })
    expect(upserts).toHaveLength(1)
    const { row, opts } = upserts[0]
    expect(row.name).toBe('glofox-data-quality')
    expect(row.location_id).toBe('loc-1')
    expect(row.last_ok_at).toBeTruthy()
    // Cadence inherited from the parent cron_heartbeats row so the
    // tenant view flags staleness on the same clock as the global one.
    expect(row.expected_interval_seconds).toBe(86400)
    expect(row.grace_seconds).toBe(3600)
    expect(opts).toMatchObject({ onConflict: 'name,location_id' })
    // muted is operator state — a stamp must never overwrite it.
    expect('muted' in row).toBe(false)
  })

  it('still stamps (with null cadence) when the parent cron row is missing', async () => {
    const { db, upserts } = stubDb({ parent: null })
    await stampTenantHeartbeat('some-cron', 'loc-1', { db })
    expect(upserts).toHaveLength(1)
    expect(upserts[0].row.expected_interval_seconds).toBeNull()
    expect(upserts[0].row.grace_seconds).toBeNull()
  })

  it('never throws — upsert error is swallowed', async () => {
    const { db } = stubDb()
    db.from = vi.fn(() => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: { message: 'boom' } }),
    }))
    await expect(stampTenantHeartbeat('x', 'loc-1', { db })).resolves.toBeUndefined()
  })

  it('never throws — even a throwing client is swallowed', async () => {
    const db = {
      from: () => {
        throw new Error('no client')
      },
    }
    await expect(stampTenantHeartbeat('x', 'loc-1', { db })).resolves.toBeUndefined()
  })

  it('no-ops on a missing name or location (never writes a malformed key)', async () => {
    const { db, upserts } = stubDb()
    await stampTenantHeartbeat('', 'loc-1', { db })
    await stampTenantHeartbeat('x', null, { db })
    expect(upserts).toHaveLength(0)
  })
})
