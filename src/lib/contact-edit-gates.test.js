// ORGCONTACTS.4 (decision 4) — edit rights on a shared contact. Pure.
//   canEditContact: edit anywhere the person has a relationship — master, or
//     MANAGER_ROLES at the contact's primary studio (today's rule), or
//     MANAGER_ROLES at a relationship studio where the caller also holds
//     Contacts. The role bar is unchanged; WHERE widens, WHO does not.
//   canDeleteOrRehomeContact: delete and change-primary by the primary
//     studio's admins (MANAGER_ROLES there), an organisation admin, or a master.
// Fictional ids only.
import { describe, it, expect } from 'vitest'
import { canEditContact, canDeleteOrRehomeContact } from './contact-edit-gates.js'
import { person, MASTER, LOC_A, LOC_B, LOC_OTHER, ORG } from '../../tests/helpers/role-sweep-callers.js'

const contact = (over = {}) => ({ id: 'c0000000-0000-4000-8000-000000000001', location_id: LOC_A, organization_id: ORG, ...over })
const managerAt = (loc, extra = {}) => person({ [loc]: { role: 'manager', permissions: { contacts: true } } }, loc, extra)
const managerNoContactsAt = (loc) => person({ [loc]: { role: 'manager', permissions: { contacts: false } } }, loc)
const staffAt = (loc) => person({ [loc]: { role: 'staff', permissions: { contacts: true } } }, loc)

describe('canEditContact', () => {
  it('master: yes', () => {
    expect(canEditContact({ user: MASTER, contact: contact(), relationshipStudioIds: [] })).toBe(true)
  })
  it("MANAGER_ROLES at the contact's primary studio: yes, with or without Contacts (today's rule)", () => {
    expect(canEditContact({ user: managerAt(LOC_A), contact: contact(), relationshipStudioIds: [LOC_A] })).toBe(true)
    expect(canEditContact({ user: managerNoContactsAt(LOC_A), contact: contact(), relationshipStudioIds: [] })).toBe(true)
  })
  it('a manager at a RELATIONSHIP studio with Contacts there: yes', () => {
    expect(canEditContact({ user: managerAt(LOC_B), contact: contact(), relationshipStudioIds: [LOC_A, LOC_B] })).toBe(true)
  })
  it('a manager at a relationship studio WITHOUT Contacts there: no', () => {
    expect(canEditContact({ user: managerNoContactsAt(LOC_B), contact: contact(), relationshipStudioIds: [LOC_A, LOC_B] })).toBe(false)
  })
  it('a manager at an unrelated studio: no; staff at a relationship studio: no', () => {
    expect(canEditContact({ user: managerAt(LOC_OTHER), contact: contact(), relationshipStudioIds: [LOC_A, LOC_B] })).toBe(false)
    expect(canEditContact({ user: staffAt(LOC_B), contact: contact(), relationshipStudioIds: [LOC_A, LOC_B] })).toBe(false)
  })
  it('no user, no contact, or a contact with no primary studio: no, even for a master (PUT answers 404)', () => {
    expect(canEditContact({ user: null, contact: contact(), relationshipStudioIds: [LOC_A] })).toBe(false)
    expect(canEditContact({ user: managerAt(LOC_A), contact: null, relationshipStudioIds: [LOC_A] })).toBe(false)
    expect(canEditContact({ user: MASTER, contact: contact({ location_id: null }), relationshipStudioIds: [LOC_A] })).toBe(false)
  })
  it('relationshipStudioIds may be missing (an unreadable rows read): only the primary rule applies', () => {
    expect(canEditContact({ user: managerAt(LOC_B), contact: contact() })).toBe(false)
    expect(canEditContact({ user: managerAt(LOC_A), contact: contact() })).toBe(true)
  })
})

describe('canDeleteOrRehomeContact', () => {
  it('master: yes', () => {
    expect(canDeleteOrRehomeContact({ user: MASTER, contact: contact() })).toBe(true)
  })
  it("MANAGER_ROLES at the contact's primary studio: yes", () => {
    expect(canDeleteOrRehomeContact({ user: managerAt(LOC_A), contact: contact() })).toBe(true)
    expect(canDeleteOrRehomeContact({ user: person({ [LOC_A]: { role: 'head_coach' } }, LOC_A), contact: contact() })).toBe(true)
  })
  it("an organisation admin of the contact's organisation: yes, with no membership at all", () => {
    const orgAdmin = { ...person({}, LOC_OTHER), locations: [], rolesByLocation: {}, orgAdminOrgIds: [ORG] }
    expect(canDeleteOrRehomeContact({ user: orgAdmin, contact: contact() })).toBe(true)
  })
  it('an organisation admin of ANOTHER organisation: no', () => {
    const otherAdmin = { ...person({}, LOC_OTHER), locations: [], rolesByLocation: {}, orgAdminOrgIds: ['f0000000-0000-4000-8000-0000000000ff'] }
    expect(canDeleteOrRehomeContact({ user: otherAdmin, contact: contact() })).toBe(false)
  })
  it("a manager at a relationship studio that is not the primary: no (editing is theirs, deleting is not)", () => {
    expect(canDeleteOrRehomeContact({ user: managerAt(LOC_B), contact: contact() })).toBe(false)
  })
  it('staff at the primary, no user, no contact, no primary: no', () => {
    expect(canDeleteOrRehomeContact({ user: staffAt(LOC_A), contact: contact() })).toBe(false)
    expect(canDeleteOrRehomeContact({ user: null, contact: contact() })).toBe(false)
    expect(canDeleteOrRehomeContact({ user: managerAt(LOC_A), contact: null })).toBe(false)
    expect(canDeleteOrRehomeContact({ user: MASTER, contact: contact({ location_id: null }) })).toBe(false)
  })
})
