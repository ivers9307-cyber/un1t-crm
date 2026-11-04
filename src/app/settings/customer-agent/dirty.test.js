// MIASETTINGS.2a — unsaved-change tracking for the Mia settings page: what
// differs from the last load or save, and which sections that touches.

import { describe, it, expect } from 'vitest'
import { changedPaths, dirtySections } from './dirty'
import { sectionForPath } from './sections'

const BASE = {
  settings: {
    enabled: true,
    tone: null,
    test_phones: [],
    followups: { enabled: false, nudge_after_hours: 3, template_name: null, daily_cap: 50 },
    quiet_hours: null,
    cancellation_form: null,
    trial_done: { enabled: false, delay_hours: 2, only_contact_ids: [] },
  },
  overridden: ['followups.daily_cap'],
}
const copy = (v) => structuredClone(v)

describe('changedPaths', () => {
  it('no change gives []', () => {
    expect(changedPaths(BASE, copy(BASE))).toEqual([])
  })

  it('a scalar change names its key', () => {
    const after = copy(BASE)
    after.settings.tone = 'Warm'
    expect(changedPaths(BASE, after)).toEqual(['tone'])
  })

  it('a nested field names its dotted path', () => {
    const after = copy(BASE)
    after.settings.followups.daily_cap = 33
    expect(changedPaths(BASE, after)).toEqual(['followups.daily_cap'])
  })

  it('a cancellation reason label names its full path, from a null block', () => {
    const after = copy(BASE)
    after.settings.cancellation_form = { reason_labels: { price: 'Too dear' } }
    expect(changedPaths(BASE, after)).toEqual(['cancellation_form.reason_labels.price'])
  })

  it('an override-only change ("Use default") is overridden:<path>', () => {
    const after = copy(BASE)
    after.overridden = []
    expect(changedPaths(BASE, after)).toEqual(['overridden:followups.daily_cap'])
  })

  it('an override change on a path whose value also changed is named once, by the value', () => {
    const after = copy(BASE)
    after.settings.tone = 'Warm'
    after.overridden = ['followups.daily_cap', 'tone']
    expect(changedPaths(BASE, after)).toEqual(['tone'])
  })

  it('null, undefined and empty text are the same; other text is exact', () => {
    const after = copy(BASE)
    after.settings.tone = ''
    after.settings.cancellation_form = { form_intro: '' }
    after.settings.trial_done.mia_instruction = undefined
    expect(changedPaths(BASE, after)).toEqual([])
    after.settings.tone = ' '
    expect(changedPaths(BASE, after)).toEqual(['tone'])
  })

  it('arrays compare as values', () => {
    const after = copy(BASE)
    after.settings.test_phones = ['+353871234567']
    after.settings.trial_done.only_contact_ids = []
    expect(changedPaths(BASE, after)).toEqual(['test_phones'])
  })

  it('the trial finisher test ids text is compared too', () => {
    const after = copy(BASE)
    after.settings.trial_done.only_contact_ids_text = 'abc'
    expect(changedPaths(BASE, after)).toEqual(['trial_done.only_contact_ids_text'])
  })

  it('the result is order independent and sorted', () => {
    const after = copy(BASE)
    after.settings.trial_done.delay_hours = 6
    after.settings.tone = 'Warm'
    after.settings.followups.daily_cap = 33
    after.overridden = ['followups.daily_cap', 'tone']
    const reordered = { overridden: ['tone', 'followups.daily_cap'], settings: Object.fromEntries(Object.entries(after.settings).reverse()) }
    expect(changedPaths(BASE, after)).toEqual(['followups.daily_cap', 'tone', 'trial_done.delay_hours'])
    expect(changedPaths(BASE, reordered)).toEqual(changedPaths(BASE, after))
    expect(changedPaths(after, reordered)).toEqual([])
  })

  it('a missing side reads as empty', () => {
    expect(changedPaths(null, BASE)).toContain('enabled')
    expect(changedPaths(BASE, null)).toContain('followups.daily_cap')
    expect(changedPaths({ settings: null, overridden: ['tone'] }, null)).toEqual(['overridden:tone'])
  })
})

describe('dirtySections', () => {
  it('maps each path to its section, overrides included', () => {
    expect(dirtySections(['tone', 'followups.daily_cap', 'overridden:quiet_hours.end', 'cancellation_form.reason_labels.price']))
      .toEqual(new Set(['personality', 'followups', 'overview', 'cancellation']))
  })

  it('no paths, no sections', () => {
    expect(dirtySections([])).toEqual(new Set())
  })
})

describe('sectionForPath', () => {
  it('matches the longest registry path at a dot boundary', () => {
    expect(sectionForPath('followups.daily_cap')).toBe('followups')
    expect(sectionForPath('cancellation_form.reason_labels.price')).toBe('cancellation')
    expect(sectionForPath('quiet_hours.start')).toBe('overview')
    expect(sectionForPath('trial_done.delay_hours')).toBe('followups')
    expect(sectionForPath('trial_done.only_contact_ids_text')).toBe('followups')
    expect(sectionForPath('test_phones')).toBe('overview')
    expect(sectionForPath('agent_name')).toBe('personality')
    expect(sectionForPath('holding_message')).toBe('handoffs')
    expect(sectionForPath('booking_url')).toBe('bookings')
    expect(sectionForPath('no_credits_handoff_text')).toBe('messages')
    expect(sectionForPath('glofox_auto_cancel')).toBe('cancellation')
    expect(sectionForPath('monthly_points_target')).toBe('member-app')
  })

  it('a whole object key whose fields share one section maps there', () => {
    expect(sectionForPath('followups')).toBe('followups')
    expect(sectionForPath('first_class_checkin')).toBe('followups')
  })

  it('no dot-boundary false match, and an unknown path is null', () => {
    expect(sectionForPath('tone_extra')).toBe(null)
    expect(sectionForPath('limits.max_replies_per_location_per_day')).toBe(null)
  })
})
