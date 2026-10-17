// MIAORG.1 Task 4 — the org editor's pure rules: who inherits each org value
// (T4-A), what a save starts applying, and "Start from a studio's settings"
// (T4-C). Fictional ids and names.
import { describe, it, expect } from 'vitest'
import {
  studiosForField, describeInheritance, newlyAppliedFields, describeNewlyApplied, copyablePaths, copyStudioIntoOrg,
} from './settings-org'
import { initialOverridden } from './settings-overrides'

const NORTH = { id: 'a0000000-0000-0000-0000-0000000000b1', name: 'North Studio', sets: ['quiet_hours.off', 'tone'], mia_on: true }
const SOUTH = { id: 'a0000000-0000-0000-0000-0000000000b2', name: 'South Studio', sets: [], mia_on: false }
const EAST = { id: 'a0000000-0000-0000-0000-0000000000b3', name: 'East Studio', sets: ['followups.daily_cap'], mia_on: true }

describe('who uses each org value (T4-A)', () => {
  it('a studio that sets any path of the field sets its own; the rest use the org value', () => {
    const { using, own } = studiosForField(['tone'], [NORTH, SOUTH, EAST])
    expect(using.map((s) => s.name)).toEqual(['South Studio', 'East Studio'])
    expect(own.map((s) => s.name)).toEqual(['North Studio'])
  })

  it('a studio\'s quiet-hours opt-out counts as its own quiet hours', () => {
    expect(studiosForField(['quiet_hours'], [NORTH, SOUTH]).own.map((s) => s.name)).toEqual(['North Studio'])
  })

  it('the staff line names both, with Mia off labelled', () => {
    expect(describeInheritance(['quiet_hours'], [NORTH, SOUTH])).toBe('Used by South Studio (Mia off). North Studio sets its own.')
    expect(describeInheritance(['followups.daily_cap'], [NORTH, SOUTH, EAST])).toBe('Used by North Studio and South Studio (Mia off). East Studio sets its own.')
    expect(describeInheritance(['tone'], [NORTH])).toBe('No studio uses this value. North Studio sets its own.')
    expect(describeInheritance(['tone'], [])).toBe('No active studios in this organisation yet.')
    expect(describeInheritance(['tone'], [SOUTH, EAST])).not.toMatch(/—/)
  })
})

describe('what a save starts applying (T4-A)', () => {
  const FIELDS = [
    { id: 'quiet_hours', label: 'Quiet hours (optional)', paths: ['quiet_hours'] },
    { id: 'tone', label: 'Tone and voice', paths: ['tone'] },
    { id: 'agent_name', label: 'Agent name', paths: ['agent_name'] },
  ]

  it('only fields going from no value to a value, with the studios that will use them', () => {
    const out = newlyAppliedFields(FIELDS, ['agent_name'], ['agent_name', 'quiet_hours.end', 'quiet_hours.start', 'tone'], [NORTH, SOUTH])
    expect(out.map((n) => n.field.id)).toEqual(['quiet_hours', 'tone'])
    // North switched quiet hours off and sets its own tone: it starts using neither
    expect(out[0].studios.map((s) => s.name)).toEqual(['South Studio'])
    expect(describeNewlyApplied(out[0])).toBe('Quiet hours (optional): South Studio (Mia off) will start using this.')
  })

  it('a field nobody would start using is not listed', () => {
    expect(newlyAppliedFields(FIELDS, [], ['tone'], [NORTH])).toEqual([])
  })

  it('a field already set before is a change, not a new application', () => {
    expect(newlyAppliedFields(FIELDS, ['tone'], ['tone'], [SOUTH])).toEqual([])
  })
})

describe('Start from a studio\'s settings (T4-C)', () => {
  const STUDIO = {
    enabled: true, test_mode: false, booking_mode: 'draft', booking_url: 'https://book.example/north',
    tone: 'Studio tone', agent_name: 'Ava', extra_rules: null,
    followups: { enabled: true, daily_cap: 30, template_name: null },
    quiet_hours: { start: '21:00', end: '07:00', tz: 'Europe/Dublin' },
    limits: { max_replies_per_location_per_day: 200 },
  }
  const ORG = { tone: 'Org tone', extra_rules: 'Org rule', followups: { nudge_after_hours: 5, daily_cap: 80 } }

  it('copies present, non-null inheritable values over the org, per field, and keeps the rest', () => {
    const before = structuredClone(STUDIO)
    const { layer, copied } = copyStudioIntoOrg(ORG, STUDIO)
    expect(layer).toEqual({
      tone: 'Studio tone',
      agent_name: 'Ava',
      extra_rules: 'Org rule',
      followups: { nudge_after_hours: 5, daily_cap: 30, enabled: true },
      quiet_hours: { start: '21:00', end: '07:00' },
      limits: { max_replies_per_location_per_day: 200 },
    })
    expect(copied).not.toContain('quiet_hours.tz')
    // never a studio-only key, and the studio blob is untouched
    for (const k of ['enabled', 'test_mode', 'booking_mode', 'booking_url']) expect(layer).not.toHaveProperty(k)
    expect(STUDIO).toEqual(before)
    expect(ORG).toEqual({ tone: 'Org tone', extra_rules: 'Org rule', followups: { nudge_after_hours: 5, daily_cap: 80 } })
  })

  it('never copies quiet_hours.off, and a studio with quiet hours off has no window to copy', () => {
    const { layer } = copyStudioIntoOrg({ quiet_hours: { start: '22:00', end: '06:00' } }, { quiet_hours: { start: '21:00', end: '07:00', off: true } })
    expect(layer.quiet_hours).toEqual({ start: '22:00', end: '06:00' })
    expect(copyablePaths(['quiet_hours.off', 'quiet_hours.start', 'quiet_hours.end', 'tone'])).toEqual(['tone'])
  })

  it('a half window is not copied', () => {
    expect(copyablePaths(['quiet_hours.start', 'tone'])).toEqual(['tone'])
  })

  it('a studio-only key the org layer somehow holds is dropped on copy', () => {
    const { layer } = copyStudioIntoOrg({ enabled: true, tone: 'Org tone' }, { tone: null })
    expect(layer).toEqual({ tone: 'Org tone' })
  })

  it('a studio with no blob copies nothing', () => {
    expect(copyStudioIntoOrg(ORG, null)).toEqual({ layer: ORG, copied: [] })
  })

  it('the client preview and the server copy agree on the paths', () => {
    expect(copyStudioIntoOrg(null, STUDIO).copied).toEqual(copyablePaths(initialOverridden(STUDIO)))
  })
})

describe('fix round — blank values and half windows', () => {
  it('nonBlankSetPaths keeps only set paths that hold a value; quiet hours only as a pair', async () => {
    const { nonBlankSetPaths } = await import('./settings-org')
    const values = { tone: '  ', agent_name: 'Ava', handoff_cooldown_hours: 0, extra_rules: null, quiet_hours: { start: '22:00', end: '' } }
    expect(nonBlankSetPaths(['tone', 'agent_name', 'handoff_cooldown_hours', 'extra_rules', 'quiet_hours.start', 'quiet_hours.end'], values))
      .toEqual(['agent_name', 'handoff_cooldown_hours'])
    expect(nonBlankSetPaths(['quiet_hours.start', 'quiet_hours.end', 'quiet_hours.tz'], { quiet_hours: { start: '22:00', end: '07:00', tz: 'UTC' } }))
      .toEqual(['quiet_hours.start', 'quiet_hours.end'])
  })

  it('isHalfQuietWindow: one end only, not when off or empty or whole', async () => {
    const { isHalfQuietWindow } = await import('./settings-overrides')
    expect(isHalfQuietWindow({ start: '22:00', end: '' })).toBe(true)
    expect(isHalfQuietWindow({ start: null, end: '07:00' })).toBe(true)
    expect(isHalfQuietWindow({ start: '22:00', end: '07:00' })).toBe(false)
    expect(isHalfQuietWindow({ start: '', end: null })).toBe(false)
    expect(isHalfQuietWindow({ start: '22:00', off: true })).toBe(false)
    expect(isHalfQuietWindow(null)).toBe(false)
  })
})
