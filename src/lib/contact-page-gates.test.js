// ROLESWEEP.1c — the contact page's server-side DATA gates, judged at the
// CONTACT's location, never the active studio. The page (a server component
// on createServerClient(), so no RLS) loads a contact's consultations, goals,
// consultation photos and InBody scans only when canLoadContactConsultations
// says yes, and the WhatsApp UTILITY templates only when the channel flags
// say the caller can WhatsApp there.
import { describe, it, expect } from 'vitest'
import { hasPermission } from './permissions'
import {
  canLoadContactConsultations, contactChannelFlags,
  canWriteContact, canOpenContactEditor, canEditMarketingPreferences, canInviteToApp,
  canEditContactDevices, canLinkAppAccount, canOverrideMemberPassword, contactActionGates,
} from './contact-page-gates'
import { ADMIN_ROLES, MANAGER_ROLES } from './schemas'
import { person, roleCases, permissionCases, MASTER, LOC_A, LOC_B } from '../../tests/helpers/role-sweep-callers.js'
import { ownerCases } from '../../tests/helpers/role-sweep-callers-c.js'

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
      [LOC_B]: { role: 'owner', permissions: { whatsapp: false, email: false, mobile: { whatsapp: false, email: false } } },
    }, LOC_A)
    expect(hasPermission(u, 'whatsapp')).toBe(true)
    expect(contactChannelFlags(u, LOC_B)).toEqual({ whatsapp: false, email: false })
    expect(contactChannelFlags(u, LOC_A)).toEqual({ whatsapp: true, email: true })
  })

  it('accepts the web OR the mobile toggle at the target, like the send routes', () => {
    // Web off at B for every channel; mobile on for email only.
    const u = person({
      [LOC_A]: { role: 'staff' },
      [LOC_B]: { role: 'staff', permissions: { whatsapp: false, email: false, mobile: { email: true } } },
    }, LOC_A)
    expect(contactChannelFlags(u, LOC_B)).toEqual({ whatsapp: false, email: true })
  })

  it('is all false for no user or no location', () => {
    const none = { whatsapp: false, email: false }
    expect(contactChannelFlags(null, LOC_A)).toEqual(none)
    expect(contactChannelFlags(person({ [LOC_A]: { role: 'owner' } }, LOC_A), null)).toEqual(none)
  })
})

// ── ROLEUI.1 — the contact page's action BUTTONS ──────────────────────────
// Each button must show exactly when the route it calls would act. Every
// table below is the SAME table the route's own sweep test runs (named on
// each describe), so "the button shows" and "the route passes" are pinned to
// one set of callers: a row whose route outcome is 'pass' shows the button;
// 'forbidden' (the route's role refusal) and 'hidden' (its non-member
// refusal) hide it.
describe('ROLEUI.1 — action gates match the routes they call', () => {
  const shows = (outcome) => outcome === 'pass'
  const contactAt = (loc, extra = {}) => ({ id: 'c0000000-0000-4000-8000-000000000001', location_id: loc, ...extra })

  describe('canWriteContact — PUT/DELETE /api/contacts/[id], GET …/impact (MANAGER_ROLES at the contact; tests/role-sweep/api-key-or-manager + contacts-bulk-and-imports)', () => {
    it.each(roleCases(MANAGER_ROLES))('%s', (_label, caller, target, outcome) => {
      expect(canWriteContact(caller, target)).toBe(shows(outcome))
    })
    it('is false for a contact with no location, even for a master (PUT answers 404, DELETE 403)', () => {
      expect(canWriteContact(MASTER, null)).toBe(false)
    })
  })

  describe('canOpenContactEditor — the Edit link and /contacts/[id]/edit (MANAGER_ROLES and `contacts`, both at the contact)', () => {
    it.each(roleCases(MANAGER_ROLES, 'contacts'))('%s', (_label, caller, target, outcome) => {
      expect(canOpenContactEditor(caller, target)).toBe(shows(outcome))
    })
    it.each(permissionCases('contacts'))('%s', (_label, caller, target, outcome) => {
      expect(canOpenContactEditor(caller, target)).toBe(shows(outcome))
    })
  })

  describe('canEditMarketingPreferences — PATCH …/marketing-preferences (ADMIN_ROLES at the contact; tests/role-sweep/contact-detail)', () => {
    it.each(roleCases(ADMIN_ROLES))('%s', (_label, caller, target, outcome) => {
      expect(canEditMarketingPreferences(caller, target)).toBe(shows(outcome))
    })
    it('a manager at the contact can edit (the route has always allowed managers)', () => {
      const u = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'manager' } }, LOC_A)
      expect(canEditMarketingPreferences(u, LOC_B)).toBe(true)
    })
  })

  describe('canInviteToApp — POST …/invite-app (owner/manager at the contact, and an email on file)', () => {
    it.each(roleCases(['owner', 'manager']))('%s', (_label, caller, target, outcome) => {
      expect(canInviteToApp(caller, contactAt(target, { email: 'member.one@example.com' }))).toBe(shows(outcome))
    })
    it('never without an email (the route answers 400), a master included', () => {
      expect(canInviteToApp(MASTER, contactAt(LOC_B, { email: null }))).toBe(false)
    })
    it('a master may invite a contact with no location (the route skips the location checks for masters)', () => {
      expect(canInviteToApp(MASTER, contactAt(null, { email: 'member.one@example.com' }))).toBe(true)
    })
  })

  describe('canEditContactDevices — POST …/devices, DELETE/PATCH …/devices/[deviceId] (owner/manager/head coach at the contact)', () => {
    it.each(roleCases(['owner', 'manager', 'head_coach']))('%s', (_label, caller, target, outcome) => {
      expect(canEditContactDevices(caller, target)).toBe(shows(outcome))
    })
  })

  describe('canLinkAppAccount — GET/POST/DELETE …/link-account (owner at the contact; tests/role-sweep/contact-detail ownerCases)', () => {
    it.each(ownerCases())('%s', (_label, caller, target, outcome) => {
      expect(canLinkAppAccount(caller, target)).toBe(shows(outcome))
    })
  })

  describe('canOverrideMemberPassword — POST /api/admin/password-override, member (owner at the contact; tests/role-sweep/staff-and-admin ownerCases)', () => {
    it.each(ownerCases())('%s', (_label, caller, target, outcome) => {
      expect(canOverrideMemberPassword(caller, contactAt(target, { user_id: 'u0000000-0000-4000-8000-000000000009' }))).toBe(shows(outcome))
    })
    it('never for a contact with no CRM login (the route answers 404 no_auth_account)', () => {
      expect(canOverrideMemberPassword(MASTER, contactAt(LOC_B, { user_id: null }))).toBe(false)
    })
    it('a master may reset a member with no location (the route lets only a master through)', () => {
      expect(canOverrideMemberPassword(MASTER, contactAt(null, { user_id: 'u0000000-0000-4000-8000-000000000009' }))).toBe(true)
    })
  })

  describe('contactActionGates — what the contact page hands its components', () => {
    it('staff at the active studio, owner at the contact\'s: every action shows', () => {
      const u = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'owner' } }, LOC_A)
      const g = contactActionGates(u, contactAt(LOC_B, { email: 'member.one@example.com', user_id: 'u0000000-0000-4000-8000-000000000009' }))
      expect(g).toEqual({
        canToggleExempt: true,
        canEditPrefs: true,
        admin: {
          canPasswordOverride: true, canEdit: true, canDelete: true, canInvite: true,
          hasUserAccount: true, canEditDevices: true, canLinkAccount: true,
        },
      })
    })

    it('owner at the active studio, staff at the contact\'s: nothing shows (every route would refuse)', () => {
      const u = person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'staff' } }, LOC_A)
      const g = contactActionGates(u, contactAt(LOC_B, { email: 'member.one@example.com', user_id: 'u0000000-0000-4000-8000-000000000009' }))
      expect(g).toEqual({
        canToggleExempt: false,
        canEditPrefs: false,
        admin: {
          canPasswordOverride: false, canEdit: false, canDelete: false, canInvite: false,
          hasUserAccount: true, canEditDevices: false, canLinkAccount: false,
        },
      })
    })

    it('a crossover contact (the caller does not belong to its studio): nothing shows', () => {
      const u = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
      const g = contactActionGates(u, contactAt(LOC_B, { email: 'member.one@example.com' }))
      expect(g.canToggleExempt).toBe(false)
      expect(g.canEditPrefs).toBe(false)
      expect(Object.values(g.admin).some(Boolean)).toBe(false)
    })

    it('a head coach at the contact\'s studio: exemption, edit, delete and straps; not the owner/admin actions', () => {
      const u = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'head_coach' } }, LOC_A)
      const g = contactActionGates(u, contactAt(LOC_B, { email: 'member.one@example.com', user_id: 'u0000000-0000-4000-8000-000000000009' }))
      expect(g).toEqual({
        canToggleExempt: true,
        canEditPrefs: false,
        admin: {
          canPasswordOverride: false, canEdit: true, canDelete: true, canInvite: false,
          hasUserAccount: true, canEditDevices: true, canLinkAccount: false,
        },
      })
    })

    it('no user: nothing shows', () => {
      const g = contactActionGates(null, contactAt(LOC_B))
      expect(g.canToggleExempt).toBe(false)
      expect(Object.values(g.admin).some(Boolean)).toBe(false)
    })
  })
})
