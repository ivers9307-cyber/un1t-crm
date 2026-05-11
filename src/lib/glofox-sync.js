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
 * slug. Unknown statuses default to 'new_lead' so the member
 * still appears in the pipeline (operator can drag them elsewhere
 * after first sight).
 */
export function pipelineStageSlugForStatus(status) {
  if (!status) return 'new_lead'
  return GLOFOX_STATUS_TO_STAGE_SLUG[String(status).toLowerCase()] || 'new_lead'
}

/**
 * Ensure the contact has at least one open deal. Backfills the
 * pipeline for existing Glofox-synced contacts that pre-date the
 * deal-creation logic. Returns:
 *   { created: true,  deal_id, stage_slug }  — fresh deal made
 *   { created: false, existing_deal_id }     — already had one
 *   { created: false, error }                 — lookup or insert failed
 */
export async function ensureDealForContact(db, locationId, contactId, glofoxStatus) {
  if (!db || !locationId || !contactId) {
    return { created: false, error: 'missing arguments' }
  }
  // 1. Already has an open deal? Don't make a second one.
  const { data: existing, error: existingErr } = await db
    .from('deals')
    .select('id')
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .limit(1)
  if (existingErr) return { created: false, error: existingErr.message }
  if (existing?.[0]) {
    return { created: false, existing_deal_id: existing[0].id }
  }
  // 2. Look up the stage by slug.
  const stageSlug = pipelineStageSlugForStatus(glofoxStatus)
  const { data: stages, error: stageErr } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('location_id', locationId)
    .eq('slug', stageSlug)
    .limit(1)
  if (stageErr) return { created: false, error: stageErr.message }
  const stageId = stages?.[0]?.id
  if (!stageId) {
    // Stage doesn't exist at this location yet. Falling back to
    // the new_lead stage rather than failing — at minimum the
    // contact should be in the pipeline somewhere visible.
    const { data: fallback } = await db
      .from('pipeline_stages')
      .select('id')
      .eq('location_id', locationId)
      .eq('slug', 'new_lead')
      .limit(1)
    if (!fallback?.[0]) return { created: false, error: `Pipeline stage '${stageSlug}' not found and no new_lead fallback` }
    return await insertDeal(db, locationId, contactId, fallback[0].id, 'new_lead')
  }
  return await insertDeal(db, locationId, contactId, stageId, stageSlug)
}

async function insertDeal(db, locationId, contactId, stageId, stageSlug) {
  const { data, error } = await db
    .from('deals')
    .insert({
      contact_id: contactId,
      stage_id: stageId,
      location_id: locationId,
      status: 'open',
    })
    .select('id')
    .single()
  if (error) return { created: false, error: error.message }
  return { created: true, deal_id: data.id, stage_slug: stageSlug }
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
      deal_to_create: { stage_slug: proposedStageSlug },
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

  // GLOFOX2.1.3 — even on UPDATE, check if the contact has an
  // open deal. If not, the apply path will backfill one. This
  // catches the case where a Glofox member was synced before
  // pipeline-deal-creation existed (like Roisin), and re-syncing
  // them now should slot them into the right stage.
  const { data: openDeals } = await db
    .from('deals')
    .select('id')
    .eq('contact_id', existing.id)
    .eq('status', 'open')
    .limit(1)
  const dealToCreate = !openDeals?.[0] ? { stage_slug: proposedStageSlug } : null

  return {
    action: 'update',
    existing_id: existing.id,
    mapped,
    changes,
    ...(dealToCreate ? { deal_to_create: dealToCreate } : {}),
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

  // GLOFOX2.1.3 — make sure the contact has a pipeline deal.
  // Idempotent: ensureDealForContact short-circuits if an open
  // deal already exists, so re-running sync never duplicates.
  // Best-effort — a deal-creation failure must not roll back the
  // contact write (we'd rather have the contact synced and tell
  // the operator to manually drop them into the pipeline).
  let dealResult = null
  if (preview.deal_to_create) {
    try {
      dealResult = await ensureDealForContact(
        db, locationId, contactId, preview.mapped.glofox_membership_status,
      )
    } catch (e) {
      dealResult = { created: false, error: e?.message || 'deal insert threw' }
    }
  }

  return { ...preview, contact_id: contactId, deal: dealResult }
}
