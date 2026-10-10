// W1.M1 — THE membership-source seam.
//
// locations.membership_source (mig 717: 'none' | 'glofox' | 'un1t') names
// which system is the source of truth for MEMBERSHIPS at a location. This
// module turns that value into a provider, and a provider is a plain object:
//
//   { key, label,
//     capabilities: { memberships, bookings, credits, invoices, schedule },
//     isConfigured(db, locationId) → { configured, missing?, readError? } }
//
// Glofox implements it today (./sources/glofox.js). The home-grown 'un1t'
// source registers itself in MEMBERSHIP_SOURCES when it lands: no schema
// change (the mig 717 CHECK already admits the value), and until then a row
// that says 'un1t' resolves to `none` with a structured warning.
//
// Pages, crons and Mia ask THIS module, never settings.glofox and never
// channel_connections directly (the five disagreeing "is Glofox connected"
// tests this replaces are listed in the SaaS review, theme E).
import { logWarn, logError } from '@/lib/log'
import { noneSource } from './sources/none'
import { glofoxSource } from './sources/glofox'

export const MEMBERSHIP_SOURCES = Object.freeze({ none: noneSource, glofox: glofoxSource })

/** Every value the mig 717 CHECK admits, registered provider or not. */
export const MEMBERSHIP_SOURCE_KEYS = Object.freeze(['none', 'glofox', 'un1t'])

/** A failed read of locations.membership_source. Reported as state 'unknown', never as 'none'. */
export const MEMBERSHIP_SOURCE_UNREADABLE = 'MEMBERSHIP_SOURCE_UNREADABLE'

/** The provider registered under `key`; an unregistered key is `none` (warned, never thrown). */
export function providerFor(key) {
  const p = MEMBERSHIP_SOURCES[key]
  if (!p) {
    logWarn('membership-source', 'no provider registered for source; resolving as none', { key: key ?? null })
    return noneSource
  }
  return p
}

async function readSourceKey(db, locationId) {
  if (!db || !locationId) return { key: null, error: null }
  // `id` is the primary key, so maybeSingle() is structural; null data = no such location.
  const { data, error } = await db.from('locations').select('membership_source').eq('id', locationId).maybeSingle()
  if (error) {
    logError('membership-source', 'locations.membership_source unreadable (this is not "none")', { locationId, err: error })
    return { key: null, error }
  }
  return { key: data?.membership_source ?? null, error: null }
}

/**
 * The provider for a location. A missing row, a null column or a failed read
 * all answer `noneSource` here: callers that must tell "none" from "unknown"
 * use membershipSourceState().
 */
export async function resolveMembershipSource(db, locationId) {
  const { key, error } = await readSourceKey(db, locationId)
  if (error || !key) return noneSource
  return providerFor(key)
}

/**
 * @returns {Promise<{ source: string|null, state: 'none'|'configured'|'unconfigured'|'unknown', missing?: string[], readError?: string }>}
 *   'none'          — the location has no membership source (lead CRM only)
 *   'configured'    — the provider has what it needs to answer
 *   'unconfigured'  — the provider is chosen but a credential is missing (`missing` names them)
 *   'unknown'       — a read failed (`readError`); never collapsed into 'none'
 */
export async function membershipSourceState(db, locationId) {
  const { key, error } = await readSourceKey(db, locationId)
  if (error) return { source: null, state: 'unknown', readError: MEMBERSHIP_SOURCE_UNREADABLE }
  const provider = key ? providerFor(key) : noneSource
  if (provider.key === 'none') return { source: 'none', state: 'none' }
  const r = await provider.isConfigured(db, locationId)
  if (r.readError) return { source: provider.key, state: 'unknown', readError: r.readError }
  if (!r.configured) return { source: provider.key, state: 'unconfigured', missing: r.missing || [] }
  return { source: provider.key, state: 'configured' }
}
