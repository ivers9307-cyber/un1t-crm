// PIPEBUILD.2 — the stage-role vocabulary. A configured board's stages carry a
// role (pipeline_stages.stage_role, mig 814) that says what the stage MEANS to
// the classifier and the builder, whatever the operator calls it.
// Pure: no IO. Import as 'shared/pipelines/stage-roles' from mobile.

export const STAGE_ROLES = Object.freeze([
  'new', 'first_class', 'class_n', 'checkpoint', 'done', 'converted', 'pile', 'custom',
])

// The role (and role_config) a default stage slug is seeded with. ONE map: mig
// 814's backfill groups and location-seed's new-studio rows both follow it
// (tests/pipeline-stage-roles-map.test.js pins it to the migration text).
const ROLE_GROUPS = [
  ['new', ['new_lead', 'paid_trial_new_lead', 'programme_lead', 'waitlist_new_enquiry', 'returning_booked'], {}],
  ['first_class', ['first_class', 'paid_trial_first_class', 'programme_first_class', 'returning_first_class'], {}],
  ['class_n', ['second_class', 'returning_second_class'], { count: 2 }],
  ['checkpoint', ['paid_trial_day_7'], { day: 7 }],
  ['done', ['trial_done', 'paid_trial_done', 'returning_final_class'], {}],
  ['converted', ['converted', 'paid_trial_converted', 'programme_converted', 'waitlist_converted'], {}],
  ['pile', ['member', 'pack_member', 'classpass', 'gympass', 'cold_lead', 'dormant'], {}],
]

export const DEFAULT_ROLE_BY_SLUG = Object.freeze(Object.fromEntries(
  ROLE_GROUPS.flatMap(([stage_role, slugs, role_config]) =>
    slugs.map((slug) => [slug, Object.freeze({ stage_role, role_config: Object.freeze({ ...role_config }) })])),
))

const LIVE_FUNNEL = new Set(['new', 'first_class', 'class_n', 'checkpoint', 'done'])

// Stored role if valid; else a dormant stage is the pile; else custom.
export function stageRoleOf(stage) {
  const stored = stage?.stage_role
  if (typeof stored === 'string' && STAGE_ROLES.includes(stored)) return stored
  return stage?.is_dormant ? 'pile' : 'custom'
}

export function isLiveFunnelRole(role) {
  return LIVE_FUNNEL.has(role)
}

export function isPileRole(role) {
  return role === 'pile'
}

// null when the role's config is valid, else a human-readable reason.
export function roleConfigError(role, config) {
  const c = config && typeof config === 'object' ? config : {}
  if (role === 'class_n') {
    if (!Number.isInteger(c.count) || c.count < 2) return 'class_n needs a whole-number count of 2 or more'
  }
  if (role === 'checkpoint') {
    if (!Number.isInteger(c.day) || c.day < 1) return 'checkpoint needs a whole-number day of 1 or more'
  }
  return null
}
