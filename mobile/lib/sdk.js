import Constants from 'expo-constants'
import { createSdk } from '../../shared/sdk'
import { authHeaders } from './api'

// Mobile binding: Bearer-JWT transport. authHeaders() attaches the
// Supabase access token, x-active-location, and (critically) the
// x-impersonate-target header for "View as user" — so the SDK can
// never drop impersonation the way a hand-rolled fetch could. Base
// URL comes from expo config (EXPO_PUBLIC_API_BASE_URL).
const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl || ''

export const sdk = createSdk({
  baseUrl: API_BASE,
  getAuthHeaders: ({ json, locationId }) => authHeaders({ json, locationId }),
})
