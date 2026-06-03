// FLOW-GRAPH Phase 3 — the AI flow agent's prompt + emit tool. Pure. Teaches
// Claude to author a sequence as the same declarative graph the builder edits
// and the runner executes (via compileGraphToSteps). The agent's output is
// shape-checked + validated with the SAME validateGraph the publish gate uses,
// with a self-correct retry loop (see ./run.js). Nothing here calls the API.
import { NODE_TYPES, CHANNEL_NODE_TYPES, TRIGGER_TYPES, TRIGGER_SOURCE_ID } from '../graph/schema.js'

// JSON schema for the forced emit tool — intentionally permissive (the real
// gate is validateGraph); it just shapes the structured output.
export const EMIT_TOOL = {
  name: 'emit_sequence_graph',
  description: 'Emit the complete sequence as a declarative flow graph.',
  input_schema: {
    type: 'object',
    properties: {
      version: { type: 'integer' },
      trigger: { type: 'object', properties: { type: { type: 'string' }, config: { type: 'object' } }, required: ['type'] },
      nodes: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' }, config: { type: 'object' } }, required: ['id', 'type'] },
      },
      edges: {
        type: 'array',
        items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string', enum: ['yes', 'no'] } }, required: ['from', 'to'] },
      },
    },
    required: ['trigger', 'nodes', 'edges'],
  },
}

export function buildAgentSystemPrompt() {
  return `You design automated member & lead nurture sequences for a gym CRM. You output a sequence as a declarative FLOW GRAPH that compiles to the existing automation engine — you are not writing code, just the graph.

GRAPH SHAPE (emit via the emit_sequence_graph tool):
{
  "version": 1,
  "trigger": { "type": "<trigger>", "config": { ... } },
  "nodes": [ { "id": "n1", "type": "<node type>", "config": { ... } }, ... ],
  "edges": [ { "from": "${TRIGGER_SOURCE_ID}", "to": "n1" }, { "from": "n1", "to": "n2" }, ... ]
}

NODE TYPES (${NODE_TYPES.join(', ')}). Channel/timing nodes are ${CHANNEL_NODE_TYPES.join(', ')}. Required config per type:
- email:   { subject } (required) and optionally { html_content } — plain HTML.
- whatsapp:{ template_id } of an APPROVED template, plus { variables: { "1": "first_name", ... } } if it has placeholders.
- sms:     { body } (required, short).
- wait:    { days?, hours?, minutes? } — at least one MUST be non-zero. Model every delay as its own wait node.
- apply_tag:        { tag }.
- update_field:     { field, value }.
- internal_task:    { subject } (+ optional note, due_offset_minutes).
- webhook:          { url } (MUST be https), { method }.
- move_pipeline_stage: { stage_slug } — one of new_lead, active_trial, hot_conversion, active_member, at_risk_member, classpass_active, lapsed, dormant, dormant_classpass.
- branch:  { predicate } where predicate is { type:"has_tag", tag } OR { type:"field_equals", field, value } OR { type:"field_in", field, values:[...] }.

EDGES & STRUCTURE RULES (these are validated — follow them exactly):
- The first node(s) are reached by an edge from the literal source id "${TRIGGER_SOURCE_ID}".
- Every node must be reachable from "${TRIGGER_SOURCE_ID}". No orphans.
- Every non-branch node has AT MOST ONE outgoing edge (a linear step). The last node in a path has none (the flow ends there).
- A branch node has EXACTLY TWO outgoing edges, one labelled "yes" and one labelled "no". Put a real step in each path.
- The flow must always move forward — NO cycles/loops.
- Node ids are short unique strings like n1, n2, ...

TRIGGER: trigger types are ${TRIGGER_TYPES.join(', ')}. The trigger is usually already chosen for this sequence — KEEP the trigger you are given unless the user explicitly asks to change it; focus on the steps.

GUIDANCE:
- Build a thoughtful, realistic nurture flow: open with a timely message, space messages with wait nodes (don't bunch them), and use a branch when the user describes a condition ("if they've booked / if they're a member / if tagged X").
- Be concise — a handful of well-chosen steps beats a long flow.
- Output ONLY by calling emit_sequence_graph. Do not explain.`
}

// The user turn: the operator's ask + the trigger to build for.
export function buildAgentUserMessage(prompt, trigger) {
  const t = trigger?.type || 'manual'
  const cfg = trigger?.config && Object.keys(trigger.config).length ? ` (config: ${JSON.stringify(trigger.config)})` : ''
  return `The sequence trigger is "${t}"${cfg}. Build the flow for this request:\n\n${prompt}`
}

// The follow-up turn when the emitted graph failed validation — fed back so the
// model self-corrects.
export function buildFixMessage(errors) {
  const lines = (errors || []).map(e => `- ${e.message}`).join('\n')
  return `The flow you emitted has problems that must be fixed:\n${lines}\n\nRe-emit a corrected graph via emit_sequence_graph.`
}
