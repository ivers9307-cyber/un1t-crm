// CHECKLIST.1 — pure helpers + CRUD wrappers for checklist
// templates. The API routes wrap these; the pure functions get
// straight unit tests.
//
// PR 1 surface: templates only.
// PR 2 will add instance generation + tick recording.
// PR 3 will add the deadline-sweep cron.

import { logWarn } from '@/lib/log'

// ────────────────────────────────────────────────────────────────
// Enums + bounds
// ────────────────────────────────────────────────────────────────

// Roles that can be assigned a shift + a corresponding checklist.
// Matches the CHECK constraint on checklist_templates.role
// (mig 214). 'master' is omitted by design — masters are
// super-admin and aren't on the shift roster.
export const CHECKLIST_ROLES = Object.freeze(['staff', 'head_coach', 'manager', 'owner'])

export const CHECKLIST_ROLE_LABELS = Object.freeze({
  staff:       'Staff',
  head_coach:  'Head Coach',
  manager:     'Manager',
  owner:       'Owner',
})

// Postgres dow convention: 0=Sun … 6=Sat. We store the int and
// render the label client-side.
export const DAYS_OF_WEEK = Object.freeze([0, 1, 2, 3, 4, 5, 6])
export const DAY_LABELS = Object.freeze([
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
])
export const DAY_SHORT_LABELS = Object.freeze([
  'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat',
])

export const TEMPLATE_NAME_MAX  = 100
export const ITEM_LABEL_MAX     = 200
export const ITEMS_PER_TEMPLATE_MAX = 50

// ────────────────────────────────────────────────────────────────
// Pure validation
// ────────────────────────────────────────────────────────────────

/**
 * Validate the role + day_of_week + name on a template create /
 * patch payload. Returns { ok: true, normalised } or { ok: false }.
 */
export function validateTemplateMeta({ role, dayOfWeek, name } = {}) {
  if (!CHECKLIST_ROLES.includes(role)) {
    return { ok: false, code: 'bad_role', error: `role must be one of: ${CHECKLIST_ROLES.join(', ')}` }
  }
  const dow = Number(dayOfWeek)
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
    return { ok: false, code: 'bad_day', error: 'day_of_week must be 0..6 (0 = Sun)' }
  }
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed.length === 0) {
    return { ok: false, code: 'name_required', error: 'A template name is required.' }
  }
  if (trimmed.length > TEMPLATE_NAME_MAX) {
    return { ok: false, code: 'name_too_long', error: `Name must be ${TEMPLATE_NAME_MAX} characters or fewer.` }
  }
  return { ok: true, normalised: { role, dayOfWeek: dow, name: trimmed } }
}

/**
 * Validate + normalise a list of items. Accepts both the
 * canonical shape ({ id, label, order }) and a minimal
 * client-side shape ({ label }) — we mint ids for the latter so
 * the admin UI doesn't have to know about uuids.
 *
 * Returns { ok: true, normalised: [{id, label, order}] } where
 * `order` is the stable index after sorting. Empty list is fine
 * (a template with no items just means "nothing yet").
 */
export function normaliseItems(input) {
  if (input == null) return { ok: true, normalised: [] }
  if (!Array.isArray(input)) {
    return { ok: false, code: 'items_bad_shape', error: 'items must be an array' }
  }
  if (input.length > ITEMS_PER_TEMPLATE_MAX) {
    return {
      ok: false,
      code: 'too_many_items',
      error: `At most ${ITEMS_PER_TEMPLATE_MAX} items per template.`,
    }
  }

  const seen = new Set()
  const out = []
  for (let i = 0; i < input.length; i++) {
    const raw = input[i]
    if (!raw || typeof raw !== 'object') {
      return { ok: false, code: 'item_bad_shape', error: `Item #${i + 1} is malformed.` }
    }
    const label = typeof raw.label === 'string' ? raw.label.trim() : ''
    if (label.length === 0) {
      return { ok: false, code: 'item_label_required', error: `Item #${i + 1} needs a label.` }
    }
    if (label.length > ITEM_LABEL_MAX) {
      return {
        ok: false,
        code: 'item_label_too_long',
        error: `Item #${i + 1} label is over ${ITEM_LABEL_MAX} characters.`,
      }
    }

    // Re-use the caller's id if it's a string; otherwise mint
    // one. Lets the admin UI edit existing items in place without
    // changing the id (so tick state in PR 2 isn't lost).
    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null
    if (id == null) id = newItemId()
    if (seen.has(id)) {
      return { ok: false, code: 'duplicate_item_id', error: `Item ids must be unique. "${id}" appears twice.` }
    }
    seen.add(id)

    // `order` is reassigned from index regardless of what the
    // caller sent — the array IS the order, so we don't trust
    // the client's value.
    out.push({ id, label, order: i })
  }
  return { ok: true, normalised: out }
}

/**
 * Mint a stable id for a checklist item. crypto.randomUUID is
 * available in Node 19+ / Edge runtime; the fallback exists in
 * case we're ever called outside that surface (tests, etc).
 */
export function newItemId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  // Fallback: 32 hex chars in uuid-ish layout. Quality not critical.
  const r = (n) => Math.floor(Math.random() * n)
  const hex = (n) => r(n).toString(16).padStart(n.toString(16).length, '0')
  return `${hex(0x100000000)}-${hex(0x10000)}-4${hex(0x1000).slice(1)}-${hex(0x10000)}-${hex(0x100000000)}${hex(0x10000)}`
}

// ────────────────────────────────────────────────────────────────
// CRUD wrappers around the supabase client
// ────────────────────────────────────────────────────────────────

const SELECT_COLUMNS = `
  id, location_id, role, day_of_week, name, items, enabled,
  created_at, updated_at
`

/**
 * List the templates at a location. Returns rows ordered by
 * (day_of_week, role) so the admin grid lays them out
 * predictably.
 */
export async function listTemplates(db, locationId) {
  if (!locationId) return []
  const { data, error } = await db
    .from('checklist_templates')
    .select(SELECT_COLUMNS)
    .eq('location_id', locationId)
    .order('day_of_week', { ascending: true })
    .order('role', { ascending: true })
  if (error) {
    logWarn('checklists', 'list failed', { locationId, error: error.message })
    return []
  }
  return data || []
}

/**
 * Drill into a single template by id. Returns null if not found.
 */
export async function getTemplate(db, id) {
  if (!id) return null
  const { data } = await db
    .from('checklist_templates')
    .select(SELECT_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  return data || null
}

/**
 * Create a new template. Returns { ok, data?, error?, code?,
 * status? }. Surfaces the unique-constraint violation as a
 * 409 with a friendly message so the admin can correct.
 */
export async function createTemplate(db, {
  locationId, role, dayOfWeek, name, items = [],
}) {
  const meta = validateTemplateMeta({ role, dayOfWeek, name })
  if (!meta.ok) return { ok: false, status: 400, ...meta }
  const its = normaliseItems(items)
  if (!its.ok) return { ok: false, status: 400, ...its }

  const { data, error } = await db
    .from('checklist_templates')
    .insert({
      location_id: locationId,
      role:        meta.normalised.role,
      day_of_week: meta.normalised.dayOfWeek,
      name:        meta.normalised.name,
      items:       its.normalised,
    })
    .select(SELECT_COLUMNS)
    .single()

  if (error) {
    // 23505 = unique_violation. The constraint is on (location,
    // role, day_of_week), which is the design point.
    if (error.code === '23505') {
      return {
        ok: false,
        status: 409,
        code: 'duplicate_template',
        error: 'A template already exists for that role + day at this location. Edit the existing one instead.',
      }
    }
    logWarn('checklists', 'create failed', { error: error.message })
    return { ok: false, status: 500, error: error.message, code: 'create_failed' }
  }
  return { ok: true, data }
}

/**
 * Patch an existing template. Accepts a subset of {name, items,
 * enabled}. Role + day + location aren't mutable post-create —
 * the unique constraint means "moving" a template is "create a
 * new one and disable the old".
 */
export async function updateTemplate(db, id, patch = {}) {
  if (!id) return { ok: false, status: 400, error: 'id required', code: 'missing_id' }

  const update = {}
  if ('name' in patch) {
    const trimmed = typeof patch.name === 'string' ? patch.name.trim() : ''
    if (trimmed.length === 0) {
      return { ok: false, status: 400, code: 'name_required', error: 'A template name is required.' }
    }
    if (trimmed.length > TEMPLATE_NAME_MAX) {
      return { ok: false, status: 400, code: 'name_too_long', error: `Name must be ${TEMPLATE_NAME_MAX} characters or fewer.` }
    }
    update.name = trimmed
  }
  if ('items' in patch) {
    const its = normaliseItems(patch.items)
    if (!its.ok) return { ok: false, status: 400, ...its }
    update.items = its.normalised
  }
  if ('enabled' in patch) {
    update.enabled = !!patch.enabled
  }
  if (Object.keys(update).length === 0) {
    return { ok: false, status: 400, code: 'no_fields', error: 'No editable fields supplied.' }
  }

  const { data, error } = await db
    .from('checklist_templates')
    .update(update)
    .eq('id', id)
    .select(SELECT_COLUMNS)
    .single()
  if (error) {
    logWarn('checklists', 'update failed', { id, error: error.message })
    return { ok: false, status: 500, error: error.message, code: 'update_failed' }
  }
  return { ok: true, data }
}

/**
 * Soft-delete (set enabled=false). Hard delete is intentionally
 * not exposed — PR 2's instances reference the template by id and
 * we don't want them to suddenly orphan.
 */
export async function disableTemplate(db, id) {
  return updateTemplate(db, id, { enabled: false })
}
