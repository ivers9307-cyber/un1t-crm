// CLASS-TIMER — the pure interval-timer engine. No IO. The server stores
// authoritative run state (started_at + pause/skip offsets) and never streams
// the clock; every display computes the live tick locally via these functions
// and corrects on its existing ~2s poll.
//
// Lives in shared/ so BOTH web (via the `@shared/class-timer` alias / the
// `src/lib/class-timer.js` re-export shim) AND mobile (relative
// `../../shared/class-timer`) use one copy. Pure — no React/Next/RN deps.

export const TIMER_SEGMENT_TYPES = ['prep', 'work', 'rest', 'station', 'custom']

// Canonical per-segment-type accent colour — ONE source of truth so the TV
// wall, the coach control screen, and the mobile timer never diverge (each
// used to keep its own map). work=red (push), rest=green (recover): the
// convention members read on the TV wall.
export const SEG_COLOR = {
  prep: '#9CA3AF',    // grey
  work: '#EF4444',    // red — push
  rest: '#10B981',    // green — recover
  station: '#3B82F6', // blue
  custom: '#A78BFA',  // violet
}

const MAX_BLOCKS = 50
const MAX_ROUND_SEGMENTS = 20
const MAX_SECONDS = 3600
const MAX_COUNT = 99

function validSegment(s) {
  return s && typeof s === 'object'
    && typeof s.label === 'string' && s.label.length >= 1 && s.label.length <= 40
    && TIMER_SEGMENT_TYPES.includes(s.type)
    && Number.isInteger(s.seconds) && s.seconds >= 1 && s.seconds <= MAX_SECONDS
}

/** Pure: validate a template structure. Returns { ok, error? }. */
export function validateStructure(structure) {
  if (!Array.isArray(structure) || structure.length < 1 || structure.length > MAX_BLOCKS) {
    return { ok: false, error: 'Structure must be 1–50 blocks' }
  }
  for (const block of structure) {
    if (!block || typeof block !== 'object') return { ok: false, error: 'Invalid block' }
    if (block.kind === 'segment') {
      if (!validSegment(block)) return { ok: false, error: `Invalid segment "${block.label}"` }
    } else if (block.kind === 'round') {
      if (!Number.isInteger(block.count) || block.count < 1 || block.count > MAX_COUNT) {
        return { ok: false, error: 'Round count must be 1–99' }
      }
      if (!Array.isArray(block.segments) || block.segments.length < 1 || block.segments.length > MAX_ROUND_SEGMENTS) {
        return { ok: false, error: 'Round must have 1–20 segments' }
      }
      for (const s of block.segments) if (!validSegment(s)) return { ok: false, error: `Invalid round segment "${s?.label}"` }
    } else {
      return { ok: false, error: 'Block kind must be segment or round' }
    }
  }
  return { ok: true }
}

/** Pure: expand a structure into a flat, offset-stamped step list. */
export function buildTimeline(structure) {
  const steps = []
  let cursor = 0
  let index = 0
  const push = (label, type, seconds, roundIndex, roundCount) => {
    const startMs = cursor
    const endMs = cursor + seconds * 1000
    steps.push({ index, label, type, seconds, roundIndex, roundCount, startMs, endMs })
    cursor = endMs
    index += 1
  }
  for (const block of structure || []) {
    if (block?.kind === 'round') {
      for (let r = 1; r <= block.count; r++) {
        for (const s of block.segments) push(s.label, s.type, s.seconds, r, block.count)
      }
    } else if (block?.kind === 'segment') {
      push(block.label, block.type, block.seconds, null, null)
    }
  }
  return { steps, totalMs: cursor }
}

/** Pure: ms into the timeline for a run at nowMs (handles running/paused/skip). */
export function computeEffectiveElapsedMs(run, nowMs) {
  if (!run?.started_at) return 0
  const started = new Date(run.started_at).getTime()
  let elapsed = nowMs - started - (Number(run.paused_accum_ms) || 0) + (Number(run.elapsed_offset_ms) || 0)
  if (run.status === 'paused' && run.paused_at) {
    elapsed -= (nowMs - new Date(run.paused_at).getTime())
  }
  return Math.max(0, elapsed)
}

/** Pure: resolve the display state for a timeline at elapsedMs. */
export function resolveTimerState(timeline, elapsedMs) {
  const { steps, totalMs } = timeline
  const clamped = Math.max(0, Math.min(elapsedMs, totalMs))
  const finished = elapsedMs >= totalMs
  let currentStep = steps[steps.length - 1] || null
  if (!finished) {
    currentStep = steps.find((s) => clamped >= s.startMs && clamped < s.endMs) || steps[0] || null
  }
  const idx = currentStep ? currentStep.index : -1
  const nextStep = (!finished && idx >= 0) ? (steps[idx + 1] || null) : null
  return {
    finished,
    currentStep,
    nextStep,
    segmentElapsedMs: currentStep ? clamped - currentStep.startMs : 0,
    segmentRemainingMs: currentStep && !finished ? currentStep.endMs - clamped : 0,
    roundIndex: currentStep ? currentStep.roundIndex : null,
    roundCount: currentStep ? currentStep.roundCount : null,
    totalElapsedMs: clamped,
    totalRemainingMs: Math.max(0, totalMs - clamped),
    totalMs,
  }
}

/** Pure: the new elapsed_offset_ms after a skip next/prev. */
export function applySkip(run, timeline, direction, nowMs) {
  const eff = computeEffectiveElapsedMs(run, nowMs)
  const st = resolveTimerState(timeline, eff)
  const cur = st.currentStep
  if (!cur) return Number(run.elapsed_offset_ms) || 0
  let target
  if (direction === 'next') {
    target = cur.endMs
  } else {
    // prev: if >1s into the segment, restart it; else jump to the previous segment.
    target = (eff - cur.startMs > 1000) ? cur.startMs : (timeline.steps[cur.index - 1]?.startMs ?? 0)
  }
  const delta = target - eff
  return (Number(run.elapsed_offset_ms) || 0) + delta
}

/**
 * Pure: pick the template whose `glofox_program` best matches a live class name
 * (CLASS-TIMER PR4 — "DR1VE is live → load DR1VE intervals?"). `templates` is
 * assumed ordered by preference (most-recently-updated first). Case-insensitive,
 * trimmed; matches on equality OR either-contains-the-other so a "DR1VE" tag
 * still catches a "DR1VE 45" / "DR1VE Express" class. Returns the matched
 * template object, or null. Templates with a blank `glofox_program` are skipped.
 */
export function matchTemplateToClassName(templates, className) {
  if (!Array.isArray(templates) || !className) return null
  const target = String(className).trim().toLowerCase()
  if (!target) return null
  for (const t of templates) {
    const prog = (t?.glofox_program || '').trim().toLowerCase()
    if (!prog) continue
    if (target === prog || target.includes(prog) || prog.includes(target)) return t
  }
  return null
}

/** Pure: the DB patch for a run control action. {} = no-op. */
export function nextRunState(run, action, nowMs, { direction, timeline } = {}) {
  const nowIso = new Date(nowMs).toISOString()
  if (action === 'pause') {
    if (run.status !== 'running') return {}
    return { status: 'paused', paused_at: nowIso }
  }
  if (action === 'resume') {
    if (run.status !== 'paused') return {}
    const extra = run.paused_at ? (nowMs - new Date(run.paused_at).getTime()) : 0
    return { status: 'running', paused_at: null, paused_accum_ms: (Number(run.paused_accum_ms) || 0) + extra }
  }
  if (action === 'stop') {
    if (run.status === 'stopped' || run.status === 'finished') return {}
    return { status: 'stopped' }
  }
  if (action === 'skip') {
    if (!timeline) return {}
    return { elapsed_offset_ms: applySkip(run, timeline, direction === 'prev' ? 'prev' : 'next', nowMs) }
  }
  return {}
}
