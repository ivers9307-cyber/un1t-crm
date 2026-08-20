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
