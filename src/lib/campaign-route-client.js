// MEMBERWRITESWEEP.1e — the browser side of the campaign editor's session
// routes (/api/communications/campaigns*). CampaignEditor and CampaignDetail
// call these instead of writing `campaigns` through the browser Supabase
// client (mig 684 closes the table to every client session).
//
// Never throws, and never trusts the body to be JSON: a Vercel 413/502 is
// plain text, and a bare res.json() turns it into "Unexpected token …".
// Resolves to { ok, status, data, error }; `data` is the route's `data` (on a
// 409 it carries the campaign's current `status`), `error` is text an
// operator can read.

export const campaignPath = (id, action = '') =>
  `/api/communications/campaigns${id ? `/${encodeURIComponent(id)}` : ''}${action ? `/${action}` : ''}`

function describeIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return ''
  const first = issues[0] || {}
  const where = Array.isArray(first.path) ? first.path.join('.') : (first.path || '')
  return [where, first.message].filter(Boolean).join(': ')
}

export async function campaignRequest(path, { method = 'GET', body } = {}) {
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
  return { ok: false, status: res.status, data: json?.data ?? null, error }
}
