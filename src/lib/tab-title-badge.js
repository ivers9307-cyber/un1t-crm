// TABTITLE.1 — the "(n) " unread prefix the Sidebar puts on the browser tab.
//
// Pulled out of Sidebar.jsx so the string rules are testable without a DOM.
// The prefix is ours; everything after it belongs to Next, which re-writes
// <title> from route metadata on every navigation and on router.refresh()
// (a studio switch). So the title is never CAPTURED and replayed, which would
// freeze a stale studio name: it is always re-derived from whatever the
// document says right now.
//
// The badge is matched with OR WITHOUT trailing whitespace. document.title's
// getter trims, so a badge written in front of an EMPTY title ("(3) ") reads
// back as "(3)"; a rule that insisted on the space missed it and the next
// pass stacked a second badge: "(3) (3)".
//
// KNOWN LIMIT, left alone on purpose: a page whose real title starts with a
// bare "(12) " (or is exactly "(12)") is indistinguishable from our badge and
// loses it. No staff page is titled that way.

const BADGE_PREFIX = /^\(\d+\+?\)(?:\s+|$)/

/** The title with any leading "(n)" / "(99+)" badge removed, trimmed. */
export function stripTitleBadge(title) {
  return String(title ?? '').trim().replace(BADGE_PREFIX, '')
}

/** The title carrying the badge for `count`, or bare when count is 0. */
export function withTitleBadge(title, count) {
  const bare = stripTitleBadge(title)
  const n = Number(count) || 0
  if (n <= 0) return bare
  const badge = `(${n > 99 ? '99+' : n})`
  // No trailing space on an empty base: the getter would trim it and the
  // Sidebar's "is it already right?" comparison would never settle.
  return bare ? `${badge} ${bare}` : badge
}
