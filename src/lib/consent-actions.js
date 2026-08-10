// GAPS-P6 — the ONE definition of the `consent_log.action` vocabulary.
//
// consent_log is the GDPR evidence trail: the append-only record of every
// time somebody gave or withdrew marketing consent, on which channel, from
// which surface. Two things make its `action` column unusually load-bearing:
// it is what a subject-access request is answered from, and it is what any
// "who has unsubscribed" report filters on.
//
// It carried TWO spellings of the same two facts until this module landed:
//
//     opt_out    14,214 rows      opted_out    83 rows
//     opt_in         84 rows      opted_in      3 rows
//
// The origin is traceable. Mig 005 created the table with the comment
// `action TEXT NOT NULL,   -- opted_in, opted_out`, and `contacts.wa_status`
// legitimately takes the VALUE 'opted_out' — so the word was copied out of a
// column where it is correct into one where it is not. The writers that
// picked it up were the WhatsApp ones (STOP/START keywords, Meta's in-app
// user-preferences control) and, historically, the Postmark
// `SubscriptionChange` handler that CAMPAIGN.13 replaced.
//
// The failure mode is silent under-counting: a query filtering
// `action = 'opt_out'` misses 83 real withdrawals of consent, including
// everybody who texted STOP. Nothing errors; the report is just wrong, in
// the direction of "we kept marketing to someone who told us to stop".
//
// So: writers import CONSENT_ACTIONS (enforced by the source scan in
// consent-actions.test.js and by the CHECK constraint in mig 516); readers
// go through normaliseConsentAction / isConsentOptOut, which stay tolerant of
// the legacy spellings so a report is correct whether or not the backfill has
// been applied yet, and forever after for anything restored from an old dump.
//
// ⚠️ NOT IN SCOPE: `contacts.wa_status`. 'opted_out' is a legitimate value
// there and must not be touched.

/** The canonical vocabulary. Every writer uses these two values. */
export const CONSENT_ACTIONS = Object.freeze({
  OPT_IN: 'opt_in',
  OPT_OUT: 'opt_out',
})

/** The same set as an array — for CHECK-constraint parity and validation. */
export const CONSENT_ACTION_VALUES = Object.freeze([
  CONSENT_ACTIONS.OPT_IN,
  CONSENT_ACTIONS.OPT_OUT,
])

/**
 * The pre-mig-516 spellings, and what each one means. Kept so readers can
 * interpret rows written before the backfill (and anything restored from an
 * older dump) without re-deriving the mapping at every call site.
 */
export const LEGACY_CONSENT_ACTIONS = Object.freeze({
  opted_in:  CONSENT_ACTIONS.OPT_IN,
  opted_out: CONSENT_ACTIONS.OPT_OUT,
})

/**
 * The action for a boolean consent intent — `true` means "they are opted in
 * to this channel now".
 * @param {boolean} optedIn
 * @returns {'opt_in'|'opt_out'}
 */
export function consentActionFor(optedIn) {
  return optedIn ? CONSENT_ACTIONS.OPT_IN : CONSENT_ACTIONS.OPT_OUT
}

/**
 * Fold a stored action onto the canonical vocabulary.
 *
 * An UNRECOGNISED value is returned verbatim, deliberately. This function is
 * on the path to a compliance export; rendering an action we do not
 * understand as though it were an opt-in would be a worse failure than
 * showing the operator a string they have to go and look up.
 *
 * @param {string|null|undefined} action
 * @returns {string|null|undefined}
 */
export function normaliseConsentAction(action) {
  if (typeof action !== 'string') return action
  return Object.prototype.hasOwnProperty.call(LEGACY_CONSENT_ACTIONS, action)
    ? LEGACY_CONSENT_ACTIONS[action]
    : action
}

/**
 * True when the row records a withdrawal of consent, in either spelling.
 * This is the predicate a report should use instead of `=== 'opt_out'`.
 * @param {string|null|undefined} action
 */
export function isConsentOptOut(action) {
  return normaliseConsentAction(action) === CONSENT_ACTIONS.OPT_OUT
}

/**
 * True when the row records consent being given, in either spelling.
 * @param {string|null|undefined} action
 */
export function isConsentOptIn(action) {
  return normaliseConsentAction(action) === CONSENT_ACTIONS.OPT_IN
}
