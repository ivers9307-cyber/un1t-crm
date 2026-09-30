// ROLEUI.2 — the contact page's buttons that had NO gate at all.
//
// Each was rendered for every viewer and refused by its route for anyone the
// route's rule excludes, including a crossover viewer (canViewContact lets a
// caller open a contact with a deal at their studio while belonging to none of
// the contact's). Each helper is the route's own decision, made at the
// CONTACT's location, run over the SAME case table as the route's sweep test
// (named on each describe): 'pass' shows the button, 'forbidden' and 'hidden'
// hide it.
import { describe, it, expect } from 'vitest'
import {
  canSetPipelineStatus, canAddContactNote, canEnrolContactInSequence, canSendCancellationForm,
  canLinkContacts, isMemberOfContactStudio, canStartWhatsAppThread, contactWorkGates,
} from './contact-page-gates'
import { person, permissionCases, MASTER, OUTSIDER, LOC_A, LOC_B } from '../../tests/helpers/role-sweep-callers.js'
import { webOrMobileCases } from '../../tests/helpers/role-sweep-callers-c.js'

const shows = (outcome) => outcome === 'pass'
const contactAt = (loc) => ({ id: 'c0000000-0000-4000-8000-000000000001', location_id: loc })

describe('canSetPipelineStatus — POST …/pipeline-status, the Cold item (`pipeline` at the contact; tests/role-sweep/contact-detail)', () => {
  it.each(permissionCases('pipeline'))('%s', (_label, caller, target, outcome) => {
    expect(canSetPipelineStatus(caller, target)).toBe(shows(outcome))
  })
})

describe('canAddContactNote — POST …/notes, the Note button (`contacts` at the contact; tests/role-sweep/contact-detail)', () => {
  it.each(permissionCases('contacts'))('%s', (_label, caller, target, outcome) => {
    expect(canAddContactNote(caller, target)).toBe(shows(outcome))
  })
})

describe('canEnrolContactInSequence — POST /api/sequences/[id]/enrol, the Sequence buttons (`email` at the sequence\'s location, which the picker lists at the contact\'s)', () => {
  it.each(permissionCases('email'))('%s', (_label, caller, target, outcome) => {
    expect(canEnrolContactInSequence(caller, target)).toBe(shows(outcome))
  })
})

describe('canSendCancellationForm — GET/POST …/cancellation-form (email OR whatsapp, web OR mobile, at the contact; tests/role-sweep/contact-messaging)', () => {
  it.each(webOrMobileCases(['email', 'whatsapp']))('%s', (_label, caller, target, outcome) => {
    expect(canSendCancellationForm(caller, target)).toBe(shows(outcome))
  })
})

describe('canLinkContacts — POST/DELETE …/link, the Linked accounts buttons (`contact_linking` at the contact; tests/role-sweep/contact-detail)', () => {
  it.each(permissionCases('contact_linking'))('%s', (_label, caller, target, outcome) => {
    expect(canLinkContacts(caller, target)).toBe(shows(outcome))
  })
})

describe('isMemberOfContactStudio — Task/Activity (activities RLS needs a profile_locations row there), Book (assertLocationAccess), consent history (assertLocationAccessOr404)', () => {
  it('a member of the contact\'s studio, whatever the active one', () => {
    expect(isMemberOfContactStudio(person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'staff' } }, LOC_A), LOC_B)).toBe(true)
  })
  it('a master', () => {
    expect(isMemberOfContactStudio(MASTER, LOC_B)).toBe(true)
  })
  it('not a crossover viewer, nor no user, nor a contact with no location', () => {
    expect(isMemberOfContactStudio(OUTSIDER, LOC_B)).toBe(false)
    expect(isMemberOfContactStudio(null, LOC_B)).toBe(false)
    expect(isMemberOfContactStudio(person({ [LOC_B]: { role: 'owner' } }, LOC_B), null)).toBe(false)
  })
})

describe('canStartWhatsAppThread — POST /api/whatsapp/conversations/start (the WEB `whatsapp` key at the contact, after membership; INBOXWEBONLY3.1)', () => {
  // The route judges `whatsapp` at the contact's studio (INBOXLOC.1) and,
  // since INBOXWEBONLY3.1 (Richard, 30 Sep), only the WEB key: the phone never
  // starts a thread, and the button leads to the web inbox. So the button
  // follows the web key there: the web-permission case table.
  it.each(permissionCases('whatsapp'))('%s', (_label, caller, target, outcome) => {
    expect(canStartWhatsAppThread(caller, target)).toBe(shows(outcome))
  })
  it('on at both: shows', () => {
    expect(canStartWhatsAppThread(person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner' } }, LOC_A), LOC_B)).toBe(true)
  })
  it('off at the active studio, the web key on at the contact\'s: shows (the route acts there)', () => {
    const u = person({ [LOC_A]: { role: 'owner', permissions: { whatsapp: false, mobile: { whatsapp: false } } }, [LOC_B]: { role: 'owner', permissions: { whatsapp: true, mobile: { whatsapp: false } } } }, LOC_A)
    expect(canStartWhatsAppThread(u, LOC_B)).toBe(true)
  })
  it('only the mobile toggle at the contact\'s studio: hidden (the route refuses it)', () => {
    const u = person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner', permissions: { whatsapp: false, mobile: { whatsapp: true } } } }, LOC_A)
    expect(canStartWhatsAppThread(u, LOC_B)).toBe(false)
  })
  it('a crossover viewer (the route 403s a non-member): hidden', () => {
    expect(canStartWhatsAppThread(OUTSIDER, LOC_B)).toBe(false)
  })
  it('a master: shows', () => {
    expect(canStartWhatsAppThread(MASTER, LOC_B)).toBe(true)
  })
})

describe('contactWorkGates — what the page hands the formerly ungated components', () => {
  it('staff at the active studio, owner at the contact\'s: every button the routes allow shows', () => {
    const u = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } }, [LOC_B]: { role: 'owner' } }, LOC_A)
    expect(contactWorkGates(u, contactAt(LOC_B))).toEqual({
      canNote: true, canTask: true, canSequence: true, canCancelForm: true, canCold: true,
      canLinkAccounts: true, canStartWhatsApp: true, canBook: true, canReadConsent: true,
    })
  })
  it('owner at the active studio, a member of the contact\'s with every key off there: only the membership actions', () => {
    const off = { pipeline: false, contacts: false, email: false, whatsapp: false, contact_linking: false, mobile: { email: false, whatsapp: false } }
    const u = person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner', permissions: off } }, LOC_A)
    expect(contactWorkGates(u, contactAt(LOC_B))).toEqual({
      canNote: false, canTask: true, canSequence: false, canCancelForm: false, canCold: false,
      canLinkAccounts: false, canStartWhatsApp: false, canBook: true, canReadConsent: true,
    })
  })
  it('a crossover viewer: nothing shows', () => {
    expect(Object.values(contactWorkGates(OUTSIDER, contactAt(LOC_B))).some(Boolean)).toBe(false)
  })
  it('no user: nothing shows', () => {
    expect(Object.values(contactWorkGates(null, contactAt(LOC_B))).some(Boolean)).toBe(false)
  })
})
