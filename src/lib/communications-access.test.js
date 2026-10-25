// C116 GATES-2 — the /communications area rule, at a named studio, at the
// active studio, and at SOME studio (the layout's coarse gate).
import { describe, it, expect } from 'vitest'
import { person, MASTER, LOC_A, LOC_B } from '../../tests/helpers/role-sweep-callers.js'
import {
  COMMUNICATIONS_AREA_PERMISSIONS, canUseCommunicationsAt, canUseCommunicationsHere,
  canUseCommunicationsSomewhere, canEditEmailTemplate, canUseCommunicationsForRecord,
} from './communications-access'

const off = { email: false, whatsapp: false, email_inbox: false }
// Nothing at A (active), `key` at B.
const onlyAtB = (key) => person({ [LOC_A]: { role: 'owner', permissions: off }, [LOC_B]: { role: 'owner', permissions: { ...off, [key]: true } } }, LOC_A)
const nowhere = person({ [LOC_A]: { role: 'owner', permissions: off }, [LOC_B]: { role: 'owner', permissions: off } }, LOC_A)

describe('the communications area', () => {
  it('is email, whatsapp or email_inbox', () => {
    expect(COMMUNICATIONS_AREA_PERMISSIONS).toEqual(['email', 'whatsapp', 'email_inbox'])
  })
  it.each(COMMUNICATIONS_AREA_PERMISSIONS)('%s at B only: somewhere and at B, not here (A active)', (key) => {
    const u = onlyAtB(key)
    expect(canUseCommunicationsSomewhere(u)).toBe(true)
    expect(canUseCommunicationsAt(u, LOC_B)).toBe(true)
    expect(canUseCommunicationsAt(u, LOC_A)).toBe(false)
    expect(canUseCommunicationsHere(u)).toBe(false)
  })
  it('none of them anywhere: no', () => {
    expect(canUseCommunicationsSomewhere(nowhere)).toBe(false)
    expect(canUseCommunicationsHere(nowhere)).toBe(false)
    expect(canUseCommunicationsSomewhere(null)).toBe(false)
  })
  it('a master', () => {
    expect(canUseCommunicationsSomewhere(MASTER)).toBe(true)
    expect(canUseCommunicationsAt(MASTER, LOC_B)).toBe(true)
  })
})

describe('canEditEmailTemplate (the /api/templates/[id] rule)', () => {
  it('email at the template\'s studio, not the active one', () => {
    expect(canEditEmailTemplate(onlyAtB('email'), LOC_B)).toBe(true)
    expect(canEditEmailTemplate(onlyAtB('whatsapp'), LOC_B)).toBe(false)
    const atAOnly = person({ [LOC_A]: { role: 'owner', permissions: { email: true } }, [LOC_B]: { role: 'owner', permissions: { email: false } } }, LOC_A)
    expect(canEditEmailTemplate(atAOnly, LOC_B)).toBe(false)
  })
  it('a location-less template: email somewhere', () => {
    expect(canEditEmailTemplate(onlyAtB('email'), null)).toBe(true)
    expect(canEditEmailTemplate(nowhere, null)).toBe(false)
  })
})

describe('canUseCommunicationsForRecord', () => {
  it('at the record\'s studio', () => {
    expect(canUseCommunicationsForRecord(onlyAtB('whatsapp'), LOC_B)).toBe(true)
    expect(canUseCommunicationsForRecord(onlyAtB('whatsapp'), LOC_A)).toBe(false)
  })
  it('a location-less record: somewhere', () => {
    expect(canUseCommunicationsForRecord(onlyAtB('whatsapp'), null)).toBe(true)
    expect(canUseCommunicationsForRecord(nowhere, null)).toBe(false)
  })
})
