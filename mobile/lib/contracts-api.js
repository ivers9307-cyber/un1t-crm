// Mobile-side contracts API. Mirrors mobile/lib/invoices-api.js —
// thin wrappers around the same /api/contracts routes the web
// /account/contracts pages use. Headers (Bearer + the
// x-impersonate-target "View as user" header) are built by the shared
// authHeaders() helper.
//
// The server scopes these per-caller (recipient sees their own; master
// sees all, owner sees their org), so forwarding x-impersonate-target
// matters: without it a master using "View as user" would see EVERY
// contract — salary and all — instead of the target's own.

import Constants from 'expo-constants'
import { authHeaders } from './api'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

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
  const headers = await authHeaders({ json: true })
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
  const headers = await authHeaders({ json: true })
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
