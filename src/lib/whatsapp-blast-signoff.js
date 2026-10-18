// WAORGNUMBER.4 (spec R7) — blast sign-off at a studio new to a shared
// WhatsApp number. A shared number has ONE quality rating and ONE Meta limit,
// so for a while after a studio switches it on, its broadcasts and drips go
// out only once an organisation admin (or a master) has signed them off.
//
//   * The window: locations.settings.whatsapp_blast_signoff_until, a plain
//     ISO date ('2026-11-16': the gate holds through that day on the studio's
//     clock, the day the copy names). Absent, blank, not a real date, or past
//     = no gate. Set for Hatch at go-live to go-live + 30 days (by hand; there
//     is no UI for it).
//   * The stamp: whatsapp_broadcasts.signed_off_by / signed_off_at (mig 748).
//     An org admin's send, schedule or start stamps it, as does
//     POST /api/whatsapp/broadcasts/[id]/sign-off on a draft (which must name
//     the content the admin saw: signedContentKey). Anyone else's send,
//     schedule or start answers 403 with signoffMessage() while the row is
//     unsigned, and anyone else's change to the signed content clears it.
//   * The engine gate: the cron has no actor, so sendBroadcast refuses an
//     unsigned broadcast with BlastSignoffRequiredError BEFORE any status flip
//     (the route answers 409; the cron's refused-start path keeps it a draft
//     and pushes the managers), and sendDripChunk pauses an unsigned drip.
//
// Zone maths only through @/lib/location-time (CLAUDE.md, TZ).
import { createHash } from 'node:crypto'
import {
  zoneOfLocation, todayStrIn, formatInZone, strictDayStartMsIn,
} from './location-time'

export const SIGNOFF_SETTING_KEY = 'whatsapp_blast_signoff_until'
export const WA_BLAST_SIGNOFF = 'WA_BLAST_SIGNOFF'
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The open sign-off window at `location`, or null.
 * @param {{ timezone?: string|null, settings?: object|null }|null} location
 * @param {Date} [now]
 * @returns {{ until: string } | null}
 */
export function signoffWindow(location, now = new Date()) {
  const raw = location?.settings?.[SIGNOFF_SETTING_KEY]
  if (typeof raw !== 'string') return null
  const until = raw.trim()
  if (!DATE_ONLY.test(until)) return null
  const zone = zoneOfLocation(location)
  if (strictDayStartMsIn(until, zone) == null) return null
  return todayStrIn(zone, now.getTime()) <= until ? { until } : null
}

/**
 * The spec copy (R7), date as "16 Nov 2026". `until` is the window's plain
 * date, already on the studio's calendar, so it is formatted as a calendar
 * day (noon UTC keeps it on its own day).
 * @param {string} locationName
 * @param {string} until  the window's `until` ('YYYY-MM-DD')
 */
export function signoffMessage(locationName, until) {
  const day = formatInZone(new Date(`${until}T12:00:00Z`), 'UTC', { day: 'numeric', month: 'short', year: 'numeric' }, 'en-GB')
  return `Blasts at ${locationName || 'this studio'} need sign-off from an organisation admin until ${day}.`
}

/**
 * The broadcast fields an org admin's sign-off vouches for: what goes out
 * (template, variables, header, audience) and, for a drip, how fast.
 */
export const SIGNED_CONTENT_FIELDS = Object.freeze([
  'template_id', 'variable_mapping', 'header_media_url', 'audience_filter', 'daily_cap', 'per_tick_max',
])

// jsonb does not keep key order, and an empty mapping / filter is stored
// either as null or as {}: both compare equal here.
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}
function normalisedField(field, value) {
  if (field === 'variable_mapping') return value ?? {}
  if (field === 'audience_filter') {
    const f = value ?? {}
    return { logic: f.logic ?? 'and', filters: f.filters ?? [] }
  }
  if (field === 'header_media_url') return value || null
  return value ?? null
}

/** True when `updates` changes a signed field of `row` (only fields present in `updates`). */
export function changesSignedContent(updates, row) {
  return SIGNED_CONTENT_FIELDS.some((f) => updates[f] !== undefined
    && canonicalJson(normalisedField(f, updates[f])) !== canonicalJson(normalisedField(f, row?.[f])))
}

/** A short key of the row's signed content: the sign-off route refuses a stale one. */
export function signedContentKey(row) {
  const body = SIGNED_CONTENT_FIELDS.map((f) => canonicalJson(normalisedField(f, row?.[f]))).join('|')
  return createHash('sha256').update(body).digest('hex').slice(0, 32)
}

/** Master, or an org admin of `orgId` (assertOrganizationAdmin's rule, as a boolean). */
export function isOrganizationAdminFor(user, orgId) {
  if (!user) return false
  if (user.isMaster) return true
  return Boolean(orgId) && (user.orgAdminOrgIds || []).includes(orgId)
}

/**
 * The studio row the gate needs. Throws on a failed read: the gate fails
 * closed (a refused send can be retried; an unsigned blast cannot be unsent).
 */
export async function readSignoffLocation(db, locationId) {
  const { data, error } = await db.from('locations')
    .select('id, name, organization_id, timezone, settings')
    .eq('id', locationId)
    .maybeSingle()
  if (error) throw new Error(`Could not check whether blasts at this studio need sign-off: ${error.message}`)
  return data || null
}

/**
 * A staff route's decision for a send, schedule or start at `location`.
 *   { blocked: message }  → answer 403 with it
 *   { stamp: { … } }      → an org admin acting: write the stamp with the action
 *   {}                    → no window, or already signed off: carry on
 */
export function routeSignoffGate({ user, location, row, now = new Date() }) {
  const win = signoffWindow(location, now)
  if (!win) return {}
  if (isOrganizationAdminFor(user, location?.organization_id)) {
    return { stamp: { signed_off_by: user.id, signed_off_at: now.toISOString() } }
  }
  if (row?.signed_off_by) return {}
  return { blocked: signoffMessage(location?.name, win.until) }
}

/** The engine's refusal message for an unsigned broadcast in an open window, or null. */
export function broadcastSignoffBlock(location, broadcast, now = new Date()) {
  if (broadcast?.signed_off_by) return null
  const win = signoffWindow(location, now)
  if (!win) return null
  return signoffMessage(location?.name, win.until)
}

export class BlastSignoffRequiredError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BlastSignoffRequiredError'
    this.code = WA_BLAST_SIGNOFF
  }
}

/** True for the typed refusal, judged by its code so it survives a mock. */
export function isBlastSignoffRequired(err) {
  return err?.code === WA_BLAST_SIGNOFF
}

/**
 * routeSignoffGate for the broadcast row's studio, reading the studio first.
 * Throws when the studio cannot be read (the route answers 503).
 */
export async function routeSignoffFor(db, { user, locationId, row, now = new Date() }) {
  const location = await readSignoffLocation(db, locationId)
  return routeSignoffGate({ user, location, row, now })
}

/**
 * Write an org admin's stamp onto broadcast `id`. Returns the write's error
 * (null on success); the caller refuses the action when it fails, because an
 * unstamped row would only be refused again by the engine.
 */
export async function writeSignoffStamp(db, id, stamp) {
  const { data, error } = await db.from('whatsapp_broadcasts')
    .update(stamp)
    .eq('id', id)
    .select('id')
  if (error) return error
  if (!data?.length) return { message: 'Broadcast not found' }
  return null
}
