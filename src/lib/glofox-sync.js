// Glofox member sync helpers (GLOFOX2.1).
//
// Pure mapping + match-or-create logic for pulling Glofox members
// into the CRM contacts table. Used today by the single-member
// /api/glofox/sync-member endpoint (dry-run + apply); used
// tomorrow by the daily bulk-sync cron.
//
// Source-of-truth contract:
//   Glofox owns:  glofox_member_id, glofox_membership_status,
//                 glofox_synced_at (auto)
//   Glofox seeds: first_name, last_name, phone, email
//                 (only writes when the CRM field is null/empty
//                  — operator edits win)
//   CRM owns:     lead_status, tags, lead_source, label, notes,
//                 activities, deals (NEVER touched by sync)
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
export function normalizePhone(phone) {
  if (typeof phone !== 'string') return null
  const trimmed = phone.trim()
  if (!trimmed) return null
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
 * Glofox `source` values map to our existing leadSourceSchema
 * enum (src/lib/schemas.js — booking / meta / tiktok / walkin /
 * referral / website / whatsapp / other). Anything we can't
 * recognise becomes 'other'. The granular Glofox-side detail is
 * preserved via glofox_member_id; operators who need a finer
 * audience filter can use the membership_status + status-driven
 * tags.
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
}

export function mapGlofoxSource(source) {
  if (!source) return 'other'
  const key = String(source).trim().toUpperCase()
  return GLOFOX_SOURCE_MAP[key] || 'other'
}

// ─────────────────────────────────────────────────────────────
// Pipeline stage mapping (GLOFOX2.1.3)
// ─────────────────────────────────────────────────────────────
//
// The CRM pipeline reads from `deals`, not `contacts.lead_status`.
// A contact without a deal row in pipeline_stages doesn't appear
// on the kanban — that's by design (deals are opportunities, a
// contact can have many or none). The Glofox sync therefore
// needs to slot each member into the right stage by creating a
// deal row alongside the contact.
//
// Stage slug map mirrors pipeline_stages seeded in mig 001:
//   new_lead, new_lead_social, trial_active, conversion_ready,
//   follow_up_needed, member, cold_email_only, lost_member,
//   returning_member.

const GLOFOX_STATUS_TO_STAGE_SLUG = {
  trial:     'trial_active',
  active:    'member',
  cancelled: 'lost_member',
  expired:   'lost_member',
  inactive:  'lost_member',
  paused:    'follow_up_needed',
  lead:      'new_lead',
}

/**
 * Pure mapping: Glofox membership status → CRM pipeline stage
 * slug FOR FIRST-TIME PLACEMENT (no existing deal yet). Unknown
 * statuses default to 'new_lead' so the member still appears in
 * the pipeline. For transitions on EXISTING deals see
 * targetDealStageForSync below.
 */
export function pipelineStageSlugForStatus(status) {
  if (!status) return 'new_lead'
  return GLOFOX_STATUS_TO_STAGE_SLUG[String(status).toLowerCase()] || 'new_lead'
}

/**
 * Transition map for EXISTING deals (GLOFOX2.1.4).
 *
 * Decides whether to auto-move a contact's open deal when their
 * Glofox membership status changes. Returns the target stage
 * slug — or null to leave the deal alone.
 *
 * Auto-move ONLY when the deal is in a "system-default" stage
 * (one this sync would have put them in). If the operator has
 * manually moved them to ANY OTHER stage (e.g., follow_up_needed
 * after a chase call, or returning_member after a comeback chat),
 * the sync respects that — Glofox owns membership state, but the
 * operator owns where the deal sits.
 *
 * Routing:
 *   → active     from trial_active / new_lead*  → member         (converted)
 *   → trial      from new_lead*                  → trial_active   (promoted)
 *   → cancelled  from member                     → lost_member    (paying customer churned)
 *   → cancelled  from trial_active / new_lead*   → follow_up_needed (chase them)
 *   → paused     from member                     → follow_up_needed (at-risk)
 *   anything else                                → null (leave alone)
 */
const SYSTEM_DEFAULT_PRE_PAID_STAGES = new Set([
  'trial_active', 'new_lead', 'new_lead_social',
])

export function targetDealStageForSync(newStatus, currentStageSlug) {
  const s = newStatus ? String(newStatus).toLowerCase() : ''
  switch (s) {
    case 'active':
      // Promoted FROM a pre-paid funnel stage → member.
      if (SYSTEM_DEFAULT_PRE_PAID_STAGES.has(currentStageSlug)) return 'member'
      return null
    case 'trial':
      // Promoted FROM a new-lead stage → trial_active.
      if (currentStageSlug === 'new_lead' || currentStageSlug === 'new_lead_social') {
        return 'trial_active'
      }
      return null
    case 'cancelled':
    case 'expired':
    case 'inactive':
      // Paying member churned → lost_member.
      if (currentStageSlug === 'member') return 'lost_member'
      // Trial / lead that didn't convert → follow_up_needed so a
      // team member can call them.
      if (SYSTEM_DEFAULT_PRE_PAID_STAGES.has(currentStageSlug)) return 'follow_up_needed'
      return null
    case 'paused':
      // Paying member on pause → at-risk; flag for follow-up.
      if (currentStageSlug === 'member') return 'follow_up_needed'
      return null
    default:
      // 'lead' or unknown → don't touch the deal. Operator wins.
      return null
  }
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
async function findStageIdBySlug(db, locationId, stageSlug) {
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
 * status. Three terminal states:
 *
 *   { action: 'create',  deal_id, stage_slug }              fresh deal made
 *   { action: 'move',    deal_id, from_slug, to_slug }       existing deal moved
 *   { action: 'leave',   deal_id, stage_slug }               nothing to do (operator-managed
 *                                                             stage OR target = current)
 *   { action: 'error',   error }                              lookup/insert/update failed
 *
 * Idempotent: re-running with the same Glofox status is a no-op
 * for both create + move paths (returns 'leave' once stable).
 */
export async function ensureDealForContact(db, locationId, contactId, glofoxStatus) {
  if (!db || !locationId || !contactId) {
    return { action: 'error', error: 'missing arguments' }
  }
  const existing = await getOpenDealWithStage(db, contactId)

  if (!existing) {
    // CREATE path — first time this contact has had a deal.
    const stageSlug = pipelineStageSlugForStatus(glofoxStatus)
    let stageId = await findStageIdBySlug(db, locationId, stageSlug)
    let resolvedSlug = stageSlug
    if (!stageId) {
      // Stage doesn't exist at this location → fall back to
      // new_lead so the contact still surfaces in the pipeline.
      const fallback = await findStageIdBySlug(db, locationId, 'new_lead')
      if (!fallback) return { action: 'error', error: `Pipeline stage '${stageSlug}' not found and no new_lead fallback` }
      stageId = fallback
      resolvedSlug = 'new_lead'
    }
    const { data, error } = await db
      .from('deals')
      .insert({ contact_id: contactId, stage_id: stageId, location_id: locationId, status: 'open' })
      .select('id')
      .single()
    if (error) return { action: 'error', error: error.message }
    return { action: 'create', deal_id: data.id, stage_slug: resolvedSlug }
  }

  // EXISTING deal — compute the transition target.
  const target = targetDealStageForSync(glofoxStatus, existing.stage_slug)
  // null target → operator-managed stage OR no transition for
  // this status. Leave it alone.
  if (!target || target === existing.stage_slug) {
    return { action: 'leave', deal_id: existing.id, stage_slug: existing.stage_slug }
  }
  // MOVE path.
  const targetStageId = await findStageIdBySlug(db, locationId, target)
  if (!targetStageId) {
    return { action: 'error', deal_id: existing.id, error: `Target stage '${target}' not found at location` }
  }
  const { error: moveErr } = await db
    .from('deals')
    .update({ stage_id: targetStageId })
    .eq('id', existing.id)
  if (moveErr) return { action: 'error', deal_id: existing.id, error: moveErr.message }
  return { action: 'move', deal_id: existing.id, from_slug: existing.stage_slug, to_slug: target }
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

export function mapGlofoxMember(member) {
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

  const membershipStatus = mapMembershipStatus(member)

  // GLOFOX2.1.2 — date of birth from Glofox `birth`. Powers the
  // birthday-wishes anniversary template + future age-segment
  // reports. Null when Glofox doesn't have it (most members).
  const dob = parseGlofoxDate(member.birth ?? member.dob ?? null)

  // GLOFOX2.1.2 — granular source mapping. Glofox's WEBPORTAL /
  // WALK_IN / FACEBOOK etc. → our leadSourceSchema enum
  // (src/lib/schemas.js). Defaults to 'other' for unmapped values.
  const leadSource = mapGlofoxSource(member.source)

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
    lead_source: leadSource,
    glofox_membership_status: membershipStatus,
  }
}

// Best-effort membership-status normaliser. Real values (trial,
// active, paused, cancelled, expired) come straight through
// lowercased. Falls back through:
//   1. lead_status / leads.status / membership.status (most likely)
//   2. active boolean — true → 'active', false → 'inactive'
//   3. 'lead' as the absolute last resort
//
// 'lead' here means "we have this person in Glofox but couldn't
// determine a membership state from the payload" — different from
// Glofox's LEAD lead_status (that becomes lowercased 'lead' too,
// which is fine; the operator can build sequences targeting it).
export function mapMembershipStatus(member) {
  if (!member || typeof member !== 'object') return 'lead'
  const raw = pluck(member, MEMBERSHIP_STATUS_PATHS)
  if (raw != null) {
    const out = String(raw).trim().toLowerCase()
    if (out) return out
  }
  // Fallback to the active boolean. Glofox uses `active: true`
  // for members in good standing; `active: false` for cancelled/
  // expired/dormant.
  if (typeof member.active === 'boolean') {
    return member.active ? 'active' : 'inactive'
  }
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
  const SELECT_COLS = 'id, email, first_name, last_name, phone, dob, glofox_member_id, glofox_membership_status, lead_source'
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

export async function previewMemberSync(db, locationId, member) {
  const mapped = mapGlofoxMember(member)
  if (!mapped) {
    return { action: 'invalid', reason: 'Could not extract glofox_member_id from payload', mapped: null }
  }

  const { byGlofox, byEmail } = await findExistingContact(db, locationId, mapped)
  // GLOFOX2.1.3 — proposed pipeline placement. Same value goes
  // into the dry-run preview AND into the live deal insert on apply.
  const proposedStageSlug = pipelineStageSlugForStatus(mapped.glofox_membership_status)

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
        glofox_membership_status: { from: null, to: mapped.glofox_membership_status },
        lead_source:              { from: null, to: mapped.lead_source },
      },
      // GLOFOX2.1.3 — fresh contact = no existing deal, so we'll
      // create one. Operator sees the stage slug in the dry-run.
      deal_action: { action: 'create', stage_slug: proposedStageSlug },
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
  // Always stamp synced_at — but represent in the diff so the
  // operator sees we will touch the row.
  changes.glofox_synced_at = { from: 'previous timestamp', to: 'now' }

  // GLOFOX2.1.4 — compute the deal action by checking existing
  // open deal + applying the transition map.
  const openDeal = await getOpenDealWithStage(db, existing.id)
  let dealAction
  if (!openDeal) {
    // No deal yet → backfill (Roisin case).
    dealAction = { action: 'create', stage_slug: proposedStageSlug }
  } else {
    const target = targetDealStageForSync(mapped.glofox_membership_status, openDeal.stage_slug)
    if (target && target !== openDeal.stage_slug) {
      dealAction = {
        action: 'move',
        deal_id: openDeal.id,
        from_slug: openDeal.stage_slug,
        to_slug: target,
      }
    } else {
      dealAction = {
        action: 'leave',
        deal_id: openDeal.id,
        stage_slug: openDeal.stage_slug,
        reason: target ? 'already in target stage' : 'operator-managed stage; sync respects it',
      }
    }
  }

  return {
    action: 'update',
    existing_id: existing.id,
    mapped,
    changes,
    deal_action: dealAction,
  }
}

// ─────────────────────────────────────────────────────────────
// Apply — actually write the change
// ─────────────────────────────────────────────────────────────
//
// Calls preview first so we never write on the ambiguous path.
// Returns { action, contact_id } or { action: 'ambiguous', ... }.

export async function applyMemberSync(db, locationId, member) {
  const preview = await previewMemberSync(db, locationId, member)
  if (preview.action === 'invalid' || preview.action === 'ambiguous') return preview
  const now = new Date().toISOString()

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
      glofox_membership_status: m.glofox_membership_status,
      glofox_synced_at: now,
      lead_source: m.lead_source,
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
    // Recompose name only if first_name OR last_name changed.
    if ('first_name' in preview.changes || 'last_name' in preview.changes) {
      updates.name = m.name
    }
    const { error } = await db.from('contacts').update(updates).eq('id', preview.existing_id)
    if (error) return { ...preview, error: error.message }
    contactId = preview.existing_id
  }

  // GLOFOX2.1.3 + 2.1.4 — ensure the contact's pipeline placement
  // reflects their Glofox status. ensureDealForContact handles
  // create / move / leave decisions internally based on the
  // current open deal + the transition map. Idempotent — running
  // twice with the same Glofox status converges to 'leave'.
  // Best-effort: a deal-write failure must not roll back the
  // contact write (we'd rather have the contact synced and tell
  // the operator about the pipeline gap than nothing).
  let dealResult = null
  try {
    dealResult = await ensureDealForContact(
      db, locationId, contactId, preview.mapped.glofox_membership_status,
    )
  } catch (e) {
    dealResult = { action: 'error', error: e?.message || 'deal write threw' }
  }

  return { ...preview, contact_id: contactId, deal: dealResult }
}
