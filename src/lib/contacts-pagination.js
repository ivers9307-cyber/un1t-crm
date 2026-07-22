// Contacts list pagination (FEAT-CONTACTS-PAGE.1 — lift the 200-row cap).
//
// The contacts list previously showed only the newest 200 rows with no way to
// reach the rest. The /api/contacts/search route already supports offset +
// exact count and orders created_at DESC identically to the server-rendered
// page.js first page, so paging past row 200 stitches cleanly.

// The server-rendered default view (src/app/contacts/page.js) caps at this many
// rows; keep in lock-step with the .limit() there.
export const CONTACTS_INITIAL_CAP = 200

// Page size for incremental "Load more" fetches via the search route.
export const CONTACTS_PAGE_SIZE = 100

/**
 * Whether a "Load more" affordance should be shown.
 * @param {{ loadedLength: number, count: number|null|undefined }} args
 *   loadedLength — rows currently loaded (server initial list, or accumulated pages).
 *   count        — exact total matched, known once a page has been fetched; null on
 *                  the pristine server-rendered view.
 */
export function hasMoreContacts({ loadedLength, count }) {
  // Once a page has been fetched we know the real total.
  if (count != null) return loadedLength < count
  // Pristine default view: total unknown, so only offer more when the initial
  // list hit its cap (fewer than the cap means we already have everything).
  return loadedLength >= CONTACTS_INITIAL_CAP
}
