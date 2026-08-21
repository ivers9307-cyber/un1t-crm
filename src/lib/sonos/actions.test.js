import { describe, it, expect } from 'vitest'
import { ACTIONS, planLiveAction } from './actions'

describe('planLiveAction', () => {
  it('rejects an unknown action', () => {
    expect(planLiveAction('reboot_everything')).toBe(null)
  })

  it('rejects a missing action', () => {
    expect(planLiveAction(undefined)).toBe(null)
    expect(planLiveAction('')).toBe(null)
  })

  it('maps volume_up to a positive relative delta with a default step', () => {
    expect(planLiveAction('volume_up')).toMatchObject({ call: 'setRelativeVolume', args: [5] })
  })

  it('maps volume_down to a negative delta', () => {
    expect(planLiveAction('volume_down')).toMatchObject({ call: 'setRelativeVolume', args: [-5] })
  })

  it('honours an explicit step and keeps the sign of the direction', () => {
    expect(planLiveAction('volume_up', 10)).toMatchObject({ args: [10] })
    expect(planLiveAction('volume_down', 10)).toMatchObject({ args: [-10] })
  })

  it('reads a negative step as a size, not an instruction to invert', () => {
    // volume_down with a step of -10 must still go DOWN.
    expect(planLiveAction('volume_down', -10)).toMatchObject({ args: [-10] })
    expect(planLiveAction('volume_up', -10)).toMatchObject({ args: [10] })
  })

  it('rejects non-numeric-typed step values for volume_up/volume_down, same as set_volume', () => {
    // The volume_up/down branch shares toFiniteNumber with set_volume now,
    // so it must reject the same shapes: `true` would otherwise coerce to
    // 1 (an accepted 1-unit step) and `[5]` to 5 (an accepted 5-unit step).
    expect(planLiveAction('volume_up', true)).toBe(null)
    expect(planLiveAction('volume_up', [5])).toBe(null)
    expect(planLiveAction('volume_up', {})).toBe(null)
    expect(planLiveAction('volume_up', '  ')).toBe(null)
    expect(planLiveAction('volume_up', '')).toBe(null)
  })

  it('still accepts the previously-valid step shapes for volume_up/volume_down', () => {
    expect(planLiveAction('volume_up', '5')).toMatchObject({ args: [5] })
    expect(planLiveAction('volume_up', 5)).toMatchObject({ args: [5] })
    expect(planLiveAction('volume_up', '5.5')).toMatchObject({ args: [6] })
    // null/undefined still mean "use the default step".
    expect(planLiveAction('volume_up', null)).toMatchObject({ args: [5] })
    expect(planLiveAction('volume_up', undefined)).toMatchObject({ args: [5] })
  })

  it('maps set_volume to an absolute level', () => {
    expect(planLiveAction('set_volume', 35)).toMatchObject({ call: 'setVolume', args: [35] })
  })

  it('rejects set_volume without a usable level', () => {
    expect(planLiveAction('set_volume')).toBe(null)
    expect(planLiveAction('set_volume', 'loud')).toBe(null)
  })

  it('accepts a zero volume, which is falsy but valid', () => {
    expect(planLiveAction('set_volume', 0)).toMatchObject({ call: 'setVolume', args: [0] })
  })

  it('rejects an out-of-range absolute volume rather than silently clamping', () => {
    // The client clamps defensively, but a 140 from a caller is a bug in
    // that caller and should be reported, not quietly turned into 100.
    expect(planLiveAction('set_volume', 140)).toBe(null)
    expect(planLiveAction('set_volume', -1)).toBe(null)
  })

  it('rejects non-numeric-typed values the route validation would not catch', () => {
    // The route's Zod schema is z.union([z.number(), z.string()]).optional(),
    // which blocks null/true/[] before this ever runs. Guard them anyway —
    // this table has to be safe to call directly, not just safe behind Zod.
    expect(planLiveAction('set_volume', null)).toBe(null)
    expect(planLiveAction('set_volume', true)).toBe(null)
    expect(planLiveAction('set_volume', [])).toBe(null)
    // This is the one Zod does NOT catch: '  ' is a valid string, and
    // Number('  ') === 0, so a naive Number() coercion turns whitespace
    // into a silently-accepted volume of 0 (the room goes silent, and the
    // route reports success). That is exactly the failure this guard
    // exists to prevent at this layer, not just at the HTTP boundary.
    expect(planLiveAction('set_volume', '  ')).toBe(null)
    expect(planLiveAction('set_volume', '')).toBe(null)
  })

  it('still accepts a numeric string, including one with a trailing .0', () => {
    expect(planLiveAction('set_volume', '35')).toMatchObject({ call: 'setVolume', args: [35] })
    expect(planLiveAction('set_volume', '5.0')).toMatchObject({ call: 'setVolume', args: [5] })
  })

  it('maps the transport actions', () => {
    expect(planLiveAction('play')).toMatchObject({ call: 'play', args: [] })
    expect(planLiveAction('pause')).toMatchObject({ call: 'pause', args: [] })
    expect(planLiveAction('skip_next')).toMatchObject({ call: 'skipNext', args: [] })
    expect(planLiveAction('skip_previous')).toMatchObject({ call: 'skipPrevious', args: [] })
  })

  it('maps load_favorite with the favourite id', () => {
    expect(planLiveAction('load_favorite', '125')).toMatchObject({ call: 'loadFavorite', args: ['125'] })
  })

  it('rejects load_favorite with no id', () => {
    expect(planLiveAction('load_favorite')).toBe(null)
    expect(planLiveAction('load_favorite', '')).toBe(null)
  })

  it('flags which actions change volume, so a fixed-volume group can refuse them', () => {
    expect(planLiveAction('volume_up').touchesVolume).toBe(true)
    expect(planLiveAction('set_volume', 20).touchesVolume).toBe(true)
    expect(planLiveAction('play').touchesVolume).toBe(false)
  })

  it('exposes the closed action list', () => {
    expect(ACTIONS).toEqual([
      'volume_up', 'volume_down', 'set_volume',
      'play', 'pause', 'skip_next', 'skip_previous', 'load_favorite',
    ])
  })
})
