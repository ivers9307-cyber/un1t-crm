// Mobile-side contracts API. Mirrors mobile/lib/invoices-api.js —
// thin wrappers around the same /api/contracts routes the web
// /account/contracts pages use. Auth via Bearer JWT (api()
// would also handle it but we only need the simple shape).
//
// All four endpoints share visibility via RLS:
//   - the recipient sees their own (this is what we use here)
//   - master sees all, owner sees their org
// The mobile app today only ever calls these as the recipient.

import Constants from 'expo-constants'
import { supabase } from './supabase'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  return headers
}

/** GET /api/contracts — recipient's own (RLS-filtered). */
export async function listContracts() {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/contracts`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/** GET /api/contracts/[id] — fetch one contract. Server-side
 *  auto-flips status issued -> viewed if this is the recipient's
 *  first open. */
export async function getContract(id) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/contracts/${id}`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/** POST /api/contracts/[id]/sign — typed-name signature. The
 *  server captures IP / UA / timestamp. */
export async function signContract(id, signatureValue) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/contracts/${id}/sign`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      signature_value: signatureValue,
      signature_method: 'typed',
    }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/** POST /api/contracts/[id]/decline — decline with reason. */
export async function declineContract(id, reason) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/contracts/${id}/decline`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ declined_reason: reason }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

/** GET /api/account/pending-contracts — count + minimal metadata
 *  for the badge / banner. Re-uses the same endpoint the web
 *  PendingContractsAlert hits. */
export async function listPendingContracts() {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/account/pending-contracts`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}
