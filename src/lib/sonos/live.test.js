import { describe, it, expect, vi } from 'vitest'
import { runLiveAction } from './live'

const groupsBody = {
  groups: [{ id: 'GRP_A', name: 'Studio', playbackState: 'PLAYBACK_STATE_PLAYING', playerIds: ['RINCON_1'] }],
  players: [{ id: 'RINCON_1', name: 'Floor' }],
}

const schedule = { id: 's1', player_ids: ['RINCON_1'] }

// Records every table touched so a test can prove no write happened.
function makeDb(row, touched = []) {
  return {
    touched,
    from(table) {
      touched.push(table)
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        }),
        update() { throw new Error(`unexpected write to ${table}`) },
        insert() { throw new Error(`unexpected write to ${table}`) },
        delete() { throw new Error(`unexpected write to ${table}`) },
      }
    },
  }
}

const deps = (over = {}) => ({
  getConfig: () => ({ clientId: 'a', clientSecret: 'b', redirectUri: 'https://x/cb' }),
  getToken: async () => ({ ok: true, token: 'tok', householdId: 'HH1' }),
  getGroups: async () => ({ ok: true, statusCode: 200, body: groupsBody }),
  getGroupVolume: async () => ({ ok: true, statusCode: 200, body: { volume: 20, muted: false, fixed: false } }),
  call: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  ...over,
})

describe('runLiveAction', () => {
  it('dispatches the planned call to the resolved group', async () => {
    const d = deps()
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'volume_up', undefined, d)
    expect(out).toMatchObject({ ok: true, groups: ['GRP_A'] })
    expect(d.call).toHaveBeenCalledWith('setRelativeVolume', 'tok', 'GRP_A', 5)
  })

  it('WRITES NOTHING to sonos_schedules', async () => {
    // The property that keeps live control and the schedule from fighting.
    // The fake db throws on any update/insert/delete, so a future
    // "helpful" stamp of last_applied fails loudly here instead of
    // silently breaking the close.
    const touched = []
    await runLiveAction(makeDb(schedule, touched), 'loc-1', 's1', 'pause', undefined, deps())
    expect(touched).toEqual(['sonos_schedules']) // the SELECT only
  })

  it('refuses an unknown action before touching anything', async () => {
    const d = deps()
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'reboot', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'invalid' })
    expect(d.call).not.toHaveBeenCalled()
  })

  it('reports not-found when the schedule belongs to another location', async () => {
    // makeDb(null) models the .eq('location_id') filter matching nothing.
    const d = deps()
    const out = await runLiveAction(makeDb(null), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'not_found' })
    expect(d.call).not.toHaveBeenCalled()
  })

  it('refuses a volume change on a fixed-volume group', async () => {
    const d = deps({
      getGroupVolume: async () => ({ ok: true, statusCode: 200, body: { volume: 20, fixed: true } }),
    })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'volume_up', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'fixed_volume' })
    expect(d.call).not.toHaveBeenCalled()
  })

  it('does not check the fixed flag for a non-volume action', async () => {
    const getGroupVolume = vi.fn()
    await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'skip_next', undefined, deps({ getGroupVolume }))
    expect(getGroupVolume).not.toHaveBeenCalled()
  })

  it('surfaces a regroup as retryable rather than retrying in-request', async () => {
    const d = deps({ call: vi.fn(async () => ({ ok: false, statusCode: 404 })) })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'regrouped' })
  })

  it('reports an empty queue distinctly from a generic failure', async () => {
    const d = deps({ call: vi.fn(async () => ({ ok: false, statusCode: 499 })) })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'no_content' })
  })

  it('reports rate limiting distinctly', async () => {
    const d = deps({ call: vi.fn(async () => ({ ok: false, statusCode: 429 })) })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'rate_limited' })
  })

  it('reports a disconnected household without throwing', async () => {
    const d = deps({ getToken: async () => ({ ok: false, reason: 'not_connected' }) })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'not_connected' })
  })

  it('reports no online speakers when the players resolve to no group', async () => {
    const d = deps({ getGroups: async () => ({ ok: true, statusCode: 200, body: { groups: [], players: [] } }) })
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, d)
    expect(out).toMatchObject({ ok: false, code: 'no_group' })
  })

  it('is dormant when Sonos is not configured', async () => {
    const out = await runLiveAction(makeDb(schedule), 'loc-1', 's1', 'play', undefined, deps({ getConfig: () => null }))
    expect(out).toMatchObject({ ok: false, code: 'not_configured' })
  })
})
