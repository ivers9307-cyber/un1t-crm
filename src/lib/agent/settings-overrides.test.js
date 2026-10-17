// MIAORG.1 Task 3 — the override-set helpers the studio editor and the PUT
// share. Fictional values throughout.
import { describe, it, expect } from 'vitest'
import {
  isKnownOverridePath, expandOverridden, initialOverridden, isOverridden,
  withOverride, withoutOverride, valueAt, fieldSource, sourceTagLabel, orgSetsAny,
} from './settings-overrides'

describe('isKnownOverridePath', () => {
  it('accepts top-level inheritable keys, object keys, their known fields and studio-only keys', () => {
    for (const p of ['tone', 'agent_name', 'handoff_sla_minutes', 'followups', 'followups.daily_cap', 'quiet_hours.tz', 'limits.max_replies_per_location_per_day', 'enabled', 'test_mode', 'booking_url']) {
      expect(isKnownOverridePath(p), p).toBe(true)
    }
  })
  it('refuses unknown keys, unknown fields, fields of a non-object key, and junk', () => {
    for (const p of ['tonne', 'followups.max_per_day', 'tone.length', 'cancellation_form.form_intro', 'social_enabled', 'glofox_auto_cancel', 'booking_expired_text', '', '.', 'followups.', null, 7]) {
      expect(isKnownOverridePath(p), String(p)).toBe(false)
    }
  })
})

describe('expandOverridden', () => {
  it('splits scalars from object fields, expands a whole object key, drops studio-only keys', () => {
    const { scalars, fields } = expandOverridden(['tone', 'enabled', 'followups', 'quiet_hours.start', 'test_mode'])
    expect([...scalars]).toEqual(['tone'])
    expect([...fields.get('followups')].sort()).toEqual(['daily_cap', 'enabled', 'nudge_after_hours', 'template_name'])
    expect([...fields.get('quiet_hours')]).toEqual(['start'])
    expect(fields.has('limits')).toBe(false)
  })
})

describe('initialOverridden (T3-D: the first save of a legacy full blob keeps every stored value)', () => {
  it('a full legacy blob marks every inheritable key and object field it holds a value for', () => {
    const studio = {
      enabled: true, test_mode: false, tone: 'Warm', extra_rules: null, agent_name: 'Mia',
      handoff_cooldown_hours: 0, monthly_points_target: 0,
      followups: { enabled: true, nudge_after_hours: 3, template_name: null, daily_cap: 50 },
      inline_suggestion: { enabled: false },
      quiet_hours: null,
      limits: { max_replies_per_conversation_per_hour: 9 },
      booking_expired_text: 'retired key',
    }
    expect(initialOverridden(studio)).toEqual([
      'agent_name',
      'followups.daily_cap', 'followups.enabled', 'followups.nudge_after_hours',
      'handoff_cooldown_hours',
      'inline_suggestion.enabled',
      'limits.max_replies_per_conversation_per_hour',
      // monthly_points_target is studio-only (final review): always saved, never an override path
      'tone',
    ])
  })
  it('no blob (Hatch) overrides nothing; a non-object is treated as none', () => {
    expect(initialOverridden(null)).toEqual([])
    expect(initialOverridden([])).toEqual([])
    expect(initialOverridden('x')).toEqual([])
  })
  it('every path it produces is one the PUT accepts', () => {
    const paths = initialOverridden({ tone: 'a', followups: { enabled: true, daily_cap: 1, nonsense: 2 }, quiet_hours: { start: '21:00', end: '07:00', tz: 'Europe/Dublin' } })
    expect(paths.every(isKnownOverridePath)).toBe(true)
    expect(paths).not.toContain('followups.nonsense')
  })
})

describe('withOverride / withoutOverride / isOverridden', () => {
  it('marking adds the path; studio-only and unknown paths are ignored', () => {
    expect(withOverride([], 'tone', 'enabled', 'nope')).toEqual(['tone'])
    expect(withOverride(['tone'], 'followups.daily_cap')).toEqual(['followups.daily_cap', 'tone'])
  })
  it('"Use organisation default" removes just that path', () => {
    expect(withoutOverride(['followups.daily_cap', 'tone'], 'tone')).toEqual(['followups.daily_cap'])
  })
  it('a whole object key is shorthand for its fields, both ways', () => {
    const all = withOverride([], 'quiet_hours')
    expect(all).toEqual(['quiet_hours.end', 'quiet_hours.off', 'quiet_hours.start', 'quiet_hours.tz'])
    expect(withoutOverride(['followups'], 'followups.enabled')).toEqual(['followups.daily_cap', 'followups.nudge_after_hours', 'followups.template_name'])
    expect(withoutOverride(all, 'quiet_hours')).toEqual([])
    expect(isOverridden(['followups'], 'followups.daily_cap')).toBe(true)
    expect(isOverridden(['followups.daily_cap'], 'followups')).toBe(true)
    expect(isOverridden(['followups.daily_cap'], 'followups.enabled')).toBe(false)
  })
})

describe('fieldSource + sourceTagLabel (T3-F)', () => {
  const org = { tone: 'Org tone', followups: { daily_cap: 80, template_name: null }, extra_rules: null }
  it('overridden -> studio (no tag)', () => {
    expect(fieldSource(['tone'], { overridden: ['tone'], org })).toBe('studio')
    expect(sourceTagLabel('studio')).toBe(null)
  })
  it('not overridden, set at the org -> "Organisation default"', () => {
    expect(fieldSource(['tone'], { overridden: [], org })).toBe('org')
    expect(fieldSource(['followups.daily_cap'], { overridden: [], org })).toBe('org')
    expect(sourceTagLabel('org')).toBe('Organisation default')
  })
  it('not overridden, null or absent at the org -> "Default"', () => {
    expect(fieldSource(['extra_rules'], { overridden: [], org })).toBe('default')
    expect(fieldSource(['followups.template_name'], { overridden: [], org })).toBe('default')
    expect(fieldSource(['tone'], { overridden: [], org: null })).toBe('default')
    expect(sourceTagLabel('default')).toBe('Default')
  })
  it('a studio-only key is always the studio\'s own', () => {
    expect(fieldSource(['enabled'], { overridden: [], org: { enabled: true } })).toBe('studio')
  })
  it('orgSetsAny: a whole object key counts only on a set field', () => {
    expect(orgSetsAny(['quiet_hours'], { quiet_hours: { start: null, end: null, tz: null } })).toBe(false)
    expect(orgSetsAny(['quiet_hours'], { quiet_hours: { start: '22:00' } })).toBe(true)
    expect(fieldSource(['quiet_hours'], { overridden: [], org: { quiet_hours: { start: null } } })).toBe('default')
    expect(orgSetsAny(['tone'], null)).toBe(false)
  })
  it('valueAt reads top-level and dotted paths', () => {
    expect(valueAt(org, 'tone')).toBe('Org tone')
    expect(valueAt(org, 'followups.daily_cap')).toBe(80)
    expect(valueAt(org, 'limits.max_replies_per_location_per_day')).toBe(undefined)
    expect(valueAt(null, 'tone')).toBe(undefined)
  })
})
