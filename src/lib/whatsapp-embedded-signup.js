// src/lib/whatsapp-embedded-signup.js
//
// WA-TECHPROV.2 — Embedded Signup v4 server-side helpers.
//
// Pure Graph-API wrappers + pure decision functions for the
// exchange route (src/app/api/locations/[id]/whatsapp/embedded-signup).
// Design: docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md §4.2.
// Meta error style mirrors whatsapp-number-health.js (metaCode/metaType).

import { META_API_URL } from './whatsapp-config'

function metaError(json, fallback) {
  const err = new Error(json?.error?.message || fallback)
  err.metaCode = json?.error?.code ?? null
  err.metaType = json?.error?.type || null
  return err
}

/**
 * ES v4 step 1 — exchange the dialog's response code for a
 * long-lived business token (server-side only; needs the app secret).
 */
export async function exchangeCodeForBusinessToken({ code, appId, appSecret }) {
  const url = `${META_API_URL}/oauth/access_token` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&code=${encodeURIComponent(code)}`
  const res = await fetch(url)
  const json = await res.json()
  if (json.error || !json.access_token) throw metaError(json, 'Embedded Signup code exchange failed')
  return json.access_token
}

/**
 * ES v4 step 2 — subscribe our app to the client WABA so its
 * webhooks flow to /api/webhooks/whatsapp.
 */
export async function subscribeAppToWaba({ wabaId, token }) {
  const res = await fetch(`${META_API_URL}/${wabaId}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  const json = await res.json()
  if (json.error || !json.success) throw metaError(json, 'WABA webhook subscription failed')
  return true
}

/** Probe registration state before calling /register (10-per-72h limit). */
export async function probeNumber({ phoneNumberId, token }) {
  const res = await fetch(
    `${META_API_URL}/${phoneNumberId}?fields=status,platform_type,display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const json = await res.json()
  if (json.error) throw metaError(json, 'Phone number probe failed')
  return json
}

/** Registered iff already CONNECTED on Cloud API; anything else registers. */
export function needsRegistration(probe) {
  return !(probe?.platform_type === 'CLOUD_API' && probe?.status === 'CONNECTED')
}

/** 6-digit two-step PIN for /register; persisted in signup_meta. */
export function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

export async function registerNumber({ phoneNumberId, token, pin }) {
  const res = await fetch(`${META_API_URL}/${phoneNumberId}/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  })
  const json = await res.json()
  if (json.error || !json.success) throw metaError(json, 'Phone number registration failed')
  return true
}

/**
 * Insert vs token-refresh vs conflict, keyed on the globally-unique
 * phone_number_id. A number owned by a DIFFERENT location is a
 * conflict surfaced to the operator — never silently reassigned.
 */
export function planPersistence({ existingRow, locationId }) {
  if (!existingRow) return { action: 'insert' }
  if (existingRow.location_id === locationId) return { action: 'update', id: existingRow.id }
  return { action: 'conflict', owningLocationId: existingRow.location_id }
}
