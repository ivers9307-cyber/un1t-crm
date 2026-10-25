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
//
// The operator scene has two questions, and this module answers both so no
// consumer re-derives either: whether the scene appears at all
// (operatorRenderable), and which branch it draws (operatorImageRef, else
// operatorLabel). For the image branch, operatorImageRef returns the trimmed
// source_ref, which the payload builder has already resolved to a public URL
// for storage rows. So it is the string to use as src, and callers must not
// re-resolve it. Never put a raw bucket path in an <img>: it is a broken image
// held for the whole dwell, and the cause of this branch's worst cross-task bug.
// For the label branch, operatorLabel returns the trimmed label, so a
// whitespace-only label is "no label" in the scene exactly as it is here.

/** How long one scene holds the screen. Richard's call, 2026-10-15. */
export const SCENE_DWELL_MS = 30000

/** Rotation order. A scene with no content is skipped, never shown empty. */
export const SCENE_KEYS = ['up-next', 'earned', 'operator']

const present = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * Which branch the operator scene draws, and the string to use as its `src`.
 * Returns the trimmed source_ref when the row is an image the scene can draw
 * (source_type storage or url, with a non-blank ref), otherwise null. A null
 * means the scene draws its label, or nothing.
 *
 * For storage rows the ref is NOT a raw bucket path by the time it gets here:
 * the payload builder has already resolved it to a public URL. So the return
 * value is the string for src, and callers must not re-resolve it or assume a
 * raw storage path is usable in an <img>. This answers WHICH BRANCH, not
 * whether the scene appears: use operatorRenderable for that.
 *
 * @param {object|null|undefined} operator  the payload's `idle.operator` row
 * @returns {string|null}
 */
export function operatorImageRef(operator) {
  if (!operator || typeof operator !== 'object') return null
  if (operator.source_type !== 'storage' && operator.source_type !== 'url') return null
  return present(operator.source_ref) ? operator.source_ref.trim() : null
}

/**
 * The label the scene draws when it has no image: the trimmed label, or null
 * when it is missing, not a string, or only whitespace. Read whatever the
 * source_type, because the scene picks its BRANCH with operatorImageRef and
 * only falls back to this when that returns null. The same rule
 * operatorRenderable counts, exported so the scene consumes it instead of
 * restating "non-blank" (the drift that blanked the stage three times).
 *
 * @param {object|null|undefined} operator  the payload's `idle.operator` row
 * @returns {string|null}
 */
export function operatorLabel(operator) {
  const label = operator?.label
  return present(label) ? label.trim() : null
}

/**
 * Whether the operator scene appears at all. It appears when it can draw
 * something: an image (operatorImageRef is non-null) or a non-blank label.
 * template_values alone is not renderable yet, so it does not count. This
 * answers WHETHER THE SCENE APPEARS, not which branch it draws: use
 * operatorImageRef for that. Eligibility and rendering must agree, or the
 * board shows a blank stage for a full 30s dwell.
 *
 * @param {object|null|undefined} operator  the payload's `idle.operator` row
 * @returns {boolean}
 */
export function operatorRenderable(operator) {
  return operatorImageRef(operator) !== null || operatorLabel(operator) !== null
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
