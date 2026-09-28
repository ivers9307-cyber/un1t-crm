// SEQROUTEGATE.1 — who may build sequences (the /automations builder's rule),
// judged at a named location. Synthetic callers only.
import { describe, it, expect } from 'vitest'
import {
  SEQUENCE_BUILDER_PERMISSIONS, canBuildSequencesAt, canBuildSequencesSomewhere, sequencePermissionRequired, sequenceNotFound,
} from './sequence-access.js'
import {
  person, LOC_A, LOC_B, MASTER, OUTSIDER, STAFF_A_MANAGER_B, MANAGER_A_STAFF_B,
} from '../../tests/helpers/role-sweep-callers.js'

const ownerAtB = (permissions) => person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'owner', permissions } }, LOC_A)

describe('canBuildSequencesAt', () => {
  it('is the builder page gate: email or whatsapp', () => {
    expect(SEQUENCE_BUILDER_PERMISSIONS).toEqual(['email', 'whatsapp'])
  })

  it('admits a manager at the location, whatever the active studio', () => {
    expect(canBuildSequencesAt(STAFF_A_MANAGER_B, LOC_B)).toBe(true)
  })

  it('refuses staff on the default permissions, even when they manage the active studio', () => {
    expect(canBuildSequencesAt(MANAGER_A_STAFF_B, LOC_B)).toBe(false)
  })

  it('admits WhatsApp alone (a sequence can be all WhatsApp steps)', () => {
    expect(canBuildSequencesAt(ownerAtB({ email: false, whatsapp: true }), LOC_B)).toBe(true)
    expect(canBuildSequencesAt(person({ [LOC_B]: { role: 'reception' } }, LOC_B), LOC_B)).toBe(true)
  })

  it('refuses when both keys are switched off at the location', () => {
    expect(canBuildSequencesAt(ownerAtB({ email: false, whatsapp: false }), LOC_B)).toBe(false)
  })

  it('refuses a non-member and a missing location; admits a master', () => {
    expect(canBuildSequencesAt(OUTSIDER, LOC_B)).toBe(false)
    expect(canBuildSequencesAt(STAFF_A_MANAGER_B, null)).toBe(false)
    expect(canBuildSequencesAt(null, LOC_B)).toBe(false)
    expect(canBuildSequencesAt(MASTER, LOC_B)).toBe(true)
  })
})

describe('canBuildSequencesSomewhere', () => {
  it('is true when the rule holds at any studio the caller belongs to', () => {
    expect(canBuildSequencesSomewhere(STAFF_A_MANAGER_B)).toBe(true)
    expect(canBuildSequencesSomewhere(MASTER)).toBe(true)
  })

  it('is false for staff everywhere', () => {
    const staffBoth = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'staff' } }, LOC_A)
    expect(canBuildSequencesSomewhere(staffBoth)).toBe(false)
    expect(canBuildSequencesSomewhere(null)).toBe(false)
  })
})

describe('sequencePermissionRequired', () => {
  it('answers 403 with one plain sentence', async () => {
    const res = sequencePermissionRequired()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Email or WhatsApp permission required' })
  })
})

describe('sequenceNotFound', () => {
  it('answers exactly what assertLocationAccessOr404 answers for another studio', async () => {
    const res = sequenceNotFound()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
  })
})
