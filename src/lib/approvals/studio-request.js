// APPROVALSQ.6 — the ONE place a request about an approvals item gets its studio.
//
// In the "All my studios" view an item can belong to a studio other than the one
// the person is switched into. `getCurrentUser()` honours `x-active-location` on
// the web (validated against the person's own studios), so a request carrying the
// item's studio is judged exactly as if the person had switched into it. A request
// for another studio's item sent WITHOUT the header would be judged at the wrong
// studio, so every card request goes through withStudio(). A guard test
// (tests/approvals-studio-header-guard.test.js) fails on a fetch that does not.
//
// An item with no `studioId` (the default "This studio" view) gets no header, so
// that view behaves exactly as it always has.

export const STUDIO_HEADER = 'x-active-location'

// `activeStudioId` is accepted for call-site clarity but never changes the answer:
// the header is sent for the active studio too, so the request is explicit.
export function studioHeaders(item, activeStudioId) { // eslint-disable-line no-unused-vars
  const id = item?.studioId
  return typeof id === 'string' && id ? { [STUDIO_HEADER]: id } : {}
}

export function withStudio(item, init = {}) {
  const headers = studioHeaders(item)
  if (!headers[STUDIO_HEADER]) return init
  return { ...init, headers: { ...(init.headers || {}), ...headers } }
}

// What a card shows as its studio chip: null when the item carries no studio name.
export function studioChip(item, activeStudioId) {
  if (!item?.studioId || !item?.studioName) return null
  return { id: item.studioId, name: item.studioName, other: item.studioId !== activeStudioId }
}
