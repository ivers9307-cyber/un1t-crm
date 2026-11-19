// CONTACTEXPORT.1 — owners and masters only, with Contacts at the studio.
import { describe, it, expect } from 'vitest'
import { canExportContactsAt } from './contact-export-gate.js'

const L = 'loc-1'
const user = (role, contacts = true) => ({
  id: 'u', role, locations: [{ id: L, role, features: {} }], activeLocation: { id: L, features: {} },
  rolesByLocation: { [L]: role }, assignmentsByLocation: { [L]: { role, permissions: { contacts } } },
})

describe('canExportContactsAt', () => {
  it('owners and masters may export; managers, coaches and staff may not', () => {
    expect(canExportContactsAt(user('owner'), L)).toBe(true)
    expect(canExportContactsAt({ ...user('staff'), role: 'master', isMaster: true }, L)).toBe(true)
    for (const r of ['manager', 'head_coach', 'staff']) expect(canExportContactsAt(user(r), L), r).toBe(false)
  })
  it('an owner without Contacts, or at another studio, may not', () => {
    expect(canExportContactsAt(user('owner', false), L)).toBe(false)
    expect(canExportContactsAt(user('owner'), 'loc-2')).toBe(false)
    expect(canExportContactsAt(null, L)).toBe(false)
  })
})
