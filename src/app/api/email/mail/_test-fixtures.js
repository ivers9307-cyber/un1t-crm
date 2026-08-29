// MAIL-TRIAL.B → RETIRE-TICKETS.1 — fixtures for the Mail surface routes.
//
// LAYERED ON THE TICKET-ERA FIXTURES, NEVER RESTATED. The access model is
// shared verbatim (see _helpers.js), so its fixtures are too: a second set of
// users, grants and locations would drift from the ones the (now shimmed)
// ticket route tests exercise, and the whole point of importing
// loadVisibleMailboxes rather than re-implementing it is that both are proven
// by the same world.
//
// The per-mailbox `surface` flag this file used to add is RETIRED (mig 578):
// Mail lists every visible mailbox. TWO accounts at the same studio remain
// the load-bearing shape — studio@ (COACH holds a grant) and accounts@
// (COACH does not) — because the per-account access gate is what the tests
// must keep proving now that the surface split no longer narrows anything.

import {
  LOC_A, LOC_B, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION,
  T_STUDIO, T_ACCOUNTS, T_OTHER_LOCATION,
  COACH, COACH_NO_INBOX, OWNER, MASTER, MULTI_LOCATION,
  GRANT_STUDIO, GRANT_MULTI_OTHER_LOCATION, GRANT_MULTI_STUDIO,
} from '../tickets/_test-fixtures'

export {
  LOC_A, LOC_B, T_STUDIO, T_ACCOUNTS, T_OTHER_LOCATION,
  COACH, COACH_NO_INBOX, OWNER, MASTER, MULTI_LOCATION,
  GRANT_STUDIO, GRANT_MULTI_OTHER_LOCATION, GRANT_MULTI_STUDIO,
}

/** studio@ — the account COACH holds a grant on. */
export const MB_MAIL = { ...MB_STUDIO }
/** accounts@ — same studio, NO coach grant. (Historic name: it sat on the
 * retired ticket surface. Kept because renaming it across every mail test
 * buys nothing — the access split it now stands for is real.) */
export const MB_TICKETS = { ...MB_ACCOUNTS }
/** The other studio's address. */
export const MB_OTHER = { ...MB_OTHER_LOCATION }

/**
 * Both mailboxes at LOC_A plus their conversations.
 *
 * `messages` is empty by default: the per-conversation counts are a separate
 * read, and a test that does not care about read state should not have to
 * describe every message to get a list back.
 */
export function mailState(extra = {}) {
  return {
    mailboxes: [MB_MAIL, MB_TICKETS, MB_OTHER],
    tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS }],
    grants: [],
    messages: [],
    ...extra,
  }
}

/**
 * A message row as the inbound webhook writes it, plus mig 575's `seen_at`.
 * NULL means unread — and only an inbound message can be unread, which is why
 * the direction is a parameter rather than a constant.
 */
export function message(over = {}) {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    ticket_id: T_STUDIO.id,
    direction: 'inbound',
    from_email: 'member@example.com',
    to_email: 'studio@un1tdublin.com',
    text_body: 'What time is the 6am?',
    is_internal_note: false,
    seen_at: null,
    created_at: '2026-08-06T09:00:00Z',
    ...over,
  }
}
