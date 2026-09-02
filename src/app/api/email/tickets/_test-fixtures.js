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
  subject: 'Class times', has_inbound: true, status: 'open', priority: 'normal',
  assigned_to: null, first_response_at: null,
  last_message_at: '2026-08-06T09:00:00Z', last_message_direction: 'inbound',
  last_message_preview: 'What time is the 6am?', unread_count: 2,
  solved_at: null, closed_at: null,
}
export const T_ACCOUNTS = {
  id: 'aaaaaaa2-0000-4000-8000-000000000002',
  location_id: LOC_A, mailbox_id: MB_ACCOUNTS.id, contact_id: null,
  requester_email: 'payer@example.com', requester_name: 'Bob Payer',
  subject: 'Direct debit bounced', has_inbound: true, status: 'open', priority: 'normal',
  assigned_to: null, first_response_at: null,
  last_message_at: '2026-08-06T10:00:00Z', last_message_direction: 'inbound',
  last_message_preview: 'My DD bounced', unread_count: 1,
  solved_at: null, closed_at: null,
}

// EMAIL-TICKET-CLEANUP.1 — every user below now carries assignmentsByLocation
// as well as rolesByLocation, because the surface gate moved into
// loadTicketForUser and resolves through the REAL hasPermissionForLocation,
// which reads assignments (guardMasterOrOwner, the elevation check, reads
// rolesByLocation — two different shapes, and getCurrentUser populates both).
// Thin fixtures would have made the real resolver answer false for everyone and
// every test pass a 404 for the wrong reason.

/**
 * A ticket at the OTHER studio (LOC_B), on LOC_B's own mailbox.
 *
 * The whole point of it: a caller can be legitimately assigned to LOC_B and
 * hold a grant on that mailbox, so assertLocationAccess AND the per-account
 * gate both pass — and they must still be refused if they do not hold
 * `email_inbox` at LOC_B. It is the only fixture that can tell the
 * location-scoped permission check apart from the two checks around it.
 */
export const T_OTHER_LOCATION = {
  id: 'aaaaaaa3-0000-4000-8000-000000000003',
  location_id: LOC_B, mailbox_id: MB_OTHER_LOCATION.id, contact_id: null,
  requester_email: 'hatch@example.com', requester_name: 'Cara Hatch',
  subject: 'Hatch enquiry', has_inbound: true, status: 'open', priority: 'normal',
  assigned_to: null, first_response_at: null,
  last_message_at: '2026-08-06T11:00:00Z', last_message_direction: 'inbound',
  last_message_preview: 'Do you open Saturdays?', unread_count: 1,
  solved_at: null, closed_at: null,
}

export const COACH = {
  id: 'profile-coach', email: 'coach@un1tdublin.com',
  role: 'staff', profileRole: 'staff',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'staff' },
  // `staff` gets email_inbox: false by role default, so a coach who works the
  // inbox holds it as a per-user override (mig 058) — which is exactly how one
  // is granted in real life. Their SINGLE studio@ grant is what keeps them out
  // of accounts@; the key and the grant are independent, and both fixtures
  // exist so a test can flip either one alone.
  assignmentsByLocation: { [LOC_A]: { role: 'staff', permissions: { email_inbox: true } } },
}

/**
 * The same coach WITHOUT the surface key — assigned to the studio, holding the
 * studio@ mailbox grant, and still refused. Proves the permission is doing work
 * that the location and mailbox checks do not: it is the one caller who passes
 * both of those and must still be turned away.
 */
export const COACH_NO_INBOX = {
  ...COACH,
  assignmentsByLocation: { [LOC_A]: { role: 'staff', permissions: { email_inbox: false } } },
}

export const OWNER = {
  id: 'profile-owner', email: 'owner@un1tdublin.com',
  role: 'owner', profileRole: 'owner',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
  // No override needed — owner holds email_inbox by role default, and is
  // elevated past mailbox grants besides.
  assignmentsByLocation: { [LOC_A]: { role: 'owner', permissions: {} } },
}
export const MASTER = {
  id: 'profile-master', email: 'master@un1t.ie',
  role: 'master', profileRole: 'master',
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  // Master is global: hasPermissionForLocation takes user.role unchanged and
  // resolvePermission short-circuits it past every tier, so no assignment row.
  assignmentsByLocation: {},
}

/**
 * ONE person, TWO studios, opposite answers — the shape the old active-location
 * gate got wrong in both directions (EMAIL-TICKET-CLEANUP.1).
 *
 * Manager at LOC_A (email_inbox true by role default), plain staff at LOC_B
 * (false). Their session pointing at one studio must not decide what they may
 * do at the other, and a mailbox grant at LOC_B must not become readable just
 * because LOC_A says manager.
 */
export const MULTI_LOCATION = {
  id: 'profile-multi', email: 'multi@un1tdublin.com',
  role: 'staff', profileRole: 'manager',
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
  assignmentsByLocation: {
    [LOC_A]: { role: 'manager', permissions: {} },
    [LOC_B]: { role: 'staff', permissions: {} },
  },
}

/** The one grant row that makes the coach a studio@ user and nothing more. */
export const GRANT_STUDIO = { mailbox_id: MB_STUDIO.id, profile_id: COACH.id }

/**
 * The multi-location user's grant on the OTHER studio's mailbox — the row that
 * makes the cross-location tests mean something. With it they pass the
 * per-account gate at LOC_B, so a refusal there can only be the surface key.
 */
export const GRANT_MULTI_OTHER_LOCATION = {
  mailbox_id: MB_OTHER_LOCATION.id, profile_id: MULTI_LOCATION.id,
}
/** …and their grant at LOC_A, where they DO hold the key. */
export const GRANT_MULTI_STUDIO = { mailbox_id: MB_STUDIO.id, profile_id: MULTI_LOCATION.id }

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
