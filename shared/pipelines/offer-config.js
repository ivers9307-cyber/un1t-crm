// PIPEBUILD.3a — the offer board's config. A board of module `offer` takes its
// behaviour from `pipelines.config` (jsonb): which way in (entry), which stages,
// the day counts. This file parses and normalises that jsonb; it never trusts it.
// Pure, no IO, ESM. Every instant elsewhere is epoch ms; nothing here parses dates.

import { STAGE_ROLES, roleConfigError } from './stage-roles.js'

export const ENTRY_TYPES = Object.freeze(['trial_purchase', 'corp_promo', 'lead_source', 'glofox_plan', 'tag', 'un1t_product'])
// PIPEBUILD.3b — which ways in work on which board module.
export const ENTRY_TYPES_BY_MODULE = Object.freeze({
  offer: Object.freeze(['trial_purchase', 'corp_promo', 'lead_source', 'glofox_plan', 'tag']),
  offer_un1t: Object.freeze(['un1t_product', 'trial_purchase', 'corp_promo']),
})

/** The offer module a studio's membership source uses. */
export function moduleForMembershipSource(source) {
  return source === 'un1t_online' || source === 'un1t' ? 'offer_un1t' : 'offer'
}
export const TRIAL_MATCHES = Object.freeze(['plan_code', 'landing_path', 'page_id'])
export const DEFAULT_DURATION_DAYS = 14
export const DEFAULT_QUIET_DAYS = 60
export const DEFAULT_CONVERTED_WINDOW_DAYS = 60
export const MIA_NOTES_MAX = 1000
export const OFFER_NAME_MAX = 60
export const SIGNER_MAX = 40

// An offer board's key. It prefixes every stage slug, template name and tag, so it
// can never collide with a built-in board key (`acquisition`, `paid_trial`, ...).
export const BOARD_KEY_RE = /^o_[a-z0-9_]{1,40}$/

/** A board key from its name: slugified, 36 characters at most, `o_` prefixed,
 *  and made unique against `takenKeys` with `_2`, `_3`, ... */
export function boardKeyFor(name, takenKeys = new Set()) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36)
    .replace(/_+$/g, '')
  const base = slug ? `o_${slug}` : 'o_board'
  if (!takenKeys.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`
    if (!takenKeys.has(candidate)) return candidate
  }
}

const STAGE_ROLES_ALLOWED = STAGE_ROLES.filter((r) => r !== 'pile' && r !== 'custom')
const AT_MOST_ONE = ['first_class', 'done', 'converted']

/** The stage slug a role takes on a board: `<key>_<role>`, `<key>_class_<n>`, `<key>_day_<n>`. */
export function stageSlugFor(boardKey, role, { day, count } = {}) {
  if (role === 'class_n') return `${boardKey}_class_${count}`
  if (role === 'checkpoint') return `${boardKey}_day_${day}`
  return `${boardKey}_${role}`
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function intInRange(raw, name, min, max, fallback, errors) {
  if (raw == null) return fallback
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    errors.push(`${name} must be a whole number from ${min} to ${max}`)
    return fallback
  }
  return raw
}

function optionalText(raw, name, max, errors) {
  if (raw == null) return undefined
  if (typeof raw !== 'string') { errors.push(`${name} must be text`); return undefined }
  const v = raw.trim()
  if (v.length > max) { errors.push(`${name} must be ${max} characters or fewer`); return undefined }
  return v
}

function parseEntry(raw, errors, module) {
  if (!isObj(raw)) { errors.push('entry is required'); return null }
  if (!ENTRY_TYPES.includes(raw.type)) {
    errors.push(`entry.type must be one of ${ENTRY_TYPES.join(', ')}`)
    return null
  }
  const allowed = module ? ENTRY_TYPES_BY_MODULE[module] : null
  if (module && (!allowed || !allowed.includes(raw.type))) {
    errors.push(`entry.type ${raw.type} does not work at this studio`)
    return null
  }
  const keepCase = raw.type === 'trial_purchase' || raw.type === 'un1t_product'
  const values = Array.isArray(raw.values)
    ? [...new Set(raw.values
      .filter((v) => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => (keepCase ? v : v.toLowerCase())))]
    : []
  if (values.length === 0) errors.push('entry.values needs at least one value')
  const entry = { type: raw.type, values }
  if (raw.type === 'trial_purchase') {
    if (!TRIAL_MATCHES.includes(raw.match)) errors.push(`entry.match must be one of ${TRIAL_MATCHES.join(', ')} for trial_purchase`)
    else entry.match = raw.match
  }
  return entry
}

function parseStages(raw, boardKey, errors) {
  if (!Array.isArray(raw) || raw.length === 0) { errors.push('stages is required'); return [] }
  const out = []
  const seenSlugs = new Set()
  // pipeline_stages carries UNIQUE (pipeline_id, name) (mig 597), so two
  // stages on one board may not share a name (compared trimmed, any case).
  const seenNames = new Set()
  const roleCounts = {}
  raw.forEach((s, i) => {
    const at = `stages[${i}]`
    if (!isObj(s)) { errors.push(`${at} must be an object`); return }
    if (!STAGE_ROLES_ALLOWED.includes(s.role)) {
      errors.push(`${at}.role must be one of ${STAGE_ROLES_ALLOWED.join(', ')}`)
      return
    }
    const name = typeof s.name === 'string' ? s.name.trim() : ''
    if (!name) errors.push(`${at}.name is required`)
    else if (seenNames.has(name.toLowerCase())) errors.push(`${at} repeats the name ${name}`)
    else seenNames.add(name.toLowerCase())
    const rc = {}
    if (s.role === 'checkpoint') rc.day = s.day
    if (s.role === 'class_n') rc.count = s.count
    const rcErr = roleConfigError(s.role, rc)
    if (rcErr) errors.push(`${at}: ${rcErr}`)
    const slug = typeof s.slug === 'string' ? s.slug.trim() : ''
    if (!rcErr) {
      const want = stageSlugFor(boardKey, s.role, rc)
      if (slug !== want) errors.push(`${at}.slug must be ${want}`)
      if (seenSlugs.has(want)) errors.push(`${at} repeats the stage ${want}`)
      seenSlugs.add(want)
    }
    roleCounts[s.role] = (roleCounts[s.role] || 0) + 1
    const stage = { role: s.role, slug, name }
    if (s.role === 'checkpoint') stage.day = s.day
    if (s.role === 'class_n') stage.count = s.count
    out.push(stage)
  })
  if ((roleCounts.new || 0) !== 1) errors.push('stages needs exactly one new stage')
  for (const r of AT_MOST_ONE) {
    if ((roleCounts[r] || 0) > 1) errors.push(`stages allows at most one ${r} stage`)
  }
  return out
}

/**
 * @param {unknown} raw  the pipelines.config jsonb
 * @param {{ boardKey: string, module?: string }} opts
 * @returns {{ ok: true, config: object } | { ok: false, errors: string[] }}
 */
export function parseOfferConfig(raw, { boardKey, module } = {}) {
  const errors = []
  if (typeof boardKey !== 'string' || !boardKey) return { ok: false, errors: ['boardKey is required'] }
  if (!BOARD_KEY_RE.test(boardKey)) return { ok: false, errors: ['boardKey must look like o_name'] }
  if (!isObj(raw)) return { ok: false, errors: ['config must be an object'] }
  const entry = parseEntry(raw.entry, errors, module)
  const stages = parseStages(raw.stages, boardKey, errors)
  const duration_days = intInRange(raw.duration_days, 'duration_days', 1, 365, DEFAULT_DURATION_DAYS, errors)
  const quiet_days = intInRange(raw.quiet_days, 'quiet_days', 1, 3650, DEFAULT_QUIET_DAYS, errors)
  const converted_window_days = intInRange(raw.converted_window_days, 'converted_window_days', 1, 3650, DEFAULT_CONVERTED_WINDOW_DAYS, errors)
  let mia_notes
  if (raw.mia_notes != null) {
    if (typeof raw.mia_notes !== 'string') errors.push('mia_notes must be text')
    else if (raw.mia_notes.length > MIA_NOTES_MAX) errors.push(`mia_notes must be ${MIA_NOTES_MAX} characters or fewer`)
    else mia_notes = raw.mia_notes
  }
  const offer_name = optionalText(raw.offer_name, 'offer_name', OFFER_NAME_MAX, errors)
  const signer = optionalText(raw.signer, 'signer', SIGNER_MAX, errors)
  if (errors.length) return { ok: false, errors }
  const config = { entry, stages, duration_days, quiet_days, converted_window_days }
  if (offer_name) config.offer_name = offer_name
  if (signer) config.signer = signer
  if (mia_notes !== undefined) config.mia_notes = mia_notes
  return { ok: true, config }
}
