// `me` domain — the signed-in user's profile + locations + permissions.
// First SDK domain; the contract proof that the rails work end-to-end.
// `/api/mobile/me` is resolved by getCurrentUser(), which honours both
// the web cookie session and the mobile Bearer JWT, so one method
// serves both platforms.
export function meDomain(request) {
  return {
    get: () => request('/api/mobile/me', { method: 'GET' }),
  }
}
