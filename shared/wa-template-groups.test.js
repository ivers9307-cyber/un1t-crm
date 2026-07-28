import { describe, it, expect } from 'vitest'
import {
  UNGROUPED_LABEL,
  templateBodyText,
  listWaTemplateGroups,
  groupWaTemplates,
} from './wa-template-groups.js'

const tpl = (name, display_group, body) => ({
  name,
  display_group,
  components: body ? [{ type: 'BODY', text: body }] : [],
})

describe('templateBodyText', () => {
  it('prefers the denormalised body_text column (mobile select shape)', () => {
    expect(templateBodyText({ body_text: 'hi', components: [{ type: 'BODY', text: 'other' }] })).toBe('hi')
  })
  it('falls back to the BODY component (web shape)', () => {
    expect(templateBodyText(tpl('a', null, 'from components'))).toBe('from components')
  })
  it('returns empty string for missing/malformed shapes', () => {
    expect(templateBodyText({})).toBe('')
    expect(templateBodyText({ components: 'nope' })).toBe('')
    expect(templateBodyText(null)).toBe('')
  })
})

describe('listWaTemplateGroups', () => {
  it('returns distinct trimmed labels, alphabetical, first-seen casing', () => {
    const groups = listWaTemplateGroups([
      tpl('a', ' Payments '),
      tpl('b', 'Bookings'),
      tpl('c', 'payments'),
      tpl('d', null),
      tpl('e', ''),
    ])
    expect(groups).toEqual(['Bookings', 'Payments'])
  })
  it('handles empty input', () => {
    expect(listWaTemplateGroups([])).toEqual([])
    expect(listWaTemplateGroups(undefined)).toEqual([])
  })
})

describe('groupWaTemplates', () => {
  it('buckets by display_group with Ungrouped last and names sorted within groups', () => {
    const groups = groupWaTemplates([
      tpl('z_no_group', null),
      tpl('welcome_b', 'Bookings'),
      tpl('dunning_1', 'Payments'),
      tpl('welcome_a', 'Bookings'),
    ])
    expect(groups.map(g => g.label)).toEqual(['Bookings', 'Payments', UNGROUPED_LABEL])
    expect(groups[0].templates.map(t => t.name)).toEqual(['welcome_a', 'welcome_b'])
    expect(groups[2].templates.map(t => t.name)).toEqual(['z_no_group'])
  })

  it('merges group labels case-insensitively, keeping first-seen casing', () => {
    const groups = groupWaTemplates([tpl('a', 'Payments'), tpl('b', 'payments')])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Payments')
    expect(groups[0].templates).toHaveLength(2)
  })

  it('treats blank/whitespace groups as Ungrouped', () => {
    const groups = groupWaTemplates([tpl('a', '   '), tpl('b', undefined)])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe(UNGROUPED_LABEL)
  })

  it('filters by search across name, group label and body text', () => {
    const templates = [
      tpl('booking_confirm', 'Bookings', 'See you at class'),
      tpl('dunning_1', 'Payments', 'Your payment failed'),
      tpl('hello', null, 'Just saying hi'),
    ]
    expect(groupWaTemplates(templates, 'dunning').flatMap(g => g.templates).map(t => t.name)).toEqual(['dunning_1'])
    expect(groupWaTemplates(templates, 'BOOK').flatMap(g => g.templates).map(t => t.name)).toEqual(['booking_confirm'])
    expect(groupWaTemplates(templates, 'payment failed').flatMap(g => g.templates).map(t => t.name)).toEqual(['dunning_1'])
    expect(groupWaTemplates(templates, 'zzz')).toEqual([])
  })

  it('matches search against body_text column shape too', () => {
    const groups = groupWaTemplates([{ name: 'x', display_group: null, body_text: 'renewal time' }], 'renewal')
    expect(groups.flatMap(g => g.templates).map(t => t.name)).toEqual(['x'])
  })

  it('handles empty input', () => {
    expect(groupWaTemplates([])).toEqual([])
    expect(groupWaTemplates(undefined)).toEqual([])
  })
})
