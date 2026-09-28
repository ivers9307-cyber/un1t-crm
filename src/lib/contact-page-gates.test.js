// ROLESWEEP.1c — the contact page's server-side DATA gates, judged at the
// CONTACT's location, never the active studio. The page (a server component
// on createServerClient(), so no RLS) loads a contact's consultations, goals,
// consultation photos and InBody scans only when canLoadContactConsultations
// says yes, and the WhatsApp UTILITY templates only when the channel flags
// say the caller can WhatsApp there.
import { describe, it, expect } from 'vitest'
import { hasPermission } from './permissions'
import { canLoadContactConsultations, contactChannelFlags } from './contact-page-gates'
import { person, MASTER, LOC_A, LOC_B } from '../../tests/helpers/role-sweep-callers.js'

describe('canLoadContactConsultations', () => {
  it('ON at the active studio, OFF at the contact\'s location: no consultation data', () => {
    const u = person({
      [LOC_A]: { role: 'manager' },
      [LOC_B]: { role: 'manager', permissions: { consultations: false } },
    }, LOC_A)
    expect(hasPermission(u, 'consultations')).toBe(true) // the active studio says yes…
    expect(canLoadContactConsultations(u, LOC_B)).toBe(false) // …the contact's studio says no
  })

  it('OFF at the active studio, ON at the contact\'s location: the data loads', () => {
    const u = person({
      [LOC_A]: { role: 'manager', permissions: { consultations: false } },
      [LOC_B]: { role: 'manager' },
    }, LOC_A)
    expect(hasPermission(u, 'consultations')).toBe(false)
    expect(canLoadContactConsultations(u, LOC_B)).toBe(true)
  })

  it('is false for no user, a contact with no location, or a location the caller has no role at', () => {
    const u = person({ [LOC_A]: { role: 'manager' } }, LOC_A)
    expect(canLoadContactConsultations(null, LOC_A)).toBe(false)
    expect(canLoadContactConsultations(u, null)).toBe(false)
    expect(canLoadContactConsultations(u, LOC_B)).toBe(false)
  })

  it('a master reads them wherever the contact\'s location has the feature', () => {
    expect(canLoadContactConsultations(MASTER, LOC_B)).toBe(true)
  })
})

describe('contactChannelFlags', () => {
  it('judges each channel at the contact\'s location, not the active studio', () => {
    const u = person({
      [LOC_A]: { role: 'owner' },
      [LOC_B]: { role: 'owner', permissions: { whatsapp: false, sms: false, email: false, mobile: { whatsapp: false, sms: false, email: false } } },
    }, LOC_A)
    expect(hasPermission(u, 'whatsapp')).toBe(true)
    expect(contactChannelFlags(u, LOC_B)).toEqual({ whatsapp: false, sms: false, email: false })
    expect(contactChannelFlags(u, LOC_A)).toEqual({ whatsapp: true, sms: true, email: true })
  })

  it('accepts the web OR the mobile toggle at the target, like the send routes', () => {
    // Web off at B for every channel; mobile on for email only.
    const u = person({
      [LOC_A]: { role: 'staff' },
      [LOC_B]: { role: 'staff', permissions: { whatsapp: false, sms: false, email: false, mobile: { email: true } } },
    }, LOC_A)
    expect(contactChannelFlags(u, LOC_B)).toEqual({ whatsapp: false, sms: false, email: true })
  })

  it('is all false for no user or no location', () => {
    const none = { whatsapp: false, sms: false, email: false }
    expect(contactChannelFlags(null, LOC_A)).toEqual(none)
    expect(contactChannelFlags(person({ [LOC_A]: { role: 'owner' } }, LOC_A), null)).toEqual(none)
  })
})
