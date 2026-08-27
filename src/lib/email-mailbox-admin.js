// EMAIL-MAILBOX-ADMIN.1 — pure validation + display rules for the mailbox
// and per-account-access editor.
//
// WHY THIS EXISTS
// mig 485 created email_mailboxes + email_mailbox_access with NO write
// surface: adding `sales@` meant a hand-written INSERT, and granting a coach
// `studio@` while withholding `accounts@` needed database access. The routes
// that close that gap have to respect four constraints the database already
// enforces, and the operator has to be told about them in words rather than
// discovering them as a 23505:
//
//   • UNIQUE (lower(address)) — GLOBAL, not per location. One address belongs
//     to exactly one mailbox estate-wide. This is the confusing one: the
//     address may already be at a studio the operator cannot see, so the
//     message has to explain the rule, not just report the collision.
//   • a partial unique index allows at most ONE is_default per location
//   • address has a shape CHECK
//   • label is 1–40 characters after trimming
//
// Pure: no DB, no env, no clock, no NextResponse. The routes own the queries
// and the status codes; this module owns "is this input legal" and "what does
// the operator see". Mirrors src/lib/email-mailboxes.js, which owns the
// read-side rules for the same two tables.

import { orderMailboxTabs } from './email-mailboxes'

/** Mirrors CHECK email_mailboxes_address_shape (mig 485). */
export const MAILBOX_ADDRESS_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
/** Mirrors CHECK email_mailboxes_label_len (mig 485): 1–40 after btrim. */
export const MAILBOX_LABEL_MAX = 40

/**
 * The canonical stored form of an address: trimmed and lowercased.
 *
 * Lowercasing at the door is deliberate. The unique index is on
 * lower(address), so `Sales@x.ie` and `sales@x.ie` are the same mailbox to
 * Postgres but two different strings on screen — storing the normalised form
 * keeps the tab strip, the Reply-To stamp and the routing match consistent.
 * (Rows created before this editor may still be mixed-case, which is why the
 * routes look addresses up with ILIKE rather than `=`.)
 *
 * @returns {string|null} null when there is nothing usable
 */
export function normalizeMailboxAddress(value) {
  const s = String(value ?? '').trim().toLowerCase()
  return s === '' ? null : s
}

/** The stored form of a label: trimmed, never blank. */
export function normalizeMailboxLabel(value) {
  const s = String(value ?? '').trim()
  return s === '' ? null : s
}

/**
 * Everything wrong with a proposed mailbox, in operator language.
 *
 * Returns [] when the input satisfies every CHECK the table carries. The
 * point is that the UI and the route agree with the database BEFORE the
 * insert: a constraint violation surfaced raw ("new row violates check
 * constraint email_mailboxes_label_len") tells an operator nothing.
 *
 * @param {{address?: unknown, label?: unknown}} input
 * @returns {string[]}
 */
export function mailboxInputIssues({ address, label } = {}) {
  const issues = []
  const addr = normalizeMailboxAddress(address)
  if (!addr) {
    issues.push('Enter the email address this account receives mail at.')
  } else if (!MAILBOX_ADDRESS_RE.test(addr)) {
    issues.push('That is not a valid email address — it needs a name, an @, and a domain with a dot.')
  }

  const lab = normalizeMailboxLabel(label)
  if (!lab) {
    issues.push('Give the account a short label — it names the tab staff click.')
  } else if (lab.length > MAILBOX_LABEL_MAX) {
    issues.push(`Labels are at most ${MAILBOX_LABEL_MAX} characters.`)
  }
  return issues
}

/**
 * The message for "this address already exists", which is the error an
 * operator is most likely to hit and least likely to understand.
 *
 * Three cases, because they need three different next actions:
 *   • already active HERE          → nothing to do
 *   • deactivated HERE             → reactivate it; do not add a second row
 *   • somewhere ELSE in the estate → explain the global rule. The other
 *     studio is named only when the caller can see the whole estate (master);
 *     for an owner, naming it would disclose another tenant's configuration,
 *     so they get the rule and a "ask whoever runs that studio" instead.
 *
 * @param {object} args
 * @param {string} args.address           the normalised address
 * @param {{location_id: string, label?: string, active?: boolean}} args.existing
 * @param {string} args.locationId        the location being edited
 * @param {string|null} [args.otherLocationName]  name of the owning studio,
 *   only when the caller is allowed to be told
 */
export function addressTakenMessage({ address, existing, locationId, otherLocationName = null }) {
  const label = existing?.label ? `“${existing.label}”` : 'another account'
  if (existing?.location_id === locationId) {
    return existing?.active === false
      ? `${address} is already set up at this studio as ${label}, but it is deactivated. Reactivate that account instead of adding it again — its ticket history is still attached to it.`
      : `${address} is already set up at this studio as ${label}.`
  }
  const who = otherLocationName ? ` It belongs to ${otherLocationName}.` : ''
  return `${address} is already in use by another studio.${who} An email address can belong to only one account across the whole estate, because inbound mail has to route somewhere unambiguous. Deactivating it there frees it up.`
}

/**
 * Turn a Postgres/PostgREST write error into something an operator can act
 * on, or null when it is not one we recognise (the route then surfaces the
 * raw message under a 500 rather than inventing a friendly lie).
 *
 * This is the RACE backstop, not the primary check: the routes look the
 * address up first, so this only fires when two operators write at once.
 */
export function mailboxConstraintMessage(error) {
  const msg = String(error?.message || '')
  if (!msg) return null
  if (/email_mailboxes_address_uidx/i.test(msg)) {
    return 'That address was just claimed by another account. An email address can belong to only one account across the whole estate.'
  }
  if (/email_mailboxes_one_default_uidx/i.test(msg)) {
    return 'This studio already has a default account. Set the new one as default from its row instead.'
  }
  if (/email_mailboxes_address_shape/i.test(msg)) {
    return 'That is not a valid email address — it needs a name, an @, and a domain with a dot.'
  }
  if (/email_mailboxes_label_len/i.test(msg)) {
    return `Labels are 1–${MAILBOX_LABEL_MAX} characters.`
  }
  if (/email_mailbox_access_pkey/i.test(msg)) {
    return 'That person already has access to this account.'
  }
  // MAILBOX-SURFACE.1 — mig 575's CHECK. The route validates the value first,
  // so reaching this means something bypassed that (an older client posting a
  // surface this build does not know, a script). It is named in the migration
  // precisely so there is a name to match here: an auto-generated constraint
  // name gives this function nothing to key on, and the operator gets the raw
  // "new row violates check constraint" string under a 500 instead.
  if (/email_mailboxes_surface_check/i.test(msg)) {
    return 'An account can be shown in Tickets or in Mail, and nothing else.'
  }
  return null
}

/**
 * Admin display order: usable accounts first, deactivated ones parked at the
 * bottom.
 *
 * Within each block the order is orderMailboxTabs' — default first, then
 * label A→Z — so the editor lists accounts in the same order the inbox tabs
 * do. Reused rather than re-derived: two orderings that drift is exactly how
 * "the tab I set as default isn't first" bugs happen.
 *
 * Unlike visibleMailboxes (the READ path) this keeps inactive rows: managing
 * them is the whole point of the surface, and `active = false` is a state an
 * operator has to be able to see and undo.
 */
export function orderMailboxAdminList(mailboxes) {
  if (!Array.isArray(mailboxes)) return []
  const active = orderMailboxTabs(mailboxes.filter(m => m?.active))
  const inactive = orderMailboxTabs(mailboxes.filter(m => !m?.active))
  return [...active, ...inactive]
}

/**
 * Is this person elevated at the location being edited — i.e. do they see
 * every account here without a grant row?
 *
 * The shape is a staff row as the routes assemble it: the per-location role
 * off profile_locations plus the global profiles.role. Same two conditions
 * guardMasterOrOwner applies to the CALLER, applied here to a LISTED person,
 * which is why it is a plain predicate and not that guard: guardMasterOrOwner
 * reads rolesByLocation off a getCurrentUser() result, and we have neither a
 * session nor a NextResponse to return.
 */
export function isImplicitlyElevated(person) {
  if (!person) return false
  return person.profile_role === 'master' || person.role === 'owner'
}

/**
 * The access list for ONE mailbox: every staff member at the location, each
 * tagged with how they get in.
 *
 *   'implicit' — master or owner-at-this-location. No grant row exists and
 *                none can be created. THIS IS THE POINT: an operator who sees
 *                an owner listed as an ordinary grant will try to revoke it,
 *                watch nothing change, and lose confidence in the whole
 *                screen. They are shown as always-on and not togglable.
 *   'granted'  — holds a row in email_mailbox_access.
 *   'none'     — cannot see this account.
 *
 * Sorted implicit first, then granted, then the rest; alphabetically within
 * each band, so the answer to "who can read billing mail?" is the top of the
 * list rather than something to hunt for.
 *
 * @param {object} args
 * @param {Array} args.staff   [{ profile_id, full_name, email, role, profile_role }]
 * @param {Array} args.grants  grant rows for THIS mailbox
 */
export function mailboxAccessRows({ staff, grants } = {}) {
  const list = Array.isArray(staff) ? staff : []
  const byProfile = new Map()
  for (const g of Array.isArray(grants) ? grants : []) {
    if (g?.profile_id) byProfile.set(g.profile_id, g)
  }

  const rank = { implicit: 0, granted: 1, none: 2 }
  return list
    .map(p => {
      const implicit = isImplicitlyElevated(p)
      const grant = byProfile.get(p.profile_id) || null
      return {
        profile_id: p.profile_id,
        full_name: p.full_name || null,
        email: p.email || null,
        role: p.role || null,
        access: implicit ? 'implicit' : (grant ? 'granted' : 'none'),
        // Never claim an implicit viewer was granted by anyone — they were not.
        granted_at: implicit ? null : (grant?.granted_at || null),
        granted_by: implicit ? null : (grant?.granted_by || null),
      }
    })
    .sort((a, b) => {
      if (rank[a.access] !== rank[b.access]) return rank[a.access] - rank[b.access]
      const an = (a.full_name || a.email || '').toLowerCase()
      const bn = (b.full_name || b.email || '').toLowerCase()
      if (an !== bn) return an < bn ? -1 : 1
      return String(a.profile_id).localeCompare(String(b.profile_id))
    })
}

/**
 * The patch that goes with a requested `active` flip.
 *
 * Deactivating CLEARS is_default. A deactivated mailbox is hidden from every
 * inbox (visibleMailboxes drops it for owners too) and stops accepting
 * inbound, so leaving it flagged default would leave the studio's Reply-To
 * pointing at an address nobody can read and nothing can deliver to — a
 * silent failure exactly like the one mig 485 was written to end. Clearing it
 * makes the studio visibly default-less until someone picks a new one.
 *
 * Reactivating does NOT restore the flag: the operator chooses.
 */
export function deactivationPatch(active) {
  return active ? { active: true } : { active: false, is_default: false }
}
