import { createSdk } from '@shared/sdk'

// Web binding: same-origin (baseUrl ''), cookie-authenticated. No
// Authorization header — the Supabase SSR auth cookies are sent
// automatically via credentials:'include' in the transport. The
// active location comes from the un1t_active_location cookie the
// server already reads, so no x-active-location header is needed on
// web.
export const sdk = createSdk({
  baseUrl: '',
  getAuthHeaders: ({ json }) => ({
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }),
})
