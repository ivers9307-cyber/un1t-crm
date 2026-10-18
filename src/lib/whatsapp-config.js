// WA-MULTI.1 — per-location WhatsApp configuration resolution.
//
// Single entry point for "give me the WhatsApp credentials I should
// use for this location".
//
// WAORGNUMBER.1 (mig 736): a number belongs to the ORGANISATION and is
// switched on per studio by a location_whatsapp_numbers row. A studio's
// numbers are the active whatsapp_numbers rows switched on there, in order:
//
//   1. the link row marked is_default for this studio;
//   2. otherwise the most recently switched-on one (link created_at).
//
//   whatsapp_numbers.location_id is the number's HOME studio only;
//   whatsapp_numbers.is_default is deprecated (the default lives on the link).
//
//   Nothing else. WACONFIGFALLBACK.1 retired the third tier (the global
//   WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID env number): a
//   location with no number switched on now gets a
//   WhatsAppNumberMissingError (./whatsapp-number-missing.js), never
//   another studio's number. Per-location comms model: row absent = may
//   never send. Each caller's decision is tabled in
//   tests/whatsapp-config-callers.test.js.
//
// A config says which studio it is FOR: `locationId` is the studio it was
// resolved for, `homeLocationId` the number's home studio, `organizationId`
// the number's organisation. They differ when a studio sends from a number
// switched on there but homed elsewhere (or, transitionally, through a
// sibling's stamped number, `viaSibling`).
//
// The webhook router (`resolveWhatsAppNumberByPhoneNumberId`)
// goes the other direction — given the phone_number_id Meta sent
// in the inbound payload, find the location that owns it.

import { createServerClient } from './supabase'
import { WhatsAppNumberMissingError } from './whatsapp-number-missing'
import { logWarn } from './log'

const META_API_VERSION = 'v21.0'
export const META_API_URL = `https://graph.facebook.com/${META_API_VERSION}`

/**
 * Map a whatsapp_numbers row to the config shape callers expect.
 *
 * WAORGNUMBER.1 — `locationId` is the studio the config was resolved FOR
 * (`forLocationId`); `homeLocationId` is the number's own studio
 * (whatsapp_numbers.location_id) and `organizationId` its organisation.
 * `viaSibling` is true only for the transitional WAHOMESTUDIO.1 clause
 * (getConversationNumberConfig).
 *
 * @param {object} row  a whatsapp_numbers row
 * @param {string|null} forLocationId
 */
function rowToConfig(row, forLocationId) {
  return {
    source: 'db',
    id: row.id,
    locationId: forLocationId ?? null,
    homeLocationId: row.location_id ?? null,
    organizationId: row.organization_id ?? null,
    viaSibling: false,
    label: row.label,
    token: row.access_token,
    phoneNumberId: row.phone_number_id,
    businessAccountId: row.business_account_id || null,
    appId: row.app_id || null,
    displayPhone: row.display_phone || null,
    sourceKind: row.source,        // 'cloud_api' | 'coexistence'
    // WA-QUALITY.2 — Meta quality rating as of the last webhook/poll
    // (GREEN/YELLOW/RED, null = never fetched). sendBroadcast's preflight
    // gate reads this.
    qualityRating: row.quality_rating ?? null,
    // WA-BUDGET — Meta messaging-limit tier as of the last webhook/poll
    // (TIER_250 … UNLIMITED, null = never fetched). The blast/drip tier-budget
    // gates read this.
    messagingLimitTier: row.messaging_limit_tier ?? null,
    // WA-QUALITY — when quality/tier were last fetched (null = never); the
    // hub's health card tells "Checking…" from "Unavailable" by it.
    qualityCheckedAt: row.quality_checked_at ?? null,
  }
}

// WAORGNUMBER.1 — the numbers switched on at a studio: link rows joined to
// their ACTIVE number, the link default first, then the most recently switched
// on. `extra` narrows the read (a WABA, one number). Returns the query builder.
function switchedOnNumbers(db, locationId, extra = (q) => q) {
  return extra(db.from('location_whatsapp_numbers')
    .select('is_default, created_at, whatsapp_numbers!inner(*)')
    .eq('location_id', locationId)
    .eq('whatsapp_numbers.is_active', true))
    .order('is_default', { ascending: false })   // the studio's default first
    .order('created_at', { ascending: false })   // then the newest switch-on
}

/**
 * WAROLE.1 — the location's OWN number (WAORGNUMBER.1: a number switched on
 * at it). Returns null when nothing active is switched on there (or no
 * location id is given); throws when the lookup itself fails, so a DB blip is
 * never read as "no number". Routes that act AT META for a location use it
 * through ownNumberOrRefusal (./whatsapp-own-number.js) to answer 409 / 500
 * before any Meta call.
 *
 * @param {string | null | undefined} locationId
 * @returns {Promise<object | null>}  config with locationId = this location
 */
export async function getLocationWhatsAppNumberConfig(locationId) {
  if (!locationId) return null
  const db = createServerClient()
  const { data: rows, error } = await switchedOnNumbers(db, locationId).limit(1)

  if (error) {
    throw new Error(`Failed to load WhatsApp config for location ${locationId}: ${error.message}`)
  }
  return rows && rows.length > 0 ? rowToConfig(rows[0].whatsapp_numbers, locationId) : null
}

/**
 * WAORGNUMBER.1 (R2, R5) — the number switched on at `locationId` that lives
 * on WhatsApp Business Account `wabaId` (a template can only be sent from a
 * number on its own WABA): default first, then the newest switch-on; null when
 * none. A null `wabaId` is "any WABA" (getLocationWhatsAppNumberConfig).
 * Throws on a failed read.
 *
 * @param {string | null | undefined} locationId
 * @param {string | null | undefined} wabaId
 * @returns {Promise<object | null>}
 */
export async function getLocationNumberForWaba(locationId, wabaId) {
  if (!wabaId) return getLocationWhatsAppNumberConfig(locationId)
  if (!locationId) return null
  const db = createServerClient()
  const { data: rows, error } = await switchedOnNumbers(db, locationId, (q) => q.eq('whatsapp_numbers.business_account_id', wabaId)).limit(1)
  if (error) {
    throw new Error(`Failed to load WhatsApp number on account ${wabaId} for location ${locationId}: ${error.message}`)
  }
  return rows && rows.length > 0 ? rowToConfig(rows[0].whatsapp_numbers, locationId) : null
}

/**
 * WAORGNUMBER.1 — every studio a number is switched on at (distinct
 * location_whatsapp_numbers.location_id for any of `numberIds`). Health and
 * account events fan out to these. Throws on a failed read.
 *
 * @param {object} db  supabase client (service role)
 * @param {string[]} numberIds
 * @returns {Promise<string[]>}
 */
export async function studiosUsingNumbers(db, numberIds) {
  const ids = (numberIds || []).filter(Boolean)
  if (ids.length === 0) return []
  const { data, error } = await db.from('location_whatsapp_numbers')
    .select('location_id')
    .in('whatsapp_number_id', ids)
  if (error) throw new Error(`Failed to load the studios using WhatsApp numbers: ${error.message}`)
  return [...new Set((data || []).map((r) => r.location_id).filter(Boolean))]
}

/**
 * WAORGNUMBER.1 — of `locationIds`, the studios with at least one ACTIVE
 * number switched on ("this studio has WhatsApp"). Throws on a failed read.
 *
 * @param {object} db  supabase client (service role)
 * @param {string[]} locationIds
 * @returns {Promise<Set<string>>}
 */
export async function locationsWithWhatsApp(db, locationIds) {
  const ids = (locationIds || []).filter(Boolean)
  if (ids.length === 0) return new Set()
  const { data, error } = await db.from('location_whatsapp_numbers')
    .select('location_id, whatsapp_numbers!inner(id)')
    .in('location_id', ids)
    .eq('whatsapp_numbers.is_active', true)
  if (error) throw new Error(`Failed to load which studios have WhatsApp: ${error.message}`)
  return new Set((data || []).map((r) => r.location_id).filter(Boolean))
}

/**
 * Resolve the WhatsApp config to use for outbound sends from
 * `locationId`: an active number switched on there (link default first).
 *
 * WACONFIGFALLBACK.1 — there is no env tier any more. A location with no
 * active number switched on (WAORGNUMBER.1), or no location at all, throws
 * WhatsAppNumberMissingError (code WA_NO_NUMBER): the caller decides what
 * that means for it (see tests/whatsapp-config-callers.test.js). A failed
 * lookup throws a plain Error, so a DB blip is never read as "no number".
 *
 * @param {string | null | undefined} locationId
 * @returns {Promise<object>}  Config object with .token + .phoneNumberId
 *   at minimum.
 */
export async function getWhatsAppConfig(locationId) {
  const own = await getLocationWhatsAppNumberConfig(locationId)
  if (own) return own
  throw new WhatsAppNumberMissingError(locationId)
}

/**
 * WAREPLYNUMBER.1 (C86) — the number a REPLY into a conversation goes from:
 * the number the customer wrote to. The inbound webhook stamps it on
 * whatsapp_conversations.whatsapp_number_id (mig 696). Used when it is still
 * active and switched on AT this location (WAORGNUMBER.1; or, WAHOMESTUDIO.1,
 * a same-organisation sibling's when this studio has none); otherwise the location default
 * (getWhatsAppConfig, which refuses a number-less studio as ever). A single-
 * number studio resolves the same number either way.
 *
 * A TEMPLATE goes from the thread number only when it shares the default's
 * WABA: templates are synced per location from the default number's account,
 * and Meta only sends a number's own-WABA templates. The one exception
 * (WAHOMESTUDIO.1): a number-less studio's thread replies through a
 * same-organisation sibling's stamped number, and its templates come from that
 * number's owner (templateLocationIdFor), not from a default it does not have.
 *
 * Any failed read here (including the column not existing yet, before 696 is
 * applied) falls back to the default, logged: losing a reply is worse than
 * sending it from the studio's default number, which is what every reply did
 * before this.
 *
 * @param {string|null|undefined} locationId  the conversation's location
 * @param {string|null|undefined} conversationId
 * @param {{ template?: boolean }} [opts]
 */
export async function getConversationReplyConfig(locationId, conversationId, { template = false } = {}) {
  const thread = await getConversationNumberConfig(locationId, conversationId)
  if (!thread) return getWhatsAppConfig(locationId)
  if (!template) return thread
  // WAHOMESTUDIO.1 — a sibling's number only reaches here for a studio with no
  // number of its own, so there is no default to compare WABAs with: the
  // template comes from the number owner's WABA (templateLocationIdFor).
  // WAORGNUMBER.1: `viaSibling` says so; `locationId` is now always this studio.
  if (thread.viaSibling) return thread
  return pickReplyConfig(thread, await getWhatsAppConfig(locationId), { template: true })
}

/**
 * WAREPLYNUMBER.1 — the number recorded on the thread
 * (whatsapp_conversations.whatsapp_number_id) while it is ACTIVE and switched
 * on at this location (WAORGNUMBER.1: a location_whatsapp_numbers row), as a
 * config FOR this location. Transitionally (WAHOMESTUDIO.1, deleted by
 * WAORGNUMBER.6) also a same-organisation number when this location has no
 * active number switched on at all: `{ viaSibling: true }`, `homeLocationId`
 * the number's home. Null otherwise (none recorded, inactive, gone, switched
 * off here while this studio has another, or another organisation's). Never
 * throws: a failed read (the column missing before mig 696 included) is null,
 * logged, so the caller replies from the default as it did before.
 *
 * @param {string|null|undefined} locationId
 * @param {string|null|undefined} conversationId
 * @returns {Promise<object|null>}
 */
export async function getConversationNumberConfig(locationId, conversationId) {
  if (!conversationId || !locationId) return null
  try {
    const db = createServerClient()
    const { data: conv, error: convErr } = await db.from('whatsapp_conversations')
      .select('whatsapp_number_id')
      .eq('id', conversationId)
      .eq('location_id', locationId)
      .maybeSingle()
    if (convErr) throw convErr
    if (!conv?.whatsapp_number_id) return null
    // The stamp, switched on here and active: PK (location_id, whatsapp_number_id)
    // makes this at most one row.
    const { data: here, error: hereErr } = await switchedOnNumbers(db, locationId, (q) => q.eq('whatsapp_number_id', conv.whatsapp_number_id))
      .maybeSingle()
    if (hereErr) throw hereErr
    if (here?.whatsapp_numbers) return rowToConfig(here.whatsapp_numbers, locationId)
    // WAHOMESTUDIO.1 (R4), transitional — a SIBLING's number: only for a thread
    // at a studio with no active number switched on, and only inside one
    // organisation (the number's organization_id). The thread is filed at the
    // customer's own studio, so a reply from the organisation number cannot
    // land in another studio's inbox (the harm WACONFIGFALLBACK.1 closed). A
    // studio that has a number switched on (Review Focus 1) never falls through
    // to a stamp that was switched off there.
    const { data: own, error: ownErr } = await switchedOnNumbers(db, locationId).limit(1)
    if (ownErr) throw ownErr
    if (own && own.length > 0) return null
    const { data: num, error: numErr } = await db.from('whatsapp_numbers')
      .select('*')
      .eq('id', conv.whatsapp_number_id)
      .eq('is_active', true)
      .maybeSingle()
    if (numErr) throw numErr
    if (!num?.organization_id) return null
    const { data: loc, error: locErr } = await db.from('locations')
      .select('id, organization_id')
      .eq('id', locationId)
      .maybeSingle()
    if (locErr) throw locErr
    if (!loc?.organization_id || loc.organization_id !== num.organization_id) return null
    return { ...rowToConfig(num, locationId), viaSibling: true }
  } catch (e) {
    logWarn('wa-config', 'reply number unreadable; replying from the default number', { conversationId, err: e?.message || String(e) })
    return null
  }
}

/**
 * WAHOMESTUDIO.1 (R5) — the studio whose whatsapp_templates a send in this
 * thread uses: templates are synced per studio from that studio's default
 * number's WABA, so a thread replying through a sibling's number sends that
 * sibling's (the number's home studio's) templates. Every other thread uses
 * its own studio's (WAORGNUMBER.1: a number switched on here is this studio's
 * to send from, whatever its home). Never throws (getConversationNumberConfig
 * never does).
 */
export async function templateLocationIdFor(locationId, conversationId) {
  const thread = await getConversationNumberConfig(locationId, conversationId)
  return thread?.viaSibling ? (thread.homeLocationId || locationId) : locationId
}

/**
 * WAREPLYNUMBER.1 — pure: the config a reply goes from, given the thread's
 * own number (or null) and the location default. Free text/media/interactive
 * → the thread number. A TEMPLATE → the thread number only when it shares the
 * default's WABA (templates are synced per location from the default's
 * account, and Meta sends only a number's own-WABA templates); else the
 * default.
 */
export function pickReplyConfig(threadConfig, defaultConfig, { template = false } = {}) {
  if (!threadConfig) return defaultConfig
  if (!template) return threadConfig
  if (defaultConfig && threadConfig.id === defaultConfig.id) return defaultConfig
  if (threadConfig.businessAccountId && threadConfig.businessAccountId === defaultConfig?.businessAccountId) return threadConfig
  return defaultConfig
}

/**
 * Resolve by a SPECIFIC whatsapp_numbers.id — used when a caller
 * wants to send from a non-default number (e.g. multi-number
 * location and the operator picked one in the inbox).
 */
export async function getWhatsAppConfigById(numberId) {
  if (!numberId) throw new Error('getWhatsAppConfigById requires a numberId.')
  const db = createServerClient()
  const { data: row, error } = await db
    .from('whatsapp_numbers')
    .select('*')
    .eq('id', numberId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw new Error(`Failed to load WhatsApp number ${numberId}: ${error.message}`)
  if (!row) throw new Error(`WhatsApp number ${numberId} not found or inactive.`)
  // WAORGNUMBER.1 — no studio asked: the config is for the number's home.
  return rowToConfig(row, row.location_id)
}

/**
 * Reverse lookup for the inbound webhook router. Meta's webhook
 * payload includes the destination phone_number_id; we map it back
 * to the owning location + config so the inbox knows where to drop
 * the message.
 *
 * Returns null ONLY when the phone_number_id is authoritatively
 * unknown (no active row). Throws when the lookup itself fails
 * (transient DB error) — callers must treat a throw as "owner
 * undetermined", never as "unknown number", so the two cases stay
 * separately loggable (WA-TECHPROV.4b). WACONFIGFALLBACK.1: the env
 * number is no longer consulted; it could only ever produce a config
 * with no location, which classifyInboundOwner drops anyway.
 */
export async function resolveWhatsAppNumberByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null

  const db = createServerClient()
  const { data: row, error } = await db
    .from('whatsapp_numbers')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) {
    // A transient lookup error must NEVER be reported as "unknown number"
    // (null): the webhook drops unknowns, and a dropped message is
    // permanently lost (we 200 + dedup, so Meta never retries). Throw so the
    // webhook logs a resolver failure, not an unknown number.
    console.warn('[wa-config] phone_number_id lookup failed:', error.message)
    throw new Error(`whatsapp_numbers lookup failed: ${error.message}`)
  }
  // WAORGNUMBER.1 — resolved for the number's home studio (the webhook routes
  // on homeLocationId; R4 decides the thread's studio later).
  return row ? rowToConfig(row, row.location_id) : null
}

/**
 * WA-TECHPROV.4 / SAAS-2 — inbound routing decision for the webhook.
 *
 * Only an active whatsapp_numbers row may own inbound traffic. Anything
 * else — an unknown phone_number_id, or any config without a location —
 * is dropped by the webhook. The historical first-location
 * fallback routed a foreign number's messages (and the contact + Mia
 * reply they spawned) into an arbitrary tenant.
 */
export function classifyInboundOwner(owningNumber) {
  if (owningNumber?.source === 'db' && owningNumber.homeLocationId) {
    // WAREPLYNUMBER.1 — the receiving row, stamped on the conversation so a
    // reply goes from the number the customer wrote to. WAORGNUMBER.1: routed
    // to the number's HOME studio (homeLocationId), never to whichever studio
    // a config happened to be resolved for.
    return { action: 'location', locationId: owningNumber.homeLocationId, numberId: owningNumber.id || null }
  }
  return { action: 'drop' }
}
