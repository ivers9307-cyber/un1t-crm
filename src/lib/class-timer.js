// CLASS-TIMER — the pure interval-timer engine. No IO. The server stores
// authoritative run state (started_at + pause/skip offsets) and never streams
// the clock; every display computes the live tick locally via these functions
// and corrects on its existing ~2s poll. Shared by web + mobile (no web-only deps).

export const TIMER_SEGMENT_TYPES = ['prep', 'work', 'rest', 'station', 'custom']

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
