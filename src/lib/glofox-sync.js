// Glofox member sync helpers (GLOFOX2.1).
//
// Pure mapping + match-or-create logic for pulling Glofox members
// into the CRM contacts table. Used today by the single-member
// /api/glofox/sync-member endpoint (dry-run + apply); used
// tomorrow by the daily bulk-sync cron.

import { fetchUserCredits, fetchMembership, fetchUserBookings, fetchUserInteractions } from './glofox.js'
import { classifyContact } from './pipeline-classifier.js'
import { upsertClassBookings } from './class-bookings.js'
import { logWarn } from './log.js'
import { matchesPush } from './glofox-notes.js'
import { normaliseGender } from './gender.js'
//
// Source-of-truth contract:
//   Glofox owns:  glofox_member_id, glofox_membership_status,
//                 glofox_synced_at (auto)
//   Glofox seeds: first_name, last_name, phone, email
//                 (only writes when the CRM field is null/empty
//                  — operator edits win)
//   CRM owns:     pipeline_stage_slug (derived from deals.stage_id by
//                 the mig 155 trigger), tags, lead_source, label,
//                 notes, activities, deals (NEVER touched by sync)
//
// Match precedence:
//   1. existing contact with this glofox_member_id → that's our row
//   2. existing contact with the same email (case-insensitive),
//      no glofox_member_id → MERGE (link them)
//   3. existing contact with same email but DIFFERENT
//      glofox_member_id → AMBIGUOUS, refuse to write
//   4. nothing matches → CREATE new contact
//
// The dry-run path returns { action, existing_id, changes,
// conflicts } so the operator can inspect before any DB write.

// ─────────────────────────────────────────────────────────────
// Pure mapping — Glofox payload → CRM contact shape
// ─────────────────────────────────────────────────────────────
//
// Real Glofox payload shape isn't documented in the public portal
// — the parser tries the most likely paths for each field and
// returns null when nothing matches. Once we see a real member
// payload we tighten the paths here without changing call sites.
//
// Known unknowns until first sync:
//   - Where lives "is this person a paying member?" — could be
//     `status`, `membership.status`, `active_memberships[0].status`
//     or something else entirely. mapMembershipStatus() tries
//     several paths + falls back to 'lead' (no membership found).

function pluck(obj, paths) {
  for (const path of paths) {
    let cur = obj
    let ok = true
    for (const key of path) {
      if (cur == null || typeof cur !== 'object') { ok = false; break }
      cur = cur[key]
    }
    if (ok && cur != null && cur !== '') return cur
  }
  return null
}

// ─────────────────────────────────────────────────────────────
// Parsers — Glofox payload conventions (GLOFOX2.1.2)
// ─────────────────────────────────────────────────────────────

/**
 * Parse a Glofox tenure-date value into an ISO timestamp string
 * suitable for contacts.joined_at TIMESTAMPTZ. Tries:
 *   1. member.joined_at (ISO date-time string per spec) — set by
 *      operators on imports / member transfers, can be backdated.
 *   2. member.created (Unix seconds — Glofox row-creation time) —
 *      fallback when joined_at isn't set (normal sign-up flow).
 *
 * Returns null when neither is present or parseable so the column
 * stays NULL rather than getting garbage. We use ISO timestamps
 * (TIMESTAMPTZ) rather than dates because the underlying Glofox
 * values are timestamps; truncating to date-only would lose
 * information.
 */
export function parseGlofoxJoinedAt(member) {
  if (!member || typeof member !== 'object') return null
  // Step 1 — joined_at preferred (operator-set, can be in the past).
  if (typeof member.joined_at === 'string' && member.joined_at.trim()) {
    const d = new Date(member.joined_at)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  // Step 2 — fallback to Glofox row-creation timestamp.
  const created = member.created
  if (typeof created === 'number' && Number.isFinite(created)) {
    // Same heuristic as parseGlofoxDate — >10 digits = millis.
    let secs = created
    if (secs > 10_000_000_000) secs = Math.floor(secs / 1000)
    // Sanity-bound: 2000-2100 in unix seconds.
    if (secs < 946_684_800 || secs > 4_102_444_800) return null
    return new Date(secs * 1000).toISOString()
  }
  return null
}

/**
 * Parse a Glofox date-ish value into a YYYY-MM-DD string suitable
 * for the contacts.dob DATE column.
 *
 * Glofox's `birth` field shape is undocumented — could arrive as:
 *   - ISO date string: "1990-05-12" or "1990-05-12T00:00:00Z"
 *   - Unix seconds: 642470400
 *   - Mongo BSON timestamp object: { sec: 642470400, usec: 0 }
 *     (Glofox uses this for modified/created elsewhere)
 *
 * Returns null when the value is null / empty / unparseable so
 * the sync can leave dob NULL rather than write garbage.
 */
export function parseGlofoxDate(value) {
  if (value == null || value === '') return null
  // ISO string — already in the right shape; strip any time
  // component since dob is DATE-only.
  if (typeof value === 'string') {
    const ymd = value.match(/^(\d{4}-\d{2}-\d{2})/)
    if (ymd) return ymd[1]
    return null
  }
  // Mongo BSON timestamp shape.
  let secs = null
  if (typeof value === 'object' && typeof value.sec === 'number') {
    secs = value.sec
  } else if (typeof value === 'number') {
    secs = value
  }
  if (secs == null || !Number.isFinite(secs)) return null
  // Heuristic: Glofox sometimes returns millis instead of seconds.
  // Anything past 10 digits + a sensible date range means millis.
  if (secs > 10_000_000_000) secs = Math.floor(secs / 1000)
  // Sanity-bound: 1900-2100 in unix seconds. Outside this is
  // almost certainly garbage (or a sentinel value Glofox uses
  // for "no birthday set").
  if (secs < -2_208_988_800 || secs > 4_102_444_800) return null
  const d = new Date(secs * 1000)
  if (Number.isNaN(d.getTime())) return null
  // Format YYYY-MM-DD using UTC parts so a server in any TZ
  // produces the same string for the same instant.
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Normalise UK + Irish mobile numbers to E.164. Length is the
 * disambiguator:
 *   - 11 digits starting 07 → UK mobile, drop leading 0 → +44
 *   - 10 digits starting 08 → Irish mobile (083/085/086/087/089),
 *     drop leading 0 → +353
 *   - already +-prefixed → trust the input
 *   - 00 prefix → swap to +
 *   - anything else → return as-is (we'd rather store the raw
 *     value than guess wrong; bulk normalisation can clean these
 *     up later with operator review)
 *
 * No third-party libraries — libphonenumber is overkill for the
 * two countries UN1T actually serves.
 */
// CLASSPASS-PHONE.2 — numbers that carry no information. ClassPass does not
// share a member's real phone, so Glofox stores the constant '+10000000000'
// and it synced through to 1,620 contacts (19% of the base), every one of
// them looking phone-reachable when none were. It survived because the
// '+' fast-path below returns anything E.164-shaped untouched. Repeated-digit
// strings ('+0000000') are the same class of filler.
function isPlaceholderNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return true
  if (digits === '10000000000') return true          // ClassPass/Glofox filler
  if (/^(\d)\1+$/.test(digits)) return true          // 0000000, 1111111, …
  return false
}

export function normalizePhone(phone) {
  if (typeof phone !== 'string') return null
  const trimmed = phone.trim()
  if (!trimmed) return null
  // Reject fillers BEFORE the E.164 fast-path — that path is what let the
  // ClassPass placeholder through untouched for months.
  if (isPlaceholderNumber(trimmed)) return null
  // Already E.164-ish.
  if (trimmed.startsWith('+')) return trimmed.replace(/\s+/g, '')
  // International prefix via 00.
  if (trimmed.startsWith('00')) return '+' + trimmed.slice(2).replace(/\s+/g, '')
  // Strip non-digits for the heuristic check.
  const digits = trimmed.replace(/\D/g, '')
  // UK mobile: 11 digits starting 07.
  if (digits.length === 11 && digits.startsWith('07')) {
    return '+44' + digits.slice(1)
  }
  // Irish mobile: 10 digits starting 08X. 083, 085, 086, 087, 089
  // are the active prefixes today; we cover the broader 08* to
  // future-proof against a new operator block.
  if (digits.length === 10 && digits.startsWith('08')) {
    return '+353' + digits.slice(1)
  }
  // Unknown / landline / international without + → leave as-is.
  return trimmed
}

/**
 * Glofox `source` values map to our leadSourceSchema enum
 * (src/lib/schemas.js — booking / meta / tiktok / walkin / referral /
 * website / whatsapp / classpass / other). Anything we can't recognise
 * becomes 'other'.
 *
 * GLOFOX2.1.8 — `origin` takes precedence over `source`. Glofox uses
 * the top-level `origin` field for 3rd-party-platform attribution
 * (currently we've seen 'classpass'), and sets `source` to 'UNKNOWN'
 * for those contacts. Reading origin first preserves the attribution
 * signal in lead_source so audience filters can target ClassPass-
 * sourced contacts directly without having to join on
 * glofox_membership_status.
 */
const GLOFOX_SOURCE_MAP = {
  WEBPORTAL:    'website',
  WEB:          'website',
  WALK_IN:      'walkin',
  WALKIN:       'walkin',
  REFERRAL:     'referral',
  FACEBOOK:     'meta',
  INSTAGRAM:    'meta',
  META:         'meta',
  TIKTOK:       'tiktok',
  BOOKING:      'booking',
  WHATSAPP:     'whatsapp',
  CLASSPASS:    'classpass',
}

const GLOFOX_ORIGIN_MAP = {
  CLASSPASS: 'classpass',
  // Future 3rd-party platforms Glofox might surface via `origin`
  // (Gympass, MoveGB, etc.) — add a row here per audience the
  // operator wants to filter on. The synthesised canonical that
  // currently routes via membership.type lives in mapMembershipStatus.
}

/**
 * Resolve a Glofox member's lead_source. Accepts either:
 *   - a full member payload (preferred — reads both origin + source)
 *   - a raw source string (legacy — for callers that already
 *     extracted member.source. origin attribution will be missed.)
 */
export function mapGlofoxSource(memberOrSource) {
  if (!memberOrSource) return 'other'
  // Full payload — try origin first, then source.
  if (typeof memberOrSource === 'object') {
    if (memberOrSource.origin) {
      const oKey = String(memberOrSource.origin).trim().toUpperCase()
      if (GLOFOX_ORIGIN_MAP[oKey]) return GLOFOX_ORIGIN_MAP[oKey]
    }
    if (memberOrSource.source) {
      const sKey = String(memberOrSource.source).trim().toUpperCase()
      if (GLOFOX_SOURCE_MAP[sKey]) return GLOFOX_SOURCE_MAP[sKey]
    }
    return 'other'
  }
  // Legacy string-only callers.
  const key = String(memberOrSource).trim().toUpperCase()
  return GLOFOX_SOURCE_MAP[key] || 'other'
}

// ─────────────────────────────────────────────────────────────
// Pipeline stage mapping (GLOFOX2.1.5)
// ─────────────────────────────────────────────────────────────
//
// The CRM pipeline reads from `deals`, not `contacts.lead_status`.
// A contact without a deal row in pipeline_stages doesn't appear
// on the kanban — that's by design (deals are opportunities, a
// contact can have many or none). The Glofox sync therefore
// needs to slot each member into the right stage by creating a
// deal row alongside the contact.
//
// Glofox has TWO separate status systems and earlier passes
// (GLOFOX2.1.3/2.1.4) conflated them. The portal screenshot +
// Glofox support docs confirm the operator-visible "Client Status"
// (Glofox's `lead_status` field) is the funnel state we want:
//
//   Cold              — captured but cold
//   Tour              — booked / completed a tour
//   No Sale (Tour)    — toured, didn't convert
//   Trial             — currently on a trial
//   No Sale (Trial)   — trial finished without converting
//   Member            — paying member  (+ active:false → ex_member)
//   Lead              — generic catch-all when nothing else fits
//
// Membership status (Active / Overdue / Paused / Cancelled / Past)
// lives on the membership subscription, not on the client. We don't
// use it directly for funnel placement — instead we derive two
// synthesised canonicals from deeper payload signals:
//
//   ex_member       — lead_status=MEMBER + top-level active=false.
//                     Glofox uses this pair to mark lapsed members.
//                     Also the collapse target for classpass_payg
//                     going inactive.
//
//   classpass_payg  — origin='classpass' + membership.type='payg'.
//                     Glofox tags ClassPass users as lead_status='LEAD'
//                     which loses the "active paying customer"
//                     signal. We synthesise so they can be routed
//                     into the conversion funnel as warm upsell
//                     targets distinct from fresh leads.
//
// GLOFOX2.1.9 — credit_member auto-detection REVERTED.
// The discriminator we attempted (lead_status=MEMBER + membership.
// type=num_classes [+ MEMBERPURCHASE=true]) failed against real
// data: member.membership returns a stale/initial reference (the
// trial pack), NOT the user's current product, so the type field
// can't be trusted. MEMBERPURCHASE=false also fires for comp'd
// credit members, ruling out that flag as a reliable filter.
// Until we have a richer Glofox API endpoint that returns a
// member's CURRENT memberships (Plan A — see GLOFOX2.1.10), all
// lead_status=MEMBER + active=true now map to 'member' canonical.
// The credit_member canonical + pipeline stage + audience option
// remain in place for operator-managed flow and future re-
// introduction once we have reliable signals.
//
// Canonical CRM statuses (what we store in glofox_membership_status):
//   cold, tour, no_sale_tour, trial, no_sale_trial,
//   member, credit_member, classpass_payg, ex_member, lead
//   (credit_member retained as a status value but the sync no
//    longer auto-derives it.)
//
// Pipeline placement (pipeline_stages slugs — mig 001 seeded the
// first 9, mig 135 added credit_member):

const GLOFOX_STATUS_TO_STAGE_SLUG = {
  cold:           'cold_email_only',
  tour:           'conversion_ready',
  no_sale_tour:   'follow_up_needed',
  trial:          'trial_active',
  no_sale_trial:  'follow_up_needed',
  member:         'member',
  credit_member:  'credit_member',     // own column — distinct marketing audience
  classpass_payg: 'conversion_ready',  // warm upsell — push to subscription
  ex_member:      'lost_member',
  lead:           'new_lead',
}

/**
 * Pure mapping: canonical Glofox status → CRM pipeline stage slug
 * FOR FIRST-TIME PLACEMENT (no existing deal yet). Unknown statuses
 * default to 'new_lead' so the member still appears in the
 * pipeline. For transitions on EXISTING deals see
 * targetDealStageForSync below.
 */
export function pipelineStageSlugForStatus(status) {
  if (!status) return 'new_lead'
  return GLOFOX_STATUS_TO_STAGE_SLUG[String(status).toLowerCase()] || 'new_lead'
}

/**
 * Stages the sync would NEVER place a contact in — pure
 * operator-managed slots. If a deal sits here, leave it.
 *   returning_member  — operator-curated comeback funnel
 *   new_lead_social   — channel-specific bucket the operator owns
 *
 * GLOFOX2.1.11 — credit_member REMOVED from this set. Plan A
 * (detectCreditMember below) gives us reliable auto-classification
 * via the /2.0/credits + parent-membership lookup, so the sync now
 * takes ownership again. When a credit member's status changes
 * (active=false, or upgrades to a subscription), the sync auto-
 * routes them.
 */
const OPERATOR_ONLY_STAGES = new Set([
  'returning_member',
  'new_lead_social',
])

/**
 * Transition for EXISTING deals (GLOFOX2.1.5).
 *
 * Auto-move rule: only move the open deal when ALL of the
 * following hold:
 *   1. The Glofox status has CHANGED since the last sync.
 *      (Idempotent re-syncs are no-ops.)
 *   2. The current deal stage is NOT an operator-only slot.
 *      (Operator manual moves to returning_member /
 *       new_lead_social are sticky.)
 *   3. The new status maps to a known stage.
 *   4. The target stage is different from the current stage.
 *
 * Returns the target slug, or null to leave the deal alone.
 *
 * The "status changed" guard makes manual operator moves between
 * syncs safe: if Glofox status is unchanged, we never overwrite an
 * operator placement, regardless of what stage they put the deal
 * in. When Glofox status does change, we route to the canonical
 * stage for the new status — Glofox is source of truth for
 * membership state, and the deal placement reflects that.
 */
export function targetDealStageForSync(previousStatus, newStatus, currentStageSlug) {
  const prev = previousStatus ? String(previousStatus).toLowerCase() : null
  const next = newStatus ? String(newStatus).toLowerCase() : null
  // 1. No change → leave it.
  if (prev === next) return null
  // 2. Operator-only stage → respect manual placement.
  if (OPERATOR_ONLY_STAGES.has(currentStageSlug)) return null
  // 3. No mapping for the new status → leave it.
  if (!next) return null
  const target = GLOFOX_STATUS_TO_STAGE_SLUG[next]
  if (!target) return null
  // 4. Target is already current → no-op.
  if (target === currentStageSlug) return null
  return target
}

/**
 * Look up the current open deal for a contact + its stage slug.
 * Returns null when no open deal exists. Used by both preview
 * (to compute the proposed action) and apply (to execute it).
 */
export async function getOpenDealWithStage(db, contactId) {
  if (!db || !contactId) return null
  // Two queries — deal first, then resolve the stage slug. Avoids
  // Supabase relation-syntax quirks and keeps the test fake simple.
  const { data: deals, error: dealErr } = await db
    .from('deals')
    .select('id, stage_id')
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .limit(1)
  if (dealErr || !deals?.[0]) return null
  const deal = deals[0]
  const { data: stages } = await db
    .from('pipeline_stages')
    .select('slug')
    .eq('id', deal.stage_id)
    .limit(1)
  return { id: deal.id, stage_id: deal.stage_id, stage_slug: stages?.[0]?.slug || null }
}

/**
 * Resolve a pipeline stage slug → stage id at a location. Returns
 * the id, or null if the stage doesn't exist (caller decides
 * fallback). Cached-per-call by keeping it inline — sync runs are
 * low-volume; we don't need a Map cache.
 */
export async function findStageIdBySlug(db, locationId, stageSlug) {
  const { data, error } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('location_id', locationId)
    .eq('slug', stageSlug)
    .limit(1)
  if (error || !data?.[0]) return null
  return data[0].id
}

/**
 * Ensure the contact's pipeline placement reflects their Glofox
 * status. Four terminal states:
 *
 *   { action: 'create',  deal_id, stage_slug }              fresh deal made
 *   { action: 'move',    deal_id, from_slug, to_slug }       existing deal moved
 *   { action: 'leave',   deal_id, stage_slug }               nothing to do (no status
 *                                                             change, operator-only slot,
 *                                                             or already at target)
 *   { action: 'error',   error }                              lookup/insert/update failed
 *
 * Auto-move only fires on a status CHANGE (previousStatus !==
 * newStatus). previousStatus is what we last wrote into
 * contacts.glofox_membership_status; newStatus is what we're
 * about to write. Idempotent — re-running with the same status
 * converges to 'leave'.
 */
/**
 * Ensure the contact's pipeline placement reflects the unified
 * classifier (PIPELINE5.4). Replaces the older Glofox-status-only
 * transition map: stage is now a function of (status × engagement
 * × recency), not just status.
 *
 * @param {object}  db
 * @param {string}  locationId
 * @param {string}  contactId
 * @param {object}  contactSnapshot   shape consumed by classifyContact:
 *   { glofox_membership_status, last_attended_at, total_attended_7d,
 *     total_attended_30d, last_payment_at, joined_at, created_at,
 *     trial_credits_remaining, recent_bookings, converted_at, pack_customer_at }
 * @param {string?} contactName       fallback for deals.title on create
 */
export async function ensureDealForContact(db, locationId, contactId, contactSnapshot, contactName = null) {
  if (!db || !locationId || !contactId) {
    return { action: 'error', error: 'missing arguments' }
  }
  // PIPELINE5.4 — classifier is the source of truth for stage.
  // Single rule set runs from applyMemberSync (per-event) AND from
  // the nightly /api/cron/pipeline-classify, so the two converge.
  const targetSlug = classifyContact(contactSnapshot || {})

  const existing = await getOpenDealWithStage(db, contactId)

  if (!existing) {
    // CREATE path — first time this contact has had a deal.
    let stageId = await findStageIdBySlug(db, locationId, targetSlug)
    let resolvedSlug = targetSlug
    if (!stageId) {
      // New-lead fallback so the contact still surfaces somewhere
      // visible. Mig 147 ensures every location has the standard
      // stage set, so this should be unreachable in practice.
      const fallback = await findStageIdBySlug(db, locationId, 'new_lead')
      if (!fallback) return { action: 'error', error: `Pipeline stage '${targetSlug}' not found and no new_lead fallback` }
      stageId = fallback
      resolvedSlug = 'new_lead'
    }
    // GLOFOX2.5 — deals.title is NOT NULL (mig 001). Use the
    // contact's name as the title, fall back to a generic label
    // when the mapped name is missing.
    const title = (contactName && contactName.trim()) || 'Glofox member'
    const { data, error } = await db
      .from('deals')
      .insert({ title, contact_id: contactId, stage_id: stageId, location_id: locationId, status: 'open' })
      .select('id')
      .single()
    if (error) return { action: 'error', error: error.message }
    return { action: 'create', deal_id: data.id, stage_slug: resolvedSlug }
  }

  // EXISTING deal — move iff the classifier says we should be in a
  // different stage. The classifier is idempotent for unchanged
  // inputs, so re-runs on the same data produce 'leave'.
  if (existing.stage_slug === targetSlug) {
    return { action: 'leave', deal_id: existing.id, stage_slug: existing.stage_slug }
  }
  const targetStageId = await findStageIdBySlug(db, locationId, targetSlug)
  if (!targetStageId) {
    return { action: 'error', deal_id: existing.id, error: `Target stage '${targetSlug}' not found at location` }
  }
  const { error: moveErr } = await db
    .from('deals')
    .update({ stage_id: targetStageId })
    .eq('id', existing.id)
  if (moveErr) return { action: 'error', deal_id: existing.id, error: moveErr.message }
  return { action: 'move', deal_id: existing.id, from_slug: existing.stage_slug, to_slug: targetSlug }
}

const ID_PATHS = [['_id'], ['id'], ['member_id']]
const EMAIL_PATHS = [['email']]
const FIRST_NAME_PATHS = [['first_name'], ['firstName'], ['name', 'first']]
const LAST_NAME_PATHS = [['last_name'], ['lastName'], ['name', 'last']]
const FULL_NAME_PATHS = [['name'], ['full_name'], ['fullName']]
const PHONE_PATHS = [['phone'], ['mobile'], ['phone_number']]
// Glofox payload uses `lead_status` as the operator-visible
// membership-stage enum (uppercase: TRIAL, ACTIVE, CANCELLED,
// EXPIRED, LEAD). We probe that first, then a few less-likely
// shapes in case Glofox renames it or other tenants see different
// keys. See the GLOFOX2.1.1 commit for the live payload that
// confirmed this ordering against UN1T Stillorgan members.
const MEMBERSHIP_STATUS_PATHS = [
  ['lead_status'],
  ['leads', 'status'],
  ['membership_status'],
  ['membershipStatus'],
  ['status'],
  ['membership', 'status'],
  ['active_membership', 'status'],
]

/**
 * Map a Glofox member payload to the CRM contact shape.
 *
 * @param {object} member Glofox member payload.
 * @param {object} [ctx]  Optional Plan A context (credits + memberships)
 *                        for credit_member detection. See mapMembershipStatus.
 */
export function mapGlofoxMember(member, ctx = null) {
  if (!member || typeof member !== 'object') return null
  const id = pluck(member, ID_PATHS)
  if (!id) return null
  const emailRaw = pluck(member, EMAIL_PATHS)
  const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : null

  // Names: prefer split first/last, fall back to splitting full name.
  let firstName = pluck(member, FIRST_NAME_PATHS)
  let lastName = pluck(member, LAST_NAME_PATHS)
  if (!firstName && !lastName) {
    const full = pluck(member, FULL_NAME_PATHS)
    if (typeof full === 'string') {
      const parts = full.trim().split(/\s+/)
      firstName = parts[0] || null
      lastName = parts.slice(1).join(' ') || null
    }
  }
  firstName = firstName ? String(firstName).trim() : null
  lastName  = lastName  ? String(lastName).trim()  : null

  // Phone: normalise UK + Irish mobiles to E.164 (GLOFOX2.1.2).
  // Falls back to the raw value if neither heuristic matches.
  const phoneRaw = pluck(member, PHONE_PATHS)
  const phone = phoneRaw ? normalizePhone(String(phoneRaw)) : null

  const membershipStatus = mapMembershipStatus(member, ctx)

  // GLOFOX2.1.2 — date of birth from Glofox `birth`. Powers the
  // birthday-wishes anniversary template + future age-segment
  // reports. Null when Glofox doesn't have it (most members).
  const dob = parseGlofoxDate(member.birth ?? member.dob ?? null)

  // GLOFOX2.1.13 — tenure date. Prefers Glofox's joined_at (operator-
  // set, can be backdated for imports), falls back to created (the
  // Glofox row-creation Unix timestamp) so every synced member has
  // a tenure anchor. Powers "Members > 6 months" anniversary
  // sequences + cohort analysis.
  const joinedAt = parseGlofoxJoinedAt(member)

  // GLOFOX2.1.2 — granular source mapping. Glofox's WEBPORTAL /
  // WALK_IN / FACEBOOK etc. → our leadSourceSchema enum
  // (src/lib/schemas.js). Defaults to 'other' for unmapped values.
  // GLOFOX2.1.8 — passing the full member so origin (e.g. 'classpass')
  // takes precedence over source when present.
  const leadSource = mapGlofoxSource(member)

  // CRM's name column is NOT NULL — compose from parts, fall back
  // to email or 'Glofox member' so we never violate the constraint.
  const name = [firstName, lastName].filter(Boolean).join(' ').trim()
    || email
    || 'Glofox member'

  return {
    glofox_member_id: String(id),
    email,
    first_name: firstName,
    last_name: lastName,
    phone,
    name,
    dob,
    joined_at: joinedAt,
    lead_source: leadSource,
    glofox_membership_status: membershipStatus,
  }
}

/**
 * CHURN-PREP.2 — extract the human-readable membership plan name
 * from a Glofox member payload.
 *
 * Glofox exposes the member's current product on member.membership:
 *   - membership_plan_name — the clean plan label ("3 Month
 *     Membership", "10 Class Pack"). Only on the single-member GET.
 *   - membership_name      — the operator's catalog label, usually
 *     with a sort-order prefix ("3) The 3 Month Membership ...").
 *     Present on both list and single-member payloads.
 *
 * Prefers membership_plan_name, falls back to membership_name, and
 * strips the operator's "N) " sort prefix. Returns null when the
 * member has no real membership applied (PAYG / lead — Glofox
 * returns blank names for both).
 *
 * Pure function — input → output, no side effects.
 */
export function extractMembershipPlan(member) {
  const m = member && typeof member === 'object' ? member.membership : null
  if (!m || typeof m !== 'object') return null
  const plan = typeof m.membership_plan_name === 'string' ? m.membership_plan_name.trim() : ''
  const name = typeof m.membership_name === 'string' ? m.membership_name.trim() : ''
  const raw = plan || name
  if (!raw) return null
  // Drop the operator's "N) " sort-order prefix from catalog names.
  const cleaned = raw.replace(/^\d+\)\s*/, '').trim()
  return cleaned || null
}

/**
 * Extract the FULL Glofox catalog plan name from
 * member.membership.membership_name — the operator-facing label that
 * carries promo/discount context ("The Monthly Membership (€99 FIRST
 * MONTH)", "The 3 Month Membership - €100 Discount"). Strips only the
 * "N) " sort-order prefix; keeps everything else.
 *
 * Companion to extractMembershipPlan (the clean canonical name). Stored
 * separately so the profile can show both. Returns null when the
 * catalog name is absent OR identical to the clean name (no extra info
 * to surface).
 *
 * Pure function — input → output, no side effects.
 */
export function extractMembershipPlanFull(member) {
  const m = member && typeof member === 'object' ? member.membership : null
  if (!m || typeof m !== 'object') return null
  const name = typeof m.membership_name === 'string' ? m.membership_name.trim() : ''
  if (!name) return null
  const cleaned = name.replace(/^\d+\)\s*/, '').trim()
  if (!cleaned) return null
  // Suppress when it adds nothing over the clean name.
  const plain = extractMembershipPlan(member)
  if (plain && cleaned === plain) return null
  return cleaned
}

/**
 * Extract the membership's lifecycle state from
 * member.membership.status — ACTIVE / PAUSED / CANCELLED / EXPIRED.
 * Lowercased for consistency with glofox_membership_status. Returns
 * null when absent (PAYG / leads carry no membership object).
 *
 * Distinct from glofox_membership_status, which is the Glofox Client
 * Status (member / trial / lead). This is the membership itself: a
 * 'member' whose membership is 'paused' is on a planned freeze, not
 * at churn risk, so the radar excludes them.
 *
 * Pure function — input → output, no side effects.
 */
export function extractMembershipState(member) {
  const m = member && typeof member === 'object' ? member.membership : null
  if (!m || typeof m !== 'object') return null
  const status = typeof m.status === 'string' ? m.status.trim().toLowerCase() : ''
  return status || null
}

/**
 * Extract the wider member profile fields from the single-member
 * Glofox payload — renewal/billing detail + the remaining useful
 * profile attributes. Returns a flat object of contacts columns
 * ready to spread into a row update. Every field degrades to null
 * when absent (PAYG / class-pack members carry no subscription;
 * leads carry no membership).
 *
 * Pure function — input → output, no side effects.
 */
export function extractMemberProfile(member) {
  const m = member && typeof member === 'object' ? member : {}
  const mem = m.membership && typeof m.membership === 'object' ? m.membership : {}
  const sub = mem.subscription && typeof mem.subscription === 'object' ? mem.subscription : {}

  // Glofox dates are unix seconds.
  const unixToIso = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
  }
  // Effective price: the subscription's actual billed price, else
  // the catalog plan price (class packs have no subscription).
  const priceUnit = Number.isFinite(Number(sub.price)) ? Number(sub.price)
    : Number.isFinite(Number(mem.plan_price)) ? Number(mem.plan_price)
      : null
  // Readable billing cadence — "6 months" / "1 month".
  let interval = null
  if (sub.interval) {
    const count = Number(sub.interval_count) || 1
    interval = `${count} ${sub.interval}${count > 1 ? 's' : ''}`
  }
  // Glofox returns this placeholder string when no contact is set.
  const ecRaw = typeof m.emergency_contact === 'string' ? m.emergency_contact.trim() : ''
  const emergency = ecRaw && !/^contact person:\s*,\s*phone number:\s*$/i.test(ecRaw)
    ? ecRaw : null
  // Canonicalise at the producer so newly-synced rows store 'male'/'female'
  // or null — Glofox carries case variants, 'M'/'F' and a legacy 'P' code,
  // and the raw pass-through silently degraded the calorie estimate to the
  // sex-neutral mean for every non-exact value (C12).
  const gender = normaliseGender(m.gender)
  // GYMPASS.1 — Gympass (Wellhub) stamps its own block on the member
  // profile: member.metadata.gympass = { id }. It's the reliable positive
  // marker for a Gympass user. (ClassPass uses metadata.classpass +
  // origin='classpass'; Gympass's own `origin` only appears for payg
  // drop-ins and is ABSENT for a full member who ALSO uses Gympass — so we
  // key off metadata.gympass.id, which is present in both cases.) Coerced
  // to a trimmed string; null when the block is absent.
  const gympassMeta = m.metadata && typeof m.metadata === 'object'
    && m.metadata.gympass && typeof m.metadata.gympass === 'object'
    ? m.metadata.gympass : null
  const gympassMemberId = gympassMeta && gympassMeta.id != null
    ? (String(gympassMeta.id).trim() || null)
    : null

  return {
    glofox_membership_expiry: unixToIso(mem.expiry_date),
    glofox_membership_price_cents: priceUnit != null ? Math.round(priceUnit * 100) : null,
    glofox_billing_interval: interval,
    glofox_payment_method: typeof sub.payment_method_type_id === 'string' ? sub.payment_method_type_id : null,
    glofox_membership_type: typeof mem.type === 'string' ? mem.type : null,
    glofox_image_url: typeof m.image_url === 'string' && m.image_url ? m.image_url : null,
    gender,
    emergency_contact: emergency,
    glofox_signup_answers: Array.isArray(m.answers) && m.answers.length > 0 ? m.answers : null,
    glofox_roaming_enabled: typeof mem.roaming_enabled === 'boolean' ? mem.roaming_enabled : null,
    glofox_account_active: typeof m.active === 'boolean' ? m.active : null,
    glofox_source: typeof m.source === 'string' && m.source ? m.source : null,
    gympass_member_id: gympassMemberId,
  }
}

// ─────────────────────────────────────────────────────────────
// Membership status mapping (GLOFOX2.1.5 + 2.1.6 ClassPass)
// ─────────────────────────────────────────────────────────────
//
// Glofox's operator-visible "Client Status" (the lead_status field)
// uses this enum, per the portal and Glofox support docs:
//
//   COLD              — captured but not engaged
//   TOUR              — booked/completed a tour
//   NO_SALE_TOUR      — toured, didn't convert
//                       (portal label: "No Sale (Tour)")
//   TRIAL             — currently on a trial
//   NO_SALE_TRIAL     — trial finished without converting
//                       (portal label: "No Sale (Trial)")
//   MEMBER            — paying member
//   LEAD              — generic, used as a catch-all
//
// We mirror these as lowercased canonicals + add three synthesised
// values:
//
//   ex_member        — lead_status=MEMBER + active:false. Also the
//                      collapse target for any paying-customer
//                      canonical going inactive. Routes to lost_member.
//
//   classpass_payg   — origin='classpass' + membership.type='payg'.
//                      ClassPass-originated PAYG users default to
//                      Glofox's catch-all LEAD lead_status, which
//                      loses the "actively paying customer" signal.
//                      Routes to conversion_ready as a warm upsell.
//
//   credit_member    — lead_status='MEMBER' + membership.type='num_classes'.
//                      A UN1T "Credit Member" — bought a class pack
//                      directly (not a subscription, not via ClassPass).
//                      Routes to its own pipeline stage 'credit_member'
//                      so the operator can target them with distinct
//                      marketing (subscription-upgrade pitch).
//
// Canonical set written to contacts.glofox_membership_status:
//   cold, tour, no_sale_tour, trial, no_sale_trial,
//   member, credit_member, classpass_payg, ex_member, lead

const CANONICAL_GLOFOX_STATUSES = new Set([
  'cold', 'tour', 'no_sale_tour', 'trial', 'no_sale_trial',
  'member', 'credit_member', 'classpass_payg', 'ex_member', 'lead',
])

/**
 * Detect a ClassPass pay-as-you-go user from the deeper payload
 * signals (Glofox doesn't expose this on lead_status). All checks
 * must pass — we don't want to false-positive on a legacy member
 * who happens to have a payg add-on, or a ClassPass user who later
 * took a real subscription.
 */
function isClassPassPayg(member) {
  if (!member || typeof member !== 'object') return false
  const origin = typeof member.origin === 'string' ? member.origin.trim().toLowerCase() : null
  const mType = typeof member.membership?.type === 'string'
    ? member.membership.type.trim().toLowerCase()
    : null
  return origin === 'classpass' && mType === 'payg'
}

// ─────────────────────────────────────────────────────────────
// Credit Member detection (GLOFOX2.1.11 — Plan A)
// ─────────────────────────────────────────────────────────────
//
// Reliable detection now possible thanks to the /2.0/credits +
// /2.0/memberships endpoints (research GLOFOX2.1.10). The previous
// attempt (GLOFOX2.1.7) used member.membership.type which is a
// stale/initial reference (typically the trial pack), not the
// user's current product. The new path uses the /credits endpoint
// to get the user's CURRENT credit packs, then resolves each
// pack's parent Membership to check the discriminating plan.type.
//
// Glofox MembershipPlan.type enum:
//   'time'         → unlimited subscription                  → member
//   'time_classes' → restricted subscription with credits    → member
//   'num_classes'  → one-off non-subscription pack           → credit_member
//
// Detection rule:
//   1. Precondition: lead_status='MEMBER' AND active=true.
//      (Trial users on the trial pack — Roisin — also have
//       num_classes credits, but their lead_status='TRIAL'
//       correctly excludes them.)
//   2. User must have ≥1 ACTIVE credit pack.
//   3. EVERY unique parent Membership of those packs must:
//      - have membership.trial !== true (defence-in-depth: the
//        trial Membership wouldn't normally appear here for a
//        MEMBER lead_status, but guard anyway), AND
//      - have plans where ALL entries are type='num_classes'
//        (so a Class Pack membership qualifies; a 'time_classes'
//        subscription with credits does not).
//
// Why "every" not "any" on rule 3: a subscription customer who
// also bought a one-off pack on top would have packs from BOTH a
// 'time_classes' subscription AND a 'num_classes' pack. They're
// still primarily a subscription member — only ALL-num_classes
// → credit_member.

/**
 * Pure check: does this Glofox Membership represent a Class Pack
 * (one-off, no subscription cycle)?
 *
 *   - membership.trial must NOT be true
 *   - membership.plans must exist + be non-empty
 *   - every plan in plans[] must have type === 'num_classes'
 */
export function isClassPackMembership(membership) {
  if (!membership || typeof membership !== 'object') return false
  if (membership.trial === true) return false
  if (!Array.isArray(membership.plans) || membership.plans.length === 0) return false
  return membership.plans.every(p => p && typeof p.type === 'string' && p.type.toLowerCase() === 'num_classes')
}

/**
 * Sum the ACTIVE credit packs' remaining sessions to give the
 * member's currently-usable credit balance. Mirrors what Glofox's
 * portal shows ("X classes remaining" on the member profile).
 *
 * Returns null when there are no active packs at all (unlimited
 * 'time' subscription members, or freshly-signed-up leads with
 * no pack yet) — null surfaces as '—' in the CRM UI rather than
 * misleading "0 credits".
 *
 * Uses the credit object's `available` field (Glofox-computed:
 * num_sessions - bookings.length). Falls back to recomputing from
 * num_sessions/bookings when `available` is missing — defensive
 * for older firmware shapes.
 */
/**
 * GLOFOX4.2 — given a member sync's before/after state, return the
 * list of trial-lifecycle tags that should be written to the
 * contact. Each tag corresponds to a sequence-trigger signal:
 *
 *   glofox_trial_ended       — trial → no_sale_trial (lifecycle)
 *   glofox_trial_converted   — trial → member | credit_member
 *   glofox_trial_credits_low — credits ≤ 1 while still on trial
 *   glofox_trial_engaged     — total_attended_30d ≥ 2 while on trial
 *
 * The transition tags (ended / converted) only fire on action='update'
 * because we need a previous status to compare. The threshold tags
 * fire on both 'create' and 'update' — writeContactTags handles
 * idempotency (skips already-active tags) so re-firing during a
 * no-op sync run is harmless.
 *
 * Pure function — input → output, no side effects. Caller passes the
 * result to writeContactTags.
 */
export function detectTrialTransitionTags({
  action,
  previousStatus,
  newStatus,
  currentCredits,
  currentAttended,
}) {
  const tags = []
  if (action === 'update') {
    if (previousStatus === 'trial' && newStatus === 'no_sale_trial') {
      tags.push('glofox_trial_ended')
    }
    if (previousStatus === 'trial' && (newStatus === 'member' || newStatus === 'credit_member')) {
      tags.push('glofox_trial_converted')
    }
  }
  if (newStatus === 'trial') {
    if (Number.isFinite(currentCredits) && currentCredits <= 1) {
      tags.push('glofox_trial_credits_low')
    }
    if (Number.isFinite(currentAttended) && currentAttended >= 2) {
      tags.push('glofox_trial_engaged')
    }
  }
  return tags
}

const MEMBER_STATUSES = new Set(['member', 'credit_member'])
const CONVERSION_CREATE_WINDOW_DAYS = 60

// True when joinedAt is a valid, non-future timestamp within the
// direct-join window — the "is this actually a fresh conversion?" gate.
function joinedWithinConversionWindow(joinedAt, now) {
  if (!joinedAt) return false
  const ms = now - new Date(joinedAt).getTime()
  return Number.isFinite(ms) && ms >= 0 && ms <= CONVERSION_CREATE_WINDOW_DAYS * 24 * 60 * 60 * 1000
}

/**
 * FUNNEL.1 — should this sync stamp contacts.converted_at?
 *
 * Write-once: never when already set. Update path: only on a real
 * transition INTO member/credit_member from a non-member status
 * (incl. classpass_payg and ex_member — any status flip into paying
 * counts; the classifier decides what the board shows). A NULL
 * previousStatus on the update path is NOT a transition — it's a
 * pre-existing CRM contact (web form / import) being linked to a
 * Glofox member for the first time, which may be a long-standing
 * member — so it takes the same join-recency gate as the create path.
 * Create path: a contact appearing for the first time already AS a
 * member is a direct join only if they joined recently — the nightly
 * full sync also creates unseen contacts, and stamping a 2022 member
 * as a fresh conversion would pollute the Converted column.
 *
 * Pure function — caller writes the timestamp.
 */
export function shouldStampConversion({ action, previousStatus, newStatus, existingConvertedAt, joinedAt, now = Date.now() }) {
  if (existingConvertedAt) return false
  if (!MEMBER_STATUSES.has(newStatus)) return false
  if (action === 'update') {
    if (MEMBER_STATUSES.has(previousStatus)) return false
    if (previousStatus == null) return joinedWithinConversionWindow(joinedAt, now)
    return true
  }
  if (action === 'create') return joinedWithinConversionWindow(joinedAt, now)
  return false
}

// FUNNEL.3 — statuses that can never be a Class Pack customer: members
// outrank the pack stage, ClassPass is a distinct motion, ex-members are
// winback targets.
const PACK_EXCLUDED_STATUSES = new Set(['member', 'credit_member', 'classpass_payg', 'ex_member'])
const PACK_CUSTOMER_MIN_CREDITS = 4 // trials are ≤3; mig-001 default of 3 stays harmless

/**
 * FUNNEL.3 — should this sync stamp contacts.pack_customer_at?
 *
 * Buying a class pack IS a conversion (operator decision 2026-07-03):
 * a non-member observed holding 4+ ACTIVE credits gets the durable
 * write-once stamp, which keeps them in the off-funnel pack_member
 * stage even after the pack runs out — pack customers never cycle
 * back into the acquisition funnel. Membership later supersedes the
 * stamp in the classifier, so no un-stamping is ever needed.
 *
 * Pure function — caller writes the timestamp.
 */
export function shouldStampPackCustomer({ newStatus, credits, existingPackCustomerAt }) {
  if (existingPackCustomerAt) return false
  if (PACK_EXCLUDED_STATUSES.has(newStatus)) return false
  return Number.isFinite(credits) && credits >= PACK_CUSTOMER_MIN_CREDITS
}

export function computeCreditsRemaining(credits) {
  if (!Array.isArray(credits) || credits.length === 0) return null
  const active = credits.filter(c => c?.active === true)
  if (active.length === 0) return null
  let total = 0
  let any = false
  for (const c of active) {
    let remaining
    if (Number.isFinite(c?.available)) {
      remaining = c.available
    } else if (Number.isFinite(c?.num_sessions)) {
      const used = Array.isArray(c.bookings) ? c.bookings.length : 0
      remaining = c.num_sessions - used
    } else {
      continue
    }
    if (remaining > 0) total += remaining
    any = true
  }
  return any ? total : null
}

/**
 * Pure check: does the Plan A context indicate a Credit Member?
 * Takes the raw member payload + a context object built by
 * buildCreditMemberContext (credits + memberships Map).
 *
 * Returns true only when the precondition + every-active-pack
 * check pass. Returns false when context is missing (degrades to
 * standard mapping path so we don't false-negative when the API
 * call to /credits failed).
 */
export function detectCreditMember(member, ctx) {
  if (!member || typeof member !== 'object') return false
  if (!ctx || !ctx.credits || !ctx.memberships) return false
  // Precondition — lead_status='MEMBER' + active=true.
  const leadStatus = String(member.lead_status || '').trim().toUpperCase()
  if (leadStatus !== 'MEMBER') return false
  if (member.active !== true) return false
  // Need at least one ACTIVE credit pack.
  const activePacks = ctx.credits.filter(c => c?.active === true)
  if (activePacks.length === 0) return false
  // Get unique membership_ids from active packs.
  const membershipIds = Array.from(new Set(
    activePacks.map(p => p?.membership_id).filter(Boolean),
  ))
  if (membershipIds.length === 0) return false
  // Every parent membership must be a Class Pack membership.
  return membershipIds.every(mid => isClassPackMembership(ctx.memberships.get(mid)))
}

/**
 * Normalise a raw Glofox status string to one of the canonicals,
 * or return null when it doesn't match. Tolerates:
 *   - case  ("MEMBER" / "member" / "Member")
 *   - spaces, dashes, dots in place of underscores
 *   - the portal label form: "No Sale (Tour)" → no_sale_tour
 *   - smushed forms: "NoSale_Trial" → no_sale_trial
 */
function normalizeGlofoxStatus(raw) {
  if (raw == null) return null
  let s = String(raw).trim().toLowerCase()
  if (!s) return null
  // Drop parens, normalise separators, collapse runs.
  s = s.replace(/[()]/g, '')
       .replace(/[\s\-.]+/g, '_')
       .replace(/_+/g, '_')
       .replace(/^_|_$/g, '')
  // Common smushed-form aliases.
  if (s === 'nosale_trial' || s === 'no_sale_trial') return 'no_sale_trial'
  if (s === 'nosale_tour'  || s === 'no_sale_tour')  return 'no_sale_tour'
  return CANONICAL_GLOFOX_STATUSES.has(s) ? s : null
}

/**
 * Map a Glofox member payload to one of the canonical statuses.
 * Order of resolution:
 *
 *   1. ClassPass PAYG detection (origin + membership.type=payg).
 *      Glofox tags these as lead_status='LEAD' which conflates them
 *      with fresh leads — so we synthesise.
 *      - active=true  → 'classpass_payg' (warm upsell)
 *      - active=false → 'ex_member'      (collapsed with churn)
 *
 *   2. Credit Member detection (GLOFOX2.1.11 — Plan A) when ctx is
 *      provided. Requires lead_status='MEMBER' + active=true + ALL
 *      active credit packs from non-trial Class-Pack memberships.
 *      Skipped when ctx is missing (caller didn't fetch credits) so
 *      callers that don't need richer detection (tests, legacy code)
 *      still work.
 *
 *   3. lead_status / leads.status / membership.status (the various
 *      shapes Glofox uses across endpoints) → normalise.
 *
 *   4. If the normalised result is 'member' AND the top-level
 *      `active` boolean is false → synthesise 'ex_member'. This is
 *      how Glofox marks a lapsed subscription member.
 *
 *   5. Default 'lead' so unrecognised payloads still land in the
 *      pipeline at new_lead rather than vanishing.
 *
 * @param {object} member  Glofox member payload (e.g., from GET /members/{id})
 * @param {object} [ctx]   Optional Plan A context. Shape:
 *                         { credits: Credits[], memberships: Map<id, Membership> }
 *                         When omitted, credit_member detection is skipped.
 */
export function mapMembershipStatus(member, ctx = null) {
  if (!member || typeof member !== 'object') return 'lead'
  // Step 1 — ClassPass PAYG (Glofox loses signal as 'LEAD').
  if (isClassPassPayg(member)) {
    return member.active === false ? 'ex_member' : 'classpass_payg'
  }
  // Step 2 — Credit Member (Plan A). Requires ctx; falls through
  // to the standard path when ctx is missing or detection fails.
  if (ctx && detectCreditMember(member, ctx)) {
    return 'credit_member'
  }
  // Step 3/4 — standard path.
  const raw = pluck(member, MEMBERSHIP_STATUS_PATHS)
  const normalized = normalizeGlofoxStatus(raw)
  if (normalized === 'member' && member.active === false) {
    return 'ex_member'
  }
  if (normalized) return normalized
  // Step 5 — fallback.
  return 'lead'
}

// ─────────────────────────────────────────────────────────────
// Match-or-create
// ─────────────────────────────────────────────────────────────
//
// The lookup logic mirrors contact-import-runner.js (which uses
// the same precedence: glofox_member_id first, then email). We
// scope to the location we're syncing for so a member at one
// location can't accidentally merge into a contact at another.

export async function findExistingContact(db, locationId, mapped) {
  if (!db || !locationId || !mapped) return { byGlofox: null, byEmail: null }
  // Lookup by glofox_member_id and email in parallel.
  // PIPELINE-FLAP.2 — last_payment_at, created_at and
  // glofox_membership_{state,expiry} are selected so the classifier inputs
  // (proposed-stage in previewMemberSync AND the apply-path snapshot in
  // applyMemberSync) can fall back to the PERSISTED row when a LIST /
  // skipBookings sync doesn't (re)compute recency. Without these columns a
  // blank live value collapsed recency to null and demoted recently-active,
  // paid-up members to dormant — flapping against the nightly classifier
  // (pipeline-reclassify), which reads the same persisted columns.
  // FUNNEL.1 — recent_bookings + converted_at join the persisted-fallback
  // set: the funnel classifier counts attended classes from recent_bookings
  // and gates the Converted column on converted_at, and a LIST/skipBookings
  // sync doesn't recompute either.
  const SELECT_COLS = 'id, email, first_name, last_name, phone, dob, joined_at, created_at, glofox_member_id, gympass_member_id, glofox_membership_status, glofox_membership_state, glofox_membership_expiry, lead_source, last_booked_at, last_attended_at, last_payment_at, total_bookings_30d, total_attended_30d, total_attended_7d, total_noshow_30d, trial_credits_remaining, recent_bookings, converted_at, pack_customer_at, pipeline_dismissed_at, last_lead_source_at'
  const queries = []
  queries.push(
    db.from('contacts')
      .select(SELECT_COLS)
      .eq('location_id', locationId)
      .eq('glofox_member_id', mapped.glofox_member_id)
      .limit(1)
  )
  if (mapped.email) {
    queries.push(
      db.from('contacts')
        .select(SELECT_COLS)
        .eq('location_id', locationId)
        .eq('email', mapped.email)
        .limit(1)
    )
  }
  const results = await Promise.all(queries)
  return {
    byGlofox: results[0]?.data?.[0] || null,
    byEmail:  results[1]?.data?.[0] || null,
  }
}

// ─────────────────────────────────────────────────────────────
// Preview — what would the sync do, without writing
// ─────────────────────────────────────────────────────────────
//
// Returns a structured object the operator inspects before
// deciding to apply. Three terminal states:
//
//   { action: 'create',  changes }                — new contact
//   { action: 'update',  existing_id, changes }   — merge into existing
//   { action: 'ambiguous', conflicts }            — refuse (different
//                                                    contacts match by
//                                                    id and by email)
//
// 'changes' is a per-field record { from, to } so the diff is
// obvious in the dry-run JSON.

// ─────────────────────────────────────────────────────────────
// Interactions sync (GLOFOX2.1.15 — Tier 1 #2)
// ─────────────────────────────────────────────────────────────
//
// Pull Glofox interactions into the CRM activity timeline so
// front-desk touchpoints show up alongside CRM-side ones.
//
// Mapping Glofox Interaction.type → CRM activities.type:
//   NOTE                  → 'note'
//   CALLED_AND_CONNECTED  → 'call'    (subject: "Call (connected)")
//   CALLED_AND_NO_ANSWER  → 'call'    (subject: "Call (no answer)")
//   MANUAL_EMAIL          → 'email'

const INTERACTION_TYPE_MAP = {
  NOTE:                   { type: 'note',  subject: 'Note' },
  CALLED_AND_CONNECTED:   { type: 'call',  subject: 'Call (connected)' },
  CALLED_AND_NO_ANSWER:   { type: 'call',  subject: 'Call (no answer)' },
  MANUAL_EMAIL:           { type: 'email', subject: 'Manual email' },
}

/**
 * Map a Glofox Interaction object into the CRM activity row shape
 * we want to upsert. Returns null when the interaction is missing
 * required fields (no _id, unknown type).
 *
 * Pure function — no DB. Caller does the upsert.
 */
export function mapGlofoxInteraction(interaction, contactId, locationId) {
  if (!interaction || typeof interaction !== 'object') return null
  if (!interaction._id) return null
  const typeKey = String(interaction.type || '').trim().toUpperCase()
  const mapping = INTERACTION_TYPE_MAP[typeKey]
  if (!mapping) return null
  // created is Unix seconds per spec — convert to ISO TIMESTAMPTZ.
  let createdAt = null
  if (typeof interaction.created === 'number' && Number.isFinite(interaction.created)) {
    let secs = interaction.created
    if (secs > 10_000_000_000) secs = Math.floor(secs / 1000)
    if (secs >= 946_684_800 && secs <= 4_102_444_800) {
      createdAt = new Date(secs * 1000).toISOString()
    }
  }
  return {
    contact_id: contactId,
    location_id: locationId,
    type: mapping.type,
    subject: mapping.subject,
    note: typeof interaction.description === 'string' ? interaction.description : null,
    done: true,                    // Glofox interactions are always already-done
    source: 'glofox',
    glofox_interaction_id: String(interaction._id),
    // created_at preserved as the Glofox-side timestamp so the
    // activity timeline shows the touchpoint when it actually
    // happened, not when we synced it.
    created_at: createdAt,
  }
}

/**
 * Upsert a list of Glofox interactions into the CRM activities
 * table. Idempotent via glofox_interaction_id (UNIQUE partial
 * index in mig 138). Re-running this for the same member converges
 * — no duplicates created, but description updates land if the
 * front-desk team edited the note.
 *
 * Returns { synced, skipped, errors } counts so the operator-facing
 * dry-run preview can show what happened.
 */
export async function syncGlofoxInteractions(db, locationId, contactId, interactions) {
  const result = { synced: 0, skipped: 0, errors: 0, reconciled: 0 }
  if (!db || !contactId || !locationId || !Array.isArray(interactions)) return result

  // GLOFOX-NOTES — load this contact's outbound pushes so we can recognise and
  // suppress our own echoes (a pushed note comes back on the inbound pull).
  // Unreconciled rows are fingerprint-matched; already-claimed ids are skipped
  // on every later run. Ledger unavailable → behave exactly as before.
  const unreconciled = []
  const claimedIds = new Set()
  try {
    const { data: pushes } = await db
      .from('glofox_note_pushes')
      .select('id, contact_id, type, description, pushed_at, glofox_interaction_id')
      .eq('contact_id', contactId)
    for (const p of pushes || []) {
      if (p.glofox_interaction_id) claimedIds.add(String(p.glofox_interaction_id))
      else unreconciled.push(p)
    }
  } catch { /* no reconciliation, fall through to plain upsert */ }

  for (const i of interactions) {
    // (a) already claimed as ours on a previous run → never re-import.
    if (i && i._id && claimedIds.has(String(i._id))) { result.skipped++; continue }

    // (b) first sight of our echo → claim the ledger row, suppress the dupe.
    const matchIdx = unreconciled.findIndex((p) => matchesPush(i, p, contactId))
    if (matchIdx !== -1) {
      const push = unreconciled[matchIdx]
      // supabase-js RESOLVES with { error } on a DB-level failure (RLS,
      // constraint, …) — it does not reject. Check the resolved error so a
      // silently-failed claim is NOT counted as reconciled and does NOT fall
      // through to the upsert (that recreates the duplicate we suppress).
      const { error: claimErr } = await db.from('glofox_note_pushes')
        .update({ glofox_interaction_id: String(i._id), status: 'reconciled' })
        .eq('id', push.id)
      if (claimErr) {
        // Claim didn't persist — leave the push unreconciled (retry next sync)
        // and DON'T upsert (avoid the duplicate). Count as an error.
        result.errors++
      } else {
        unreconciled.splice(matchIdx, 1)
        result.reconciled++
      }
      continue
    }

    // (c) genuine Glofox-originated interaction → upsert into activities.
    const row = mapGlofoxInteraction(i, contactId, locationId)
    if (!row) { result.skipped++; continue }
    const { error } = await db.from('activities').upsert(row, { onConflict: 'glofox_interaction_id' })
    if (error) result.errors++
    else result.synced++
  }
  return result
}

// ─────────────────────────────────────────────────────────────
// Booking aggregates (GLOFOX2.1.14 — Tier 1 #1)
// ─────────────────────────────────────────────────────────────
//
// Compute engagement signals from a member's recent bookings:
//   - last_booked_at       max(booking.created)
//   - last_attended_at     max(booking.time_start where attended)
//   - total_bookings_30d   bookings created in last 30d (any status)
//   - total_attended_30d   bookings attended in last 30d
//   - total_noshow_30d     no-shows in last 30d
//                          (status=BOOKED, time_start in past, not attended)
//
// Pure function — caller fetches bookings (fetchUserBookings),
// passes them in. Designed to be called from per-member sync,
// daily cron, AND webhook handler so all paths converge to the
// same aggregates.

/**
 * Trim the most-recent N bookings to the shape we want to store
 * on contacts.recent_bookings JSONB. Caller passes the same list
 * used for the aggregate computation; we drop fields the UI
 * doesn't need (paid, image_url, etc.) to keep the JSONB small.
 *
 * Sorted by time_start descending (most recent class first), so
 * the contact-page UI can render directly.
 */
export function trimRecentBookings(bookings, limit = 10) {
  if (!Array.isArray(bookings) || bookings.length === 0) return []
  const sliced = bookings
    .filter(b => b && typeof b === 'object')
    .slice() // don't mutate caller
    .sort((a, b) => (Number(b.time_start) || 0) - (Number(a.time_start) || 0))
    .slice(0, limit)
  return sliced.map(b => ({
    glofox_id:   b._id || null,
    event_name:  b.event_name || null,
    model_name:  b.model_name || null,
    model:       b.model || null,
    time_start:  Number(b.time_start) || null,
    created:     Number(b.created) || null,
    status:      typeof b.status === 'string' ? b.status.toUpperCase() : null,
    attended:    b.attended === true,
    duration:    Number(b.duration) || null,
  }))
}

/**
 * Compute booking aggregates from a list of Glofox Booking objects.
 * Returns the shape stored on contacts (timestamps as ISO strings,
 * counts as integers).
 *
 * @param {Array} bookings  Array of Booking shapes per /2.0/bookings.
 *                          Expected fields: created, time_start,
 *                          attended (bool), status (BOOKED/CANCELED).
 * @param {number} [now]    Timestamp in millis for "now" — overridable
 *                          for deterministic tests.
 */
export function computeBookingAggregates(bookings, now = Date.now()) {
  const empty = {
    last_booked_at: null,
    last_attended_at: null,
    total_bookings_30d: 0,
    total_attended_30d: 0,
    total_attended_7d: 0,   // PIPELINE5.3 — Hot Conversion signal
    total_noshow_30d: 0,
  }
  if (!Array.isArray(bookings) || bookings.length === 0) return empty
  const nowSec = Math.floor(now / 1000)
  const cutoff7d  = nowSec - 7  * 24 * 60 * 60
  const cutoff30d = nowSec - 30 * 24 * 60 * 60
  let lastBookedSec = 0
  let lastAttendedSec = 0
  let bookings30d = 0
  let attended30d = 0
  let attended7d  = 0
  let noshow30d = 0
  for (const b of bookings) {
    if (!b || typeof b !== 'object') continue
    const created = Number(b.created) || 0
    const timeStart = Number(b.time_start) || 0
    const attended = b.attended === true
    const status = typeof b.status === 'string' ? b.status.toUpperCase() : ''
    // last_booked_at — most recent booking-row creation (any status).
    if (created > lastBookedSec) lastBookedSec = created
    // last_attended_at — most recent class start where they attended.
    if (attended && timeStart > lastAttendedSec) lastAttendedSec = timeStart
    // 30-day rollups, scoped by booking creation time.
    if (created >= cutoff30d) bookings30d++
    if (attended && timeStart >= cutoff30d && timeStart <= nowSec) {
      attended30d++
    }
    // PIPELINE5.3 — 7-day attended count. Drives the Hot Conversion
    // classifier signal (≥2 classes in last 7d). Same gating as the
    // 30d count but a tighter window — counts attended classes
    // whose start time fell in the last 7 days.
    if (attended && timeStart >= cutoff7d && timeStart <= nowSec) {
      attended7d++
    }
    // No-show: status=BOOKED, class already happened (time_start in
    // past), but they didn't attend. Excludes CANCELED (member
    // cancelled in advance — not a no-show).
    if (status === 'BOOKED' && !attended && timeStart > 0 && timeStart <= nowSec
        && timeStart >= cutoff30d) {
      noshow30d++
    }
  }
  return {
    last_booked_at: lastBookedSec ? new Date(lastBookedSec * 1000).toISOString() : null,
    last_attended_at: lastAttendedSec ? new Date(lastAttendedSec * 1000).toISOString() : null,
    total_bookings_30d: bookings30d,
    total_attended_30d: attended30d,
    total_attended_7d: attended7d,
    total_noshow_30d: noshow30d,
  }
}

/**
 * Merge freshly-computed booking aggregates into a contact-update
 * patch — the safe way to apply computeBookingAggregates() output.
 *
 * The 7-/30-day COUNTS are windowed by definition, so they always
 * take the fresh value (an empty window legitimately means 0).
 *
 * The last_attended_at / last_booked_at TIMESTAMPS are advance-only:
 * a fresh value only wins if it is newer than what's already stored.
 * This is the fix for the bug where a short fetch window (e.g. the
 * 30-day default) returns no recent bookings for a member who simply
 * hasn't trained lately, computeBookingAggregates returns null, and
 * the caller writes that null straight over a real historical date —
 * wiping it. ISO-8601 strings compare correctly with `>`.
 *
 * @param {object|null} existing  the contact's current row (needs
 *                                last_attended_at / last_booked_at)
 * @param {object} fresh          a computeBookingAggregates() result
 * @returns {object} a patch — counts always, timestamps only when newer
 */
export function mergeBookingAggregates(existing, fresh) {
  const patch = {
    total_bookings_30d: fresh.total_bookings_30d,
    total_attended_30d: fresh.total_attended_30d,
    total_attended_7d:  fresh.total_attended_7d,
    total_noshow_30d:   fresh.total_noshow_30d,
  }
  if (fresh.last_attended_at &&
      (!existing?.last_attended_at || fresh.last_attended_at > existing.last_attended_at)) {
    patch.last_attended_at = fresh.last_attended_at
  }
  if (fresh.last_booked_at &&
      (!existing?.last_booked_at || fresh.last_booked_at > existing.last_booked_at)) {
    patch.last_booked_at = fresh.last_booked_at
  }
  return patch
}

/**
 * Build the Plan A context for credit_member detection. Fetches
 * the member's credit packs from /2.0/credits, then resolves each
 * unique active pack's parent Membership via /2.0/memberships/{id}
 * (cached across the sync run).
 *
 * Best-effort: failures during fetch return an empty/partial ctx
 * so the caller can still proceed with standard mapping. Caller
 * passes the optional `membershipCache` Map to share across many
 * member syncs in a bulk run (the Class Packs membership is the
 * same object for every Credit Member).
 */
export async function buildCreditMemberContext(creds, member, membershipCache = null) {
  if (!creds || !member) return { credits: [], memberships: new Map() }
  const memberId = member._id || member.id || member.member_id
  if (!memberId) return { credits: [], memberships: new Map() }
  const credits = await fetchUserCredits(creds, memberId)
  const cache = membershipCache || new Map()
  // Only resolve memberships for ACTIVE packs — saves API calls
  // when historical packs are present.
  const uniqueIds = Array.from(new Set(
    credits.filter(c => c?.active === true).map(c => c?.membership_id).filter(Boolean),
  ))
  for (const mid of uniqueIds) {
    await fetchMembership(creds, mid, cache)
  }
  return { credits, memberships: cache }
}

// GLOFOX-DETAIL (2026-05-30) — the rich membership detail fields that
// the single-member GET (/2.0/members/:id) carries on member.membership.
// Written on the SHARED sync write-path (previewMemberSync/applyMemberSync)
// so the webhook re-fetch keeps them fresh in near-real-time, matching the
// set the attendance-refresh cron already writes. The bulk LIST payload
// (nightly glofox-sync) omits member.membership, so we GUARD every write on
// its presence — the list-sync can never null out detail captured elsewhere.
const GLOFOX_DETAIL_KEYS = [
  'glofox_membership_plan', 'glofox_membership_plan_full', 'glofox_membership_state', 'glofox_membership_type',
  'glofox_membership_expiry', 'glofox_membership_price_cents', 'glofox_billing_interval',
  'glofox_payment_method', 'glofox_account_active', 'glofox_source', 'glofox_image_url',
  'gender', 'emergency_contact', 'glofox_signup_answers', 'glofox_roaming_enabled',
  'gympass_member_id',
]

// Detail keys the MEMBER owns via the champ-app profile wizard
// (/api/me/body-metrics writes contacts.gender). Glofox may carry the
// same field but frequently has it blank/'not_specified' — the sync must
// never NULL out a value the member set. Fill-when-empty and genuine value
// updates still flow; only null-clobber is suppressed.
const MEMBER_OWNED_DETAIL_KEYS = new Set(['gender'])

export async function previewMemberSync(db, locationId, member, opts = {}) {
  // GLOFOX2.1.11 — build the Plan A context (credits + parent
  // memberships) when creds are provided. Without creds, we degrade
  // to standard mapping (no credit_member detection) — happens for
  // legacy callers, tests with mock dbs, etc.
  let ctx = null
  if (opts.creds) {
    ctx = await buildCreditMemberContext(opts.creds, member, opts.membershipCache)
  } else if (opts.ctx) {
    ctx = opts.ctx
  }
  const mapped = mapGlofoxMember(member, ctx)
  if (!mapped) {
    return { action: 'invalid', reason: 'Could not extract glofox_member_id from payload', mapped: null }
  }

  // GLOFOX2.6 — sync the live credit balance to the contact.
  // trial_credits_remaining historically defaulted to 3 from
  // mig 001 and was operator-edited; from now on Glofox is the
  // source of truth for any contact with a glofox_member_id. Sum
  // 'available' across active credit packs (data we already
  // fetched for credit_member detection — zero extra API cost).
  if (ctx?.credits) {
    mapped.trial_credits_remaining = computeCreditsRemaining(ctx.credits)
  }

  // GLOFOX-DETAIL — attach membership detail to `mapped` when the payload
  // is the single-member shape (has member.membership). extractMember* are
  // pure; on the LIST payload member.membership is absent so we skip,
  // leaving any previously-captured detail untouched.
  const hasMembershipDetail = !!(member && typeof member === 'object'
    && member.membership && typeof member.membership === 'object')
  if (hasMembershipDetail) {
    mapped.glofox_membership_plan      = extractMembershipPlan(member)
    mapped.glofox_membership_plan_full = extractMembershipPlanFull(member)
    mapped.glofox_membership_state     = extractMembershipState(member)
    Object.assign(mapped, extractMemberProfile(member))
  }

  // GLOFOX2.1.14 — booking aggregates. Fetched alongside credits when
  // creds are provided. Caller can short-circuit by passing
  // opts.bookings (pre-fetched list) or opts.skipBookings (e.g., for
  // the bulk cron that pulls per-branch bookings in one shot instead
  // of one call per member).
  let bookingAggs = null
  let bookingsList = null
  if (opts.bookings !== undefined) {
    bookingsList = opts.bookings
    bookingAggs = computeBookingAggregates(opts.bookings)
  } else if (opts.creds && !opts.skipBookings) {
    const memberId = member._id || member.id
    if (memberId) {
      bookingsList = await fetchUserBookings(opts.creds, memberId)
      bookingAggs = computeBookingAggregates(bookingsList)
    }
  }
  if (bookingAggs) {
    mapped.last_booked_at      = bookingAggs.last_booked_at
    mapped.last_attended_at    = bookingAggs.last_attended_at
    mapped.total_bookings_30d  = bookingAggs.total_bookings_30d
    mapped.total_attended_30d  = bookingAggs.total_attended_30d
    mapped.total_attended_7d   = bookingAggs.total_attended_7d
    mapped.total_noshow_30d    = bookingAggs.total_noshow_30d
    // GLOFOX2.1.18 — last 10 bookings for the contact-page history view.
    mapped.recent_bookings = trimRecentBookings(bookingsList, 10)
    // HR-CLASS-ALLOC.2 — stash the raw bookings (non-persisted) so applyMemberSync
    // can refresh this member's class_bookings roster slice. applyMemberSync lifts
    // it off + deletes it before any return, so it never leaks into a dry-run
    // preview response, and the explicit-allowlist contacts write never persists it.
    mapped.__bookings_list = bookingsList
  }

  // GLOFOX2.1.15 — interactions. Fetched alongside credits/bookings
  // when creds provided. Preview returns the COUNT only; the actual
  // upsert happens in applyMemberSync (so dry-run never writes
  // activities). Caller can short-circuit with opts.interactions
  // (pre-fetched) or opts.skipInteractions.
  let interactions = null
  if (opts.interactions !== undefined) {
    interactions = opts.interactions
  } else if (opts.creds && !opts.skipInteractions) {
    const memberId = member._id || member.id
    if (memberId) {
      interactions = await fetchUserInteractions(opts.creds, memberId)
    }
  }
  if (interactions) {
    // Stash on the preview output so applyMemberSync can re-use
    // them without re-fetching, and dry-run can show the count.
    mapped._glofox_interactions = interactions
  }

  const { byGlofox, byEmail } = await findExistingContact(db, locationId, mapped)
  const existingRow = byGlofox || byEmail
  // PIPELINE5.4 — proposed pipeline placement comes from the
  // unified classifier (status × engagement × recency), not just
  // glofox_membership_status. Computed from the post-sync mapped
  // values so the dry-run preview matches what apply will actually
  // do.
  // PIPELINE-FLAP.2 — every recency / live-membership signal falls back to
  // the PERSISTED row when the mapped (live-sync) value is blank. A LIST or
  // skipBookings sync doesn't (re)compute last_attended_at / membership
  // detail, so without the fallback those collapse to null and a
  // recently-active, paid-up member is wrongly demoted to dormant — flapping
  // against pipeline-reclassify (the nightly cron), which classifies off the
  // SAME persisted columns. The two classifiers must consume the same source.
  const proposedStageSlug = classifyContact({
    glofox_membership_status: mapped.glofox_membership_status,
    glofox_membership_state: mapped.glofox_membership_state ?? existingRow?.glofox_membership_state ?? null,
    glofox_membership_expiry: mapped.glofox_membership_expiry ?? existingRow?.glofox_membership_expiry ?? null,
    last_attended_at: mapped.last_attended_at ?? existingRow?.last_attended_at ?? null,
    total_attended_7d: mapped.total_attended_7d ?? existingRow?.total_attended_7d ?? 0,
    total_attended_30d: mapped.total_attended_30d ?? existingRow?.total_attended_30d ?? 0,
    last_payment_at: mapped.last_payment_at ?? existingRow?.last_payment_at ?? null,
    joined_at: mapped.joined_at ?? existingRow?.joined_at ?? null,
    created_at: existingRow?.created_at ?? null,
    trial_credits_remaining: mapped.trial_credits_remaining ?? existingRow?.trial_credits_remaining ?? null,
    // FUNNEL.1 — the funnel classifier counts attended classes from
    // recent_bookings and gates the Converted column on converted_at.
    recent_bookings: mapped.recent_bookings ?? existingRow?.recent_bookings ?? null,
    // Preview can't know about a not-yet-written stamp (apply stamps it);
    // the persisted value is the best dry-run signal. Same for the
    // FUNNEL.3 pack stamp — though live credits ≥4 also classify to
    // pack_member, so a brand-new pack still previews correctly.
    converted_at: existingRow?.converted_at ?? null,
    pack_customer_at: existingRow?.pack_customer_at ?? null,
    // FUNNEL.4 — operator Cold dismissal (persisted; never touched by sync).
    pipeline_dismissed_at: existingRow?.pipeline_dismissed_at ?? null,
    // GYMPASS.2 — off-funnel gympass pile; mapped value or persisted fallback.
    gympass_member_id: mapped.gympass_member_id ?? existingRow?.gympass_member_id ?? null,
  })

  // Ambiguous: same email already linked to a DIFFERENT glofox member.
  if (byGlofox && byEmail && byGlofox.id !== byEmail.id) {
    return {
      action: 'ambiguous',
      mapped,
      conflicts: {
        contact_matched_by_glofox_id: { id: byGlofox.id, email: byGlofox.email, glofox_member_id: byGlofox.glofox_member_id },
        contact_matched_by_email:     { id: byEmail.id,  email: byEmail.email,  glofox_member_id: byEmail.glofox_member_id },
      },
      reason: 'Two CRM contacts match — one by glofox_member_id, another by email. Manually merge in the CRM, then re-run.',
    }
  }

  const existing = byGlofox || byEmail
  if (!existing) {
    // CREATE path — uses the mapped lead_source (Glofox source
    // → leadSourceSchema enum). Falls back to 'other' when
    // Glofox didn't tell us where the contact came from.
    return {
      action: 'create',
      mapped,
      changes: {
        glofox_member_id:         { from: null, to: mapped.glofox_member_id },
        email:                    { from: null, to: mapped.email },
        first_name:               { from: null, to: mapped.first_name },
        last_name:                { from: null, to: mapped.last_name },
        phone:                    { from: null, to: mapped.phone },
        name:                     { from: null, to: mapped.name },
        dob:                      { from: null, to: mapped.dob },
        joined_at:                { from: null, to: mapped.joined_at },
        glofox_membership_status: { from: null, to: mapped.glofox_membership_status },
        lead_source:              { from: null, to: mapped.lead_source },
        ...(mapped.trial_credits_remaining != null
          ? { trial_credits_remaining: { from: null, to: mapped.trial_credits_remaining } }
          : {}),
        ...(bookingAggs ? {
          last_booked_at:        { from: null, to: bookingAggs.last_booked_at },
          last_attended_at:      { from: null, to: bookingAggs.last_attended_at },
          total_bookings_30d:    { from: null, to: bookingAggs.total_bookings_30d },
          total_attended_30d:    { from: null, to: bookingAggs.total_attended_30d },
          total_attended_7d:     { from: null, to: bookingAggs.total_attended_7d },
          total_noshow_30d:      { from: null, to: bookingAggs.total_noshow_30d },
        } : {}),
      },
      // GLOFOX2.1.3 — fresh contact = no existing deal, so we'll
      // create one. Operator sees the stage slug in the dry-run.
      deal_action: { action: 'create', stage_slug: proposedStageSlug },
      interactions_to_sync: interactions ? interactions.length : 0,
    }
  }

  // UPDATE path — Glofox is source of truth for the sync-owned
  // fields; for the seed fields (first_name / last_name / phone /
  // dob) we only write when CRM is empty so operator edits aren't
  // clobbered. lead_source is NEVER updated post-create — operator
  // may have re-categorised the contact and that wins.
  const changes = {}
  if (existing.glofox_member_id !== mapped.glofox_member_id) {
    changes.glofox_member_id = { from: existing.glofox_member_id, to: mapped.glofox_member_id }
  }
  if (existing.glofox_membership_status !== mapped.glofox_membership_status) {
    changes.glofox_membership_status = {
      from: existing.glofox_membership_status,
      to: mapped.glofox_membership_status,
    }
  }
  if (!existing.first_name && mapped.first_name) {
    changes.first_name = { from: existing.first_name, to: mapped.first_name }
  }
  if (!existing.last_name && mapped.last_name) {
    changes.last_name = { from: existing.last_name, to: mapped.last_name }
  }
  if (!existing.phone && mapped.phone) {
    changes.phone = { from: existing.phone, to: mapped.phone }
  }
  if (!existing.dob && mapped.dob) {
    changes.dob = { from: existing.dob, to: mapped.dob }
  }
  // GLOFOX2.1.13 — joined_at writes when CRM is empty AND when
  // Glofox has a backdated joined_at that's earlier than what we
  // currently have (operator just did an import-with-history).
  // Otherwise leave the existing value alone (don't churn it).
  if (mapped.joined_at) {
    const existingTs = existing.joined_at ? new Date(existing.joined_at).getTime() : null
    const mappedTs = new Date(mapped.joined_at).getTime()
    if (existingTs == null || (Number.isFinite(mappedTs) && mappedTs < existingTs)) {
      changes.joined_at = { from: existing.joined_at, to: mapped.joined_at }
    }
  }
  // GLOFOX2.6 — credit balance is overwritten when we have credit
  // context. Glofox is source of truth. Operator manual edits to
  // trial_credits_remaining on Glofox-linked contacts will be
  // overwritten on next sync — by design (the operator should comp
  // credits in Glofox, not in the CRM).
  if (ctx?.credits) {
    const newRemaining = mapped.trial_credits_remaining
    if (newRemaining !== existing.trial_credits_remaining) {
      changes.trial_credits_remaining = {
        from: existing.trial_credits_remaining ?? null,
        to: newRemaining,
      }
    }
  }

  // GLOFOX-DETAIL — diff the membership detail fields (only present on
  // `mapped` when this is the single-member payload). Glofox is source of
  // truth for these; null-vs-value diffs surface in the operator dry-run.
  for (const k of GLOFOX_DETAIL_KEYS) {
    if (!(k in mapped)) continue
    const before = existing[k] ?? null
    const after = mapped[k] ?? null
    // MEMBER-OWNED — never overwrite a value the member set in the app
    // with a Glofox null (Glofox often has gender blank/'not_specified').
    if (MEMBER_OWNED_DETAIL_KEYS.has(k) && after === null && before !== null) continue
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes[k] = { from: before, to: after }
    }
  }

  // GLOFOX2.1.14 — booking aggregates always overwrite when fetched
  // (full recompute is the source of truth; cron is the safety net
  // that corrects any webhook-counter drift).
  if (bookingAggs) {
    changes.last_booked_at        = { from: existing.last_booked_at ?? null,        to: bookingAggs.last_booked_at }
    changes.last_attended_at      = { from: existing.last_attended_at ?? null,      to: bookingAggs.last_attended_at }
    changes.total_bookings_30d    = { from: existing.total_bookings_30d ?? 0,       to: bookingAggs.total_bookings_30d }
    changes.total_attended_30d    = { from: existing.total_attended_30d ?? 0,       to: bookingAggs.total_attended_30d }
    changes.total_attended_7d     = { from: existing.total_attended_7d ?? 0,        to: bookingAggs.total_attended_7d }
    changes.total_noshow_30d      = { from: existing.total_noshow_30d ?? 0,         to: bookingAggs.total_noshow_30d }
    // GLOFOX2.1.18 — recent_bookings JSONB diff is too verbose for
    // the operator preview; surface a lightweight indicator instead.
    changes.recent_bookings       = { from: '<previous list>', to: `${mapped.recent_bookings?.length || 0} booking(s)` }
  }

  // Always stamp synced_at — but represent in the diff so the
  // operator sees we will touch the row.
  changes.glofox_synced_at = { from: 'previous timestamp', to: 'now' }

  // PIPELINE5.4 — deal action driven by the classifier (status ×
  // engagement × recency). The proposedStageSlug computed above
  // already used classifyContact; we just compare it against the
  // open deal's current stage to decide create / move / leave.
  // Idempotent: classifier returns the same slug for the same
  // input, so a no-op sync produces 'leave'.
  const previousStatus = existing.glofox_membership_status
  const newStatus = mapped.glofox_membership_status
  const openDeal = await getOpenDealWithStage(db, existing.id)
  let dealAction
  if (!openDeal) {
    // No deal yet → backfill at the classifier's target.
    dealAction = { action: 'create', stage_slug: proposedStageSlug }
  } else if (openDeal.stage_slug !== proposedStageSlug) {
    dealAction = {
      action: 'move',
      deal_id: openDeal.id,
      from_slug: openDeal.stage_slug,
      to_slug: proposedStageSlug,
      previous_status: previousStatus,
      new_status: newStatus,
    }
  } else {
    let reason
    if (previousStatus === newStatus) reason = 'classifier output unchanged'
    else reason = 'classifier maps both statuses to the same stage'
    dealAction = {
      action: 'leave',
      deal_id: openDeal.id,
      stage_slug: openDeal.stage_slug,
      previous_status: previousStatus,
      new_status: newStatus,
      reason,
    }
  }

  return {
    action: 'update',
    existing_id: existing.id,
    // PIPELINE-FLAP.2 — expose the matched persisted row so applyMemberSync's
    // reclassify snapshot can fall back to its recency columns
    // (last_attended_at / last_payment_at) when the live-sync `mapped` value
    // is blank. Previously this key didn't exist, so the
    // `?? preview.existing?.last_*` fallbacks in the apply snapshot were dead
    // (undefined → null) and the deal flapped to dormant.
    existing,
    mapped,
    changes,
    deal_action: dealAction,
    interactions_to_sync: interactions ? interactions.length : 0,
  }
}

// ─────────────────────────────────────────────────────────────
// Apply — actually write the change
// ─────────────────────────────────────────────────────────────
//
// Calls preview first so we never write on the ambiguous path.
// Returns { action, contact_id } or { action: 'ambiguous', ... }.

export async function applyMemberSync(db, locationId, member, opts = {}) {
  const preview = await previewMemberSync(db, locationId, member, opts)
  if (preview.action === 'invalid' || preview.action === 'ambiguous') return preview
  // HR-CLASS-ALLOC.2 — lift the stashed raw bookings off the preview before any
  // further work so it can't ride along on a returned preview object.
  const bookingsForRoster = Array.isArray(preview.mapped?.__bookings_list) ? preview.mapped.__bookings_list : null
  if (preview.mapped) delete preview.mapped.__bookings_list
  const now = new Date().toISOString()

  // GLOFOX2.1.5 — capture previousStatus BEFORE we overwrite the
  // contact row. The deal-transition rule keys off the (previous,
  // new) status pair, so we need to know what was there. If the
  // status didn't change, preview.changes won't include the key —
  // in that case previous === new (a re-sync). If the status did
  // change, .from carries the old value (which may legitimately
  // be null for contacts pre-existing without a Glofox link).
  const newStatus = preview.mapped.glofox_membership_status
  const previousStatus = preview.action === 'update'
    ? ('glofox_membership_status' in (preview.changes || {})
        ? preview.changes.glofox_membership_status.from
        : newStatus)
    : null

  let contactId
  if (preview.action === 'create') {
    const m = preview.mapped
    const { data, error } = await db.from('contacts').insert({
      location_id: locationId,
      glofox_member_id: m.glofox_member_id,
      email: m.email,
      first_name: m.first_name,
      last_name: m.last_name,
      phone: m.phone,
      name: m.name,
      dob: m.dob,
      joined_at: m.joined_at,
      glofox_membership_status: m.glofox_membership_status,
      glofox_synced_at: now,
      lead_source: m.lead_source,
      // GLOFOX2.6 + 3-followup — credit balance from Glofox.
      // Always EXPLICITLY set (even to null) so the schema's mig 001
      // default of 3 doesn't leak into Glofox-linked rows.
      //   numeric → Trial member with an active pack; render badge
      //   null    → subscription Member, exhausted/inactive pack,
      //             OR fetch failure. GlofoxProfileCard guards on
      //             `credits != null` so the badge disappears in
      //             all three cases — correct vs. the previous
      //             behavior of showing a stale "3 credits".
      trial_credits_remaining: m.trial_credits_remaining ?? null,
      // GLOFOX2.1.14 — booking aggregates (default to 0/null when
      // we couldn't fetch them, so the row is still well-formed).
      last_booked_at:       m.last_booked_at       ?? null,
      last_attended_at:     m.last_attended_at     ?? null,
      total_bookings_30d:   m.total_bookings_30d   ?? 0,
      total_attended_30d:   m.total_attended_30d   ?? 0,
      total_attended_7d:    m.total_attended_7d    ?? 0,
      total_noshow_30d:     m.total_noshow_30d     ?? 0,
      // GLOFOX2.1.18 — last 10 bookings as JSONB.
      // GLOFOX-DETAIL — membership detail when present on the mapped
      // single-member payload (omitted entirely for LIST-sourced rows).
      ...Object.fromEntries(GLOFOX_DETAIL_KEYS.filter(k => k in m).map(k => [k, m[k] ?? null])),
      recent_bookings:      m.recent_bookings      ?? null,
    }).select('id').single()
    if (error) return { ...preview, error: error.message }
    contactId = data.id
  } else {
    // UPDATE — only write the fields that changed.
    const m = preview.mapped
    const updates = { glofox_synced_at: now }
    if ('glofox_member_id' in preview.changes)         updates.glofox_member_id         = m.glofox_member_id
    if ('glofox_membership_status' in preview.changes) updates.glofox_membership_status = m.glofox_membership_status
    if ('first_name' in preview.changes)               updates.first_name               = m.first_name
    if ('last_name'  in preview.changes)               updates.last_name                = m.last_name
    if ('phone'      in preview.changes)               updates.phone                    = m.phone
    if ('dob'        in preview.changes)               updates.dob                      = m.dob
    if ('joined_at'  in preview.changes)               updates.joined_at                = m.joined_at
    if ('trial_credits_remaining' in preview.changes)  updates.trial_credits_remaining = m.trial_credits_remaining
    // Booking aggregates — write each individually (mapped only
    // carries them when bookings were fetched).
    if ('last_booked_at'     in preview.changes)       updates.last_booked_at     = m.last_booked_at
    if ('last_attended_at'   in preview.changes)       updates.last_attended_at   = m.last_attended_at
    if ('total_bookings_30d' in preview.changes)       updates.total_bookings_30d = m.total_bookings_30d
    if ('total_attended_30d' in preview.changes)       updates.total_attended_30d = m.total_attended_30d
    if ('total_attended_7d'  in preview.changes)       updates.total_attended_7d  = m.total_attended_7d
    if ('total_noshow_30d'   in preview.changes)       updates.total_noshow_30d   = m.total_noshow_30d
    if ('recent_bookings'    in preview.changes)       updates.recent_bookings    = m.recent_bookings
    // GLOFOX-DETAIL — write each detail field the diff flagged.
    for (const k of GLOFOX_DETAIL_KEYS) { if (k in preview.changes) updates[k] = m[k] ?? null }
    // Recompose name only if first_name OR last_name changed.
    if ('first_name' in preview.changes || 'last_name' in preview.changes) {
      updates.name = m.name
    }
    const { error } = await db.from('contacts').update(updates).eq('id', preview.existing_id)
    if (error) return { ...preview, error: error.message }
    contactId = preview.existing_id
  }

  // FUNNEL.1 — stamp the conversion moment. Runs on the webhook path
  // (MEMBER_UPDATED → applyMemberSync), so the Converted column moves
  // near-instantly; the nightly sync is a catch-all for MISSED WEBHOOKS
  // only — a FAILED stamp is permanent (the next sync sees
  // member→member, never restamps), so every failure must be logged to
  // be diagnosable. Write-once — .is('converted_at', null) makes a
  // concurrent double-fire harmless. Best-effort: a stamp failure must
  // not roll back the contact write.
  let convertedAt = preview.existing?.converted_at ?? null
  if (shouldStampConversion({
    action: preview.action,
    previousStatus,
    newStatus,
    existingConvertedAt: convertedAt,
    joinedAt: preview.mapped?.joined_at ?? preview.existing?.joined_at ?? null,
  })) {
    try {
      const { error: stampErr } = await db.from('contacts')
        .update({ converted_at: now })
        .eq('id', contactId)
        .is('converted_at', null)
      if (!stampErr) convertedAt = now
      else logWarn('glofox-sync', 'converted_at stamp failed', { contactId, err: stampErr.message })
    } catch (e) {
      logWarn('glofox-sync', 'converted_at stamp threw', { err: e?.message })
    }
  }

  // FUNNEL.3 — stamp the Class Pack moment. Same write-once/best-effort
  // discipline as converted_at above. Unlike conversion this is NOT a
  // transition edge — any sync observing 4+ active credits on a
  // non-member qualifies — so a failed stamp self-heals on the next
  // sync while the credits are still ≥4; logging stays for parity.
  let packCustomerAt = preview.existing?.pack_customer_at ?? null
  if (shouldStampPackCustomer({
    newStatus,
    credits: preview.mapped?.trial_credits_remaining ?? preview.existing?.trial_credits_remaining ?? null,
    existingPackCustomerAt: packCustomerAt,
  })) {
    try {
      const { error: packErr } = await db.from('contacts')
        .update({ pack_customer_at: now })
        .eq('id', contactId)
        .is('pack_customer_at', null)
      if (!packErr) packCustomerAt = now
      else logWarn('glofox-sync', 'pack_customer_at stamp failed', { contactId, err: packErr.message })
    } catch (e) {
      logWarn('glofox-sync', 'pack_customer_at stamp threw', { err: e?.message })
    }
  }

  // HR-CLASS-ALLOC.2 — refresh this member's slice of the class_bookings roster
  // from the same bookings list previewMemberSync fetched. Best-effort: a roster
  // write must never roll back the member sync.
  if (bookingsForRoster && bookingsForRoster.length) {
    try {
      await upsertClassBookings(db, {
        locationId,
        contactId,
        glofoxMemberId: preview.mapped.glofox_member_id,
        memberName: preview.mapped.name || null,
        bookings: bookingsForRoster,
      })
    } catch (e) {
      logWarn('glofox-sync', 'class_bookings upsert threw', { err: e?.message })
    }
  }

  // PIPELINE5.4 — pipeline placement now comes from the unified
  // classifier (status × engagement × recency), not just Glofox
  // status. Build the snapshot from the mapped values (post-sync
  // state); ensureDealForContact runs classifyContact internally.
  // Best-effort: a deal-write failure must not roll back the
  // contact write.
  // PIPELINE-FLAP fix — only reclassify (move the deal) when this sync
  // actually has the attendance signal the classifier needs. Callers
  // that skip the booking fetch (opts.skipBookings — e.g. the detail-
  // backfill cron, which only refreshes plan/membership detail) MUST
  // pass opts.skipReclassify so they don't run classifyContact with
  // attendance blanked to 0 and wrongly flip active members to dormant.
  // The booking-aware paths (full glofox-sync, webhook re-fetch) leave
  // it unset and remain the sole classifiers. Guarded on skipBookings
  // too so a future skipBookings caller can't silently reintroduce the
  // flap.
  const reclassify = !opts.skipReclassify && !opts.skipBookings
  let dealResult = null
  if (reclassify) {
    try {
      const m = preview.mapped || {}
      // PIPELINE-FLAP.2 — this snapshot is what ensureDealForContact runs
      // through classifyContact to (re)place the deal. It MUST see the same
      // recency the nightly classifier (pipeline-reclassify) reads from the
      // persisted contacts row, or the two writers disagree and the deal
      // flaps Dormant↔Active Member every night. A LIST / skipBookings sync
      // doesn't (re)compute attendance/payment/membership-detail, so EVERY
      // such field falls back to the persisted row (preview.existing, now
      // populated on the update path) before defaulting to null/0.
      const ex = preview.existing || {}
      const contactSnapshot = {
        glofox_membership_status: m.glofox_membership_status,
        glofox_membership_state:  m.glofox_membership_state  ?? ex.glofox_membership_state  ?? null,
        glofox_membership_expiry: m.glofox_membership_expiry ?? ex.glofox_membership_expiry ?? null,
        // last_attended_at is advance-only on the persisted row (see
        // mergeBookingAggregates) — i.e. the true most-recent attendance.
        // Falling back to it can never resurrect stale data: it's the exact
        // value pipeline-reclassify already classifies off.
        last_attended_at:    m.last_attended_at  ?? ex.last_attended_at  ?? null,
        total_attended_7d:   m.total_attended_7d  ?? ex.total_attended_7d  ?? 0,
        total_attended_30d:  m.total_attended_30d ?? ex.total_attended_30d ?? 0,
        // last_payment_at + lifetime_transaction_count come from
        // INVOICE_UPDATED webhooks (GLOFOX2.1.20) or the PIPELINE5.5
        // backfill — applyMemberSync doesn't compute them, so we
        // pull from the existing row when available.
        last_payment_at:     m.last_payment_at  ?? ex.last_payment_at ?? null,
        joined_at:           m.joined_at ?? ex.joined_at ?? null,
        created_at:          ex.created_at ?? null,
        trial_credits_remaining: m.trial_credits_remaining ?? ex.trial_credits_remaining ?? null,
        // FUNNEL.1 — the funnel classifier counts attended classes from
        // recent_bookings and gates the Converted column on converted_at.
        // FUNNEL.3 — pack_customer_at (just-stamped value included) keeps
        // Class Pack customers in the off-funnel pack_member stage.
        recent_bookings: m.recent_bookings ?? ex.recent_bookings ?? null,
        converted_at:    convertedAt,
        pack_customer_at: packCustomerAt,
        // FUNNEL.4 — operator Cold dismissal, from the persisted row (sync
        // never writes it). Keeps a cold lead cold across a webhook sync,
        // and lets a fresh attendance (last_attended_at newer) revive them.
        pipeline_dismissed_at: ex.pipeline_dismissed_at ?? null,
        // GYMPASS.2 — a Gympass user is parked in the off-funnel gympass
        // pile by classifyContact. A LIST / detail-less sync leaves it off
        // `m`, so fall back to the persisted row (matches the nightly
        // pipeline-reclassify input, so the two writers converge).
        gympass_member_id: m.gympass_member_id ?? ex.gympass_member_id ?? null,
      }
      dealResult = await ensureDealForContact(
        db, locationId, contactId, contactSnapshot,
        m.name || null,
      )
    } catch (e) {
      dealResult = { action: 'error', error: e?.message || 'deal write threw' }
    }
  } else {
    dealResult = { action: 'skipped', reason: 'reclassify skipped (no booking signal)' }
  }

  // GLOFOX2.1.15 — upsert Glofox interactions into CRM activity
  // timeline. Idempotent via the partial UNIQUE index on
  // glofox_interaction_id. Best-effort: failures here don't roll
  // back the contact write — operator gets the count so they can
  // diagnose if anything's off.
  let interactionsResult = null
  const interactions = preview.mapped?._glofox_interactions
  if (Array.isArray(interactions) && interactions.length > 0) {
    try {
      interactionsResult = await syncGlofoxInteractions(db, locationId, contactId, interactions)
    } catch (e) {
      interactionsResult = { synced: 0, skipped: 0, errors: interactions.length, error: e?.message }
    }
  }

  // GLOFOX4.2 — detect trial-lifecycle transitions and write
  // sequence-triggering tags. Idempotent via writeContactTags.
  const transitionTags = detectTrialTransitionTags({
    action: preview.action,
    previousStatus,
    newStatus,
    currentCredits: preview.mapped?.trial_credits_remaining,
    currentAttended: preview.mapped?.total_attended_30d,
  })
  let transitionTagsResult = null
  if (transitionTags.length > 0) {
    try {
      const { writeContactTags } = await import('./contact-tags.js')
      transitionTagsResult = await writeContactTags(db, {
        contactId,
        locationId,
        tags: transitionTags,
        metadata: { from_status: previousStatus, to_status: newStatus, source: 'glofox_sync' },
      })
    } catch (e) {
      transitionTagsResult = { error: e?.message || 'tag write threw' }
    }
  }

  // GYMPASS.2 — a Gympass (Wellhub) user gets a durable `gympass` tag,
  // idempotent. Keyed off the synced metadata.gympass id (or the persisted
  // fallback); classifyContact separately parks them in the off-funnel
  // Gympass pile. Best-effort — never blocks the contact/deal write.
  const gympassMemberId = preview.mapped?.gympass_member_id ?? preview.existing?.gympass_member_id ?? null
  let gympassTagResult = null
  if (gympassMemberId) {
    try {
      const { writeContactTag } = await import('./contact-tags.js')
      gympassTagResult = await writeContactTag(db, {
        contactId,
        locationId,
        tag: 'gympass',
        metadata: { gympass_member_id: gympassMemberId, source: 'glofox_sync' },
      })
    } catch (e) {
      gympassTagResult = { error: e?.message || 'gympass tag write threw' }
    }
  }

  // SEQ-TRIG (membership_state_change) — fire when the Glofox membership
  // state (active / paused / locked) transitions. Drives win-back / dunning
  // sequences (state → locked → dunning). Mirrors the trial-transition tags
  // above: best-effort, never rolls back the contact write. preview.changes
  // already carries { from, to } and is only populated on a real update with
  // the single-member detail payload, so a create / no-op sync won't fire.
  // STAGETRIG.1 (pipeline_stage_change) — fire when the classifier actually
  // MOVED the deal. Same best-effort shape as the membership_state trigger
  // below and driven off the same kind of pre-computed diff: dealResult is
  // ensureDealForContact's return value, which already carries
  // { action: 'move', from_slug, to_slug }.
  //
  // Until now triggerSequencesForPipelineStageChange was called ONLY from
  // POST /api/contacts (old stage always null), so every stage move an
  // operator or a sync performed was invisible to the sequence engine and no
  // pipeline_stage_change sequence with a to_status other than the creation
  // stage could ever fire.
  //
  // The adapter fires on 'move' only — NOT on 'leave' (the classifier is
  // idempotent, so an unchanged member returns 'leave' on every single sync)
  // and NOT on 'create' (that's contact creation, already covered). Volume is
  // therefore bounded by real reclassifications of members Glofox reports as
  // modified, which is the same population the membership_state trigger
  // already fires for. The NIGHTLY BULK reclassify (pipeline-reclassify.js,
  // /api/cron/pipeline-classify) is deliberately NOT wired — it moves
  // thousands of deals in one pass.
  let stageChangeTriggerResult = null
  if (dealResult?.action === 'move') {
    try {
      const { triggerSequencesForDealPlacement } = await import('./sequences/triggers.js')
      await triggerSequencesForDealPlacement(contactId, dealResult)
      stageChangeTriggerResult = { fired: true, from: dealResult.from_slug ?? null, to: dealResult.to_slug ?? null }
    } catch (e) {
      stageChangeTriggerResult = { error: e?.message || 'pipeline_stage_change trigger threw' }
    }
  }

  let membershipStateTriggerResult = null
  const stateChange = preview.changes?.glofox_membership_state
  if (stateChange && stateChange.from !== stateChange.to) {
    try {
      const { triggerSequencesForMembershipStateChange } = await import('./sequences/triggers.js')
      await triggerSequencesForMembershipStateChange(contactId, stateChange.from ?? null, stateChange.to ?? null)
      membershipStateTriggerResult = { fired: true, from: stateChange.from ?? null, to: stateChange.to ?? null }
    } catch (e) {
      membershipStateTriggerResult = { error: e?.message || 'membership_state trigger threw' }
    }
  }

  return {
    ...preview,
    contact_id: contactId,
    deal: dealResult,
    interactions: interactionsResult,
    transition_tags: transitionTagsResult,
    gympass_tag: gympassTagResult,
    stage_change_trigger: stageChangeTriggerResult,
    membership_state_trigger: membershipStateTriggerResult,
  }
}
