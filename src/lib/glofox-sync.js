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

  const phone = pluck(member, PHONE_PATHS)
  const phoneStr = phone ? String(phone).trim() : null

  const membershipStatus = mapMembershipStatus(member)

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
    phone: phoneStr,
    name,
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
  const queries = []
  queries.push(
    db.from('contacts')
      .select('id, email, first_name, last_name, phone, glofox_member_id, glofox_membership_status, lead_source')
      .eq('location_id', locationId)
      .eq('glofox_member_id', mapped.glofox_member_id)
      .limit(1)
  )
  if (mapped.email) {
    queries.push(
      db.from('contacts')
        .select('id, email, first_name, last_name, phone, glofox_member_id, glofox_membership_status, lead_source')
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
    // CREATE path — mark the lead_source as 'glofox' so we know
    // where the contact originated.
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
        glofox_membership_status: { from: null, to: mapped.glofox_membership_status },
        lead_source:              { from: null, to: 'glofox' },
      },
    }
  }

  // UPDATE path — Glofox is source of truth for the four sync-
  // owned fields; for the seed fields (first_name etc.) we only
  // write when CRM is empty so operator edits aren't clobbered.
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
  // Always stamp synced_at — but represent in the diff so the
  // operator sees we will touch the row.
  changes.glofox_synced_at = { from: 'previous timestamp', to: 'now' }

  return { action: 'update', existing_id: existing.id, mapped, changes }
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
      glofox_membership_status: m.glofox_membership_status,
      glofox_synced_at: now,
      lead_source: 'glofox',
    }).select('id').single()
    if (error) return { ...preview, error: error.message }
    return { ...preview, contact_id: data.id }
  }

  // UPDATE — only write the fields that changed.
  const m = preview.mapped
  const updates = { glofox_synced_at: now }
  if ('glofox_member_id' in preview.changes)         updates.glofox_member_id         = m.glofox_member_id
  if ('glofox_membership_status' in preview.changes) updates.glofox_membership_status = m.glofox_membership_status
  if ('first_name' in preview.changes)               updates.first_name               = m.first_name
  if ('last_name'  in preview.changes)               updates.last_name                = m.last_name
  if ('phone'      in preview.changes)               updates.phone                    = m.phone
  // Recompose name only if first_name OR last_name changed.
  if ('first_name' in preview.changes || 'last_name' in preview.changes) {
    updates.name = m.name
  }
  const { error } = await db.from('contacts').update(updates).eq('id', preview.existing_id)
  if (error) return { ...preview, error: error.message }
  return { ...preview, contact_id: preview.existing_id }
}
