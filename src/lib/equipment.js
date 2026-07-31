// EQUIP-MAINT.1 — pure logic for the equipment maintenance feature.
//
// Nothing here touches Supabase or the network. Every function takes
// plain data and returns plain data, so the risky part (date maths)
// is testable without mocks. DB access lives in ./equipment-db.js.
// Date arithmetic lives in ./equipment-dates.js — split out at review
// because it is the only genuinely risky and reusable part of this
// feature, and this file will keep growing through PR 2/3. Re-exported
// below so existing import sites are unaffected.

export const EQUIPMENT_STATUS = Object.freeze({
  IN_SERVICE: 'in_service',
  OUT_OF_SERVICE: 'out_of_service',
  RETIRED: 'retired',
})

export const INSPECTION_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
})

export const ITEM_LABEL_MAX = 200
export const ITEM_ID_MAX = 100
export const MAX_ITEMS_PER_TYPE = 50
export const RESULT_NOTE_MAX = 500
export const INTERVAL_WEEKS_MIN = 1
export const INTERVAL_WEEKS_MAX = 52

// issues.description caps at 4000 (mig 213) — compose never exceeds it.
export const ISSUE_DESCRIPTION_MAX = 4000

export { dowOf, addDays, nextOccurrenceOfDow, firstDueOn, rollForward } from './equipment-dates.js'

// ---- checklist item validation ------------------------------------

/**
 * Validate a checklist item array against the shape stored in
 * equipment_types.items — [{ id, label, order }], the same shape
 * checklist_templates.items uses.
 *
 * `order` is always renumbered from the array index, so the array
 * order the operator dragged into is the order of record and a stale
 * client-side `order` value can never desync the list. Any other
 * field on an input row is silently stripped — only { id, label,
 * order } survive — so it's obvious when a later PR adds a field that
 * needs its own pass-through here.
 *
 * @returns {{ ok: true, items: Array }|{ ok: false, error: string }}
 */
export function validateItems(raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'Checklist items must be a list.' }
  }
  if (raw.length === 0) {
    return { ok: false, error: 'Add at least one checklist item.' }
  }
  if (raw.length > MAX_ITEMS_PER_TYPE) {
    return { ok: false, error: `A checklist can hold at most ${MAX_ITEMS_PER_TYPE} items.` }
  }

  const seen = new Set()
  const items = []

  for (let i = 0; i < raw.length; i++) {
    const row = raw[i]
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (!id) return { ok: false, error: `Item ${i + 1} is missing an id.` }
    if (id.length > ITEM_ID_MAX) {
      return { ok: false, error: `Item ${i + 1} id is over ${ITEM_ID_MAX} characters.` }
    }
    if (seen.has(id)) return { ok: false, error: `Duplicate item id: ${id}.` }
    seen.add(id)

    const label = typeof row?.label === 'string' ? row.label.trim() : ''
    if (!label) return { ok: false, error: `Item ${i + 1} needs a label.` }
    if (label.length > ITEM_LABEL_MAX) {
      return { ok: false, error: `Item ${i + 1} label is over ${ITEM_LABEL_MAX} characters.` }
    }

    items.push({ id, label, order: i })
  }

  return { ok: true, items }
}

// ---- inspection results -------------------------------------------

/**
 * Validate a results blob against an items snapshot.
 *
 * Two separate failure modes, deliberately distinguished:
 *   - `missing`  → items with no pass/fail mark. Submission is refused;
 *                  the route returns these ids so the UI can highlight
 *                  the unanswered rows.
 *   - `error`    → a fail with no note, an over-long note, or a
 *                  malformed items snapshot.
 *
 * `items` is a jsonb snapshot (`equipment_inspections.items`) whose
 * elements Postgres only constrains to `jsonb_typeof = 'array'` —
 * elements themselves are unvalidated, so a malformed element (null, a
 * bare string) is possible and must fail cleanly here rather than
 * throwing or producing an unmappable id in `missing`.
 *
 * @returns {{ ok: true, failed: Array<{id,label,note}> }
 *          |{ ok: false, error: string, missing?: string[] }}
 */
export function validateResults({ items, results }) {
  if (!results || typeof results !== 'object' || Array.isArray(results)) {
    return { ok: false, error: 'Results must be an object keyed by item id.' }
  }
  if (!Array.isArray(items)) {
    return { ok: false, error: 'Items snapshot is missing.' }
  }

  const missing = []
  const failed = []

  for (const item of items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
      return { ok: false, error: 'Items snapshot is malformed.' }
    }

    const row = results[item.id]
    const state = row?.state
    if (state !== 'pass' && state !== 'fail') {
      missing.push(item.id)
      continue
    }
    if (state === 'fail') {
      const note = typeof row.note === 'string' ? row.note.trim() : ''
      if (!note) {
        return { ok: false, error: `"${item.label}" was marked as a fault but has no note.` }
      }
      if (note.length > RESULT_NOTE_MAX) {
        return { ok: false, error: `The note on "${item.label}" is over ${RESULT_NOTE_MAX} characters.` }
      }
      failed.push({ id: item.id, label: item.label, note })
    }
  }

  if (missing.length > 0) {
    return { ok: false, error: 'Every check must be marked pass or fail before submitting.', missing }
  }

  return { ok: true, failed }
}

/**
 * Compose the issues.description for a failed inspection.
 * One issue per inspection listing every failed item, rather than one
 * issue per failure — a badly worn treadmill should reach the owner as
 * a single item of work, not four.
 *
 * Hard-capped at ISSUE_DESCRIPTION_MAX because issues.description has a
 * CHECK constraint at 4000 (mig 213) and would otherwise 500 the route.
 * A truncated list leaves a marker with the true fault count instead of
 * silently dropping the remaining faults mid-word with no trace, and
 * never leaves an unpaired UTF-16 surrogate at the cut point — Postgres
 * rejects one in a JSON string, which would otherwise 500 the issue
 * insert (inspectors type notes on phones and use emoji). `.length`
 * (not `[...text].length`) is deliberate: it counts UTF-16 units, so it
 * over-counts relative to Postgres's character-counting `length()` and
 * so errs conservatively against the 4000 CHECK rather than risking a
 * rejected insert — don't "optimise" it to a code-point count.
 */
export function buildIssueDescription({ equipmentName, typeName, dueOn, failed = [], extraNote }) {
  const lines = [`${equipmentName} (${typeName}) failed inspection due ${dueOn}.`, '']
  for (const f of failed) lines.push(`• ${f.label}: ${f.note}`)

  const note = typeof extraNote === 'string' ? extraNote.trim() : ''
  if (note) lines.push('', note)

  const text = lines.join('\n')
  if (text.length <= ISSUE_DESCRIPTION_MAX) return text

  const marker = `\n… truncated (${failed.length} faults in total — see the inspection record).`
  let out = text.slice(0, ISSUE_DESCRIPTION_MAX - marker.length)
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1) // don't split a surrogate pair
  return out + marker
}

/**
 * Should resolving `resolvedIssueId` put this asset back in service?
 * Only when that exact issue is what removed it. An asset taken off the
 * floor manually from the register has no linked issue and must be
 * returned to service manually — resolving an unrelated issue on it
 * must not silently put broken kit back on the floor.
 */
export function shouldReturnToService(equipment, resolvedIssueId) {
  if (!equipment) return false
  if (equipment.status !== EQUIPMENT_STATUS.OUT_OF_SERVICE) return false
  if (!equipment.out_of_service_issue_id) return false
  return equipment.out_of_service_issue_id === resolvedIssueId
}

/**
 * Is this asset due for inspection as of `today` (YYYY-MM-DD)?
 * "Due" here means due AND in service. `equipment_due_idx`'s predicate
 * (`status <> 'retired'`) is deliberately wider than that — it's an
 * index for cheapness, this function is the truth: an out-of-service
 * asset already has an open issue and must not show up as due again.
 */
export function isDue(equipment, today) {
  if (equipment?.status !== EQUIPMENT_STATUS.IN_SERVICE) return false
  return equipment.next_due_on <= today
}
