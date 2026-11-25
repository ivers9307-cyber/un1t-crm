// MIAHANDOFF.1 — audit 2026-11-15 item 10: the write that parks a thread for a
// person (agent_active false) was a bare await, so a failed write still told
// the customer "a person will help" while Mia stayed on and no queue showed
// it. It is now retried once and, if it still fails, logged as an error. The
// holding message and the staff push still go. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(), sendInteractiveOptions: vi.fn(), sendTypingIndicator: vi.fn(),
  sendCtaUrlMessage: vi.fn(), splitTrailingUrl: () => null,
}))
vi.mock('@/lib/push', () => ({
  sendPushToRolesAtLocation: vi.fn().mockResolvedValue(undefined),
  sendPushToInboxStaffAtLocation: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { handoff, sendAndLog } from './auto-reply'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { logError } from '@/lib/log'

function db(updateErrors) {
  const updates = []
  let i = 0
  return {
    updates,
    from: (table) => ({
      update: (patch) => ({
        eq: async () => {
          updates.push({ table, patch })
          const isPark = 'agent_active' in patch
          const err = isPark ? (updateErrors[i++] ?? null) : null
          return { error: err }
        },
      }),
      insert: async () => ({ error: null }),
    }),
  }
}
const adapter = {
  name: 'whatsapp', label: 'WhatsApp', conversationsTable: 'whatsapp_conversations', messagesTable: 'whatsapp_messages',
  pushCategory: 'whatsapp', handoffType: 'wa_handoff',
  send: vi.fn(async () => ({ messageId: 'wamid.1' })),
  outboundRow: (r) => r,
}
const args = { conversationId: 'conv-1', locationId: 'loc-1', recipient: '353870000000', contactId: 'c-1', reason: 'needs a person', settings: {}, brand: 'UN1T' }
const parks = (d) => d.updates.filter((u) => 'agent_active' in u.patch)

beforeEach(() => vi.clearAllMocks())

describe('handoff — parking the thread', () => {
  it('parks once on success, sends the holding message and pushes staff', async () => {
    const d = db([])
    await handoff(d, adapter, args)
    expect(parks(d)).toHaveLength(1)
    expect(parks(d)[0].patch).toMatchObject({ agent_active: false, handoff_escalated_at: null })
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    expect(logError).not.toHaveBeenCalled()
  })
  it('a failed park is retried once; a second success logs nothing', async () => {
    const d = db([{ code: '57014', message: 'timeout' }])
    await handoff(d, adapter, args)
    expect(parks(d)).toHaveLength(2)
    expect(logError).not.toHaveBeenCalled()
  })
  it('a park that fails twice is logged as an error, and the customer and staff are still told', async () => {
    const d = db([{ code: '57014', message: 'timeout' }, { code: '57014', message: 'timeout' }])
    await handoff(d, adapter, args)
    expect(logError).toHaveBeenCalledWith('agent.handoff', expect.stringMatching(/NOT parked/), expect.objectContaining({ conversationId: 'conv-1', code: '57014' }))
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
  })
})

// INBOXFOLLOW.1 — Mia's handoff asks for a human; her replies answer the
// customer and touch nothing staff-owned.
describe('inbox follow-up stamps', () => {
  const STAFF_OR_SNOOZE = ['staff_owned_since', 'staff_waiting_since', 'staff_nudged_at', 'staff_nudge_outcome', 'snoozed_until', 'snoozed_by', 'snooze_note']

  it('the park write stamps handoff_requested_at with the handoff time', async () => {
    const d = db([])
    await handoff(d, adapter, args)
    const park = parks(d)[0].patch
    expect(park.handoff_requested_at).toBe(park.agent_handed_off_at)
  })

  it('the holding message stamp clears customer_waiting_since and nothing staff-owned', async () => {
    const d = db([])
    await handoff(d, adapter, args)
    const hold = d.updates.find((u) => u.patch.last_message_direction === 'outbound').patch
    expect(hold.customer_waiting_since).toBeNull()
    for (const k of STAFF_OR_SNOOZE) expect(hold).not.toHaveProperty(k)
    expect(hold).not.toHaveProperty('handoff_requested_at')
  })

  it('a normal Mia reply clears customer_waiting_since and nothing staff-owned', async () => {
    const d = db([])
    const ok = await sendAndLog(d, adapter, { conversationId: 'conv-1', locationId: 'loc-1', recipient: '353870000000', contactId: 'c-1', text: 'Hello', settings: {} })
    expect(ok).toBe(true)
    const stamp = d.updates.find((u) => u.patch.last_message_direction === 'outbound').patch
    expect(stamp.customer_waiting_since).toBeNull()
    for (const k of STAFF_OR_SNOOZE) expect(stamp).not.toHaveProperty(k)
  })
})
