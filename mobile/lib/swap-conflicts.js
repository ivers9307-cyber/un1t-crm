// SWAPOVERRIDE.1 — the phone's half of the SWAPS.2 "Check before approving"
// step. PUT /api/schedule/swaps/[id] with status 'approved' re-checks every
// coach the swap moves onto a shift (approved leave covering the date, another
// live shift overlapping it that day) and refuses with
//
//   409 { success: false, code: 'swap_conflicts', error: '<all sentences>',
//         conflicts: [{ kind: 'leave'|'overlap'|'check_failed', role, coachId,
//                       date, ..., message: '<one sentence>' }] }
//
// unless the request carries confirm_conflicts: true. The sentences are built
// SERVER-SIDE (swapConflictMessage in src/lib/swap-lifecycle.js, with the
// coach's name from profiles), and the web Swaps page renders exactly those
// `message` strings — so the phone renders them too rather than re-wording
// them. The conflict rows carry a coachId, never a name, so a client-side
// re-wording could only ever be worse. The per-kind fallbacks below exist for
// a conflict that somehow arrives without its sentence.
//
// Pure — no React Native — so it is Vitest-testable (there is no RN component
// test runner). mobile/app/(staff)/approvals.jsx is the caller.

// Must equal SWAP_CONFLICTS_CODE in src/lib/swap-lifecycle.js, which mobile
// cannot import. swap-conflicts.test.js pins the two by reading that file.
export const SWAP_CONFLICTS_CODE = 'swap_conflicts'

/**
 * Is this api() envelope the "approve anyway?" refusal — as opposed to any
 * other failure (stale swap, already decided, 403, network), which keeps the
 * plain "Could not approve" alert?
 *
 * Keyed on the response CODE, not the 409: the route sends other 409s
 * (swap_stale, swap_not_open, swap_conflict — a coach already ON that shift)
 * that must never be offered an override. api() carries `status` on a non-2xx
 * envelope; when present it must be 409.
 */
export function isSwapConflictRefusal(res) {
  if (!res || typeof res !== 'object') return false
  if (res.success !== false) return false
  if (res.code !== SWAP_CONFLICTS_CODE) return false
  if (res.status !== undefined && res.status !== 409) return false
  return true
}

function fallbackLine(c) {
  const date = c?.date ? ` on ${c.date}` : ''
  if (c?.kind === 'leave') return `A coach in this swap has approved leave${date}.`
  if (c?.kind === 'overlap') {
    const window = c.startTime && c.endTime ? ` ${c.startTime} to ${c.endTime}` : ''
    return `A coach in this swap is already on another shift${window}${date}.`
  }
  if (c?.kind === 'check_failed') return `Couldn't check a coach's leave and other shifts${date}.`
  return 'This swap has a conflict.'
}

/**
 * One display line per conflict, in the server's order, duplicates dropped.
 * Never empty for a refusal: with no usable conflict rows it falls back to the
 * response's `error`, then to a generic sentence (the web does the same).
 */
export function swapConflictLines(res) {
  const rows = Array.isArray(res?.conflicts) ? res.conflicts : []
  const lines = []
  for (const c of rows) {
    if (!c || typeof c !== 'object') continue
    const msg = typeof c.message === 'string' ? c.message.trim() : ''
    const line = msg || fallbackLine(c)
    if (!lines.includes(line)) lines.push(line)
  }
  if (lines.length) return lines
  const err = typeof res?.error === 'string' ? res.error.trim() : ''
  return [err || 'This swap has a conflict.']
}

/**
 * The native Alert for a conflict refusal, or null when `res` is not one
 * (the caller then shows its ordinary "Could not approve").
 *
 * A check that could not be read (`check_failed`) is not a clash, so when
 * EVERY conflict is unchecked the title says so instead of implying one.
 *
 * @returns {null | { title: string, message: string, lines: string[], uncheckedOnly: boolean }}
 */
export function swapConflictPrompt(res) {
  if (!isSwapConflictRefusal(res)) return null
  const lines = swapConflictLines(res)
  const rows = Array.isArray(res.conflicts) ? res.conflicts.filter((c) => c && typeof c === 'object') : []
  const uncheckedOnly = rows.length > 0 && rows.every((c) => c.kind === 'check_failed')
  const body = lines.length === 1 ? lines[0] : lines.map((l) => `• ${l}`).join('\n')
  return {
    title: uncheckedOnly ? "Couldn't check this swap" : 'Check before approving',
    message: `${body}\n\nApprove anyway?`,
    lines,
    uncheckedOnly,
  }
}
