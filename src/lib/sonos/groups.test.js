import { describe, it, expect } from 'vitest'
import { mapGroups, resolveGroupIds } from './groups'

const raw = {
  groups: [
    { id: 'GRP_A', name: 'Studio', coordinatorId: 'RINCON_1', playbackState: 'PLAYBACK_STATE_PLAYING', playerIds: ['RINCON_1', 'RINCON_2'] },
    { id: 'GRP_B', name: 'Reception', coordinatorId: 'RINCON_3', playbackState: 'PLAYBACK_STATE_IDLE', playerIds: ['RINCON_3'] },
  ],
  players: [
    { id: 'RINCON_1', name: 'Floor Left' },
    { id: 'RINCON_2', name: 'Floor Right' },
    { id: 'RINCON_3', name: 'Reception' },
  ],
}

describe('mapGroups', () => {
  it('returns groups and players in a stable shape', () => {
    const out = mapGroups(raw)
    expect(out.groups).toHaveLength(2)
    expect(out.groups[0]).toMatchObject({ id: 'GRP_A', playbackState: 'PLAYBACK_STATE_PLAYING' })
    expect(out.players).toEqual([
      { id: 'RINCON_1', name: 'Floor Left' },
      { id: 'RINCON_2', name: 'Floor Right' },
      { id: 'RINCON_3', name: 'Reception' },
    ])
  })

  it('tolerates a missing or malformed body without throwing', () => {
    expect(mapGroups(null)).toEqual({ groups: [], players: [] })
    expect(mapGroups({ groups: 'nope' })).toEqual({ groups: [], players: [] })
  })

  it('drops entries with no id', () => {
    expect(mapGroups({ groups: [{ name: 'ghost' }], players: [{ name: 'ghost' }] }))
      .toEqual({ groups: [], players: [] })
  })
})

describe('resolveGroupIds', () => {
  const { groups } = mapGroups(raw)

  it('finds the group holding a player', () => {
    expect(resolveGroupIds(groups, ['RINCON_1'])).toEqual(['GRP_A'])
  })

  it('returns each distinct group ONCE when several players share it', () => {
    // Two speakers in the same group must not produce two loadFavorite calls.
    expect(resolveGroupIds(groups, ['RINCON_1', 'RINCON_2'])).toEqual(['GRP_A'])
  })

  it('returns every distinct group when players span more than one', () => {
    expect(resolveGroupIds(groups, ['RINCON_1', 'RINCON_3'])).toEqual(['GRP_A', 'GRP_B'])
  })

  it('follows the order of player_ids, so the first player names the primary group', () => {
    expect(resolveGroupIds(groups, ['RINCON_3', 'RINCON_1'])).toEqual(['GRP_B', 'GRP_A'])
  })

  it('ignores players that are offline or unknown to the household', () => {
    expect(resolveGroupIds(groups, ['RINCON_GONE', 'RINCON_1'])).toEqual(['GRP_A'])
  })

  it('returns empty rather than throwing on junk input', () => {
    expect(resolveGroupIds(null, null)).toEqual([])
  })
})

import { planAction } from './groups'

// 2026-08-24 is a Monday. Dublin is UTC+1 in August, so 06:00 Dublin is
// 05:00Z and 21:30 Dublin is 20:30Z.
const MONDAY = '2026-08-24'
const at = (hhmmZ) => new Date(`2026-08-24T${hhmmZ}:00Z`).getTime()
const OPEN_AT = at('05:00')

const schedule = {
  enabled: true,
  windows: [{ days: [1, 2, 3, 4, 5], on: '06:00', off: '21:30', volume: 35, favorite_id: 'fv-1' }],
  override: null,
  last_applied: null,
}

describe('planAction', () => {
  it('opens the window on the first tick inside it, carrying volume and favourite', () => {
    expect(planAction(schedule, at('05:00'), MONDAY)).toEqual({
      action: 'open', windowOnAt: OPEN_AT, volume: 35, favoriteId: 'fv-1',
    })
  })

  it('still opens on a LATER tick if the boundary minute was missed', () => {
    // A missed cron tick must self-heal. Edge-detection on playback state
    // would not: it would see the window already begun and do nothing.
    expect(planAction(schedule, at('05:07'), MONDAY)).toMatchObject({ action: 'open' })
  })

  it('does nothing once the window is applied', () => {
    const s = { ...schedule, last_applied: { window_on_at: OPEN_AT, action: 'open' } }
    expect(planAction(s, at('12:00'), MONDAY)).toBe(null)
  })

  it('does not resume music a human paused mid-window', () => {
    // The whole point of exactly-once: a coach who pauses stays paused.
    const s = { ...schedule, last_applied: { window_on_at: OPEN_AT, action: 'open' } }
    expect(planAction(s, at('14:00'), MONDAY)).toBe(null)
  })

  it('closes the window it opened, once the window has ended', () => {
    const s = { ...schedule, last_applied: { window_on_at: OPEN_AT, action: 'open' } }
    expect(planAction(s, at('20:30'), MONDAY)).toEqual({ action: 'close', windowOnAt: OPEN_AT })
  })

  it('does not close twice', () => {
    const s = { ...schedule, last_applied: { window_on_at: OPEN_AT, action: 'close' } }
    expect(planAction(s, at('20:35'), MONDAY)).toBe(null)
  })

  it('does NOT pause a window it never opened', () => {
    // Recovery after downtime spanning a whole window: pausing here would
    // silence music a coach started by hand.
    expect(planAction(schedule, at('20:35'), MONDAY)).toBe(null)
  })

  it('does nothing outside every window with no open on record', () => {
    expect(planAction(schedule, at('03:00'), MONDAY)).toBe(null)
  })

  it('does nothing when the schedule is disabled', () => {
    expect(planAction({ ...schedule, enabled: false }, at('05:00'), MONDAY)).toBe(null)
  })

  it('no-ops entirely while a suppression override is live', () => {
    const s = {
      ...schedule,
      override: { state: 'off', until: new Date(at('23:00')).toISOString() },
    }
    expect(planAction(s, at('05:00'), MONDAY)).toBe(null)
  })

  it('resumes normal service once the override expires', () => {
    const s = {
      ...schedule,
      override: { state: 'off', until: new Date(at('04:00')).toISOString() },
    }
    expect(planAction(s, at('05:00'), MONDAY)).toMatchObject({ action: 'open' })
  })

  it('does not fire on a day the window does not run', () => {
    // 2026-08-23 is a Sunday; the window is Mon-Fri.
    expect(planAction(schedule, new Date('2026-08-23T05:00:00Z').getTime(), '2026-08-23')).toBe(null)
  })

  it('treats a re-run (last_applied cleared) as unapplied', () => {
    // This is exactly what the "run now" button does.
    const s = { ...schedule, last_applied: null }
    expect(planAction(s, at('12:00'), MONDAY)).toMatchObject({ action: 'open' })
  })

  it('defaults a missing volume to a sane level rather than silence', () => {
    const s = {
      ...schedule,
      windows: [{ days: [1, 2, 3, 4, 5], on: '06:00', off: '21:30', favorite_id: 'fv-1' }],
    }
    expect(planAction(s, at('05:00'), MONDAY)).toMatchObject({ volume: 30 })
  })

  // Guards the silent-restart failure: `active.on_at` is always a raw
  // epoch-ms number, but if last_applied.window_on_at ever came back as a
  // string (a timestamptz column, a .toISOString() "to make it readable",
  // any serialisation that stringifies), a strict === against the number
  // would silently never match. Every tick inside the window would then
  // take the open branch and re-issue loadFavorite, restarting the studio
  // playlist every sixty seconds.
  it('suppresses re-open when window_on_at was persisted as a numeric string', () => {
    const s = { ...schedule, last_applied: { window_on_at: String(OPEN_AT), action: 'open' } }
    expect(planAction(s, at('12:00'), MONDAY)).toBe(null)
  })

  // Same silent-restart guard as above, covering the other realistic
  // string shape a jsonb round-trip or schema change could produce.
  it('suppresses re-open when window_on_at was persisted as an ISO string', () => {
    const s = { ...schedule, last_applied: { window_on_at: new Date(OPEN_AT).toISOString(), action: 'open' } }
    expect(planAction(s, at('12:00'), MONDAY)).toBe(null)
  })

  it('closes with a numeric windowOnAt even when the stored value was a string, so the stringy value does not propagate into the next write', () => {
    const s = { ...schedule, last_applied: { window_on_at: String(OPEN_AT), action: 'open' } }
    const result = planAction(s, at('20:30'), MONDAY)
    expect(result).toEqual({ action: 'close', windowOnAt: OPEN_AT })
    expect(typeof result.windowOnAt).toBe('number')
  })

  it('does not close on an unparseable window_on_at, since it cannot identify which window it opened', () => {
    // Inventing a close here could silence music someone started by hand —
    // the same reasoning as "does NOT pause a window it never opened",
    // just reached via a corrupt record instead of a missing one.
    const s = { ...schedule, last_applied: { window_on_at: 'garbage', action: 'open' } }
    expect(planAction(s, at('20:35'), MONDAY)).toBe(null)
  })
})
