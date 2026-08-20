import { describe, it, expect, vi } from 'vitest'
import { runSonosReconcile } from './reconcile'

const MONDAY_0500Z = new Date('2026-08-24T05:00:00Z').getTime()
const OPEN_AT = MONDAY_0500Z

const groupsBody = {
  groups: [{ id: 'GRP_A', name: 'Studio', playbackState: 'PLAYBACK_STATE_IDLE', playerIds: ['RINCON_1'] }],
  players: [{ id: 'RINCON_1', name: 'Floor' }],
}

function makeDb(schedules) {
  const updates = []
  return {
    updates,
    from(table) {
      if (table === 'sonos_schedules') {
        return {
          select: () => ({ eq: () => ({ limit: async () => ({ data: schedules, error: null }) }) }),
          update(patch) {
            return { eq: async (col, id) => { updates.push({ id, patch }); return { error: null } } }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const baseSchedule = {
  id: 's1',
  location_id: 'loc-1',
  enabled: true,
  player_ids: ['RINCON_1'],
  windows: [{ days: [1, 2, 3, 4, 5], on: '06:00', off: '21:30', volume: 35, favorite_id: 'fv-1' }],
  override: null,
  last_applied: null,
}

const deps = (over = {}) => ({
  now: () => MONDAY_0500Z,
  getConfig: () => ({ clientId: 'a', clientSecret: 'b', redirectUri: 'https://x/cb' }),
  getToken: async () => ({ ok: true, token: 'tok', householdId: 'HH1' }),
  getGroups: async () => ({ ok: true, statusCode: 200, body: groupsBody }),
  setVolume: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  loadFavorite: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  pause: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  ...over,
})

describe('runSonosReconcile', () => {
  it('skips quietly when the integration is dormant', async () => {
    const out = await runSonosReconcile(makeDb([]), deps({ getConfig: () => null }))
    expect(out).toMatchObject({ skipped: true, reason: 'unconfigured' })
  })

  it('reports misconfiguration loudly rather than looking dormant', async () => {
    const out = await runSonosReconcile(makeDb([]), deps({ getConfig: () => ({ error: 'half set' }) }))
    expect(out).toMatchObject({ skipped: true, reason: 'misconfigured' })
  })

  it('sets volume BEFORE loading the favourite', async () => {
    const d = deps()
    const order = []
    d.setVolume = vi.fn(async () => { order.push('volume'); return { ok: true, statusCode: 200 } })
    d.loadFavorite = vi.fn(async () => { order.push('favorite'); return { ok: true, statusCode: 200 } })
    await runSonosReconcile(makeDb([baseSchedule]), d)
    // Volume last would play the first seconds at the previous window's level.
    expect(order).toEqual(['volume', 'favorite'])
    expect(d.setVolume).toHaveBeenCalledWith('tok', 'GRP_A', 35)
    expect(d.loadFavorite).toHaveBeenCalledWith('tok', 'GRP_A', 'fv-1')
  })

  it('records last_applied so the next tick is a no-op', async () => {
    const db = makeDb([baseSchedule])
    await runSonosReconcile(db, deps())
    expect(db.updates[0].patch.last_applied).toMatchObject({ window_on_at: OPEN_AT, action: 'open' })
    expect(db.updates[0].patch.last_state).toMatchObject({ group_id: 'GRP_A' })
  })

  it('does NOT mark the window applied when the favourite failed to load', async () => {
    // Otherwise a transient failure silently costs the whole window.
    const d = deps({ loadFavorite: vi.fn(async () => ({ ok: false, statusCode: 500 })) })
    const db = makeDb([baseSchedule])
    const out = await runSonosReconcile(db, d)
    expect(db.updates.find((u) => u.patch.last_applied)).toBeUndefined()
    expect(out.failed).toBe(1)
  })

  it('treats a 499 on pause as benign — an idle group is already stopped', async () => {
    const closing = {
      ...baseSchedule,
      last_applied: { window_on_at: OPEN_AT, action: 'open' },
    }
    const d = deps({
      now: () => new Date('2026-08-24T20:30:00Z').getTime(),
      pause: vi.fn(async () => ({ ok: false, statusCode: 499, body: { errorCode: 'ERROR_PLAYBACK_NO_CONTENT' } })),
    })
    const db = makeDb([closing])
    const out = await runSonosReconcile(db, d)
    expect(db.updates[0].patch.last_applied).toMatchObject({ action: 'close' })
    expect(out.failed).toBe(0)
  })

  it('writes nothing and reports sonosDown when the groups read fails', async () => {
    const db = makeDb([baseSchedule])
    const out = await runSonosReconcile(db, deps({ getGroups: async () => ({ ok: false, statusCode: 0 }) }))
    expect(db.updates).toHaveLength(0)
    expect(out).toMatchObject({ ok: true, sonosDown: true })
  })

  it('surfaces a revoked grant without throwing', async () => {
    const out = await runSonosReconcile(
      makeDb([baseSchedule]),
      deps({ getToken: async () => ({ ok: false, reason: 'refresh_failed', statusCode: 400 }) }),
    )
    expect(out).toMatchObject({ ok: true })
    expect(out.tokenFailures).toBe(1)
  })

  it('reads the household ONCE for several schedules at the same location', async () => {
    const getGroups = vi.fn(async () => ({ ok: true, statusCode: 200, body: groupsBody }))
    const two = [baseSchedule, { ...baseSchedule, id: 's2', name: 'Reception' }]
    await runSonosReconcile(makeDb(two), deps({ getGroups }))
    expect(getGroups).toHaveBeenCalledTimes(1)
  })
})
