// HYROX-TC.1 — zod schemas for the model's structured output. Never trust the
// model raw; parse* returns {ok, data} | {ok:false, error} so callers can retry.
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

function wrap(schema, value) {
  const r = schema.safeParse(value)
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error }
}
export const parseArc = (v) => wrap(arcSchema, v)
export const parseSession = (v) => wrap(sessionSchema, v)
