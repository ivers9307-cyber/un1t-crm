// VISREFRESH.1 — pure helpers for the contacts list's presentation.
//
// contactsListState() names the ONE state the list area is in, so a failed
// read, a filter with no matches and a studio with no contacts are never
// drawn the same way. Before this the page discarded the initial read's
// error and the view rendered "No contacts found." for all three.

/**
 * @param {{ error?: string|null, loading?: boolean, rowCount: number, filtersActive: boolean }} args
 *   error         — a read failure (the server's initial read, or the search route)
 *   loading       — a fresh (non-append) fetch is in flight
 *   rowCount      — rows currently visible after client-side narrowing
 *   filtersActive — any search text, stage chip, advanced filter row or the duplicates toggle
 * @returns {'error'|'loading'|'no-matches'|'empty'|'rows'}
 */
export function contactsListState({ error = null, loading = false, rowCount = 0, filtersActive = false } = {}) {
  // A failed read with nothing to show is an error, never an empty list. With
  // rows already on screen (a failed "Load more") the rows stay and the
  // caller shows the error beside them.
  if (error && rowCount === 0) return 'error'
  if (loading && rowCount === 0) return 'loading'
  if (rowCount === 0) return filtersActive ? 'no-matches' : 'empty'
  return 'rows'
}

/** Stage chip label: 'new_lead' → 'New lead'; '' → 'All'. */
export function stageChipLabel(slug) {
  if (!slug) return 'All'
  const words = String(slug).split('_').join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
