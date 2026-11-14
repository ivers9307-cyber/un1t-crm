// APPROVALSQ.5 — the one place the web asks the route to undo a quiet clear:
// `PATCH /api/agent/membership-requests/<id>` with exactly `{ undo_clear: true }`.
// Resolves, never throws. `error` is the route's own words; `status` 409 means
// "this clear can no longer be undone" (the window passed, or it was not yours).

export async function undoClearRequest(id) {
  try {
    const res = await fetch(`/api/agent/membership-requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ undo_clear: true }),
    })
    const data = await res.json()
    if (data?.success === true) return { ok: true, request: data.request }
    return { ok: false, status: res.status, error: data?.error || 'Could not undo this clear.' }
  } catch {
    return { ok: false, status: 0, error: 'Network error. Try again.' }
  }
}
