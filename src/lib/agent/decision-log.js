// FEAT-AGENT-TRACE.1 — persist one agent decision (why Mia replied or stayed
// silent) to agent_decisions (mig 436). Best-effort: this must NEVER throw or
// slow the live agent turn — a decision-log failure can't be allowed to change
// whether/what the agent replies.

import { logWarn } from '@/lib/log'

// Mig 444 caps — the meta column is a debug trace, not an archive: a runaway
// tool input (a pasted essay reaching save_lead_details) must not balloon the
// row. Inputs are stringified and clipped; the tool list is bounded well above
// MAX_TOOL_ITERATIONS so a normal turn is never truncated.
const META_MAX_TOOLS = 12
const META_MAX_INPUT_CHARS = 200
// MIA-HYGIENE.4 — upstream error text (an Anthropic body, a stack line) can be
// long; the trace wants the shape of the failure, not the essay.
const META_MAX_ERROR_CHARS = 160

/**
 * Compact a turn trace into the agent_decisions.meta payload (mig 444).
 * Returns null when the trace holds nothing worth persisting, so decision
 * rows from skip paths (never called the model) stay meta-free. Pure.
 * @param {{tools?: Array<{name:string,input?:object}>, stopReason?: string|null, iterations?: number}} [trace]
 * @returns {{tools?: Array, stop_reason?: string, iterations?: number}|null}
 */
export function compactDecisionMeta(trace = {}) {
  const meta = {}
  const tools = Array.isArray(trace.tools) ? trace.tools : []
  if (tools.length) {
    meta.tools = tools.slice(0, META_MAX_TOOLS).map((t) => {
      let input
      try {
        const s = JSON.stringify(t.input ?? {})
        input = s.length > META_MAX_INPUT_CHARS ? s.slice(0, META_MAX_INPUT_CHARS) + '…' : s
      } catch {
        input = '{}'
      }
      return { name: String(t.name || 'unknown'), input }
    })
    if (tools.length > META_MAX_TOOLS) meta.tools_truncated = tools.length
  }
  if (trace.stopReason) meta.stop_reason = String(trace.stopReason).slice(0, 40)
  if (trace.iterations) meta.iterations = trace.iterations
  // MIA-HYGIENE.4 — WHY a turn failed. Error rows used to persist meta: null,
  // so agent_decisions could say a turn errored but never what the API
  // returned or how many attempts it took, and the only richer record was a
  // console line inside Vercel's retention window.
  if (trace.error && typeof trace.error === 'object') {
    const e = {}
    if (trace.error.kind) e.kind = String(trace.error.kind).slice(0, 40)
    if (Number.isFinite(trace.error.status)) e.status = trace.error.status
    if (Number.isFinite(trace.error.attempts)) e.attempts = trace.error.attempts
    if (trace.error.message) {
      const m = String(trace.error.message)
      e.message = m.length > META_MAX_ERROR_CHARS ? m.slice(0, META_MAX_ERROR_CHARS) + '…' : m
    }
    if (Object.keys(e).length) meta.error = e
  }
  return Object.keys(meta).length ? meta : null
}

export async function recordAgentDecision(db, { channel, conversationId, contactId, locationId, decision, reason, meta } = {}) {
  try {
    await db.from('agent_decisions').insert({
      channel: channel || null,
      conversation_id: conversationId || null,
      contact_id: contactId || null,
      location_id: locationId || null,
      // Normalise to the two-value enum — anything that isn't an actual reply
      // is a 'silent' outcome (skipped, handed off, errored, empty, …).
      decision: decision === 'reply' ? 'reply' : 'silent',
      reason: reason ? String(reason).slice(0, 100) : null,
      meta: meta || null,
    })
  } catch (err) {
    try { logWarn('agent', 'recordAgentDecision failed', { err }) } catch { /* never throw */ }
  }
}
