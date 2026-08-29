// MAIL-ALLLOC.1 — the pure half of multi-location Mail: scope persistence,
// tile building, digest sections, the last-good total and the search fan-out
// merge.
//
// Everything here is pure (no fetch, no DOM, localStorage behind the same
// guarded-access posture as mail-display.js's density store), so the decisions
// the tiles and the All-mode list make — which studio a reload lands on, what
// an unreachable studio looks like, whether a badge may ever say 0 when it
// means "unknown" — are unit-testable without rendering anything.
//
// WHY A SECOND FILE BESIDE mail-display.js. mail-display.js is the ONE
// surface's vocabulary; this file exists only for callers who can read two or
// more studios, and a single-location caller must be able to keep rendering
// today's UI without any of these decisions ever running. Keeping them apart
// keeps that promise auditable.

import { mailboxLabel } from '@/lib/ticket-display'

/* ── scope ───────────────────────────────────────────────────────────── */

/** The one non-location scope. Everything else a scope can hold is a location id. */
export const MAIL_SCOPE_ALL = 'all'

export const MAIL_SCOPE_KEY_PREFIX = 'un1t.mail.scope.'

// The house id shape — the same expression MailSurface validates `?c=` with
// (and the route helpers' UUID_SHAPE). `?loc=` and the persisted scope are
// operator-editable strings, not server data, so anything that is not this
// shape has no honest interpretation as a location and is ignored outright.
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Is this string the house id shape? (The `?loc=` deep-link validator.) */
export function isUuidShaped(value) {
  return typeof value === 'string' && UUID_SHAPE.test(value)
}

/**
 * The storage key, per user — or null without one.
 *
 * 🔴 FAIL CLOSED, same reasoning as the reply-draft store: an unscoped
 * preference is one another signed-in user on a shared front-desk machine
 * would inherit. Losing persistence in a broken-session edge case is the
 * cheaper failure.
 */
export function mailScopeKey(userId) {
  if (!userId) return null
  return `${MAIL_SCOPE_KEY_PREFIX}${userId}`
}

/**
 * The stored scope, or All.
 *
 * 🔴 EVERY ACCESS IS WRAPPED — localStorage THROWS in a private window and
 * under a "block site data" policy (see readDensity), and a display
 * preference must never take the surface down. Anything unreadable or
 * unrecognisable collapses to All, which is also the multi-location default.
 */
export function readMailScope(userId) {
  try {
    if (typeof window === 'undefined') return MAIL_SCOPE_ALL
    const key = mailScopeKey(userId)
    if (!key) return MAIL_SCOPE_ALL
    const stored = window.localStorage.getItem(key)
    if (stored === MAIL_SCOPE_ALL || isUuidShaped(stored)) return stored
    return MAIL_SCOPE_ALL
  } catch {
    return MAIL_SCOPE_ALL
  }
}

/** Persist a scope. Silently ignores anything that is not All or an id. */
export function writeMailScope(userId, scope) {
  if (scope !== MAIL_SCOPE_ALL && !isUuidShaped(scope)) return
  try {
    if (typeof window === 'undefined') return
    const key = mailScopeKey(userId)
    if (!key) return
    window.localStorage.setItem(key, scope)
  } catch {
    // A preference that could not be saved resets next visit. Never worth an
    // error on screen.
  }
}

/**
 * A scope the surface can actually honour.
 *
 * A persisted (or deep-linked) scope naming a location that is no longer in
 * the caller's readable set falls back to All — the contract's rule, because
 * the alternative is a screen scoped to a studio that shows nothing and says
 * nothing about why.
 */
export function resolveMailScope(scope, knownLocationIds) {
  if (scope === MAIL_SCOPE_ALL) return MAIL_SCOPE_ALL
  const known = Array.isArray(knownLocationIds) ? knownLocationIds : []
  return known.includes(scope) ? scope : MAIL_SCOPE_ALL
}

/* ── sections ────────────────────────────────────────────────────────── */

/**
 * The digest payload, as sections the list can render.
 *
 * One entry per digest location, in the server's own (name-sorted) order:
 * `{ locationId, name, unavailable, needsReplyCount, viewTotal,
 *    conversations, hasMore, countsPartial }`.
 *
 * 🔴 NOTHING IS DROPPED. An unavailable location keeps its section (the
 * error state renders in its place), and an empty one keeps its header + a
 * quiet empty — hiding either reads as "that studio has no mail" to the
 * exact person responsible for it.
 */
export function buildDigestSections(data) {
  const locations = Array.isArray(data?.locations) ? data.locations : []
  return locations.map(l => {
    const conversations = Array.isArray(l.conversations) ? l.conversations : []
    const viewTotal = typeof l.view_total === 'number' ? l.view_total : null
    return {
      locationId: l.location_id,
      name: l.name || null,
      unavailable: !!l.unavailable,
      needsReplyCount: typeof l.needs_reply_count === 'number' ? l.needs_reply_count : null,
      viewTotal,
      conversations,
      // "View all N" appears only past the cap — a section already showing
      // everything gets no row (and an unknown total can never claim one).
      hasMore: !l.unavailable && viewTotal !== null && viewTotal > conversations.length,
      countsPartial: !!l.counts_partial || !!l.counts_unavailable,
      searchPartial: !!l.searchPartial,
    }
  })
}

/**
 * The one flat, ordered row list behind the grouped render — what j/k walks
 * and what the archive successor is computed against. Section order IS list
 * order, so the keyboard walks the screen top to bottom, across headers.
 */
export function flattenSectionRows(sections) {
  if (!Array.isArray(sections)) return []
  return sections.flatMap(s => (Array.isArray(s?.conversations) ? s.conversations : []))
}

/* ── the last-good total ─────────────────────────────────────────────── */

/**
 * The badge/back-count number.
 *
 * 🔴 `needs_reply_total: null` means "a studio could not be counted", and an
 * unknown must never render as a confident smaller number — keep the LAST
 * GOOD total on screen. Null only when nothing was ever known (first load
 * failing partial), which the caller renders as no number at all, never 0.
 */
export function resolveNeedsReplyTotal(incoming, lastGood) {
  if (typeof incoming === 'number') return incoming
  return typeof lastGood === 'number' ? lastGood : null
}

/* ── tiles ───────────────────────────────────────────────────────────── */

/**
 * The tile row: All first, then one tile per studio.
 *
 * Before the digest first answers, the tiles come from the page-provided
 * eligible list (that is why page.js passes it — no tile flash while the
 * digest is in flight) with unknown counts. Once the digest answers, the
 * digest's own location set takes over — a permission-eligible studio with
 * no visible mailboxes is absent from the digest and loses its tile, exactly
 * as the contract's "tiles render ONLY when the digest answers 2+" implies.
 *
 * `count` is ALWAYS needs-reply, whatever view is active; null means unknown
 * (pre-digest, or that studio unavailable) and the tile renders NO chip —
 * never 0.
 */
export function buildLocationTiles({ eligible, digestLocations, allCount }) {
  const studios = Array.isArray(digestLocations)
    ? digestLocations.map(l => ({
        id: l.location_id,
        name: l.name || null,
        count: !l.unavailable && typeof l.needs_reply_count === 'number' ? l.needs_reply_count : null,
      }))
    : (Array.isArray(eligible) ? eligible : []).map(l => ({ id: l.id, name: l.name || null, count: null }))
  return [
    {
      id: MAIL_SCOPE_ALL,
      name: 'All locations',
      count: typeof allCount === 'number' ? allCount : null,
    },
    ...studios,
  ]
}

/**
 * A scoped list refresh knows its own studio's fresh needs-reply count; fold
 * it into the last digest answer so the tile stays honest between digest
 * polls. Pure, and a no-op (same reference) whenever there is nothing to
 * update — an unknown count must never overwrite a good one.
 */
export function withLocationNeedsReply(digestLocations, locationId, count) {
  if (!Array.isArray(digestLocations)) return digestLocations
  if (typeof count !== 'number') return digestLocations
  if (!digestLocations.some(l => l.location_id === locationId)) return digestLocations
  return digestLocations.map(l =>
    l.location_id === locationId ? { ...l, needs_reply_count: count } : l
  )
}

/* ── search fan-out ──────────────────────────────────────────────────── */

/**
 * The All-mode search merge: one scoped-list result per studio, grouped
 * under the same section headers as the digest, uncapped.
 *
 * `results` is keyed by location id: `{ ok, conversations, searchPartial }`.
 * 🔴 A studio that failed — or never answered at all — becomes an error
 * section while every other studio still renders; one blipped studio must
 * not take down the whole search. A studio with zero matches keeps an
 * honest empty section: "no matches here" is an answer, absence is not.
 */
export function buildSearchSections(locations, results) {
  const list = Array.isArray(locations) ? locations : []
  return list.map(l => {
    const result = results?.[l.locationId]
    if (!result?.ok) {
      return {
        locationId: l.locationId,
        name: l.name || null,
        unavailable: true,
        needsReplyCount: null,
        viewTotal: null,
        conversations: [],
        hasMore: false,
        countsPartial: false,
        searchPartial: false,
      }
    }
    return {
      locationId: l.locationId,
      name: l.name || null,
      unavailable: false,
      needsReplyCount: null,
      viewTotal: null,
      conversations: Array.isArray(result.conversations) ? result.conversations : [],
      // Search results ARE everything found — there is no View-all to offer.
      hasMore: false,
      countsPartial: false,
      searchPartial: !!result.searchPartial,
    }
  })
}

/* ── compose From grouping ───────────────────────────────────────────── */

/**
 * The compose From options for a multi-studio caller.
 *
 * `perLocation` is `[{ locationId, name, mailboxes }]` in display order. With
 * 2+ studios actually holding mailboxes, each option's label is prefixed with
 * its studio name — TicketCompose renders labels flat (it is not this task's
 * file to change), so the studio name IN the label is what "grouped by
 * studio" means on this surface. With one studio the mailboxes pass through
 * untouched: no prefix noise for a choice that has no cross-studio ambiguity.
 *
 * Sending is unchanged either way — compose already takes mailbox_id, and the
 * mailbox carries its own location.
 */
export function groupMailboxesByStudio(perLocation) {
  const list = Array.isArray(perLocation) ? perLocation : []
  const withBoxes = list.filter(l => Array.isArray(l?.mailboxes) && l.mailboxes.length > 0)
  if (withBoxes.length === 0) return []
  if (withBoxes.length === 1) return withBoxes[0].mailboxes
  return withBoxes.flatMap(l =>
    l.mailboxes.map(m => ({ ...m, label: `${l.name || 'Studio'} · ${mailboxLabel(m)}` }))
  )
}
