// InBody bridge → location scoping (security audit W2-H / M1).
//
// THE LEAK this closes: a bridge token from location A must only ever see and
// ingest location A's InBody data. The two bridge-facing queues store their
// location differently, so scoping works differently on each:
//
//   inbody_backfill_requests.location_id  — SET AT CREATE by the inbody-sync
//     route from contact.location_id. So it can be scoped/checked directly on
//     location_id.
//
//   inbody_webhook_events.location_id     — NULL until ingest (the webhook
//     receiver never sets it; ingest stamps it from the bridge). So it CANNOT
//     be filtered by location_id in `pending` — that would return nothing.
//     Instead the webhook carries `account` (the Lookin'Body account id, e.g.
//     "stillorganun1t"), which maps to a location via
//     locations.settings.inbody.accounts — the same JSONB-config pattern
//     Glofox uses for branch_id (settings.glofox.branch_id).
//
// Config shape (JSONB on locations.settings, no dedicated column — mirrors
// settings.glofox):
//   { "inbody": { "accounts": ["stillorganun1t", "…"] } }
// Back-compat: a legacy singular { "inbody": { "account": "x" } } is also read.

import { createServerClient } from '@/lib/supabase'

// Normalise an InBody account id for comparison. InBody accounts are ASCII
// alphanumeric; we lower-case + trim so a config-vs-payload casing difference
// doesn't silently drop scans. Non-strings → null.
export function normaliseInbodyAccount(raw) {
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  return s || null
}

// Pull the set of InBody account ids configured for a single location.
// Returns a Set<string> (normalised), possibly empty. Reads both the plural
// `accounts` array and the legacy singular `account`.
export async function inbodyAccountsForLocation(db, locationId) {
  const client = db || createServerClient()
  const out = new Set()
  if (!locationId) return out
  const { data, error } = await client
    .from('locations')
    .select('settings')
    .eq('id', locationId)
    .maybeSingle()
  if (error || !data) return out
  const cfg = data.settings?.inbody || {}
  const list = Array.isArray(cfg.accounts) ? cfg.accounts : []
  for (const a of list) {
    const n = normaliseInbodyAccount(a)
    if (n) out.add(n)
  }
  const single = normaliseInbodyAccount(cfg.account)
  if (single) out.add(single)
  return out
}

// Given the bridge's location, resolve the accounts it owns and return an
// { accounts: Set<string>, hasConfig: boolean } descriptor. `hasConfig` lets a
// caller distinguish "this location owns these accounts" from "this location
// has no InBody accounts configured at all".
export async function bridgeInbodyScope(db, bridge) {
  const accounts = await inbodyAccountsForLocation(db, bridge?.locationId)
  return { accounts, hasConfig: accounts.size > 0 }
}

// Does this webhook-event `account` belong to the bridge's location?
// A null/blank event account can never be claimed (fails safe → false).
export function eventAccountMatchesScope(eventAccount, scope) {
  const n = normaliseInbodyAccount(eventAccount)
  if (!n) return false
  return scope?.accounts?.has(n) === true
}

// ── usertoken / phone-shape validation (audit M1 tail) ─────────────────────
//
// A compromised bridge must not be able to attach scan history to an arbitrary
// member by relaying a bogus usertoken. Contact-matching keys off the phone
// digit tail, so we require the value to be phone-shaped (>=9 digits, not an
// email / uuid / free text) before trusting it. Light touch — this is a shape
// gate, not full E.164 validation (InBody stores local formats like
// 0871234567).
const PHONE_SHAPE = /^[+()\-\s.\d]{9,20}$/

export function isPhoneShaped(raw) {
  if (typeof raw !== 'string') return false
  const s = raw.trim()
  if (!PHONE_SHAPE.test(s)) return false
  const digits = s.replace(/\D/g, '')
  return digits.length >= 9 && digits.length <= 15
}
