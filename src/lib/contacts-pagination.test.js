import { describe, it, expect } from 'vitest'
import { hasMoreContacts, CONTACTS_INITIAL_CAP, CONTACTS_PAGE_SIZE } from './contacts-pagination.js'

describe('hasMoreContacts', () => {
  it('pristine view (no count): offers more only when the initial list hit the cap', () => {
    expect(hasMoreContacts({ loadedLength: CONTACTS_INITIAL_CAP, count: null })).toBe(true)
    expect(hasMoreContacts({ loadedLength: CONTACTS_INITIAL_CAP, count: undefined })).toBe(true)
    expect(hasMoreContacts({ loadedLength: 199, count: null })).toBe(false) // fewer than cap = we have all
    expect(hasMoreContacts({ loadedLength: 0, count: null })).toBe(false)
  })

  it('once a page is fetched (count known): more iff loaded < total', () => {
    expect(hasMoreContacts({ loadedLength: 300, count: 1842 })).toBe(true)
    expect(hasMoreContacts({ loadedLength: 1842, count: 1842 })).toBe(false)
    expect(hasMoreContacts({ loadedLength: 200, count: 200 })).toBe(false) // exactly the cap, no more
    expect(hasMoreContacts({ loadedLength: 50, count: 50 })).toBe(false)
  })

  it('count of 0 means no more (empty result)', () => {
    expect(hasMoreContacts({ loadedLength: 0, count: 0 })).toBe(false)
  })

  it('sane constants', () => {
    expect(CONTACTS_INITIAL_CAP).toBe(200)
    expect(CONTACTS_PAGE_SIZE).toBeGreaterThan(0)
  })
})
