// SHIFTTYPE.1 (mig 628) — the kind + min_coaches half of a shift-template (or
// manual slot) write.
//
// An admin shift has NO minimum staffing (Richard, 25 Sep 2026), and the
// database says so too: CHECK shift_templates_admin_no_minimum
// (kind <> 'admin' OR min_coaches = 0). Policy:
//
//   * an EXPLICIT contradiction (kind admin + min_coaches > 0) is refused with
//     a 400 the editor can show. Silently rewriting it would save something
//     the operator did not type and hide a client bug.
//   * an OMITTED value is normalised: admin with no minimum is 0; leaving
//     admin for class with no minimum restores the create default of 1
//     (SHIFTMIN.1). class -> admin writes min_coaches 0 in the SAME update,
//     because the CHECK needs both columns to change in one statement.
//
// Web-only (the phone never writes templates). Named differently from
// shared/shift-kind.js on purpose: a same-named module in both trees is a
// pair tests/shared-pair-sync.test.js would make someone classify.

import { DEFAULT_SHIFT_KIND } from '@shared/shift-kind'

export const ADMIN_MINIMUM_ERROR = 'admin_has_no_minimum'
const ADMIN_MINIMUM_MESSAGE = 'An admin shift has no minimum number of coaches. Set the minimum to 0, or make it a class shift.'
const CLASS_DEFAULT_MIN = 1

/**
 * @param {'class'|'admin'|string} kind
 * @param {number|null|undefined} minCoaches  the value the caller SENT (undefined = not sent)
 * @returns {null | { status: 400, body: { success: false, error: string, message: string } }}
 */
export function adminMinimumRefusal(kind, minCoaches) {
  if (kind !== 'admin') return null
  if (minCoaches === undefined || minCoaches === null || minCoaches === 0) return null
  return { status: 400, body: { success: false, error: ADMIN_MINIMUM_ERROR, message: ADMIN_MINIMUM_MESSAGE } }
}

/**
 * @param {object} args
 * @param {{ kind?: string, min_coaches?: number } | null} [args.prior]  the stored row for an edit; null for a create
 * @param {object} args.body  the validated request body
 * @returns {{ ok: true, patch: { kind?: 'class'|'admin', min_coaches?: number } }
 *         | { ok: false, status: 400, body: object }}
 */
export function resolveTemplateKindWrite({ prior = null, body = {} }) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
  const priorKind = prior ? (prior.kind === 'admin' ? 'admin' : 'class') : null
  const nextKind = has('kind') ? body.kind : (priorKind ?? DEFAULT_SHIFT_KIND)

  const refusal = adminMinimumRefusal(nextKind, has('min_coaches') ? body.min_coaches : undefined)
  if (refusal) return { ok: false, ...refusal }

  const patch = {}
  if (!prior || has('kind')) patch.kind = nextKind

  if (nextKind === 'admin') {
    if (!prior || has('kind') || has('min_coaches')) patch.min_coaches = 0
  } else if (!prior) {
    patch.min_coaches = has('min_coaches') ? body.min_coaches : CLASS_DEFAULT_MIN
  } else if (has('min_coaches')) {
    patch.min_coaches = body.min_coaches
  } else if (priorKind === 'admin' && has('kind')) {
    patch.min_coaches = CLASS_DEFAULT_MIN
  }
  return { ok: true, patch }
}
