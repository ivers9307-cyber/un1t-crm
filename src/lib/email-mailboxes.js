// EMAIL-TICKET.2 — pure mailbox routing + visibility rules.
// Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// WHY THIS EXISTS
// Mig 394 gave a studio ONE inbound address, on locations.email_inbox_reply_to.
// A studio actually needs several — accounts@, sales@, studio@ — possibly on
// different domains, each visible to different people. email_mailboxes replaces
// that column; this module holds the two decisions that come with it: which
// mailbox an inbound message belongs to, and which mailboxes a person may see.
//
// THE RULE THAT MATTERS
// resolveMailboxByRecipient returns NULL when nothing matches. It deliberately
// has no fallback. The webhook it replaces resolved an unmatched recipient to
// "the oldest active location", which is why Postmark's own sample payload
// filed itself into Stillorgan's queue on 2026-08-05. With several addresses
// across several domains that behaviour silently mixes one studio's mail into
// another's. Null here means the caller dead-letters — loudly wrong beats
// quietly wrong.
//
// Pure: no DB, no env, no clock. The route owns the queries.

import { normalizeEmail } from './email-inbox'

/**
 * The mailbox an inbound message was delivered to, or null.
 *
 * Matching is exact (case-insensitive) against ACTIVE mailboxes only — a
 * deactivated address stops accepting mail, the same way mig 394 treated a
 * NULL email_inbox_reply_to as "channel off".
 *
 * `recipients` is expected in the caller's precedence order — the order
 * `recipientEmails()` (email-inbox.js) returns: To → Cc → To-display →
 * `OriginalRecipient`, the SMTP envelope ground truth for that delivery.
 * The FIRST recipient with a matching mailbox wins. That ordering is a
 * contract, not a suggestion: a message addressed to two of a studio's own
 * mailboxes at once (e.g. To: accounts@, Cc: sales@) must resolve the same
 * way regardless of what order `mailboxes` came back from the DB in — row
 * order from a table with no natural ORDER BY is exactly the kind of
 * "whichever came back first" nondeterminism this module exists to refuse.
 *
 * @param {Array<{id: string, address: string, active: boolean}>} mailboxes
 * @param {string[]} recipients — every address the mail was delivered to, in
 *   caller precedence order
 * @returns {object|null} the mailbox row, or null. NEVER a guess.
 */
export function resolveMailboxByRecipient(mailboxes, recipients) {
  if (!Array.isArray(mailboxes) || !Array.isArray(recipients)) return null
  const byAddress = new Map()
  for (const m of mailboxes) {
    if (!m?.active) continue
    const a = normalizeEmail(m.address)
    if (a !== null && !byAddress.has(a)) byAddress.set(a, m)
  }
  for (const r of recipients) {
    const n = normalizeEmail(r)
    if (n && byAddress.has(n)) return byAddress.get(n)
  }
  return null
}

/**
 * The mailboxes a person may see at a location.
 *
 * Elevated (master, or owner at that location) sees every active mailbox with
 * no grant rows needed — the same posture as the rest of the estate, where
 * owners are not asked to grant themselves things. Everyone else sees only
 * mailboxes they hold an explicit grant for, because `accounts@` carries
 * billing correspondence that a coach has no business reading.
 *
 * Inactive mailboxes are hidden from everyone, elevated included.
 *
 * @param {Array} mailboxes — mailboxes at ONE location; the caller scopes that
 * @param {{isElevated?: boolean, grantedMailboxIds?: string[]}} viewer
 */
export function visibleMailboxes(mailboxes, viewer) {
  if (!Array.isArray(mailboxes)) return []
  const active = mailboxes.filter(m => m?.active)
  if (viewer?.isElevated) return active
  const granted = new Set(Array.isArray(viewer?.grantedMailboxIds) ? viewer.grantedMailboxIds : [])
  if (granted.size === 0) return []
  return active.filter(m => granted.has(m.id))
}

/**
 * Display order for the tab strip: the studio's default mailbox first, then
 * label A→Z, with address as a final tiebreak so the order is total and the
 * tabs never reshuffle between renders.
 *
 * Returns a new array; does not mutate the input.
 */
export function orderMailboxTabs(mailboxes) {
  if (!Array.isArray(mailboxes)) return []
  return [...mailboxes].sort((a, b) => {
    if (!!b?.is_default !== !!a?.is_default) return b?.is_default ? 1 : -1
    const byLabel = String(a?.label ?? '').localeCompare(String(b?.label ?? ''))
    if (byLabel !== 0) return byLabel
    return String(a?.address ?? '').localeCompare(String(b?.address ?? ''))
  })
}

/**
 * Whether this person has any mailbox to look at here. The caller must ALSO
 * check the `email_inbox` feature permission — this answers only the
 * per-account half of the two-level gate.
 *
 * Deliberately false when a studio has no mailboxes, even for an elevated
 * viewer: holding the feature permission should not put an empty inbox in the
 * nav of a studio that does not do email.
 */
export function hasAnyMailboxAccess(mailboxes, viewer) {
  return visibleMailboxes(mailboxes, viewer).length > 0
}
