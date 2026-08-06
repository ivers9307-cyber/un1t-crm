// Shared fixtures for the ticket route tests.
//
// TWO MAILBOXES AT ONE LOCATION, ALWAYS. Every fixture set carries both
// studio@ (granted to the coach) and accounts@ (not granted), because the
// property this feature exists to guarantee is that a location-scoped check
// alone is NOT enough: every staffer at the studio passes assertLocationAccess,
// and accounts@ carries the billing correspondence they must not read. A
// single-mailbox fixture would pass with the whole per-account gate deleted.

export const LOC_A = 'a0000000-0000-0000-0000-000000000001'
export const LOC_B = 'b0000000-0000-0000-0000-000000000002'

export const MB_STUDIO = {
  id: '11111111-1111-4111-8111-111111111111',
  location_id: LOC_A, address: 'studio@un1tdublin.com', label: 'Studio',
  is_default: true, active: true,
}
export const MB_ACCOUNTS = {
  id: '22222222-2222-4222-8222-222222222222',
  location_id: LOC_A, address: 'accounts@un1tdublin.com', label: 'Accounts',
  is_default: false, active: true,
}
export const MB_OTHER_LOCATION = {
  id: '33333333-3333-4333-8333-333333333333',
  location_id: LOC_B, address: 'studio@hatchstreetfitness.com', label: 'Studio',
  is_default: true, active: true,
}

export const T_STUDIO = {
  id: 'aaaaaaa1-0000-4000-8000-000000000001',
  location_id: LOC_A, mailbox_id: MB_STUDIO.id, contact_id: 'contact-1',
  requester_email: 'member@example.com', requester_name: 'Ada Member',
  subject: 'Class times', status: 'open', priority: 'normal',
  assigned_to: null, first_response_at: null,
  last_message_at: '2026-08-06T09:00:00Z', last_message_direction: 'inbound',
  last_message_preview: 'What time is the 6am?', unread_count: 2,
  solved_at: null, closed_at: null,
}
export const T_ACCOUNTS = {
  id: 'aaaaaaa2-0000-4000-8000-000000000002',
  location_id: LOC_A, mailbox_id: MB_ACCOUNTS.id, contact_id: null,
  requester_email: 'payer@example.com', requester_name: 'Bob Payer',
  subject: 'Direct debit bounced', status: 'open', priority: 'normal',
  assigned_to: null, first_response_at: null,
  last_message_at: '2026-08-06T10:00:00Z', last_message_direction: 'inbound',
  last_message_preview: 'My DD bounced', unread_count: 1,
  solved_at: null, closed_at: null,
}

export const COACH = {
  id: 'profile-coach', email: 'coach@un1tdublin.com',
  role: 'staff', profileRole: 'staff',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'staff' },
}
export const OWNER = {
  id: 'profile-owner', email: 'owner@un1tdublin.com',
  role: 'owner', profileRole: 'owner',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
}
export const MASTER = {
  id: 'profile-master', email: 'master@un1t.ie',
  role: 'master', profileRole: 'master',
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
}

/** The one grant row that makes the coach a studio@ user and nothing more. */
export const GRANT_STUDIO = { mailbox_id: MB_STUDIO.id, profile_id: COACH.id }

/** Both mailboxes + both tickets at LOC_A — the standard world. */
export function baseState(extra = {}) {
  return {
    mailboxes: [MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION],
    tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS }],
    grants: [],
    messages: [],
    ...extra,
  }
}
