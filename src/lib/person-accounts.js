// src/lib/person-accounts.js — PERSON-ACCT.1
//
// Foundation library for the duplicate-contact problem: one person often
// has 2-3 `contacts` rows, each with a DIFFERENT `glofox_member_id`
// (external booking-system account), linked via `person_groups` /
// `person_group_members`. Later tasks fan reads (credits, bookings,
// membership state) out across ALL of a person's accounts rather than
// just the one contact row a conversation happens to be attached to.
//
// House rules honoured here: supabase-js builders are thenables — every
// query goes through try/await/catch, never `.catch()`; every `.in()`
// call chunks its id list at ≤150 (PostgREST URL-length limit, see the
// BUG-FIX #538 lesson referenced in person-links.js).

import { normalisePhone9 } from './person-links'
import { escapeLikePattern } from './like-escape'

const CONTACT_COLUMNS =
  'id, name, glofox_member_id, glofox_membership_status, glofox_membership_state, ' +
  'trial_credits_remaining, last_attended_at, phone, wa_phone, email, updated_at, location_id'

const CHUNK_SIZE = 150

// PERSON-ACCT.3 — same cohort as src/lib/account-home.js / churn-radar.js's
// MEMBER_STATUSES ('member' + 'credit_member' = a genuine paying membership,
// as opposed to a lead/trial/drop-in). Defined locally rather than imported
// from account-home.js: that module pulls @/lib/auth, which pulls
// next/headers + next/server + @supabase/ssr — this module is imported
// directly (unmocked) by the agent's account/booking tools on every
// WhatsApp turn that reads a membership, so it must stay free of that
// stack. person-accounts.test.js asserts this list equals account-home's
// export so the two can never silently drift.
export const MEMBER_STATUSES = Object.freeze(['member', 'credit_member'])

/**
 * Does this contact row hold a membership that can actually book a class
 * right now? Pure.
 *
 * Verified against live prod (2026-08-26, 8,646 contacts):
 * contacts.glofox_membership_status is NEVER the string 'active' — real
 * values are trial (3701), lead (1723), classpass_payg (1630), member
 * (1045), null (268), cold (172), credit_member (65), no_sale_trial (36),
 * no_sale_tour (5), tour (1). And glofox_membership_state === 'active'
 * ALONE is not proof of a real membership either: 1,679 LEADS and 1,630
 * classpass_payg rows also carry state='active' — it is the state of
 * whatever membership record Glofox last synced, not evidence that record
 * is a genuine subscription/credit membership.
 *
 * The correct test combines BOTH columns: a genuine member/credit_member
 * STATUS (MEMBER_STATUSES) whose STATE has not ended — 'active' or
 * null/never-set count as live-right-now; 'paused'/'locked' are a real
 * membership that just can't book today, and 'future' hasn't started yet,
 * so both are correctly excluded here (a caller wanting "is this person a
 * member at all, regardless of whether they can book today" wants
 * MEMBER_STATUSES.includes(...) alone, not this helper).
 *
 * DO NOT "simplify" this back to `glofox_membership_status === 'active'` —
 * per the distribution above that string never occurs, so that check is
 * dead code that always evaluates false. It was live at three sites in
 * this repo before PERSON-ACCT.3 caught it (two already shipped) — see
 * that task's commit for the incident.
 */
export function hasBookableMembership(row) {
  if (!row) return false
  if (!MEMBER_STATUSES.includes(row.glofox_membership_status)) return false
  return row.glofox_membership_state === 'active' || row.glofox_membership_state == null
}

// Defensive-by-convention: person groups are 2-6 rows in practice, so this
// loop almost always runs once. The ≤150 cap is house law for every
// `.in()` call regardless (PostgREST URL-length limit — BUG-FIX #538).
// Exported since PERSON-ACCT.9 so callers OUTSIDE this module (the funnel's
// person-wide approval dedupe, book_class's) chunk the same way instead of
// re-rolling the loop and getting the cap wrong.
export function chunkIds(ids, size = CHUNK_SIZE) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean)
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Fetch contacts rows for a list of ids, chunking every `.in()` call at
 * ≤150 ids. Throws on the first Postgrest error so the caller's outer
 * try/catch can collapse it into the readFailed posture.
 */
async function fetchContactsByIds(db, ids) {
  const rows = []
  for (const batch of chunkIds(ids)) {
    const { data, error } = await db.from('contacts').select(CONTACT_COLUMNS).in('id', batch)
    if (error) throw error
    rows.push(...(data || []))
  }
  return rows
}

/**
 * Dedupe contact rows carrying a glofox_member_id down to one row per
 * account. When two contacts share a glofox_member_id, keep the row whose
 * id === anchorContactId if present, else the one that sorts first
 * lexicographically on the stringified id (ids are uuids). Rows with no
 * glofox_member_id are dropped (they're not "accounts").
 */
function dedupeAccounts(contacts, anchorContactId) {
  const byMemberId = new Map()
  for (const c of contacts) {
    if (!c || !c.glofox_member_id) continue
    const existing = byMemberId.get(c.glofox_member_id)
    if (!existing) {
      byMemberId.set(c.glofox_member_id, c)
      continue
    }
    const existingIsAnchor = existing.id === anchorContactId
    const currentIsAnchor = c.id === anchorContactId
    if (currentIsAnchor && !existingIsAnchor) {
      byMemberId.set(c.glofox_member_id, c)
    } else if (!currentIsAnchor && !existingIsAnchor && String(c.id) < String(existing.id)) {
      byMemberId.set(c.glofox_member_id, c)
    }
    // else: existing wins (it's the anchor, or it already sorted first)
  }
  return [...byMemberId.values()]
}

/**
 * linkedAccountsForContact(db, contactId, { groupId } = {}) →
 *   { anchorContactId, contacts, accounts, readFailed? }
 *
 * Look up contactId's person_group_members row → its group id (or none) →
 * every member contact id of that group → the contacts rows for them. An
 * ungrouped contact short-circuits to a singleton of its own row (one
 * contacts read, no group lookup fan-out).
 *
 * Pass `groupId` when the caller has already resolved it (e.g. the agent
 * turn resolves the conversation's group every turn) to SKIP the initial
 * person_group_members membership lookup and go straight to the
 * group-members list read. Everyone else omits it.
 *
 * The group-members list read is unioned with contactId itself, so the
 * anchor's own row is always present in `contacts` even if that read
 * comes back empty (a racy/stale read must never lose the caller's own
 * contact).
 *
 * `accounts` is `contacts` filtered to rows carrying a non-null
 * glofox_member_id, deduped per account (see dedupeAccounts above) — this
 * is the list later tasks fan Glofox reads across.
 *
 * On any DB error, or on a missing contactId, returns `{ anchorContactId,
 * contacts: [], accounts: [], readFailed: true }`. Callers MUST treat
 * readFailed as "fall back to single-account behaviour", never as "this
 * person has no accounts".
 */
export async function linkedAccountsForContact(db, contactId, { groupId } = {}) {
  if (!contactId) {
    return { anchorContactId: contactId ?? null, contacts: [], accounts: [], readFailed: true }
  }
  try {
    let resolvedGroupId = groupId ?? null
    if (!resolvedGroupId) {
      const { data: membership, error: memberErr } = await db
        .from('person_group_members')
        .select('group_id')
        .eq('contact_id', contactId)
        .maybeSingle()
      if (memberErr) throw memberErr
      resolvedGroupId = membership?.group_id ?? null
    }

    let contacts
    if (!resolvedGroupId) {
      const { data, error } = await db.from('contacts').select(CONTACT_COLUMNS).eq('id', contactId)
      if (error) throw error
      contacts = data || []
    } else {
      const { data: members, error: membersErr } = await db
        .from('person_group_members')
        .select('contact_id')
        .eq('group_id', resolvedGroupId)
      if (membersErr) throw membersErr
      const ids = [...new Set([contactId, ...((members || []).map((m) => m.contact_id).filter(Boolean))])]
      contacts = await fetchContactsByIds(db, ids)
    }

    const accounts = dedupeAccounts(contacts, contactId)
    return { anchorContactId: contactId, contacts, accounts }
  } catch (err) {
    console.error('[person-accounts] linkedAccountsForContact failed:', err?.message || err)
    return { anchorContactId: contactId, contacts: [], accounts: [], readFailed: true }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function normaliseEmail(raw) {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  return trimmed || null
}

/**
 * corroborated(anchorRow, otherRow) → boolean [pure]
 *
 * True when the two contact rows are the same row (same id), or when they
 * share a normalised phone number (last 9 digits, compared across BOTH
 * `phone` and `wa_phone` on both rows) or an exact trim+lowercase email
 * match. Null/missing fields never match — an empty phone/email on one
 * side never corroborates anything.
 */
export function corroborated(anchorRow, otherRow) {
  if (!anchorRow || !otherRow) return false
  if (anchorRow.id != null && otherRow.id != null && anchorRow.id === otherRow.id) return true
  if (sharePhone(anchorRow, otherRow)) return true
  if (sameEmail(anchorRow, otherRow)) return true
  return false
}

// The two halves of `corroborated`, separately — because for an UNGROUPED row
// they are not the same strength of evidence (see reusableSibling below).
function sharePhone(a, b) {
  const aPhones = [normalisePhone9(a?.phone), normalisePhone9(a?.wa_phone)].filter(Boolean)
  const bPhones = [normalisePhone9(b?.phone), normalisePhone9(b?.wa_phone)].filter(Boolean)
  return aPhones.some((p) => bPhones.includes(p))
}

function sameEmail(a, b) {
  const aEmail = normaliseEmail(a?.email)
  const bEmail = normaliseEmail(b?.email)
  return !!aEmail && !!bEmail && aEmail === bEmail
}

/**
 * reusableSibling(anchorRow, row, { viaGroup }) -> boolean [pure]
 *
 * May a WRITE — a booking, a credit spend, a membership ride — be moved onto
 * `row`'s Glofox account silently, with no human looking at it?
 *
 * This is deliberately STRICTER than `corroborated`, and the difference is
 * one thing: **a shared phone number is not a shared identity.** Couples and
 * families share a number. Measured at Stillorgan (2026-08-26): 326 contact
 * groups share a phone, 62 of those carry DIFFERENT first names, and 59 of
 * the 62 hold more than one Glofox account. So "same last-9 digits" would
 * silently book PERSON B's class against PERSON A's account and spend A's
 * credits — the wrong-account write this whole programme exists to remove,
 * committed by the code meant to remove it.
 *
 * The codebase already knows this hazard and already refuses it elsewhere:
 * `resolveAutoVerify` (src/lib/agent/core.js) returns null — will not
 * auto-verify — when two UNGROUPED contacts share the inbound number, pinned
 * as "the couple case" in core.test.js. This predicate is the same refusal at
 * the write boundary.
 *
 * Reuse is therefore allowed on exactly two kinds of evidence:
 *   (a) `viaGroup` — the row is a person_group member. person-detect vetted
 *       that link with its own high-confidence rules (and its own refusal of
 *       the couple case), or a human linked it by hand. Corroboration is
 *       still required on top, mirroring electWriteAccount's rule 1: a group
 *       row sharing NO identifier at all is a name match somebody accepted
 *       for display, not a mandate to write.
 *   (b) an exact email match — `contacts_email_unique` is GLOBAL in this
 *       schema (mig 008: `ON contacts (email) WHERE email IS NOT NULL`) and
 *       prod carries zero shared addresses, so one address really is one
 *       person. Being case-SENSITIVE, that index still permits a casing
 *       variant, which our trim+lowercase compare catches — the one shape
 *       where two rows legitimately share an address.
 *
 * A phone-only match from the DIRECT search is neither: it blocks the mint
 * (conservative — a human decides), but it never moves a write. Do NOT
 * "simplify" this back to `corroborated` — that is the defect, not a tidy-up.
 */
export function reusableSibling(anchorRow, row, { viaGroup = false } = {}) {
  if (!anchorRow || !row) return false
  if (anchorRow.id != null && row.id != null && anchorRow.id === row.id) return true
  if (sameEmail(anchorRow, row)) return true
  return viaGroup === true && corroborated(anchorRow, row)
}

// ---------------------------------------------------------------------------
// PERSON-ACCT.9 — seeing the person BEFORE the group exists
// ---------------------------------------------------------------------------

// A person's rows are 2-6 in practice; this cap only stops a pathological
// shared/blank number (a studio landline typed into 400 lead forms) from
// pulling a page of strangers into a decision. It is a bound, not a filter:
// everything returned is still corroboration-checked by the caller.
const SIBLING_SEARCH_LIMIT = 50

/**
 * directSiblingRows(db, { anchorRow, locationId }) →
 *   { rows, readFailed }
 *
 * The half of "who is this person" that `person_group_members` CANNOT
 * answer: a contact created seconds ago by a public form is not in any
 * group yet (groups only form when detection runs, or when staff link by
 * hand), so a returner who fills the form with a new email looks like a
 * blank slate to every group-based read.
 *
 * Two searches, both scoped to `locationId` when one is given:
 *   • phone — last 9 digits, matched across BOTH `phone` and `wa_phone` on
 *     both sides. normalisePhone9 strips every non-digit, so the pattern
 *     carries no LIKE wildcard and no PostgREST `or` separator; the `%`
 *     prefix is a DELIBERATE suffix search, spelled in the source (the
 *     no-unescaped-ilike-pattern convention).
 *   • email — exact, case-insensitive. `.ilike` + escapeLikePattern, NOT
 *     `.eq` (contacts are stored mixed-case) and NOT a raw `.ilike` (`_`
 *     and `%` are legal email characters — the 2026-08-07 incident).
 *
 * The anchor's own row is dropped. `readFailed: true` on ANY failed read,
 * with whatever rows did come back still returned — a caller must never
 * read an unreadable search as "this person has no other rows".
 */
export async function directSiblingRows(db, { anchorRow, locationId = null } = {}) {
  if (!db || !anchorRow) return { rows: [], readFailed: true }
  const anchorId = anchorRow.id ?? null
  const rows = []
  let readFailed = false

  const scoped = (q) => (locationId != null ? q.eq('location_id', locationId) : q)

  const phones = [...new Set(
    [normalisePhone9(anchorRow.phone), normalisePhone9(anchorRow.wa_phone)].filter(Boolean),
  )]
  if (phones.length) {
    try {
      const or = phones.flatMap((p) => [`phone.ilike.%${p}`, `wa_phone.ilike.%${p}`]).join(',')
      const { data, error } = await scoped(
        db.from('contacts').select(CONTACT_COLUMNS).or(or),
      ).limit(SIBLING_SEARCH_LIMIT)
      if (error) throw error
      rows.push(...(data || []))
    } catch (err) {
      readFailed = true
      console.error('[person-accounts] directSiblingRows phone search failed:', err?.message || err)
    }
  }

  const email = normaliseEmail(anchorRow.email)
  if (email) {
    try {
      const { data, error } = await scoped(
        db.from('contacts').select(CONTACT_COLUMNS).ilike('email', escapeLikePattern(email)),
      ).limit(SIBLING_SEARCH_LIMIT)
      if (error) throw error
      rows.push(...(data || []))
    } catch (err) {
      readFailed = true
      console.error('[person-accounts] directSiblingRows email search failed:', err?.message || err)
    }
  }

  const byId = new Map()
  for (const row of rows) {
    if (!row || !row.id || row.id === anchorId) continue
    if (!byId.has(row.id)) byId.set(row.id, row)
  }
  return { rows: [...byId.values()], readFailed }
}

/**
 * personRowsForContact(db, { contactId, contact, locationId, groupId }) →
 *   { anchorRow, rows, groupContactIds, readFailed }
 *
 * Every `contacts` row that plausibly belongs to the same PERSON as
 * `contactId`, at `locationId`: the person-group union
 * (linkedAccountsForContact) UNIONed with the direct phone/email search
 * above. `rows` excludes the anchor itself and is deduped by id.
 *
 * Group membership and a direct identifier match are deliberately NOT the
 * same evidence, and this function does not conflate them — it returns the
 * union, tells the caller WHICH ids came from the group (`groupContactIds`),
 * and leaves the split to `corroborated` / `reusableSibling`. A grouped row
 * that shares no phone or email is a name-ish match somebody (or detection)
 * once accepted: good enough to REFUSE to mint a duplicate over, never good
 * enough to WRITE to. A phone-only row from the DIRECT search is weaker
 * still — it may be the anchor's partner (see reusableSibling).
 *
 * A row whose OWN `location_id` is present and differs from `locationId` is
 * dropped (the group read spans locations by design). A null location_id is
 * never treated as foreign — same rule as electWriteAccount's location
 * guard, for the same reason: a sync gap must not strand a real account.
 *
 * `readFailed` is the OR of both halves. It never means "no rows".
 */
export async function personRowsForContact(db, { contactId, contact = null, locationId = null, groupId = null } = {}) {
  const anchorId = contactId ?? contact?.id ?? null
  if (!db || !anchorId) return { anchorRow: contact || null, rows: [], groupContactIds: [], readFailed: true }

  let readFailed = false
  const byId = new Map()
  const groupContactIds = new Set()
  const add = (row, { viaGroup = false } = {}) => {
    if (!row || !row.id || row.id === anchorId) return
    if (locationId != null && row.location_id != null && row.location_id !== locationId) return
    if (!byId.has(row.id)) byId.set(row.id, row)
    // Provenance is recorded even when the row was already known from the
    // other half: being ALSO findable by phone never weakens a vetted group
    // link, and the group is the stronger evidence of the two.
    if (viaGroup) groupContactIds.add(row.id)
  }

  const linked = await linkedAccountsForContact(db, anchorId, { groupId })
  if (linked.readFailed) readFailed = true
  for (const row of linked.contacts) add(row, { viaGroup: true })

  // Prefer the caller's own freshly-read row as the anchor (it is the row the
  // decision is being made FOR); fall back to the group read's copy.
  const anchorRow = contact || linked.contacts.find((c) => c && c.id === anchorId) || null

  const direct = await directSiblingRows(db, { anchorRow, locationId })
  if (direct.readFailed) readFailed = true
  for (const row of direct.rows) add(row)

  return { anchorRow, rows: [...byId.values()], groupContactIds: [...groupContactIds], readFailed }
}

// Tier an account for write-election purposes: 2 = has a bookable membership
// right now, 1 = no membership but holds trial credits, 0 = neither (pure
// recency tiebreak territory). Higher tier always outranks a lower one
// regardless of recency — a stale membership still beats a very-recently-
// active account with nothing to spend.
function writeElectionTier(row) {
  if (hasBookableMembership(row)) return 2
  if (Number(row?.trial_credits_remaining) > 0) return 1
  return 0
}

// Most-recent-activity timestamp for ranking, ms since epoch. Tries
// last_attended_at first; falls back to updated_at only when the primary is
// absent OR fails to parse. Both absent/unparseable → -Infinity, i.e. this
// row sorts LAST — an account election must never treat "we don't know when
// this was last used" as "just used".
function writeElectionActivityMs(row) {
  const primary = row?.last_attended_at
  const primaryMs = primary != null ? Date.parse(primary) : NaN
  if (!Number.isNaN(primaryMs)) return primaryMs
  const fallback = row?.updated_at
  const fallbackMs = fallback != null ? Date.parse(fallback) : NaN
  if (!Number.isNaN(fallbackMs)) return fallbackMs
  return -Infinity
}

// Total order over candidates: tier desc, then activity desc, then id asc.
// The id tiebreak is what makes election a pure function of the account SET
// rather than of `accounts`' incoming array order — two callers who fetch
// the same group in different orders (e.g. a cache vs a fresh read) must
// never elect different accounts for the same write.
function compareForElection(a, b) {
  const tierA = writeElectionTier(a)
  const tierB = writeElectionTier(b)
  if (tierA !== tierB) return tierB - tierA
  // Compare via equality first, not subtraction: both sides commonly land on
  // -Infinity (no usable activity at all), and -Infinity - -Infinity is NaN,
  // which silently corrupts Array.sort's ordering instead of throwing.
  const ma = writeElectionActivityMs(a)
  const mb = writeElectionActivityMs(b)
  if (ma !== mb) return mb - ma
  const idA = String(a.id)
  const idB = String(b.id)
  if (idA < idB) return -1
  if (idA > idB) return 1
  return 0
}

/**
 * electWriteAccount({ accounts, anchorContactId, concernsMemberIds = [], locationId }) →
 *   { outcome: 'none', candidates: [] }
 * | { outcome: 'elected', account, candidates: [account] }
 * | { outcome: 'conflict', candidates: [...tied, ranked] }
 *
 * PERSON-ACCT.5 — deliberately elects ONE account for a WRITE (book/cancel/
 * pause), or escalates, rather than reading `accounts` in whatever order the
 * caller happened to fetch it. This is NOT `pickPrimary` (person-links.js),
 * which ranks accounts for DISPLAY/outreach — which row a contact list or
 * churn radar shows as "the" contact. That ranking still puts a classpass
 * row on the podium (score 0, but still sorted and returned) because
 * showing it is harmless; WRITING to it is not (below). Reusing a display
 * ranking to decide which Glofox account actually receives a booking/cancel
 * call is exactly the bug this task exists to prevent: pickPrimary happily
 * returns whichever row scores highest even when that row is a stranger's
 * (it has no corroboration concept at all), so a shared surname/lookup that
 * grouped the wrong two contacts together would silently book the WRONG
 * PERSON's class. Election refuses to guess: it only ever picks among rows
 * that are actually corroborated with the person being written for, and it
 * answers 'conflict' rather than a coin-flip when two accounts are equally
 * good candidates.
 *
 * ClassPass rows stay READ-visible elsewhere in this module (linkedAccounts-
 * ForContact, findBookingAcrossAccounts) because showing a customer their
 * ClassPass booking is correct — but classpass_payg is a status Glofox
 * itself does not treat as a normal membership: bookings/cancellations for
 * it are governed by ClassPass's own payment/credit/refund flow. Writing to
 * it directly through the Glofox member API would create or cancel a
 * booking Glofox thinks the member paid for directly, while ClassPass's own
 * ledger never hears about it — a silent double-booking/refund mismatch.
 * So classpass_payg is excluded from candidates ALWAYS, even when it is the
 * only entitled (bookable-membership or credits-holding) row in the group.
 *
 * Rules, applied in order:
 *  1. Candidates = accounts minus classpass_payg rows, minus rows that fail
 *     `corroborated(anchorRow, row)` (anchorRow = the row whose id ===
 *     anchorContactId if present, else the first account by id sort — a row
 *     is always corroborated with itself, so the anchor is never excluded
 *     by its own rule), minus — when `locationId` is passed — rows whose
 *     OWN `location_id` is present AND differs from it. Zero candidates →
 *     'none'.
 *
 *     The location guard is defensive hardening, not a rule the data
 *     currently exercises: `linkedAccountsForContact` resolves a person's
 *     WHOLE group regardless of location, and — verified against
 *     production 2026-08-26 — zero person groups today span more than one
 *     location. But nothing stops one existing (a member who trains at two
 *     studios), and electing an account at the WRONG location would file an
 *     approval row whose `contact_id` and `location_id` disagree. A null or
 *     absent `location_id` is NEVER treated as evidence of a foreign
 *     location — excluding it on absence alone could strand a legitimate
 *     account behind a sync gap, which is worse than the latent risk this
 *     guards against. Passing no `locationId` at all (the parameter's
 *     default) is a complete no-op, preserving every existing caller's
 *     behaviour exactly.
 *  2. If concernsMemberIds intersects the candidate set, narrow candidates
 *     to that intersection — the account already holding the activity this
 *     write concerns wins over a bare entitlement elsewhere, so a person's
 *     booking/cancel history doesn't fragment across accounts.
 *  3. Rank the remaining candidates: bookable membership, then credits,
 *     then most-recent activity, then id (deterministic, order-independent).
 *  4. Conflict: if ≥2 candidates tie at the TOP tier (both counted as
 *     "having a bookable membership", or — only when none do — both
 *     "holding credits") → 'conflict' with the tied rows, ranked. A tie at
 *     the bottom (recency-only) tier is NOT a conflict — the id tiebreak
 *     always yields a single, deterministic winner there.
 *  5. Otherwise → 'elected' with the top-ranked candidate.
 *
 * Pure: never mutates `accounts` (every sort/filter runs over a copy).
 */
export function electWriteAccount({ accounts, anchorContactId, concernsMemberIds = [], locationId = null } = {}) {
  const list = Array.isArray(accounts) ? accounts : []

  const anchorRow = list.find((a) => a && a.id === anchorContactId)
    ?? [...list].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))[0]

  const eligible = list.filter((acct) => {
    if (!acct) return false
    if (acct.glofox_membership_status === 'classpass_payg') return false
    // Location guard (defensive hardening, see the doc comment above): only
    // ever excludes on a POSITIVE mismatch — a row with no location_id at
    // all is never treated as foreign.
    if (locationId != null && acct.location_id != null && acct.location_id !== locationId) return false
    return corroborated(anchorRow, acct)
  })

  if (eligible.length === 0) return { outcome: 'none', candidates: [] }

  const concerns = Array.isArray(concernsMemberIds) ? concernsMemberIds : []
  let pool = eligible
  if (concerns.length > 0) {
    const concerned = eligible.filter((acct) => concerns.includes(acct.glofox_member_id))
    if (concerned.length > 0) pool = concerned
  }

  const ranked = [...pool].sort(compareForElection)
  const topTier = writeElectionTier(ranked[0])
  const tiedAtTop = topTier > 0 ? ranked.filter((acct) => writeElectionTier(acct) === topTier) : [ranked[0]]

  if (tiedAtTop.length >= 2) {
    return { outcome: 'conflict', candidates: tiedAtTop }
  }
  return { outcome: 'elected', account: ranked[0], candidates: [ranked[0]] }
}

/**
 * findBookingAcrossAccounts(creds, accounts, bookingId, fetchImpl) →
 *   { owner, unreadable }
 *
 * Fans a booking lookup out across every account via Promise.allSettled,
 * calling `fetchImpl(creds, account.glofox_member_id, { windowDays: 0,
 * limit: 100 })` per account (production callers pass
 * fetchUserBookingsResult from '@/lib/glofox'; injected here for
 * testability). Booking rows are matched on `_id` — the same field
 * shapeMemberBookingsForAgent/cancel_class_booking use in
 * src/lib/agent/booking-tools.js.
 *
 * `owner` is the account object whose bookings contain bookingId (null if
 * none do; the FIRST account in `accounts` order wins if more than one
 * somehow carries it). `unreadable` lists accounts whose read failed — the
 * promise rejected, or the result reported `ok: false`. An ok read with
 * empty/absent bookings is EMPTY, not unreadable. A missing/non-function
 * `fetchImpl` never throws — every account is reported unreadable.
 */
export async function findBookingAcrossAccounts(creds, accounts, bookingId, fetchImpl) {
  const reads = await fanUpcomingBookings(creds, accounts, fetchImpl)

  let owner = null
  const unreadable = []

  for (const { account, ok, bookings } of reads) {
    if (!ok) {
      unreadable.push(account)
      continue
    }
    if (!owner && bookings.some((b) => b && b._id === bookingId)) {
      owner = account
    }
  }

  return { owner, unreadable }
}

/**
 * fanUpcomingBookings(creds, accounts, fetchImpl) →
 *   [{ account, ok, bookings }]  (input order preserved)
 *
 * PERSON-ACCT.7 — the ONE upcoming-bookings fan-out. Every caller that asks
 * "what is this whole person booked into" runs through here: the agent's
 * list_my_upcoming_bookings merge, cancel_class_booking's owner lookup
 * (findBookingAcrossAccounts, above) and book_class's election-activity +
 * double-booking backstop. Sharing it is the point — three copies of the
 * same allSettled would be three chances to drift on the window, the cap, or
 * on what counts as an unreadable account.
 *
 * `ok: false` covers a rejected promise AND a result reporting `ok: false`.
 * An ok read with no bookings is EMPTY, not unreadable — the distinction is
 * load-bearing (an unreadable account must never become "you have nothing
 * booked"). A missing/non-function `fetchImpl` never throws: every account
 * comes back unreadable.
 */
export async function fanUpcomingBookings(creds, accounts, fetchImpl) {
  const list = Array.isArray(accounts) ? accounts : []
  if (typeof fetchImpl !== 'function') {
    return list.map((account) => ({ account, ok: false, bookings: [] }))
  }
  const settled = await Promise.allSettled(
    list.map((account) => fetchImpl(creds, account.glofox_member_id, {
      // windowDays: 0 → class start >= now, i.e. upcoming bookings only
      // (glofox.js computes cutoffSec = now; do not "tidy" to a default
      // window).
      windowDays: 0,
      limit: 100,
    })),
  )
  return settled.map((result, i) => {
    const account = list[i]
    if (result.status !== 'fulfilled' || !result.value || result.value.ok !== true) {
      return { account, ok: false, bookings: [] }
    }
    return {
      account,
      ok: true,
      bookings: Array.isArray(result.value.bookings) ? result.value.bookings : [],
    }
  })
}

// The Glofox Booking is POLYMORPHIC: its class reference is `model_id` (with
// discriminator model:'events'), NOT a top-level `event_id` — the same read
// mapBookingToRosterRow makes (src/lib/class-bookings.js), where hard-
// requiring event_id left class_bookings empty all-time.
function bookingEventId(b) {
  const id = b?.model_id ?? b?.event_id
  return id == null ? null : String(id)
}

// /2.0/bookings is fetched with exclude_cancelled=false, so cancelled rows
// come back too. Mirrors shapeMemberBookingsForAgent: a missing status counts
// as booked, anything other than BOOKED does not.
function isActiveBooking(b) {
  const status = typeof b?.status === 'string' ? b.status.toUpperCase() : null
  return !status || status === 'BOOKED'
}

/**
 * summariseBookingFan(reads, eventId) →
 *   { concernsMemberIds, alreadyBookedOn, unreadable }   [pure]
 *
 * PERSON-ACCT.7 — reads a fanUpcomingBookings result for the two things a
 * WRITE needs to know:
 *   • concernsMemberIds — the accounts actually holding this person's
 *     upcoming bookings, fed to electWriteAccount so the write lands where
 *     their activity already is rather than fragmenting across accounts;
 *   • alreadyBookedOn — the account already holding `eventId` (null if none,
 *     the first in `reads` order if somehow two do). This is the
 *     cross-account double-booking backstop: Glofox dedupes per member id,
 *     so it cannot see a booking sitting on the person's OTHER account.
 *
 * Unreadable accounts are reported, never counted as empty. A null/absent
 * eventId can only yield `alreadyBookedOn: null` — an unmatchable id must
 * never produce a confident "already booked".
 */
export function summariseBookingFan(reads, eventId) {
  const wanted = eventId == null ? null : String(eventId)
  const concernsMemberIds = []
  const unreadable = []
  let alreadyBookedOn = null

  for (const read of Array.isArray(reads) ? reads : []) {
    if (!read) continue
    if (!read.ok) {
      unreadable.push(read.account)
      continue
    }
    const active = (Array.isArray(read.bookings) ? read.bookings : []).filter(isActiveBooking)
    if (active.length && read.account?.glofox_member_id) {
      concernsMemberIds.push(read.account.glofox_member_id)
    }
    if (!alreadyBookedOn && wanted && active.some((b) => bookingEventId(b) === wanted)) {
      alreadyBookedOn = read.account
    }
  }

  return { concernsMemberIds, alreadyBookedOn, unreadable }
}
