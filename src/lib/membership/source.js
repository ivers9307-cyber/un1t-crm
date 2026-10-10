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
// source is added to MEMBERSHIP_SOURCES (a frozen literal) when it lands: no
// schema change (the mig 717 CHECK already admits the value). Until then a
// row that says 'un1t' resolves to the `none` PROVIDER with a structured
// warning, while membershipSourceState keeps the row's identity
// ({ source: 'un1t', state: 'unconfigured', missing: ['provider'] }).
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
  if (!key || key === 'none') return { source: 'none', state: 'none' }
  const provider = providerFor(key)
  // A value the CHECK admits but no module serves yet: the row keeps its
  // identity (a UI says "un1t: not available yet"), never "no source".
  if (provider.key !== key) return { source: key, state: 'unconfigured', missing: ['provider'] }
  const r = await provider.isConfigured(db, locationId)
  if (r.readError) return { source: provider.key, state: 'unknown', readError: r.readError }
  if (!r.configured) return { source: provider.key, state: 'unconfigured', missing: r.missing || [] }
  return { source: provider.key, state: 'configured' }
}

/**
 * Every location whose membership_source is `key`, as ids in id order. THE
 * one sanctioned reader of the column outside this module: crons and Mia
 * discover their locations here (W1.M3b), never by querying the column or
 * sniffing settings->'glofox'. Paginated under the 1k cap. A failed read is
 * `{ ids: null, error }` — never an empty list.
 *
 * @param {object} db   service-role client
 * @param {string} key  a value the mig 717 CHECK admits (MEMBERSHIP_SOURCE_KEYS)
 * @returns {Promise<{ ids: string[]|null, error: any }>}
 */
export async function listLocationsByMembershipSource(db, key, { pageSize = 500 } = {}) {
  if (!MEMBERSHIP_SOURCE_KEYS.includes(key)) throw new TypeError(`listLocationsByMembershipSource: unknown membership source '${key}'`)
  const ids = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from('locations')
      .select('id')
      .eq('membership_source', key)
      .order('id')
      .range(from, from + pageSize - 1)
    if (error) {
      logError('membership-source', 'locations by membership_source unreadable', { key, from, err: error })
      return { ids: null, error }
    }
    for (const row of data || []) ids.push(row.id)
    if (!data || data.length < pageSize) break
  }
  return { ids, error: null }
}
