// C146 TASKSNEEDCONTACTS.1 — the web's task / activity write controls follow
// the Contacts rule mig 700 put on reading `activities`.
import { describe, it, expect } from 'vitest'
import { canWriteActivitiesAt, taskStatusUpdateOutcome, personActionsFor } from './activity-write-gate'
import { contactWorkGates } from './contact-page-gates'
import { person, MASTER, OUTSIDER, LOC_A, LOC_B } from '../../tests/helpers/role-sweep-callers.js'
import { webOrMobileCases } from '../../tests/helpers/role-sweep-callers-c.js'

const shows = (outcome) => outcome === 'pass'

describe('canWriteActivitiesAt — Contacts web OR phone at the studio (private.auth_contact_read_location_ids)', () => {
  it.each(webOrMobileCases(['contacts']))('%s', (_label, caller, target, outcome) => {
    expect(canWriteActivitiesAt(caller, target)).toBe(shows(outcome))
  })

  it('role defaults: an owner and a master', () => {
    expect(canWriteActivitiesAt(person({ [LOC_B]: { role: 'owner' } }, LOC_B), LOC_B)).toBe(true)
    expect(canWriteActivitiesAt(MASTER, LOC_B)).toBe(true)
  })

  it('the studio switch binds a master too', () => {
    const m = {
      ...MASTER,
      locations: MASTER.locations.map((l) => (l.id === LOC_B ? { ...l, features: { contacts: false } } : l)),
    }
    expect(canWriteActivitiesAt(m, LOC_B)).toBe(false)
  })

  it('the web key alone is enough, as the database allows', () => {
    const u = person({ [LOC_B]: { role: 'owner', permissions: { contacts: true, mobile: { contacts: false } } } }, LOC_B)
    expect(canWriteActivitiesAt(u, LOC_B)).toBe(true)
  })

  it('the role template tier counts', () => {
    const u = person({ [LOC_B]: { role: 'owner', template: { contacts: false, mobile: { contacts: false } } } }, LOC_B)
    expect(canWriteActivitiesAt(u, LOC_B)).toBe(false)
  })

  it('fails closed with no user or no studio', () => {
    expect(canWriteActivitiesAt(null, LOC_B)).toBe(false)
    expect(canWriteActivitiesAt(person({ [LOC_B]: { role: 'owner' } }, LOC_B), null)).toBe(false)
  })
})

describe('contactWorkGates.canTask — membership AND Contacts at the contact\'s studio', () => {
  const contactAt = (loc) => ({ id: 'c0000000-0000-4000-8000-000000000001', location_id: loc })

  it('a member with Contacts there: shows', () => {
    const u = person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'staff' } }, LOC_A)
    expect(contactWorkGates(u, contactAt(LOC_B)).canTask).toBe(true)
  })

  it('a member with Contacts off there on web and phone: hidden', () => {
    const u = person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner', permissions: { contacts: false, mobile: { contacts: false } } } }, LOC_A)
    expect(contactWorkGates(u, contactAt(LOC_B)).canTask).toBe(false)
  })

  it('Contacts off at the ACTIVE studio only: still shows at the contact\'s', () => {
    const u = person({ [LOC_A]: { role: 'owner', permissions: { contacts: false, mobile: { contacts: false } } }, [LOC_B]: { role: 'owner' } }, LOC_A)
    expect(contactWorkGates(u, contactAt(LOC_B)).canTask).toBe(true)
  })

  it('a crossover viewer: hidden', () => {
    expect(contactWorkGates(OUTSIDER, contactAt(LOC_B)).canTask).toBe(false)
  })
})

describe('taskStatusUpdateOutcome — an update by id must touch its row', () => {
  it('ok when the row comes back', () => {
    expect(taskStatusUpdateOutcome({ data: [{ id: 't-1' }], error: null })).toEqual({ ok: true })
  })

  it('an error is a failure with its message', () => {
    expect(taskStatusUpdateOutcome({ data: null, error: { message: 'permission denied' } }))
      .toEqual({ ok: false, message: 'permission denied' })
  })

  it('0 rows is a failure, not a silent success (RLS filters the UPDATE to nothing)', () => {
    const r = taskStatusUpdateOutcome({ data: [], error: null })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not saved/i)
    expect(taskStatusUpdateOutcome({ data: null, error: null }).ok).toBe(false)
  })
})

describe('personActionsFor — the kebab items for a board', () => {
  it('drops only task when canTask is false', () => {
    expect(personActionsFor(['message', 'task', 'sequence', 'cold'], { canTask: false })).toEqual(['message', 'sequence', 'cold'])
  })
  it('keeps everything when canTask is true or not given', () => {
    expect(personActionsFor(['message', 'task'], { canTask: true })).toEqual(['message', 'task'])
    expect(personActionsFor(['message', 'task'])).toEqual(['message', 'task'])
  })
})
