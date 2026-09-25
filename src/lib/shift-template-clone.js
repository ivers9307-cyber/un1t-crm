// TPLCLONE.1 — copy shift templates from one studio to another in the SAME
// organisation.
//
// Pure: no network, no database, no next/* import. The route
// (src/app/api/schedule/templates/clone/route.js) does every read and the
// write; the template manager (a client component) imports the UI helpers
// below. Keep the database OUT of this file: check:location-scoping reads route
// and page files only, so a query moved in here would be invisible to it.

/**
 * The columns a copy carries across.
 *
 * Everything else on shift_templates is identity (id, location_id, created_at,
 * updated_at) or set by the copy itself (active, display_order): that is
 * TEMPLATE_CLONE_MANAGED_COLUMNS. The route reads the source with select('*')
 * and copies through this list, so this list is the ONE place that decides
 * what a copy carries.
 *
 * `days_of_week` is the one column copied only on request (`copyWeekdays`):
 * by default a copy lands as a one-off template (`[]`), because copying the
 * weekly pattern makes the target studio's calendar generate eight weeks of
 * empty shifts at once and switches its roster runway alerts on.
 *
 * SHIFTTYPE.1 (Wave 2 PR 13) adds `kind`: add it here, one line, and the copy
 * carries it. tests/shift-template-clone.guards.test.js fails until every
 * column of shift_templates in supabase/migrations is in exactly one of these
 * two lists, so a new column can never be dropped by a copy in silence.
 */
export const TEMPLATE_CLONE_COLUMNS = Object.freeze([
  'name',
  'start_time',
  'end_time',
  'color',
  'role_label',
  'days_of_week',
  'min_coaches',
  'max_coaches',
])

/** Never copied: identity, or set by the copy (active = true, display_order = after the target's). */
export const TEMPLATE_CLONE_MANAGED_COLUMNS = Object.freeze([
  'id',
  'location_id',
  'created_at',
  'updated_at',
  'active',
  'display_order',
])

export const CLONE_SKIP_REASONS = Object.freeze({
  nameExists: 'name_exists',
  duplicateInSource: 'duplicate_in_source',
  inactive: 'inactive',
  notFound: 'not_found',
})

/** Plain words for each reason, for the preview and the notice. */
export const CLONE_SKIP_LABELS = Object.freeze({
  name_exists: 'a template with this name is already here',
  duplicate_in_source: 'another template being copied has the same name',
  inactive: 'deactivated at the other studio',
  not_found: 'no longer at the other studio',
})

/** The comparison key for "is this name already taken": case and outer spaces ignored. */
export function templateNameKey(name) {
  return String(name ?? '').trim().toLowerCase()
}

/**
 * Decide what a copy creates and what it skips.
 *
 * @param {object} args
 * @param {object[]} args.sourceTemplates  shift_templates rows at the source studio, in display order
 * @param {object[]} args.targetTemplates  { name, display_order } of EVERY template at the target, active or not
 * @param {string[]|null} [args.templateIds]  copy only these source ids; null = every active template
 * @param {boolean} [args.copyWeekdays=false]  carry days_of_week across; false = the copy is a one-off ([])
 * @returns {{ toCreate: Array<{ source_id: string, source_days_of_week: string[], row: object }>, skipped: Array<{ source_id: string, name: string|null, reason: string }> }}
 *   `row` carries no location_id: the route adds the target's, in the insert
 *   payload itself, where check:location-scoping can see it.
 *   `source_days_of_week` is the source's weekly pattern whether or not it is
 *   copied, so the preview can say what ticking "copy the weekdays" would do.
 */
export function planTemplateClone({ sourceTemplates, targetTemplates, templateIds = null, copyWeekdays = false }) {
  const target = targetTemplates || []
  const taken = new Set(target.map((t) => templateNameKey(t?.name)))
  const orders = target.map((t) => t?.display_order).filter(Number.isInteger)
  let nextOrder = orders.length ? Math.max(...orders) + 1 : 0

  const wanted = Array.isArray(templateIds) ? new Set(templateIds) : null
  const found = new Set()
  const planned = new Set()
  const toCreate = []
  const skipped = []

  for (const t of sourceTemplates || []) {
    if (!t?.id) continue
    if (wanted && !wanted.has(t.id)) continue
    found.add(t.id)

    // The template manager lists `t.active` truthy as active, so null is
    // inactive here too. Asked for by id, say why it was not copied; not asked
    // for, it was never part of "all active templates".
    if (!t.active) {
      if (wanted) skipped.push({ source_id: t.id, name: t.name, reason: CLONE_SKIP_REASONS.inactive })
      continue
    }

    const key = templateNameKey(t.name)
    if (taken.has(key)) {
      skipped.push({ source_id: t.id, name: t.name, reason: CLONE_SKIP_REASONS.nameExists })
      continue
    }
    if (planned.has(key)) {
      skipped.push({ source_id: t.id, name: t.name, reason: CLONE_SKIP_REASONS.duplicateInSource })
      continue
    }
    planned.add(key)

    const sourceDays = Array.isArray(t.days_of_week) ? [...t.days_of_week] : []
    const row = {}
    for (const col of TEMPLATE_CLONE_COLUMNS) {
      if (t[col] !== undefined) row[col] = t[col]
    }
    // `[]`, not null: the column is NOT NULL DEFAULT '{}' (mig 067), and an
    // empty array is what the block generator, the nightly horizon run and the
    // runway alerts all read as "generates nothing on its own".
    row.days_of_week = copyWeekdays ? [...sourceDays] : []
    row.active = true
    row.display_order = nextOrder++
    toCreate.push({ source_id: t.id, source_days_of_week: sourceDays, row })
  }

  if (wanted) {
    for (const id of wanted) {
      if (!found.has(id)) skipped.push({ source_id: id, name: null, reason: CLONE_SKIP_REASONS.notFound })
    }
  }
  return { toCreate, skipped }
}

/**
 * Do these two studios belong to one organisation?
 *
 * Both organisation ids must be present AND equal: `undefined === undefined`
 * is not "the same organisation" (same rule as src/app/api/shelly/discover).
 *
 * @param {Array<{ id: string, organization_id?: string|null }>|null} locationRows
 * @returns {'same_org' | 'cross_org' | 'not_found'}
 */
export function organizationCheck(locationRows, fromLocationId, toLocationId) {
  const byId = new Map((locationRows || []).filter((l) => l?.id).map((l) => [l.id, l]))
  const from = byId.get(fromLocationId)
  const to = byId.get(toLocationId)
  if (!from || !to) return 'not_found'
  if (!from.organization_id || !to.organization_id) return 'cross_org'
  return from.organization_id === to.organization_id ? 'same_org' : 'cross_org'
}
