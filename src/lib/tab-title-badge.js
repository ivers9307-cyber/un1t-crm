// TABTITLE.1 — the "(n) " unread prefix the Sidebar puts on the browser tab.
//
// Pulled out of Sidebar.jsx so the two string rules are testable without a
// DOM. The prefix is ours; everything after it belongs to Next, which
// re-writes <title> from route metadata on every navigation and on
// router.refresh() (a studio switch). So the title is never CAPTURED and
// replayed, which would freeze a stale studio name: it is always re-derived
// from whatever the document says right now.

const BADGE_PREFIX = /^\(\d+\+?\)\s+/

/** The title with any "(n) " / "(99+) " prefix removed. */
export function stripTitleBadge(title) {
  return String(title ?? '').replace(BADGE_PREFIX, '')
}

/** The title carrying the prefix for `count`, or bare when count is 0. */
export function withTitleBadge(title, count) {
  const bare = stripTitleBadge(title)
  const n = Number(count) || 0
  if (n <= 0) return bare
  return `(${n > 99 ? '99+' : n}) ${bare}`
}
