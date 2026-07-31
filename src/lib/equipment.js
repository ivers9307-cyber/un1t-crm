// EQUIP-MAINT.1 — pure logic for the equipment maintenance feature.
//
// Nothing here touches Supabase or the network. Every function takes
// plain data and returns plain data, so the risky part (date maths)
// is testable without mocks. DB access lives in ./equipment-db.js.
//
// DATES: every date here is a timezone-less calendar string
// (YYYY-MM-DD), like bookings.booking_date. We build from parts in UTC
// and format by hand — never toISOString(), never local-time parsing —
// so results are identical under TZ=Europe/Dublin and a US timezone,
// and across the BST/GMT boundary. See CLAUDE.md "Timezones".

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
export const MAX_ITEMS_PER_TYPE = 50
export const RESULT_NOTE_MAX = 500
export const INTERVAL_WEEKS_MIN = 1
export const INTERVAL_WEEKS_MAX = 52

// issues.description caps at 4000 (mig 213) — compose never exceeds it.
export const ISSUE_DESCRIPTION_MAX = 4000

// ---- date helpers -------------------------------------------------

/** Format a UTC Date as YYYY-MM-DD by hand (toISOString is guardrail-blocked). */
function formatUtc(dt) {
  const y = dt.getUTCFullYear()
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const d = String(dt.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function toUtcDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** Day of week for a YYYY-MM-DD string, Postgres convention (0 = Sunday). */
export function dowOf(dateStr) {
  return toUtcDate(dateStr).getUTCDay()
}

/** Add (or subtract) whole days to a YYYY-MM-DD string. */
export function addDays(dateStr, days) {
  const dt = toUtcDate(dateStr)
  dt.setUTCDate(dt.getUTCDate() + days)
  return formatUtc(dt)
}

/** The next date on or after `fromDateStr` falling on weekday `dow`. */
export function nextOccurrenceOfDow(fromDateStr, dow) {
  const delta = (dow - dowOf(fromDateStr) + 7) % 7
  return addDays(fromDateStr, delta)
}

/**
 * First due date for a newly registered asset.
 * Operator override wins; otherwise the next inspection weekday on or
 * after today; otherwise (no settings row yet) today, which gets
 * snapped to the weekday at the first roll-forward.
 */
export function firstDueOn({ today, inspectionDayOfWeek, explicitFirstDue }) {
  if (explicitFirstDue) return explicitFirstDue
  if (inspectionDayOfWeek === null || inspectionDayOfWeek === undefined) return today
  return nextOccurrenceOfDow(today, inspectionDayOfWeek)
}

/**
 * Next due date after a submitted inspection.
 * Measured from `dueOn` (the cycle date), NOT from today, so a late
 * inspection does not drag the schedule permanently later. If that
 * still lands in the past, step in whole intervals until it is on or
 * after today, so submitting never produces an instantly-overdue item.
 * Because the interval is whole weeks, the weekday is preserved.
 */
export function rollForward({ dueOn, intervalWeeks, today }) {
  const step = intervalWeeks * 7
  let next = addDays(dueOn, step)
  while (next < today) next = addDays(next, step)
  return next
}

// ---- checklist item validation ------------------------------------

/**
 * Validate a checklist item array against the shape stored in
 * equipment_types.items — [{ id, label, order }], the same shape
 * checklist_templates.items uses.
 *
 * `order` is always renumbered from the array index, so the array
 * order the operator dragged into is the order of record and a stale
 * client-side `order` value can never desync the list.
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
 *   - `error`    → a fail with no note, or an over-long note.
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
 */
export function buildIssueDescription({ equipmentName, typeName, dueOn, failed, extraNote }) {
  const lines = [`${equipmentName} (${typeName}) failed inspection due ${dueOn}.`, '']
  for (const f of failed) lines.push(`• ${f.label}: ${f.note}`)

  const note = typeof extraNote === 'string' ? extraNote.trim() : ''
  if (note) lines.push('', note)

  const text = lines.join('\n')
  return text.length > ISSUE_DESCRIPTION_MAX ? text.slice(0, ISSUE_DESCRIPTION_MAX) : text
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

/** Is this asset due for inspection as of `today` (YYYY-MM-DD)? */
export function isDue(equipment, today) {
  if (equipment?.status !== EQUIPMENT_STATUS.IN_SERVICE) return false
  return equipment.next_due_on <= today
}
