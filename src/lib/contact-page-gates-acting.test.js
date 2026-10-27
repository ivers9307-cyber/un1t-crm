// CARDLENS.6 — contactWorkGates with an acting studio. Note, Task, Sequence and
// Book follow the studio the page acts at (their routes take location_id);
// everything whose route still judges the primary studio stays there.
import { describe, it, expect } from 'vitest'
import { contactWorkGates, contactChannelFlags } from './contact-page-gates'
import { person, LOC_A, LOC_B } from '../../tests/helpers/role-sweep-callers.js'

// The person's primary studio is A; the viewer is a manager at B only.
const CONTACT = { id: 'c0000000-0000-4000-8000-000000000001', location_id: LOC_A }
const B_MANAGER = person({ [LOC_B]: { role: 'manager' } }, LOC_B)

describe('contactWorkGates — actingLocationId', () => {
  it('a manager at B acting at B can note, task, enrol and book', () => {
    const g = contactWorkGates(B_MANAGER, CONTACT, { actingLocationId: LOC_B })
    expect(g).toMatchObject({ canNote: true, canTask: true, canSequence: true, canBook: true })
  })

  it('without an acting studio the same viewer gets nothing (judged at the primary, as before)', () => {
    const g = contactWorkGates(B_MANAGER, CONTACT)
    expect(g).toMatchObject({ canNote: false, canTask: false, canSequence: false, canBook: false })
  })

  it('the gates whose routes judge the primary stay at the primary', () => {
    const g = contactWorkGates(B_MANAGER, CONTACT, { actingLocationId: LOC_B })
    expect(g).toMatchObject({ canCancelForm: false, canCold: false, canLinkAccounts: false, canStartWhatsApp: false, canReadConsent: false, canReadStudioCards: false })
  })

  it('channel flags at the acting studio', () => {
    expect(contactChannelFlags(B_MANAGER, LOC_B)).toEqual({ whatsapp: true, email: true })
    expect(contactChannelFlags(B_MANAGER, LOC_A)).toEqual({ whatsapp: false, email: false })
  })
})
