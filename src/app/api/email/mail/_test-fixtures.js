// MAIL-TRIAL.B — fixtures for the Mail surface routes.
//
// LAYERED ON THE TICKET SURFACE'S OWN, NEVER RESTATED. The access model is
// shared verbatim (see _helpers.js), so its fixtures are too: a second set of
// users, grants and locations would drift from the ones the ticket route tests
// exercise, and the whole point of importing loadVisibleMailboxes rather than
// re-implementing it is that both surfaces are proven by the same world.
//
// WHAT THIS FILE ADDS is one column: `surface` (mig 575).
//
// 🔴 THE SPLIT IS THE FIXTURE. studio@ is on the mail surface and accounts@ is
// on the ticket surface — deliberately the shape of the real trial, where
// `hatchstreet@un1t.com` runs on Mail and `accounts@hatchstreetfitness.com`
// stays on tickets. Both mailboxes sit at the SAME location and the elevated
// caller can see both, so any test that finds an accounts@ conversation on
// this surface has caught the exclusivity failure that would make the trial
// meaningless.

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

/** studio@ — the address running the Mail trial. */
export const MB_MAIL = { ...MB_STUDIO, surface: 'inbox' }
/** accounts@ — the same studio, the OTHER screen. Must never appear here. */
export const MB_TICKETS = { ...MB_ACCOUNTS, surface: 'tickets' }
/** The other studio's address, also on tickets — the default every row gets. */
export const MB_OTHER = { ...MB_OTHER_LOCATION, surface: 'tickets' }

/**
 * Both mailboxes at LOC_A with the surfaces split, plus their conversations.
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
