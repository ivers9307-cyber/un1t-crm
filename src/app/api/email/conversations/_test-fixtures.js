// Shared fixtures for the RETIRED /api/email/conversations* route tests.
//
// Originally INBOX-PERM.2's fixtures, when the property under test was which
// permission key these routes gate on. EMAIL-CONV-STOP.1 (2026-08-07) retired
// the routes to 410 Gone, so the conversation/message/location rows are gone
// with them — there is no query left to feed. What survives is the pair of
// users, because the gate order is still under test: an unauthenticated caller
// gets 401 and a caller without `email_inbox` gets 403, both BEFORE the 410, so
// the retirement cannot be used to enumerate routes.
//
// Each user carries an EXPLICIT per-user permission bag so the real resolver
// (tier 2 wins over role defaults) answers the question and no test here mocks
// hasPermission. A mocked permission check would pass with the gate pointed at
// any key at all — which is exactly how `em` sat on the `whatsapp` key
// unnoticed.

export const LOC_A = 'a0000000-0000-0000-0000-000000000001'

/**
 * A staff user at LOC_A with an explicit permission bag.
 * `features: {}` leaves the tier-1 location gate open, so the bag decides.
 */
export function staffWith(permissions, { locationId = LOC_A } = {}) {
  return {
    id: 'profile-coach',
    email: 'coach@un1tdublin.com',
    role: 'staff',
    profileRole: 'staff',
    activeLocation: { id: locationId, features: {} },
    activeAssignment: { permissions },
    locations: [{ id: locationId }],
    rolesByLocation: { [locationId]: 'staff' },
  }
}

/**
 * The bypass user: WhatsApp inbox ON, email inbox OFF, and — crucially — no
 * email_mailbox_access grant anywhere. Before INBOX-PERM.2 this person could
 * list, read, resolve and SEND from the company address.
 */
export const WA_ONLY = staffWith({ whatsapp: true, email_inbox: false })

/** Holds the email key and nothing else — the person these routes were for. */
export const EMAIL_ONLY = staffWith({ whatsapp: false, email_inbox: true })

/** Any id at all — these routes no longer look one up. */
export const CONV_ID = 'ccccccc1-0000-4000-8000-000000000001'
