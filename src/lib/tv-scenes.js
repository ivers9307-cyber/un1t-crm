// src/lib/tv-scenes.js
//
// TVSCENE.1 — which idle scene is on screen, and when.
//
// Pure on purpose. The scene index is a FUNCTION OF ELAPSED TIME, not a
// timer: the board already re-renders every second for its header clock, so
// `sceneAt` advances itself with no setTimeout to reset. That is deliberate —
// a dwell timer inside IdleStage, the component that would otherwise own the
// rotation, is exactly the shape of TVTOAST.1 (#2066), where an effect
// depending on a callback identity that changed every second meant the
// timeout never fired. No timer, no bug.

/** How long one scene holds the screen. Richard's call, 2026-10-15. */
export const SCENE_DWELL_MS = 30000

/** Rotation order. A scene with no content is skipped, never shown empty. */
export const SCENE_KEYS = ['up-next', 'earned', 'operator']

const present = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * Whether an operator row can actually be drawn. The operator scene draws an
 * image (source_type storage or url, with a source_ref) or a text label,
 * nothing else. So eligibility and rendering must agree: if this says true the
 * scene shows something, and if it says false the scene is skipped. Two copies
 * of this rule would drift, and the board would show a blank stage for a full
 * 30s dwell. template_values alone is not renderable yet, so it does not count.
 * OperatorScene in Task 3 must guard on this predicate and not re-derive it.
 *
 * @param {object|null|undefined} operator  the payload's `idle.operator` row
 * @returns {boolean}
 */
export function operatorRenderable(operator) {
  if (!operator || typeof operator !== 'object') return false
  const image =
    (operator.source_type === 'storage' || operator.source_type === 'url') &&
    present(operator.source_ref)
  return image || present(operator.label)
}

const HAS_CONTENT = {
  'up-next': (idle) => Array.isArray(idle?.up_next) && idle.up_next.length > 0,
  earned: (idle) => Array.isArray(idle?.earned) && idle.earned.length > 0,
  operator: (idle) => operatorRenderable(idle?.operator),
}

/**
 * The scenes that currently have something to say, in rotation order.
 * A scene with nothing is skipped entirely — no "nothing this week" card.
 *
 * @param {object|null|undefined} idle  the payload's `idle` block
 * @returns {string[]}
 */
export function eligibleScenes(idle) {
  return SCENE_KEYS.filter((key) => HAS_CONTENT[key](idle))
}

/**
 * Which eligible scene is showing, given how long the board has been idle.
 * Tolerates the list shrinking between polls: the modulo is taken against the
 * CURRENT length, so an expiring scene can never leave the index out of range.
 *
 * @param {string[]} eligible
 * @param {number} elapsedMs
 * @returns {string|null} null when nothing is eligible
 */
export function sceneAt(eligible, elapsedMs) {
  const list = Array.isArray(eligible) ? eligible : []
  if (list.length === 0) return null
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  return list[Math.floor(ms / SCENE_DWELL_MS) % list.length]
}
