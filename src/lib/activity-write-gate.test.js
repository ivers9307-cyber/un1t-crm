// C146 TASKSNEEDCONTACTS.1 — the web's task / activity write controls follow
// the Contacts rule mig 700 put on reading `activities`. C148 ACTWRITEGATEWEB.1
// (Richard 2 Oct) — and the WEB Tasks key (`activities`) at the same studio:
// the web writes are service-role routes now, judged on this one function.
import { describe, it, expect, vi } from 'vitest'
import { canWriteActivitiesAt, taskWriteOutcome, postActivityWrite, personActionsFor } from './activity-write-gate'
import { contactWorkGates } from './contact-page-gates'
import { person, MASTER, OUTSIDER, LOC_A, LOC_B } from '../../tests/helpers/role-sweep-callers.js'
import { webOrMobileCases } from '../../tests/helpers/role-sweep-callers-c.js'

const shows = (outcome) => outcome === 'pass'

describe('canWriteActivitiesAt — web Tasks AND Contacts (web OR phone) at the studio', () => {
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

  it('C148: web Tasks (`activities`) off at the studio: no, whatever Contacts says', () => {
    const u = person({ [LOC_B]: { role: 'owner', permissions: { activities: false, contacts: true } } }, LOC_B)
    expect(canWriteActivitiesAt(u, LOC_B)).toBe(false)
  })

  it('C148: the phone Tasks / Pipeline keys do not stand in for web Tasks', () => {
    const u = person({ [LOC_B]: { role: 'owner', permissions: { activities: false, mobile: { tasks: true, pipeline: true } } } }, LOC_B)
    expect(canWriteActivitiesAt(u, LOC_B)).toBe(false)
  })

  it('C148: web Tasks with neither phone key is enough (the gap RLS left)', () => {
    const u = person({ [LOC_B]: { role: 'staff', permissions: { activities: true, contacts: true, mobile: { tasks: false, pipeline: false } } } }, LOC_B)
    expect(canWriteActivitiesAt(u, LOC_B)).toBe(true)
  })

  it('C148: web Tasks judged at the row\'s studio, not the active one', () => {
    const u = person({ [LOC_A]: { role: 'owner', permissions: { activities: false } }, [LOC_B]: { role: 'owner' } }, LOC_A)
    expect(canWriteActivitiesAt(u, LOC_B)).toBe(true)
    expect(canWriteActivitiesAt(u, LOC_A)).toBe(false)
  })

  it('C148: the studio\'s Tasks switch binds a master too', () => {
    const m = {
      ...MASTER,
      locations: MASTER.locations.map((l) => (l.id === LOC_B ? { ...l, features: { activities: false } } : l)),
    }
    expect(canWriteActivitiesAt(m, LOC_B)).toBe(false)
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

describe('taskWriteOutcome — read a task route\'s answer', () => {
  it('ok with the row when the route says success', () => {
    expect(taskWriteOutcome({ ok: true, body: { success: true, data: { id: 't-1' } } })).toEqual({ ok: true, data: { id: 't-1' } })
  })

  it('a refusal carries the route\'s message', () => {
    expect(taskWriteOutcome({ ok: false, body: { success: false, error: 'No Tasks permission at this location' } }))
      .toEqual({ ok: false, message: 'No Tasks permission at this location' })
  })

  it('a 200 without success, or no body, is not a success', () => {
    expect(taskWriteOutcome({ ok: true, body: { success: false } }).ok).toBe(false)
    const r = taskWriteOutcome({ ok: false, body: null })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not saved/i)
  })
})

describe('postActivityWrite — POST JSON, never a silent success', () => {
  it('posts the payload and returns the row', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { id: 't-1' } }) }))
    const r = await postActivityWrite('/api/activities/tasks', { subject: 'x' }, fetchImpl)
    expect(r).toEqual({ ok: true, data: { id: 't-1' } })
    expect(fetchImpl).toHaveBeenCalledWith('/api/activities/tasks', expect.objectContaining({ method: 'POST', body: JSON.stringify({ subject: 'x' }) }))
  })

  it('a network failure is a failure with a message', async () => {
    const r = await postActivityWrite('/api/x', {}, async () => { throw new Error('Failed to fetch') })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not saved/i)
  })

  it('a non-JSON error page is a failure', async () => {
    const r = await postActivityWrite('/api/x', {}, async () => ({ ok: false, json: async () => { throw new Error('html') } }))
    expect(r.ok).toBe(false)
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
