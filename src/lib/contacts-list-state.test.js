import { describe, it, expect } from 'vitest'
import { contactsListState, stageChipLabel } from './contacts-list-state'

describe('contactsListState (VISREFRESH.1)', () => {
  it('a failed read with nothing loaded is an error, not an empty list', () => {
    expect(contactsListState({ error: 'boom', rowCount: 0 })).toBe('error')
    expect(contactsListState({ error: 'boom', rowCount: 0, filtersActive: true })).toBe('error')
  })
  it('a failed Load more keeps the rows on screen', () => {
    expect(contactsListState({ error: 'boom', rowCount: 12 })).toBe('rows')
  })
  it('loading shows only when there is nothing to show yet', () => {
    expect(contactsListState({ loading: true, rowCount: 0 })).toBe('loading')
    expect(contactsListState({ loading: true, rowCount: 5 })).toBe('rows')
  })
  it('zero rows is "no matches" under a filter and "empty" without one', () => {
    expect(contactsListState({ rowCount: 0, filtersActive: true })).toBe('no-matches')
    expect(contactsListState({ rowCount: 0, filtersActive: false })).toBe('empty')
  })
  it('error beats loading', () => {
    expect(contactsListState({ error: 'x', loading: true, rowCount: 0 })).toBe('error')
  })
})

describe('stageChipLabel', () => {
  it.each([
    ['', 'All'], ['new_lead', 'New lead'], ['first_class', 'First class'],
    ['trial_done', 'Trial done'], ['member', 'Member'], ['pack_member', 'Pack member'],
  ])('%s → %s', (slug, label) => expect(stageChipLabel(slug)).toBe(label))
})
