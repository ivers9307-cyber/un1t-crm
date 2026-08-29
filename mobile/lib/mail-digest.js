// MAIL-ALLLOC.1 — pure decisions for multi-location Mail on mobile: the
// location tiles, the All-locations digest view, and the scope hand-off to
// the search and compose screens. The Mail tab (app/(staff)/(tabs)/email.jsx)
// renders what these functions decide and owns nothing branchable itself —
// mobile screens have no render harness (contract rule 6), so any rule that
// lived in the JSX would ship untested.
//
// THE LOCKED DESIGN this file implements (CONTRACTS-ALLLOC.md — approved
// after three rounds; do not renegotiate):
//   • Tiles render ONLY when the digest answers 2+ locations — a
//     single-location caller sees today's UI, byte-for-byte unchanged.
//   • All is the default for multi-location callers, but the chosen scope
//     persists per user (AsyncStorage `un1t.mail.scope.<userId>` — the SAME
//     key name as the web's localStorage twin; the namespaces never meet).
//     A persisted scope naming a location no longer in the digest falls back
//     to All, never to a broken view.
//   • The tile count is ALWAYS needs-reply, whatever view is active. When
//     the summed total is null (a partial digest), the LAST GOOD number
//     stands — an unknown contributor must never render as a confident 0.
//   • All mode is grouped sticky studio sections, NO location pills on rows,
//     one scroll. Each section: header ("Hatch Street · 3 need reply"), the
//     digest's ≤5 rows shaped EXACTLY like list rows, then "View all N →"
//     only when the cap hid something. A section with view_total 0 renders
//     the header + a quiet "Nothing here" — hiding reads as missing mail.
//   • A location answered `unavailable: true` renders as an inline error
//     state with a retry; its tile shows no count (no chip), never 0.
//
// The web statement of the same decisions is src/components/mail/mail-digest.js
// — a deliberate re-statement, not an import (mobile cannot reach src/ or
// src/components; CLAUDE.md — `shared/` is the seam and none of this is
// exported there). The rules that must not drift are the bullets above.
//
// AsyncStorage, not SecureStore: a scope choice is neither a token nor
// customer data (the name of a studio, at most) — same reasoning as the
// reply-drafts store in ./mail-drafts.js, whose fail-closed key discipline
// this file copies.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { ticketToInboxRow, segCountLabel } from './email-tickets'

/* ───────────────────────── scope persistence ───────────────────────── */

// Same key name as the web store on purpose — one name for one concept —
// but this one lives in a phone's AsyncStorage, that one in a browser's
// localStorage; they can never collide.
export const MAIL_SCOPE_PREFIX = 'un1t.mail.scope.'

/** The scope value meaning "every readable studio at once". */
export const ALL_SCOPE = 'all'

/**
 * `<prefix><userId>`, or null. 🔴 FAIL CLOSED with no user id — an unscoped
 * scope is a scope another signed-in user would hydrate (the mail-drafts
 * rule, restated: losing persistence in a broken-session edge case is the
 * cheaper failure).
 */
export function mailScopeKey(userId) {
  if (!userId) return null
  return `${MAIL_SCOPE_PREFIX}${userId}`
}

/**
 * The persisted scope string ('all' or a location id), or null. No entry,
 * no user id and broken storage all collapse to null — none is a distinction
 * the screen can act on, and resolveScope() validates the value anyway.
 */
export async function readMailScope(userId) {
  try {
    const key = mailScopeKey(userId)
    if (!key) return null
    return await AsyncStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Persist a chosen scope. Best-effort — a scope that could not be saved
 * survives only as long as the screen, never worth an error over. Refuses
 * junk: only ALL_SCOPE or a non-empty location-id string is a scope.
 */
export async function writeMailScope(userId, scope) {
  const key = mailScopeKey(userId)
  if (!key) return false
  if (typeof scope !== 'string' || !scope) return false
  try {
    await AsyncStorage.setItem(key, scope)
    return true
  } catch {
    return false
  }
}

/**
 * The scope to actually render, given what was persisted and what the digest
 * answered. All is the default; a persisted location that left the digest
 * (permission revoked, mailbox removed) falls back to All rather than to an
 * empty view claiming a studio has no mail.
 *
 * Callers only reach this once the digest answered 2+ locations — a single
 * location renders today's UI and never consults a scope at all.
 */
export function resolveScope(persisted, locations) {
  if (persisted === ALL_SCOPE) return ALL_SCOPE
  if (persisted && (locations || []).some(l => l?.location_id === persisted)) return persisted
  return ALL_SCOPE
}

/* ───────────────────────────── tiles ───────────────────────────────── */

/** Tiles exist only when there are two or more readable studios. */
export function showLocationTiles(locations) {
  return (locations || []).length >= 2
}

/**
 * The tile row: All first (carrying the summed needs-reply total the caller
 * resolved via resolveNeedsReplyTotal — last-good, never a confident 0),
 * then one tile per digest location in the digest's own name order.
 *
 * The count is ALWAYS needs-reply whatever view is active (the tile answers
 * "where is work", not "what am I looking at"). segCountLabel gives null at
 * zero and for null — which is exactly the contract: a zero is quiet, an
 * unavailable location makes no claim, and neither ever renders as "0".
 */
export function locationTiles(locations, needsReplyTotal) {
  return [
    { id: ALL_SCOPE, label: 'All', count: segCountLabel(needsReplyTotal) },
    ...(locations || []).map(l => ({
      id: l.location_id,
      label: l.name || 'Studio',
      count: l.unavailable ? null : segCountLabel(l.needs_reply_count),
    })),
  ]
}

/**
 * The needs-reply chip's classes, split cls/text for RN's non-inheriting
 * Text. On a light tile it is the contract's chip recipe verbatim; on the
 * selected ink tile the /10 wash would be invisible over black, so the chip
 * goes solid light amber (the approved mockup's own selected-tile chip) —
 * text stays on the -700 ramp either way, per the chip lint.
 */
export function tileChipStyle(selected) {
  return selected
    ? { cls: 'bg-amber-50', text: 'text-amber-700' }
    : { cls: 'bg-amber-500/10', text: 'text-amber-700' }
}

/**
 * The summed badge number under the last-good rule: a real number (zero
 * included) wins; a null total (the digest was partial) keeps the last good
 * number; with no good number ever, null — the caller renders nothing, and
 * NEVER 0, for "unknown".
 */
export function resolveNeedsReplyTotal(incoming, lastGood) {
  if (typeof incoming === 'number' && Number.isFinite(incoming)) return incoming
  return typeof lastGood === 'number' && Number.isFinite(lastGood) ? lastGood : null
}

/* ──────────────────────────── sections ─────────────────────────────── */

/** The quiet line inside a section whose view is genuinely empty. */
export const SECTION_EMPTY_TEXT = 'Nothing here'

/** The inline error state for a location that answered unavailable. */
export function sectionUnavailableCopy(name) {
  return {
    text: `${name || 'This studio'} couldn’t be reached`,
    retry: 'Retry',
  }
}

/**
 * The digest's locations → SectionList sections. One section per location,
 * in the digest's own (name-sorted) order:
 *
 *   state 'error' — the location answered unavailable; the screen renders
 *                   sectionUnavailableCopy + a retry that refetches the
 *                   whole digest. No rows, no View-all, no header count.
 *   state 'empty' — the current view is genuinely empty here (view_total 0);
 *                   header + SECTION_EMPTY_TEXT, never hidden.
 *   state 'rows'  — the digest's ≤5 rows, shaped through the SAME
 *                   ticketToInboxRow as list rows (so a digest row and a
 *                   list row can never disagree about one conversation),
 *                   each stamped with its location_id — the seam the swipe
 *                   verbs thread into archive/seen. mailbox_label stays null:
 *                   in All mode the section header is the provenance, and
 *                   rows never grow a pill (locked design).
 *
 * viewAllLabel exists only when the cap hid something (view_total > rows on
 * screen) — a studio whose five-or-fewer are all showing gets no row that
 * goes nowhere. headerDetail states the needs-reply count in words, only
 * when it is a number above zero.
 */
export function buildDigestSections(locations) {
  return (locations || []).map(l => {
    if (l?.unavailable) {
      return {
        key: l.location_id,
        location_id: l.location_id,
        name: l.name || null,
        state: 'error',
        headerDetail: null,
        data: [],
        viewAllLabel: null,
      }
    }
    const data = (l?.conversations || []).map(t => ({
      ...ticketToInboxRow(t, { showMailbox: false }),
      location_id: l.location_id,
    }))
    const total = Number(l?.view_total)
    const needs = Number(l?.needs_reply_count)
    return {
      key: l.location_id,
      location_id: l.location_id,
      name: l.name || null,
      state: data.length === 0 ? 'empty' : 'rows',
      headerDetail: Number.isFinite(needs) && needs > 0
        ? `${needs} ${needs === 1 ? 'needs' : 'need'} reply`
        : null,
      data,
      viewAllLabel: Number.isFinite(total) && total > data.length
        ? `View all ${total} in ${l.name || 'this studio'} →`
        : null,
    }
  })
}

/* ─────────────── optimistic archive/undo over the digest ───────────── */

/**
 * Take one conversation out of whichever section holds it — the optimistic
 * half of an All-mode archive. Pure: answers a NEW locations array plus
 * where the row was ({ locationId, index, conversation }) so UNDO can put
 * the RAW conversation back exactly there; removed is null for an id the
 * digest does not hold (nothing was changed).
 *
 * view_total is decremented (floored at zero) so the section's View-all row
 * and its empty-state switch stay honest while the row is gone; the
 * needs-reply counts are deliberately NOT re-derived here — the tile numbers
 * settle on the next digest fetch, which the screen fires once the write
 * lands (re-deriving the needs-reply predicate client-side is exactly what
 * the server's stamps exist to prevent).
 */
export function removeConversation(locations, rowId) {
  const list = locations || []
  let removed = null
  const next = list.map(l => {
    const conversations = l?.conversations || []
    const index = conversations.findIndex(c => c?.id === rowId)
    if (index === -1) return l
    removed = { locationId: l.location_id, index, conversation: conversations[index] }
    return {
      ...l,
      conversations: [...conversations.slice(0, index), ...conversations.slice(index + 1)],
      view_total: Math.max(0, Number(l.view_total) - 1),
    }
  })
  return removed ? { locations: next, removed } : { locations: list, removed: null }
}

/**
 * Put an undone conversation back where it was (the section-shaped twin of
 * email-tickets' insertRowAt, same rules): the index is clamped, a negative
 * one appends, and a row the section already holds again is left alone —
 * a duplicate key would turn an undo into a crash. view_total goes back up
 * only when the row actually re-enters. Pure; a location no longer in the
 * digest is a no-op (there is no section to put the row into).
 */
export function insertConversation(locations, locationId, conversation, index) {
  return (locations || []).map(l => {
    if (l?.location_id !== locationId || !conversation) return l
    const conversations = l.conversations || []
    if (conversations.some(c => c?.id === conversation.id)) return l
    const i = index < 0 ? conversations.length : Math.min(index, conversations.length)
    return {
      ...l,
      conversations: [...conversations.slice(0, i), conversation, ...conversations.slice(i)],
      view_total: Number(l.view_total) + 1,
    }
  })
}

/**
 * Patch one conversation in place (the read-toggle's optimistic flip) —
 * exactly the row named, purely, everything else by reference.
 */
export function patchConversation(locations, rowId, patch) {
  return (locations || []).map(l => {
    const conversations = l?.conversations || []
    if (!conversations.some(c => c?.id === rowId)) return l
    return {
      ...l,
      conversations: conversations.map(c => (c?.id === rowId ? { ...c, ...patch } : c)),
    }
  })
}

/* ─────────────────────────── honest states ─────────────────────────── */

/**
 * The C2 rule, summed across the estate: neither count flag may render as
 * "all read". Any section whose per-message scan FAILED outranks any that
 * merely truncated — same copy as the scoped screen, so the notice reads
 * identically wherever the fact appears.
 */
export function digestCountsNotice(locations) {
  const list = locations || []
  if (list.some(l => l?.counts_unavailable)) {
    return 'Couldn’t check read state — unread marks may be missing.'
  }
  if (list.some(l => l?.counts_partial)) {
    return 'Read state is incomplete on this page.'
  }
  return null
}

/**
 * Which of All mode's two body states renders — the audit-S1 rule at digest
 * scale. A failed refresh of the SAME view keeps the sections standing under
 * a banner ("never a confident zero"); but once the operator has switched
 * view, the sections on screen answer the OLD view and would stand
 * mislabeled under the new seg — a failed load for a DIFFERENT view renders
 * the error state instead of a quiet lie.
 */
export function allModeListState({ error, loadedView, view }) {
  if (error && loadedView !== view) return 'error'
  return 'sections'
}

/* ─────────────── scope params (search + compose hand-off) ──────────── */

/**
 * The route params the Mail tab pushes to /email/search and /email/compose:
 * the current scope plus the digest's readable studios as JSON (expo-router
 * params are strings). The receiving screens parse them back with the two
 * functions below and fall back to today's single-location behaviour when
 * anything is missing or malformed — a deep link with no params must read
 * as today's screen, not a crash.
 */
export function buildScopeParams(scope, locations) {
  return {
    scope: scope || ALL_SCOPE,
    locs: JSON.stringify((locations || []).map(l => ({ id: l.location_id, name: l.name }))),
  }
}

/**
 * [{ id, name }] out of the locs param, or null. Malformed entries are
 * dropped rather than fanned out to — a search against garbage ids would
 * paint per-studio error sections for studios that do not exist.
 */
export function parseLocationsParam(raw) {
  if (typeof raw !== 'string' || !raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.id !== 'string' || !entry.id) continue
    out.push({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : '' })
  }
  return out.length ? out : null
}

/**
 * The search screen's scope: { mode: 'all', locations } to fan out, or
 * { mode: 'scoped', locationId } to behave exactly as today. An All scope
 * with no parseable targets degrades to scoped-at-the-fallback (usually the
 * active location) — a fan-out with nowhere to fan is today's search.
 */
export function parseScopeParams(params, fallbackLocationId) {
  const scope = typeof params?.scope === 'string' ? params.scope : null
  if (scope === ALL_SCOPE) {
    const locations = parseLocationsParam(params?.locs)
    if (locations) return { mode: 'all', locations }
    return { mode: 'scoped', locationId: fallbackLocationId || null }
  }
  if (scope) return { mode: 'scoped', locationId: scope }
  return { mode: 'scoped', locationId: fallbackLocationId || null }
}
