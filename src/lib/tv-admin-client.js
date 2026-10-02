// MEMBERWRITESWEEP.1f — the browser side of the TV admin's session routes
// (/api/admin/tv-displays*, /api/admin/tv-templates*). TVAdmin.jsx and
// TemplateEditor.jsx call these instead of reading and writing tv_displays,
// tv_content and tv_templates through the browser Supabase client (mig 685,
// PR 1g, closes the three tables to every client session).
//
// Never throws, and never trusts the body to be JSON: a Vercel 413/502 is
// plain text, and a bare res.json() turns it into "Unexpected token …".
// Resolves to { ok, status, data, error }; `error` is text an operator can read.

const enc = encodeURIComponent

export const tvAdminPaths = {
  displays: (locationId) => `/api/admin/tv-displays?location_id=${enc(locationId)}`,
  register: () => '/api/admin/tv-displays',
  display: (id) => `/api/admin/tv-displays/${enc(id)}`,
  content: (id) => `/api/admin/tv-displays/${enc(id)}/content`,
  templates: (locationId) => `/api/admin/tv-templates?location_id=${enc(locationId)}`,
  createTemplate: () => '/api/admin/tv-templates',
  template: (id) => `/api/admin/tv-templates/${enc(id)}`,
}

function describeIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return ''
  const first = issues[0] || {}
  const where = Array.isArray(first.path) ? first.path.join('.') : (first.path || '')
  return [where, first.message].filter(Boolean).join(': ')
}

export async function tvRequest(path, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  } catch {
    return { ok: false, status: 0, data: null, error: 'Could not reach the server. Check your connection and try again.' }
  }
  let json = null
  try { json = await res.json() } catch { json = null }
  if (res.ok && json && json.success !== false) {
    return { ok: true, status: res.status, data: json.data ?? null, error: null }
  }
  const detail = describeIssues(json?.issues)
  const error = json?.error
    ? (detail ? `${json.error} (${detail})` : json.error)
    : `Request failed (${res.status})`
  return { ok: false, status: res.status, data: null, error }
}

/**
 * A delete answered: done, or the row was already gone (a 404 from a route
 * whose row the caller's own list showed). Either way it is gone.
 */
export const deletedOrGone = (r) => r.ok || r.status === 404

/**
 * The list route answers `content` per TV; the page's server load (an embed)
 * and TVCard read `tv_content`. Keep both names so the card reads either.
 */
export function withTvContent(rows) {
  return (rows || []).map((d) => ({ ...d, tv_content: d.content ?? null }))
}
