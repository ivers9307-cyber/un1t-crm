// HYROX-TC.2 — pure builders that turn generated output into persistable rows.
// No IO. The route inserts what these return.

export function weeksToExpand(arc, window) {
  const plan = Array.isArray(arc?.plan) ? arc.plan : []
  const n = Math.max(0, Math.min(window ?? plan.length, plan.length))
  return plan.slice(0, n)
}

export function slotsForWeek(sessionsPerWeek) {
  const n = Math.max(1, Number(sessionsPerWeek) || 1)
  return Array.from({ length: n }, (_, i) => i + 1)
}

export function blockRowFrom(input, arc, userId, modelId) {
  return {
    location_id: input.location_id,
    title: input.title ?? null,
    starts_on: input.starts_on,
    weeks: input.weeks ?? 12,
    sessions_per_week: input.sessions_per_week ?? 2,
    session_weekdays: input.session_weekdays,
    difficulty_dial: input.difficulty_dial ?? 'mixed',
    auto_tune_enabled: Boolean(input.auto_tune_enabled),
    arc,
    status: 'active',
    generated_by: modelId ?? null,
  }
}

export function sessionRowFrom(blockId, locationId, expanded) {
  return {
    block_id: blockId,
    location_id: locationId,
    week_no: expanded.week_no,
    slot: expanded.slot,
    phase: expanded.phase,
    focus: expanded.focus ?? null,
    is_benchmark: Boolean(expanded.is_benchmark),
    full_session: expanded.full_session,
    board: expanded.board,
    status: 'draft',
  }
}
