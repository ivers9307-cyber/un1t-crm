// HYROX-TC.1/3 — zod schemas for the model's structured output. Never trust the
// model raw; parse* returns {ok, data} | {ok:false, error} so callers can retry.
//
// The model does NOT reliably emit exactly the requested JSON types, so the raw
// object is NORMALISED (types coerced, wrapper unwrapped) before validation — the
// 2026-07-23 session_generation_failed was stations coming back with numeric
// performance/elite that z.string() rejected. The schema keeps its original
// optional/default semantics; coercion happens in the normalize step below.
import { z } from 'zod'
import { PHASES, DIFFICULTY_DIALS, DEFAULT_CAP_MINUTES } from './constants'

export const stationSchema = z.object({
  name: z.string().min(1),
  performance: z.string().min(1),
  elite: z.string().min(1),
})

export const boardSchema = z.object({
  wordmark: z.string().min(1).default('HYROX TRAINING CLUB'),
  location_label: z.string().min(1),
  week_label: z.string().min(1),
  focus: z.string().min(1),
  format: z.string().min(1),
  cap_minutes: z.number().int().positive().default(DEFAULT_CAP_MINUTES),
  stations: z.array(stationSchema).min(1),
  target: z.string().min(1),
})

export const fullSessionSchema = z.object({
  warmup: z.string().min(1),
  strength: z.string().nullish(),
  main: z.string().min(1),
  finisher: z.string().nullish(),
  cues: z.array(z.string()).default([]),
  why: z.string().min(1),
})

export const sessionSchema = z.object({
  week_no: z.number().int().min(1),
  slot: z.number().int().min(1),
  phase: z.enum(PHASES),
  focus: z.string().min(1),
  is_benchmark: z.boolean().default(false),
  full_session: fullSessionSchema,
  board: boardSchema,
})

export const weekPlanSchema = z.object({
  week_no: z.number().int().min(1),
  phase: z.enum(PHASES),
  stimulus: z.string().min(1),
  is_benchmark: z.boolean().default(false),
  progression: z.string().min(1),
})

export const arcSchema = z.object({
  weeks: z.number().int().positive(),
  dial: z.enum(DIFFICULTY_DIALS),
  plan: z.array(weekPlanSchema).min(1),
})

// ── coercion helpers ────────────────────────────────────────────────
// Flatten a stray nested object into readable indented text (NOT raw JSON), so a
// full_session field the model wrongly nested still renders as prose in the drawer.
const objectToText = (obj, depth = 0) => {
  const pad = '  '.repeat(depth)
  const lines = []
  for (const [k, val] of Object.entries(obj)) {
    if (val == null) continue
    const label = String(k).replace(/_/g, ' ')
    if (Array.isArray(val)) {
      lines.push(`${pad}${label}:`)
      for (const item of val) lines.push(item != null && typeof item === 'object' ? objectToText(item, depth + 1) : `${pad}  - ${item}`)
    } else if (typeof val === 'object') {
      lines.push(`${pad}${label}:`)
      lines.push(objectToText(val, depth + 1))
    } else {
      lines.push(`${pad}${label}: ${val}`)
    }
  }
  return lines.join('\n')
}
const text = (v) => {
  if (v == null) return v
  if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => text(x)).join('\n')
  if (typeof v === 'object') return objectToText(v)
  return String(v)
}
const intFrom = (v) => {
  if (v == null || v === '') return undefined
  const m = String(v).match(/-?\d+/)
  const n = m ? Number(m[0]) : NaN
  return Number.isFinite(n) ? n : undefined
}
const strArray = (v) => {
  if (v == null) return undefined
  if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => text(x))
  if (typeof v === 'string') return v.trim() ? [v] : []
  return [text(v)]
}
const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const bool = (v) => {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['true', 'yes', '1', 'y'].includes(v.trim().toLowerCase())
  if (typeof v === 'number') return v !== 0
  return undefined
}
// Drop undefined keys so the schema's .default()/.optional()/.nullish() apply.
const clean = (obj) => {
  const out = {}
  for (const [k, val] of Object.entries(obj)) if (val !== undefined) out[k] = val
  return out
}

function normalizeStation(s) {
  if (!s || typeof s !== 'object') return s
  return clean({ ...s, name: text(s.name), performance: text(s.performance), elite: text(s.elite) })
}

function normalizeBoard(b) {
  if (!b || typeof b !== 'object') return b
  return clean({
    ...b,
    wordmark: b.wordmark == null ? undefined : text(b.wordmark),
    location_label: text(b.location_label),
    week_label: text(b.week_label),
    focus: text(b.focus),
    format: text(b.format),
    cap_minutes: intFrom(b.cap_minutes),
    stations: Array.isArray(b.stations) ? b.stations.map(normalizeStation) : b.stations,
    target: text(b.target),
  })
}

function normalizeFull(f) {
  if (!f || typeof f !== 'object') return f
  return clean({
    ...f,
    warmup: text(f.warmup),
    strength: f.strength == null ? undefined : text(f.strength),
    main: text(f.main),
    finisher: f.finisher == null ? undefined : text(f.finisher),
    cues: strArray(f.cues),
    why: text(f.why),
  })
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  let obj = raw
  // Unwrap a single-key wrapper, e.g. { "session": {...} }.
  if (!obj.board && !obj.full_session) {
    const keys = Object.keys(obj)
    if (keys.length === 1 && obj[keys[0]] && typeof obj[keys[0]] === 'object') obj = obj[keys[0]]
  }
  const board = normalizeBoard(obj.board)
  let focus = obj.focus
  if ((focus == null || focus === '') && board && board.focus) focus = board.focus
  return clean({
    ...obj,
    week_no: intFrom(obj.week_no) ?? 1,
    slot: intFrom(obj.slot) ?? 1,
    phase: lower(obj.phase),
    focus: focus == null ? undefined : text(focus),
    is_benchmark: bool(obj.is_benchmark),
    full_session: normalizeFull(obj.full_session),
    board,
  })
}

function normalizeArc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  return clean({
    ...raw,
    weeks: intFrom(raw.weeks),
    dial: lower(raw.dial),
    plan: Array.isArray(raw.plan)
      ? raw.plan.map((w) => (w && typeof w === 'object' ? clean({
          ...w,
          week_no: intFrom(w.week_no) ?? 1,
          phase: lower(w.phase),
          stimulus: text(w.stimulus),
          is_benchmark: bool(w.is_benchmark),
          progression: text(w.progression),
        }) : w))
      : raw.plan,
  })
}

function wrap(schema, value) {
  const r = schema.safeParse(value)
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error }
}
export const parseArc = (v) => wrap(arcSchema, normalizeArc(v))
export const parseSession = (v) => wrap(sessionSchema, normalizeSession(v))
