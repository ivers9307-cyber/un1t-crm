// Pure request-header builder shared by api() and every hand-rolled
// /api/* client wrapper (invoices, expenses, contracts, checklists,
// issues, policies). Kept RN-free — no expo-constants / supabase /
// secure-store imports — so it runs under vitest's Node env like the
// rest of the pure mobile/lib helpers.
//
// SECURITY — x-impersonate-target MUST ride on every authenticated
// request when a "View as user" session is active, otherwise the call
// reaches the server as the REAL signed-in user (a master, in the only
// case that can impersonate) and the server serves THEIR view. That is
// exactly how the mobile contractor-invoices View-as leak happened: the
// invoices client hand-rolled its headers and never attached this one,
// so "View as Colm" showed the master's whole-location invoice queue.
// Funnelling every client through this builder makes the header
// impossible to forget.
//
// Mirrors the web cookie path: the server (getCurrentUser) only honours
// the header when the underlying session is a master, so a non-master
// JWT sending it has the value silently ignored.

/**
 * @param {object} [opts]
 * @param {string|null} [opts.token]                Supabase access_token (Bearer)
 * @param {string|null} [opts.impersonateTargetId]  active View-as target UUID
 * @param {string|null} [opts.locationId]           x-active-location override
 * @param {boolean}     [opts.json]                 include Content-Type: application/json
 *                                                  (omit for multipart FormData — RN sets the boundary)
 * @returns {Record<string,string>}
 */
export function buildAuthHeaders({ token, impersonateTargetId, locationId, json = false } = {}) {
  const headers = { Accept: 'application/json' }
  if (json) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  if (locationId) headers['x-active-location'] = locationId
  if (impersonateTargetId) headers['x-impersonate-target'] = impersonateTargetId
  return headers
}
