// PIPEBUILD.5i — the board wizard's state. Pure: no React, no IO, so the
// reducer, the config it builds and the step checks are unit-tested directly
// (pipeline-wizard.test.js). The step components under
// src/components/pipelines/wizard/ render it; Task 11's settings page reuses
// them with the same { state, dispatch } props.
//
// The checks are parseOfferConfig's own (shared/pipelines/offer-config.js),
// run with boardKey 'o_preview' and translated into plain words per step, and
// renderPack's (shared/pipelines/recipes.js) for the follow-up wording, so
// the wizard never refuses or admits anything the server would not. The
// server is still the judge: it re-parses, and overwrites every stage slug.

import { RECIPES, renderPack, studioSlugFor } from '@shared/pipelines/recipes.js'
import {
  parseOfferConfig, stageSlugFor, MIA_NOTES_MAX, OFFER_NAME_MAX, SIGNER_MAX,
} from '@shared/pipelines/offer-config.js'

export const WIZARD_STEPS = Object.freeze([
  'Recipe', 'Name and offer', 'Who enters', 'Stages', 'Follow-ups', 'Notes for Mia', 'Review',
])

// The server's words and list (src/lib/pipeline-boards.js UN1T_STUDIO_ERROR,
// src/lib/pipeline-offer-claims.js UN1T_MEMBERSHIP_SOURCES), copied because a
// client bundle must not import those server modules; the test pins both.
export const UN1T_STUDIO_NOTICE = "Offer boards at un1t.online studios aren't available yet."
export const UN1T_SOURCES = Object.freeze(['un1t_online', 'un1t'])
export const isUn1tStudio = (source) => UN1T_SOURCES.includes(source)

export const OWNER_ONLY_NOTICE = 'Only owners can build boards.'
export const DEFAULT_PRIORITY = 100
// boardCreateSchema's bounds (src/lib/schemas.js), copied for the client
// bundle; pipeline-wizard.test.js parses the same values with the schema.
export const BOARD_NAME_MAX = 80
export const PRIORITY_MIN = 1
export const PRIORITY_MAX = 1000
const PREVIEW_KEY = 'o_preview'

// The entry rule in words. A trial purchase's words follow its match.
export const TRIAL_MATCH_LABELS = Object.freeze({
  plan_code: 'Plan code',
  landing_path: 'Landing page path',
  page_id: 'Landing page',
})
const ENTRY_WORDS = Object.freeze({
  corp_promo: 'People who claim the promo…',
  lead_source: 'People who come in through the lead source…',
  glofox_plan: 'People on the Glofox membership…',
  tag: 'People tagged…',
})
const TRIAL_WORDS = Object.freeze({
  plan_code: 'People who buy a trial with plan code…',
  landing_path: 'People who buy a trial on landing page path…',
  page_id: 'People who buy a trial on landing page…',
})

/** "People who buy a trial with plan code…" for an entry rule. */
export function entryDescription(entry) {
  if (!entry) return ''
  if (entry.type === 'trial_purchase') return TRIAL_WORDS[entry.match] || 'People who buy a trial…'
  return ENTRY_WORDS[entry.type] || 'People who match…'
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/**
 * @param {{ studioName?: string, bookingFlowId?: string, appLinks?: { iosUrl: string, androidUrl: string } }} [studio]
 *   what the preview renders with: the studio's name, and the Book / app
 *   buttons the server would add (src/lib/pipeline-board-followups.js
 *   renderInputsFor), so the preview shows what Meta gets.
 */
export function initialWizardState(studio = {}) {
  return {
    step: 0,
    showErrors: false,
    studio: {
      name: String(studio.studioName ?? '').trim(),
      ...(studio.bookingFlowId ? { bookingFlowId: studio.bookingFlowId } : {}),
      ...(studio.appLinks ? { appLinks: studio.appLinks } : {}),
    },
    recipeKey: null,
    name: '',
    offerName: '',
    signer: '',
    priority: DEFAULT_PRIORITY,
    durationDays: null,
    entry: null,
    stages: [],
    bodies: {},
    miaNotes: '',
  }
}

// A number field's value: a whole number when it reads as one, else what was
// typed, so the check can say what is wrong instead of silently dropping it.
function wholeOrRaw(v) {
  if (typeof v === 'number') return v
  const s = String(v ?? '').trim()
  return /^\d+$/.test(s) ? Number(s) : s
}

function fromRecipe(recipe) {
  const defaults = recipe.defaultConfig(PREVIEW_KEY)
  const bodies = {}
  for (const pack of recipe.packs) {
    bodies[pack.key] = Object.fromEntries(pack.templates.map((t) => [t.ref, t.body]))
  }
  // A checkpoint whose follow-up is written for a set day keeps that day: the
  // message counts {days_left} from it, and the server refuses the pack on a
  // stage moved to another day (installFollowupPack, pack_day_mismatch).
  const packDayByRole = Object.fromEntries(recipe.packs.filter((p) => p.day != null).map((p) => [p.role, p.day]))
  return {
    recipeKey: recipe.key,
    durationDays: defaults.duration_days,
    entry: { ...defaults.entry, values: [] },
    stages: defaults.stages.map((s) => ({
      role: s.role,
      name: s.name,
      defaultName: s.name,
      ...(s.day != null ? { day: s.day } : {}),
      ...(s.count != null ? { count: s.count } : {}),
      ...(s.role === 'checkpoint' && packDayByRole.checkpoint != null
        ? { day: packDayByRole.checkpoint, fixedDay: packDayByRole.checkpoint }
        : {}),
      enabled: true,
      locked: s.role === 'new',
    })),
    bodies,
  }
}

function patchStage(state, index, patch) {
  if (!state.stages[index]) return state
  return { ...state, stages: state.stages.map((s, i) => (i === index ? { ...s, ...patch } : s)) }
}

export function wizardReducer(state, action) {
  switch (action?.type) {
    case 'pickRecipe': {
      const recipe = RECIPES[action.recipeKey]
      if (!recipe || state.recipeKey === recipe.key) return { ...state, showErrors: false }
      return { ...state, ...fromRecipe(recipe), showErrors: false }
    }
    case 'setName': return { ...state, name: String(action.name ?? '') }
    case 'setOfferName': return { ...state, offerName: String(action.name ?? '') }
    case 'setSigner': return { ...state, signer: String(action.name ?? '') }
    case 'setPriority': return { ...state, priority: wholeOrRaw(action.priority) }
    case 'setDurationDays': return { ...state, durationDays: wholeOrRaw(action.days) }
    case 'setEntryValues':
      if (!state.entry) return state
      return { ...state, entry: { ...state.entry, values: Array.isArray(action.values) ? [...action.values] : [] } }
    case 'setEntryMatch':
      if (!state.entry || state.entry.type !== 'trial_purchase') return state
      if (state.entry.match === action.match) return state
      // Plan codes, paths and pages are different lists: a match change empties the pick.
      return { ...state, entry: { ...state.entry, match: action.match, values: [] } }
    case 'toggleStage': {
      const s = state.stages[action.index]
      if (!s || s.locked) return state
      return patchStage(state, action.index, { enabled: !s.enabled })
    }
    case 'renameStage': return patchStage(state, action.index, { name: String(action.name ?? '') })
    case 'setStageDay':
      if (state.stages[action.index]?.role !== 'checkpoint') return state
      if (state.stages[action.index].fixedDay != null) return state
      return patchStage(state, action.index, { day: wholeOrRaw(action.day) })
    case 'setStageCount':
      if (state.stages[action.index]?.role !== 'class_n') return state
      return patchStage(state, action.index, { count: wholeOrRaw(action.count) })
    case 'setBody': {
      if (!state.bodies[action.packKey]) return state
      return {
        ...state,
        bodies: { ...state.bodies, [action.packKey]: { ...state.bodies[action.packKey], [action.ref]: String(action.body ?? '') } },
      }
    }
    case 'setMiaNotes': return { ...state, miaNotes: String(action.notes ?? '') }
    case 'next': {
      if (state.step >= WIZARD_STEPS.length - 1) return state
      if (stepErrors(state, state.step).length) return { ...state, showErrors: true }
      return { ...state, step: state.step + 1, showErrors: false }
    }
    case 'back': return { ...state, step: Math.max(0, state.step - 1), showErrors: false }
    default: return state
  }
}

// ---------------------------------------------------------------------------
// editing a saved board (PIPEBUILD.5k, /settings/pipelines/[id])
// ---------------------------------------------------------------------------

/**
 * Wizard state for a board that already exists, so the settings page edits it
 * with the same reducer and step components. The recipe gives the stage list
 * (a stage the board does not use comes back unticked, at its recipe place),
 * the board gives every value. A stage on the board that the recipe does not
 * list is kept, ticked, so a save never drops it. A checkpoint with a pack
 * keeps that pack's fixed day (Task 9's rule).
 *
 * The follow-up wording starts as each installed follow-up's current template
 * text (`followups[].body_texts`, by ref), else the recipe's own.
 *
 * @param {object} board  GET /api/pipelines/[id]'s board
 * @param {object|string} recipe  RECIPES entry, or its key
 * @param {object} [studio]  as initialWizardState
 */
export function stateFromBoard(board, recipe, studio = {}) {
  const r = typeof recipe === 'string' ? RECIPES[recipe] : recipe
  const base = initialWizardState(studio)
  if (!r || !board) return base
  const fresh = fromRecipe(r)
  const config = board.config && typeof board.config === 'object' ? board.config : {}
  const stored = Array.isArray(config.stages) ? config.stages : []

  const byRole = new Map()
  for (const s of fresh.stages) if (!byRole.has(s.role)) byRole.set(s.role, s)
  const used = new Set()
  const stages = stored.map((s) => {
    const def = byRole.get(s.role)
    const takeDef = def && !used.has(s.role)
    if (takeDef) used.add(s.role)
    const out = {
      role: s.role,
      name: String(s.name ?? ''),
      defaultName: takeDef ? def.defaultName : String(s.name ?? ''),
      enabled: true,
      locked: s.role === 'new',
    }
    if (s.role === 'checkpoint') {
      out.day = s.day
      if (takeDef && def.fixedDay != null) out.fixedDay = def.fixedDay
    }
    if (s.role === 'class_n') out.count = s.count
    return out
  })
  // The recipe's unused stages, unticked, each after the last board stage
  // that comes before it in the recipe (or first).
  fresh.stages.forEach((def, i) => {
    if (used.has(def.role)) return
    const before = new Set(fresh.stages.slice(0, i).map((s) => s.role))
    let at = 0
    stages.forEach((s, j) => { if (before.has(s.role)) at = j + 1 })
    stages.splice(at, 0, { ...def, enabled: false })
    used.add(def.role)
  })

  const bodies = { ...fresh.bodies }
  for (const f of board.followups || []) {
    const texts = f?.body_texts
    if (!bodies[f?.pack_key] || !texts || typeof texts !== 'object') continue
    const next = { ...bodies[f.pack_key] }
    for (const [ref, text] of Object.entries(texts)) {
      if (ref in next && typeof text === 'string' && text) next[ref] = text
    }
    bodies[f.pack_key] = next
  }

  const entry = config.entry && typeof config.entry === 'object'
    ? {
      type: config.entry.type,
      ...(config.entry.match ? { match: config.entry.match } : {}),
      values: Array.isArray(config.entry.values) ? [...config.entry.values] : [],
    }
    : fresh.entry

  return {
    ...base,
    recipeKey: r.key,
    name: String(board.name ?? ''),
    offerName: String(config.offer_name ?? ''),
    signer: String(config.signer ?? ''),
    priority: Number.isInteger(board.priority) ? board.priority : DEFAULT_PRIORITY,
    durationDays: config.duration_days ?? fresh.durationDays,
    entry,
    stages,
    bodies,
    miaNotes: String(config.mia_notes ?? ''),
  }
}

/**
 * The config PATCH /api/pipelines/[id] takes: the wizard's, keeping the stored
 * quiet_days and converted_window_days, which the wizard does not edit (left
 * out, the server would put the defaults back, which needs the board off).
 */
export function settingsConfig(state, storedConfig = {}) {
  const config = wizardConfig(state)
  const s = storedConfig && typeof storedConfig === 'object' ? storedConfig : {}
  if (s.quiet_days != null) config.quiet_days = s.quiet_days
  if (s.converted_window_days != null) config.converted_window_days = s.converted_window_days
  return config
}

/** The recipe's pack for one board stage: same role, and for a checkpoint the same day. */
export function packForBoardStage(recipe, stage) {
  const r = typeof recipe === 'string' ? RECIPES[recipe] : recipe
  if (!r || !stage) return null
  const same = r.packs.filter((p) => p.role === stage.stage_role)
  if (stage.stage_role === 'checkpoint') {
    const day = stage.role_config?.day
    return same.find((p) => p.day != null && p.day === day) || null
  }
  return same[0] || null
}

/**
 * One pack's wording, only the messages that differ from the recipe's (as
 * wizardBodies), for the follow-up PUT's `bodies`. Null when nothing differs,
 * so the server renders the recipe's own.
 */
export function packBodies(state, packKey) {
  const out = wizardBodies(state)[packKey]
  return out && Object.keys(out).length ? out : null
}

// ---------------------------------------------------------------------------
// what the wizard sends
// ---------------------------------------------------------------------------

const enabledStages = (state) => state.stages.filter((s) => s.enabled)

/** The `config` POST /api/locations/[id]/pipelines takes. Stage slugs are left to the server. */
export function wizardConfig(state) {
  const config = {
    entry: state.entry
      ? { type: state.entry.type, ...(state.entry.match ? { match: state.entry.match } : {}), values: [...state.entry.values] }
      : null,
    stages: enabledStages(state).map((s) => ({
      role: s.role,
      name: s.name.trim(),
      ...(s.role === 'checkpoint' ? { day: s.day } : {}),
      ...(s.role === 'class_n' ? { count: s.count } : {}),
    })),
    duration_days: state.durationDays,
  }
  const offerName = state.offerName.trim()
  const signer = state.signer.trim()
  if (offerName) config.offer_name = offerName
  if (signer) config.signer = signer
  if (state.miaNotes.trim()) config.mia_notes = state.miaNotes
  return config
}

/** The create route's whole body: { name, recipe_key, config, priority }. */
export function wizardCreateBody(state) {
  return { name: state.name.trim(), recipe_key: state.recipeKey, config: wizardConfig(state), priority: state.priority }
}

/**
 * The operator's own wording, by pack and ref, only where it differs from the
 * recipe's. Unchanged wording is left out so the server renders the recipe's
 * own (which swaps "Tap below" for the reply line when there is no button).
 */
export function wizardBodies(state) {
  const recipe = RECIPES[state.recipeKey]
  if (!recipe) return {}
  const out = {}
  for (const pack of recipe.packs) {
    for (const t of pack.templates) {
      const body = state.bodies[pack.key]?.[t.ref]
      if (body != null && body !== t.body) (out[pack.key] ||= {})[t.ref] = body
    }
  }
  return out
}

/** The recipe's packs whose stage is ticked, in recipe order. */
export function followupPacks(state) {
  const recipe = RECIPES[state.recipeKey]
  if (!recipe) return []
  const roles = new Set(enabledStages(state).map((s) => s.role))
  return recipe.packs.filter((p) => roles.has(p.role))
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

/** The same fill-ins the server uses: offer name else the board name, sign-off else the studio name. */
function renderOpts(state) {
  const studioName = state.studio?.name || ''
  return {
    boardKey: PREVIEW_KEY,
    studioSlug: studioSlugFor(studioName) || 'studio',
    studioName,
    offerName: state.offerName.trim() || state.name.trim(),
    durationDays: state.durationDays,
    signer: state.signer.trim() || studioName,
    ...(state.studio?.bookingFlowId ? { bookingFlowId: state.studio.bookingFlowId } : {}),
    ...(state.studio?.appLinks ? { appLinks: state.studio.appLinks } : {}),
  }
}

function plainError(err) {
  const message = String(err?.message ?? err).replace(/^wording: /, '')
  const m = /^durationDays must be more than the day (\d+) check-in/.exec(message)
  if (m) return `The offer must last more than ${m[1]} days for the day ${m[1]} check-in.`
  return message
}

/**
 * One message as Meta will get it, with {{1}} shown as Tim.
 * @returns {{ components: object[]|null, error: string|null }}
 */
export function previewTemplate(state, packKey, ref) {
  const recipe = RECIPES[state.recipeKey]
  const pack = recipe?.packs.find((p) => p.key === packKey)
  const template = pack?.templates.find((t) => t.ref === ref)
  if (!template) return { components: null, error: 'There is no such message.' }
  const body = state.bodies[packKey]?.[ref]
  const changed = body != null && body !== template.body
  try {
    const { templates } = renderPack(recipe.key, packKey, { ...renderOpts(state), ...(changed ? { bodies: { [ref]: body } } : {}) })
    const rendered = templates.find((t) => t.ref === ref)
    const components = rendered.components.map((c) => (
      c.type === 'BODY' ? { ...c, text: c.text.replace(/(?<!\{)\{\{1\}\}(?!\})/g, 'Tim') } : c
    ))
    return { components, error: null }
  } catch (err) {
    return { components: null, error: plainError(err) }
  }
}

// ---------------------------------------------------------------------------
// step checks
// ---------------------------------------------------------------------------

// parseOfferConfig's messages, said plainly. `stageAt(i)` is the i-th ticked stage.
function translate(message, stageAt) {
  let m
  if (message === 'entry is required' || message.startsWith('entry.type')) return 'Pick a recipe.'
  if (message === 'entry.values needs at least one value') return 'Pick at least one option.'
  if (message.startsWith('entry.match')) return 'Choose what to match the trial purchase on.'
  if ((m = /^stages\[(\d+)\]\.name is required$/.exec(message))) return `Give the ${stageAt(m[1])} stage a name.`
  if ((m = /^stages\[\d+\] repeats the name (.+)$/.exec(message))) return `Two stages are called ${m[1]}. Give each stage its own name.`
  if (/^stages\[\d+\]: checkpoint/.test(message)) return 'The check-in day must be a whole number, 1 or more.'
  if (/^stages\[\d+\]: class_n/.test(message)) return 'The class count must be a whole number, 2 or more.'
  if (/^stages\[\d+\] repeats the stage/.test(message)) return 'Two stages are on the same day or class count. Change one.'
  if (message === 'stages is required') return 'Tick at least one stage.'
  if (message.startsWith('duration_days')) return 'The offer length must be a whole number of days from 1 to 365.'
  if (message.startsWith('offer_name')) return `The offer name must be ${OFFER_NAME_MAX} characters or fewer.`
  if (message.startsWith('signer')) return `The sign-off must be ${SIGNER_MAX} characters or fewer.`
  if (message.startsWith('mia_notes')) return `Notes for Mia must be ${MIA_NOTES_MAX} characters or fewer.`
  return message
}

const STEP_OF = [
  [/^entry\b/, 'Who enters'],
  [/^stages\b/, 'Stages'],
  [/^(duration_days|offer_name|signer)\b/, 'Name and offer'],
  [/^mia_notes\b/, 'Notes for Mia'],
]

function parserErrorsByStep(state) {
  const config = wizardConfig(state)
  const candidate = {
    ...config,
    // The parser insists on a slug; the preview key's is the one it expects.
    stages: config.stages.map((s) => ({ ...s, slug: stageSlugFor(PREVIEW_KEY, s.role, s) })),
  }
  const parsed = parseOfferConfig(candidate, { boardKey: PREVIEW_KEY })
  const out = {}
  if (parsed.ok) return out
  const ticked = enabledStages(state)
  const stageAt = (i) => ticked[Number(i)]?.defaultName || `stage ${Number(i) + 1}`
  for (const message of parsed.errors) {
    const step = STEP_OF.find(([re]) => re.test(message))?.[1] ?? 'Review'
    const text = translate(message, stageAt)
    ;(out[step] ||= []).includes(text) || out[step].push(text)
  }
  return out
}

const hasBraces = (v) => /\{\{|\}\}/.test(v)

function nameStepErrors(state) {
  const errors = []
  const name = state.name.trim()
  if (!name) errors.push('Give the board a name.')
  else if (name.length > BOARD_NAME_MAX) errors.push(`The board name must be ${BOARD_NAME_MAX} characters or fewer.`)
  // These three become {offer} and {signer} in the messages (the board name
  // stands in for a blank offer name), where {{ }} would add a Meta variable.
  if (hasBraces(state.offerName) || (!state.offerName.trim() && hasBraces(name))) {
    errors.push(state.offerName.trim() ? "The offer name can't contain {{ or }}." : "The board name can't contain {{ or }}.")
  }
  if (hasBraces(state.signer)) errors.push("The sign-off can't contain {{ or }}.")
  const p = state.priority
  if (!Number.isInteger(p) || p < PRIORITY_MIN || p > PRIORITY_MAX) {
    errors.push(`Priority must be a whole number from ${PRIORITY_MIN} to ${PRIORITY_MAX}.`)
  }
  return errors
}

function followupErrors(state) {
  const errors = []
  for (const pack of followupPacks(state)) {
    for (const t of pack.templates) {
      const { error } = previewTemplate(state, pack.key, t.ref)
      const text = error && `${pack.name}: ${error}`
      if (text && !errors.includes(text)) errors.push(text)
    }
  }
  return errors
}

/**
 * What stops the wizard leaving `step` (a name from WIZARD_STEPS or its
 * index). 'Review' answers for every step at once.
 * @returns {string[]}
 */
export function stepErrors(state, step) {
  const name = typeof step === 'number' ? WIZARD_STEPS[step] : step
  if (name === 'Recipe') return RECIPES[state.recipeKey] ? [] : ['Pick a recipe.']
  if (!RECIPES[state.recipeKey]) return ['Pick a recipe.']
  const byStep = parserErrorsByStep(state)
  const forStep = (n) => {
    if (n === 'Name and offer') return [...nameStepErrors(state), ...(byStep[n] || [])]
    // A wording check needs the offer fields to be right first.
    if (n === 'Follow-ups') return (forStep('Name and offer').length || forStep('Stages').length) ? [] : followupErrors(state)
    return byStep[n] || []
  }
  if (name === 'Review') {
    return WIZARD_STEPS.slice(1, -1).flatMap(forStep).concat(byStep.Review || [])
  }
  return forStep(name)
}
