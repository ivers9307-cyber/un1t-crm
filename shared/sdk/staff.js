// `staff` domain — the staff directory (read). list() + get(id) hit the
// neutral /api/staff routes (resolved by getCurrentUser → cookie on web,
// Bearer on mobile), backed by src/lib/staff.js. Create/update land in
// C2; this is the read slice.
export function staffDomain(request) {
  return {
    list: () => request('/api/staff', { method: 'GET' }),
    get: (id) => request(`/api/staff/${id}`, { method: 'GET' }),
    // Write — C2a. update() only ever carries safe profile fields
    // (full_name, employment_type) from the mobile editor; it never
    // sends `assignments`, so the PUT's UniFi/door/assignment branch
    // (route.js:269) is not reached. The route enforces owner/master.
    update: (id, patch) => request(`/api/staff/${id}`, { method: 'PUT', body: patch }),
    sendPasswordReset: (id) => request(`/api/staff/${id}/send-password-reset`, { method: 'POST' }),
  }
}
