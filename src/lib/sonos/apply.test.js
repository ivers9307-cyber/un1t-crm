// src/lib/sonos/apply.test.js
import { describe, it, expect, vi } from 'vitest'
import { applyOpen } from './apply'
import { logWarn } from '@/lib/log'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }))

const NOW = new Date('2026-08-24T05:00:00Z').getTime()
const WINDOW_ON_AT = NOW

const groups = [
  { id: 'GRP_A', name: 'Studio', playbackState: 'PLAYBACK_STATE_IDLE', playerIds: ['RINCON_1'] },
  { id: 'GRP_B', name: 'Reception', playbackState: 'PLAYBACK_STATE_PAUSED', playerIds: ['RINCON_2'] },
]

const schedule = { id: 's1', location_id: 'loc-1', player_ids: ['RINCON_1'] }
const plan = { action: 'open', windowOnAt: WINDOW_ON_AT, volume: 35, favoriteId: 'fv-1' }

// Records every UPDATE the helper issues. `updateError` makes the write fail
// the way a real supabase builder does: resolved, never thrown.
function makeDb({ updateError = null } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      if (table !== 'sonos_schedules') throw new Error(`unexpected table ${table}`)
      return {
        update(patch) {
          return {
            eq: async (col, val) => {
              updates.push({ col, val, patch })
              return { error: updateError }
            },
          }
        },
      }
    },
  }
}

const okDeps = () => ({
  setVolume: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  loadFavorite: vi.fn(async () => ({ ok: true, statusCode: 200 })),
})

function run(db, over = {}) {
  return applyOpen(db, {
    token: 'tok',
    schedule,
    plan,
    groups,
    groupIds: ['GRP_A'],
    nowMs: NOW,
    deps: okDeps(),
    ...over,
  })
}

describe('applyOpen', () => {
  it('sets volume then loads the favourite, and stamps the open once', async () => {
    const db = makeDb()
    const deps = okDeps()
    const order = []
    deps.setVolume.mockImplementation(async () => { order.push('volume'); return { ok: true, statusCode: 200 } })
    deps.loadFavorite.mockImplementation(async () => { order.push('favorite'); return { ok: true, statusCode: 200 } })

    const out = await run(db, { deps })

    expect(out).toEqual({ ok: true })
    expect(order).toEqual(['volume', 'favorite'])
    expect(deps.setVolume).toHaveBeenCalledWith('tok', 'GRP_A', 35)
    expect(deps.loadFavorite).toHaveBeenCalledWith('tok', 'GRP_A', 'fv-1')

    expect(db.updates).toHaveLength(1)
    const { col, val, patch } = db.updates[0]
    expect(col).toBe('id')
    expect(val).toBe('s1')
    // window_on_at MUST be the raw number. A string never === the planner's
    // active.on_at, so every tick re-opens and the playlist restarts.
    expect(typeof patch.last_applied.window_on_at).toBe('number')
    expect(patch.last_applied).toEqual({
      window_on_at: WINDOW_ON_AT,
      action: 'open',
      at: new Date(NOW).toISOString(),
    })
    expect(patch.last_state).toEqual({
      group_id: 'GRP_A',
      playback_state: 'PLAYBACK_STATE_IDLE',
      at: new Date(NOW).toISOString(),
    })
    expect(patch.updated_at).toBe(new Date(NOW).toISOString())
  })

  it('uses the FIRST group id as the primary for last_state', async () => {
    const db = makeDb()
    const deps = okDeps()
    await run(db, { deps, groupIds: ['GRP_B', 'GRP_A'] })
    expect(db.updates[0].patch.last_state.group_id).toBe('GRP_B')
    expect(db.updates[0].patch.last_state.playback_state).toBe('PLAYBACK_STATE_PAUSED')
    expect(deps.setVolume).toHaveBeenCalledTimes(2)
    expect(deps.loadFavorite).toHaveBeenCalledTimes(2)
    expect(db.updates).toHaveLength(1)
  })

  it('stamps nothing and reports sonos when there are no groups to apply to', async () => {
    const db = makeDb()
    const deps = okDeps()
    const out = await run(db, { deps, groupIds: [] })
    expect(out).toEqual({ ok: false, reason: 'sonos' })
    expect(deps.setVolume).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
  })

  it('records a null playback_state when the primary group is not in the list', async () => {
    const db = makeDb()
    await run(db, { groupIds: ['GRP_GONE'] })
    expect(db.updates[0].patch.last_state.playback_state).toBeNull()
  })

  it('skips the favourite for a group whose volume failed, still tries the other group, and stamps nothing', async () => {
    const db = makeDb()
    const deps = okDeps()
    deps.setVolume.mockImplementation(async (_t, groupId) =>
      groupId === 'GRP_A' ? { ok: false, statusCode: 500 } : { ok: true, statusCode: 200 })

    const out = await run(db, { deps, groupIds: ['GRP_A', 'GRP_B'] })

    expect(out).toEqual({ ok: false, reason: 'sonos' })
    expect(deps.loadFavorite).toHaveBeenCalledTimes(1)
    expect(deps.loadFavorite).toHaveBeenCalledWith('tok', 'GRP_B', 'fv-1')
    // Deliberately unstamped: the next tick retries the window.
    expect(db.updates).toHaveLength(0)
    expect(logWarn).toHaveBeenCalledWith('sonos-apply', 'setVolume failed', { scheduleId: 's1', groupId: 'GRP_A', statusCode: 500 })
  })

  it('stamps nothing when the favourite fails to load', async () => {
    const db = makeDb()
    const deps = okDeps()
    deps.loadFavorite.mockResolvedValue({ ok: false, statusCode: 500 })

    const out = await run(db, { deps })

    expect(out).toEqual({ ok: false, reason: 'sonos' })
    expect(db.updates).toHaveLength(0)
  })

  it('reports a failed stamp as its own outcome, distinct from a Sonos failure', async () => {
    const err = { message: 'boom' }
    const db = makeDb({ updateError: err })

    const out = await run(db)

    // Every Sonos call succeeded — the music IS playing — so the caller
    // must be able to tell this apart from `sonos` and report accordingly.
    expect(out).toEqual({ ok: false, reason: 'stamp', error: err })
    expect(db.updates).toHaveLength(1)
  })

  it('passes a null favoriteId straight through rather than refusing to open', async () => {
    // The planner documents this choice (groups.js): refusing would leave
    // the room silent with zero signal. The helper does not second-guess it.
    const db = makeDb()
    const deps = okDeps()
    await run(db, { deps, plan: { ...plan, favoriteId: null } })
    expect(deps.loadFavorite).toHaveBeenCalledWith('tok', 'GRP_A', null)
  })
})
