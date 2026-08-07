// Shared fixtures for the LEGACY email conversation route tests
// (INBOX-PERM.2).
//
// THE PROPERTY UNDER TEST is which permission key these routes gate on. Every
// fixture user therefore carries an EXPLICIT per-user permission bag, so the
// real resolver (tier 2 wins over role defaults) answers the question and no
// test here mocks hasPermission. A mocked permission check would pass with the
// gate pointed at any key at all — which is exactly how `em` sat on the
// `whatsapp` key unnoticed.

export const LOC_A = 'a0000000-0000-0000-0000-000000000001'
export const LOC_B = 'b0000000-0000-0000-0000-000000000002'

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

/** Holds the email key and nothing else — the person these routes are for. */
export const EMAIL_ONLY = staffWith({ whatsapp: false, email_inbox: true })

export const CONV = {
  id: 'ccccccc1-0000-4000-8000-000000000001',
  location_id: LOC_A,
  contact_id: 'contact-1',
  counterpart_email: 'member@example.com',
  subject: 'Class times',
  unread_count: 3,
  resolved_at: null,
  last_message_at: '2026-08-06T09:00:00Z',
  last_message_direction: 'inbound',
  last_message_preview: 'What time is the 6am?',
}

export const CONV_MESSAGES = [
  {
    id: 'm-1', conversation_id: CONV.id, location_id: LOC_A,
    direction: 'inbound', subject: 'Class times', text_body: 'What time is the 6am?',
    rfc_message_id: '<inbound-1@mail.example.com>', references_header: null,
    created_at: '2026-08-06T09:00:00Z',
  },
  {
    id: 'm-2', conversation_id: CONV.id, location_id: LOC_A,
    direction: 'outbound', subject: 'Re: Class times', text_body: 'Six sharp.',
    created_at: '2026-08-06T09:30:00Z',
  },
]

/** The standard world: one conversation at LOC_A with a two-message thread. */
export function baseState(extra = {}) {
  return {
    conversations: [{ ...CONV }],
    messages: CONV_MESSAGES.map(m => ({ ...m })),
    locations: [{ id: LOC_A, email_inbox_reply_to: 'studio@un1tdublin.com' }],
    ...extra,
  }
}
