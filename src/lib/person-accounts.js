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

const CONTACT_COLUMNS =
  'id, name, glofox_member_id, glofox_membership_status, glofox_membership_state, ' +
  'trial_credits_remaining, last_attended_at, phone, wa_phone, email, updated_at'

const CHUNK_SIZE = 150

// Defensive-by-convention: person groups are 2-6 rows in practice, so this
// loop almost always runs once. The ≤150 cap is house law for every
// `.in()` call regardless (PostgREST URL-length limit — BUG-FIX #538).
function chunkIds(ids, size = CHUNK_SIZE) {
  const out = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
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

  const anchorPhones = [normalisePhone9(anchorRow.phone), normalisePhone9(anchorRow.wa_phone)].filter(Boolean)
  const otherPhones = [normalisePhone9(otherRow.phone), normalisePhone9(otherRow.wa_phone)].filter(Boolean)
  if (anchorPhones.some((p) => otherPhones.includes(p))) return true

  const anchorEmail = normaliseEmail(anchorRow.email)
  const otherEmail = normaliseEmail(otherRow.email)
  if (anchorEmail && otherEmail && anchorEmail === otherEmail) return true

  return false
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
  const list = Array.isArray(accounts) ? accounts : []
  if (typeof fetchImpl !== 'function') {
    return { owner: null, unreadable: [...list] }
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

  let owner = null
  const unreadable = []

  settled.forEach((result, i) => {
    const account = list[i]
    if (result.status !== 'fulfilled' || !result.value || result.value.ok !== true) {
      unreadable.push(account)
      return
    }
    const bookings = Array.isArray(result.value.bookings) ? result.value.bookings : []
    if (!owner && bookings.some((b) => b && b._id === bookingId)) {
      owner = account
    }
  })

  return { owner, unreadable }
}
