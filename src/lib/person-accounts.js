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
