// FLOW-GRAPH.1 — the canonical node-graph vocabulary + structural (shape)
// validation. Semantic validation (topology, reachability, per-type
// required config) lives in validate.js. This module is pure.
import { z } from 'zod'

export const CHANNEL_NODE_TYPES = ['email', 'whatsapp', 'sms', 'wait']
export const CONFIG_NODE_TYPES = [
  'apply_tag', 'update_field', 'internal_task', 'webhook', 'branch', 'move_pipeline_stage',
]
// Order matters for the test + for stable UI listing.
export const NODE_TYPES = [
  'email', 'whatsapp', 'sms', 'wait',
  'apply_tag', 'update_field', 'internal_task', 'webhook', 'branch', 'move_pipeline_stage',
]

// The engine's trigger vocabulary (triggers.js + cron-triggers.js). Kept as a
// flat list; trigger-specific config is validated per-type in validate.js.
export const TRIGGER_TYPES = [
  'manual', 'booking_created', 'first_booking', 'pipeline_stage_change', 'tag_added',
  'event_reminder', 'segment_added', 'segment_removed', 'anniversary', 'inactivity',
  'race_registered', 'race_finished', 'order_completed', 'order_failed', 'order_abandoned',
  'achievement_unlocked', 'webhook',
]

export const TRIGGER_SOURCE_ID = 'trigger'

export function isChannelNode(type) {
  return CHANNEL_NODE_TYPES.includes(type)
}

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NODE_TYPES),
  config: z.object({}).passthrough().default({}),
  // optional UI hint; ignored by compile/runner
  position: z.object({ x: z.number(), y: z.number() }).optional(),
})

const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.enum(['yes', 'no']).optional(),
})

const graphSchema = z.object({
  version: z.number().int().positive(),
  trigger: z.object({ type: z.enum(TRIGGER_TYPES), config: z.object({}).passthrough().default({}) }),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
})

/** Structural (shape) validation only. Returns { ok, data?, error? }. */
export function parseGraphShape(graph) {
  const r = graphSchema.safeParse(graph)
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error }
}
