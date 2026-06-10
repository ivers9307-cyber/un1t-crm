// `staff` domain — the staff directory (read) + write actions. list() +
// get(id) hit the neutral /api/staff routes (resolved by getCurrentUser →
// cookie on web, Bearer on mobile), backed by src/lib/staff.js.
export function staffDomain(request) {
  return {
    list: () => request('/api/staff', { method: 'GET' }),
    get: (id) => request(`/api/staff/${id}`, { method: 'GET' }),
    // Create — C3 wizard. POSTs a new staff member; the route invites
    // them by email (Supabase magic link → /reset-password) and creates
    // their initial assignment(s). The route enforces owner-at-location /
    // master and validates every assignment's role against the caller.
    create: (payload) => request('/api/staff', { method: 'POST', body: payload }),
    // Write — C2a. update() only ever carries safe profile fields
    // (full_name, employment_type) from the mobile editor; it never
    // sends `assignments`, so the PUT's UniFi/door/assignment branch
    // (route.js:269) is not reached. The route enforces owner/master.
    update: (id, patch) => request(`/api/staff/${id}`, { method: 'PUT', body: patch }),
    sendPasswordReset: (id) => request(`/api/staff/${id}/send-password-reset`, { method: 'POST' }),
  }
}
