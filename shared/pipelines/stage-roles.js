// PIPEBUILD.2 — the stage-role vocabulary. A configured board's stages carry a
// role (pipeline_stages.stage_role, mig 814) that says what the stage MEANS to
// the classifier and the builder, whatever the operator calls it.
// Pure: no IO. Import as 'shared/pipelines/stage-roles' from mobile.

export const STAGE_ROLES = Object.freeze([
  'new', 'first_class', 'class_n', 'checkpoint', 'done', 'converted', 'pile', 'custom',
])

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
