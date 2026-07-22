// FEAT-AGENT-TRACE.1 — persist one agent decision (why Mia replied or stayed
// silent) to agent_decisions (mig 436). Best-effort: this must NEVER throw or
// slow the live agent turn — a decision-log failure can't be allowed to change
// whether/what the agent replies.

import { logWarn } from '@/lib/log'

export async function recordAgentDecision(db, { channel, conversationId, contactId, locationId, decision, reason } = {}) {
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
    })
  } catch (err) {
    try { logWarn('agent', 'recordAgentDecision failed', { err }) } catch { /* never throw */ }
  }
}
