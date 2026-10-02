// C146 TASKSNEEDCONTACTS.1 — where the phone offers task / activity writes.
//
// Mig 700 (C144) made reading `activities` need Contacts at the studio, and
// every phone write to that table reads its row back (insert/update …
// .select()), so at a studio where the person cannot read Contacts those
// writes are refused whole. The database's Contacts rule is
// private.auth_contact_read_location_ids(): Contacts on the WEB or on the
// PHONE, through the same tiers as resolvePermission. These cases pin the
// phone to that rule, tier by tier, and pin the two consumers (the nav
// layout and the Home feed link) to it.

import { describe, it, expect } from 'vitest'
import { canReadContactsHere, canUseTasksHere, canLogActivityHere, tasksAccessState } from './tasks-access.js'
import { resolveLayoutForUser } from './mobile-layout.js'
import { mobileRouteForFeedRow } from './today-feed-nav.js'

const owner = { id: 'p-1', role: 'owner' }
const master = { id: 'p-m', role: 'master' }

// A studio with nothing switched off and no per-user overrides: role
// defaults decide (owner: web + phone Contacts on, phone Tasks on).
const studio = (over = {}) => ({ id: 'loc-a', features: {}, permissions: { mobile: {} }, ...over })

// Contacts off on both platforms for this person, by per-user override.
const contactsOffForMe = (extraMobile = {}) => studio({
  permissions: { contacts: false, mobile: { contacts: false, ...extraMobile } },
})

describe('canReadContactsHere (mirrors auth_contact_read_location_ids)', () => {
  it('is true on role defaults', () => {
    expect(canReadContactsHere(owner, studio())).toBe(true)
  })

  it('is false when the studio switches Contacts off, a master included', () => {
    const off = studio({ features: { contacts: false } })
    expect(canReadContactsHere(owner, off)).toBe(false)
    expect(canReadContactsHere(master, off)).toBe(false)
  })

  it('is false when both the web and the phone Contacts key are off for the person', () => {
    expect(canReadContactsHere(owner, contactsOffForMe())).toBe(false)
  })

  it('is true with only the PHONE Contacts key on (web off)', () => {
    const loc = studio({ permissions: { contacts: false, mobile: { contacts: true } } })
    expect(canReadContactsHere(owner, loc)).toBe(true)
  })

  it('is true with only the WEB Contacts key on (phone off), as the database is', () => {
    const loc = studio({ permissions: { contacts: true, mobile: { contacts: false } } })
    expect(canReadContactsHere(owner, loc)).toBe(true)
  })

  it('follows the role template tier on both platforms', () => {
    const loc = studio({ roleTemplate: { contacts: false, mobile: { contacts: false } } })
    expect(canReadContactsHere(owner, loc)).toBe(false)
    const webOnly = studio({ roleTemplate: { contacts: true, mobile: { contacts: false } } })
    expect(canReadContactsHere(owner, webOnly)).toBe(true)
  })

  it('fails closed with no profile or no studio', () => {
    expect(canReadContactsHere(null, studio())).toBe(false)
    expect(canReadContactsHere(owner, null)).toBe(false)
  })
})

describe('canUseTasksHere', () => {
  it('needs the phone Tasks key AND Contacts', () => {
    expect(canUseTasksHere(owner, studio())).toBe(true)
    expect(canUseTasksHere(owner, contactsOffForMe())).toBe(false)
    expect(canUseTasksHere(owner, studio({ permissions: { mobile: { tasks: false } } }))).toBe(false)
  })

  it('re-evaluates per studio: the same person, two studios', () => {
    const a = studio({ id: 'loc-a' })
    const b = { ...contactsOffForMe(), id: 'loc-b' }
    expect(canUseTasksHere(owner, a)).toBe(true)
    expect(canUseTasksHere(owner, b)).toBe(false)
    expect(canUseTasksHere(owner, a)).toBe(true)
  })
})

describe('tasksAccessState (the Tasks screens)', () => {
  it('is pending until /api/mobile/me has landed (a cold-start push opens the screen first)', () => {
    expect(tasksAccessState(null, null)).toBe('pending')
    expect(tasksAccessState(owner, null)).toBe('pending')
    expect(tasksAccessState(null, studio())).toBe('pending')
  })

  it('then follows canUseTasksHere', () => {
    expect(tasksAccessState(owner, studio())).toBe('allowed')
    expect(tasksAccessState(owner, contactsOffForMe())).toBe('off')
    expect(tasksAccessState(owner, studio({ permissions: { mobile: { tasks: false } } }))).toBe('off')
  })
})

describe('canLogActivityHere (deal Call / Email / Meeting)', () => {
  it('follows Contacts', () => {
    expect(canLogActivityHere(owner, studio())).toBe(true)
    expect(canLogActivityHere(owner, contactsOffForMe())).toBe(false)
    expect(canLogActivityHere(owner, studio({ features: { contacts: false } }))).toBe(false)
  })
})

describe('the nav layout drops Tasks where Contacts is unreadable', () => {
  const tasksPlaced = (loc) => {
    const { bar, more } = resolveLayoutForUser(owner, loc)
    return bar.includes('tasks') || more.includes('tasks')
  }

  it('keeps Tasks in More on role defaults', () => {
    expect(tasksPlaced(studio())).toBe(true)
  })

  it('removes Tasks at a studio with Contacts off for the person', () => {
    expect(tasksPlaced(contactsOffForMe())).toBe(false)
  })

  it('removes Tasks at a studio with the Contacts switch off', () => {
    expect(tasksPlaced(studio({ features: { contacts: false } }))).toBe(false)
  })

  it('touches nothing else in the layout', () => {
    const on = resolveLayoutForUser(owner, studio({ permissions: { mobile: { contacts: true } } }))
    const off = resolveLayoutForUser(owner, studio({ permissions: { contacts: false, mobile: { contacts: false } } }))
    const strip = (keys) => keys.filter(k => k !== 'tasks' && k !== 'contacts')
    expect(strip(off.bar)).toEqual(strip(on.bar))
    expect(strip(off.more)).toEqual(strip(on.more))
  })
})

describe('the Home feed tasks row', () => {
  it('links to /tasks only when Tasks is usable', () => {
    expect(mobileRouteForFeedRow('tasks', { canUseTasks: true })).toBe('/tasks')
    expect(mobileRouteForFeedRow('tasks', { canUseTasks: false })).toBe(null)
  })

  it('leaves every other row alone', () => {
    expect(mobileRouteForFeedRow('approvals', { canUseTasks: false })).toBe('/approvals')
  })
})
