// SEQPAGEGATE.1 — the sequence the builder's CLIENT components receive.
//
// /automations/[id] used to pass the whole email_sequences row (select('*'))
// and every step (email HTML, design_json) into SequenceFlowBuilder and
// AutomationPerformance, both 'use client', so webhook_secret travelled in
// the RSC payload to anyone who could open the builder. The builder needs
// the settings fields below, the webhook token (to show the URL) and ONE
// fact about the secret: is one set? The value never leaves the server.
//
// SERVER ONLY: the selects read webhook_secret so the boolean can be
// computed; toBuilderSequence is the only thing that may cross.

export const SEQUENCE_BUILDER_ROW_SELECT = [
  'id, location_id, name, description, status',
  'trigger_type, trigger_config, audience_filter, goal_config, send_window, re_enrolment_cooldown_days',
  'webhook_token, webhook_secret',
].join(', ')

// + what resolveSequenceGraph reads on the server (the graph is computed
// there and passed separately; steps go to the client only via
// toPerformanceSteps).
export const SEQUENCE_BUILDER_PAGE_SELECT = `${SEQUENCE_BUILDER_ROW_SELECT}, graph, draft_graph, sequence_steps(*)`

const CLIENT_KEYS = Object.freeze([
  'id', 'location_id', 'name', 'description', 'status',
  'trigger_type', 'trigger_config', 'audience_filter', 'goal_config', 'send_window', 're_enrolment_cooldown_days',
])

export function toBuilderSequence(row) {
  if (!row) return null
  const out = {}
  for (const key of CLIENT_KEYS) out[key] = row[key] ?? null
  // The token is the URL's credential; the panel shows it only for a
  // webhook trigger, and the PUT response returns it when one is switched on.
  out.webhook_token = row.trigger_type === 'webhook' ? (row.webhook_token ?? null) : null
  // '' counts as none: the inbound route checks `if (seq.webhook_secret)`.
  out.has_webhook_secret = typeof row.webhook_secret === 'string' && row.webhook_secret.length > 0
  return out
}

export function toPerformanceSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map((s) => ({ id: s.id, step_type: s.step_type, config: s.config ?? null }))
}
