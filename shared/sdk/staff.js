// `staff` domain — the staff directory (read). list() + get(id) hit the
// neutral /api/staff routes (resolved by getCurrentUser → cookie on web,
// Bearer on mobile), backed by src/lib/staff.js. Create/update land in
// C2; this is the read slice.
export function staffDomain(request) {
  return {
    list: () => request('/api/staff', { method: 'GET' }),
    get: (id) => request(`/api/staff/${id}`, { method: 'GET' }),
  }
}
