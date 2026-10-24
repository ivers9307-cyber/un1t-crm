// FINDTEAM.2 — find-team settings, copy defaults and the capacity rule. Pure, Node env.

import { describe, it, expect } from 'vitest'
import {
  FIND_TEAM_DEFAULTS,
  FindTeamSettingsSchema,
  resolveFindTeamSettings,
  soloTeamName,
  countsTowardTeamCapacity,
} from './find-team.js'

describe('FIND_TEAM_DEFAULTS', () => {
  it('is off by default with operator-editable copy', () => {
    expect(FIND_TEAM_DEFAULTS.enabled).toBe(false)
    expect(FIND_TEAM_DEFAULTS.label).toBe('Find me a team')
    expect(FIND_TEAM_DEFAULTS.placed_subject).toBe("You're on a team for {{event_name}}")
    expect(Object.isFrozen(FIND_TEAM_DEFAULTS)).toBe(true)
  })
})

describe('resolveFindTeamSettings', () => {
  it('returns the defaults for a race with no find_team', () => {
    expect(resolveFindTeamSettings({})).toEqual(FIND_TEAM_DEFAULTS)
    expect(resolveFindTeamSettings(null)).toEqual(FIND_TEAM_DEFAULTS)
    expect(resolveFindTeamSettings({ find_team: null })).toEqual(FIND_TEAM_DEFAULTS)
  })

  it('keeps default copy when only enabled is saved', () => {
    const s = resolveFindTeamSettings({ find_team: { enabled: true } })
    expect(s.enabled).toBe(true)
    expect(s.label).toBe('Find me a team')
  })

  it('overlays saved copy and drops nulls', () => {
    const s = resolveFindTeamSettings({ find_team: { enabled: true, label: 'Solo? Join a team', blurb: null } })
    expect(s.label).toBe('Solo? Join a team')
    expect(s.blurb).toBe(FIND_TEAM_DEFAULTS.blurb)
  })

  it('keeps an empty string cleared on purpose', () => {
    expect(resolveFindTeamSettings({ find_team: { blurb: '' } }).blurb).toBe('')
  })

  it('always resolves enabled to a boolean', () => {
    expect(resolveFindTeamSettings({ find_team: { enabled: 'yes' } }).enabled).toBe(false)
    expect(resolveFindTeamSettings({ find_team: {} }).enabled).toBe(false)
  })

  it('ignores a non-object find_team', () => {
    expect(resolveFindTeamSettings({ find_team: [1] })).toEqual(FIND_TEAM_DEFAULTS)
    expect(resolveFindTeamSettings({ find_team: 'x' })).toEqual(FIND_TEAM_DEFAULTS)
  })
})

describe('FindTeamSettingsSchema', () => {
  it('accepts an empty object and a full one', () => {
    expect(FindTeamSettingsSchema.safeParse({}).success).toBe(true)
    expect(FindTeamSettingsSchema.safeParse({ ...FIND_TEAM_DEFAULTS, enabled: true }).success).toBe(true)
  })

  it('rejects copy over 2000 characters and a non-boolean enabled', () => {
    expect(FindTeamSettingsSchema.safeParse({ blurb: 'x'.repeat(2001) }).success).toBe(false)
    expect(FindTeamSettingsSchema.safeParse({ enabled: 'true' }).success).toBe(false)
  })

  it('trims copy', () => {
    expect(FindTeamSettingsSchema.parse({ label: '  Hi  ' }).label).toBe('Hi')
  })
})

describe('soloTeamName', () => {
  it('names the team of one after the person', () => {
    expect(soloTeamName('Sarah Byrne')).toBe('Sarah Byrne (looking for a team)')
    expect(soloTeamName('  Sarah Byrne  ')).toBe('Sarah Byrne (looking for a team)')
  })
})

describe('countsTowardTeamCapacity', () => {
  it('counts a confirmed registration that is not looking for a team', () => {
    expect(countsTowardTeamCapacity({ status: 'confirmed' })).toBe(true)
    expect(countsTowardTeamCapacity({ status: 'confirmed', looking_for_team: false })).toBe(true)
  })
  it('does not count an unplaced solo', () => {
    expect(countsTowardTeamCapacity({ status: 'confirmed', looking_for_team: true })).toBe(false)
  })
  it('does not count anything that is not confirmed', () => {
    expect(countsTowardTeamCapacity({ status: 'placed' })).toBe(false)
    expect(countsTowardTeamCapacity({ status: 'pending_payment' })).toBe(false)
    expect(countsTowardTeamCapacity(null)).toBe(false)
  })
})
