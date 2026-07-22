// AGENT-REARM.3 — the pre-send take-over guard. A human may grab a thread
// while the model is mid-generation (Aisling Fagan 2026-07-13: Garrett's inbox
// takeover and Mia's reply left in the same second). humanTookOverDuringTurn
// is re-checked just before sending so Mia never talks over the human.
import { describe, it, expect } from 'vitest'
import { humanTookOverDuringTurn, whatsappAdapter } from './auto-reply'

// Minimal supabase-builder stub: every chained method returns the builder,
// and the terminals (.single / .limit) resolve to the pre-set result.
function makeBuilder(result) {
  const b = {
    select: () => b,
    eq: () => b,
    order: () => b,
    limit: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
  }
  return b
}
function stubDb({ conv, lastOut, throwOn }) {
  return {
    from(table) {
      if (throwOn === table) return { select: () => { throw new Error('db down') } }
      if (table === 'whatsapp_conversations') return makeBuilder({ data: conv })
      if (table === 'whatsapp_messages') return makeBuilder({ data: lastOut })
      return makeBuilder({ data: null })
    },
  }
}

const TURN_START = '2026-07-13T14:24:00.000Z'
const DURING = '2026-07-13T14:24:07.000Z' // a staff message sent mid-turn
const BEFORE = '2026-07-13T14:20:00.000Z' // an old human message from a prior turn

describe('humanTookOverDuringTurn', () => {
  it('true when the agent gate was flipped off (inbox manual take-over)', async () => {
    const db = stubDb({ conv: { agent_active: false } })
    expect(await humanTookOverDuringTurn(db, whatsappAdapter, 'c1', TURN_START)).toBe(true)
  })

  // INBOX-REDESIGN.2.3 — an operator paused the thread (agent_paused_at,
  // mig 435) while Mia was mid-generation: treat it exactly like the
  // agent_active flip above, so the stale reply never sends.
  it('true when the conversation was paused mid-turn (agent_paused_at set)', async () => {
    const db = stubDb({ conv: { agent_active: true, agent_paused_at: DURING } })
    expect(await humanTookOverDuringTurn(db, whatsappAdapter, 'c1', TURN_START)).toBe(true)
  })

  it('true when a HUMAN outbound landed during the turn (before the gate flip committed)', async () => {
    const db = stubDb({
      conv: { agent_active: true },
      lastOut: [{ source: 'api', sent_by: 'staff-1', created_at: DURING }],
    })
    expect(await humanTookOverDuringTurn(db, whatsappAdapter, 'c1', TURN_START)).toBe(true)
  })

  it('false when the only human outbound is OLD (a cooldown re-arm must still reply)', async () => {
    const db = stubDb({
      conv: { agent_active: true },
      lastOut: [{ source: 'api', sent_by: 'staff-1', created_at: BEFORE }],
    })
    expect(await humanTookOverDuringTurn(db, whatsappAdapter, 'c1', TURN_START)).toBe(false)
  })

  it("false when the last outbound is the agent's own message", async () => {
    const db = stubDb({
      conv: { agent_active: true },
      lastOut: [{ source: 'agent', sent_by: null, created_at: DURING }],
    })
    expect(await humanTookOverDuringTurn(db, whatsappAdapter, 'c1', TURN_START)).toBe(false)
  })

  it('false for an automated api send (template/sequence — sent_by is null, not a human)', async () => {
    const db = stubDb({
      conv: { agent_active: true },
      lastOut: [{ source: 'api', sent_by: null, created_at: DURING }],
    })
    expect(await humanTookOverDuringTurn(db, whatsappAdapter, 'c1', TURN_START)).toBe(false)
  })

  it('false (never blocks a send) when the check throws', async () => {
    const db = stubDb({ throwOn: 'whatsapp_conversations' })
    expect(await humanTookOverDuringTurn(db, whatsappAdapter, 'c1', TURN_START)).toBe(false)
  })
})
