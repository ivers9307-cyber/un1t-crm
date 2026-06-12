// AGENT-OBS.1 — sendAndLog must report whether the reply actually went
// out. The 2026-06-12 incident: every agent send failed at Meta (dead
// per-location token) but the runner returned { handled: true } and
// nothing surfaced anywhere — three hours of blind debugging. These
// tests pin the contract: send failure → false (and no message row),
// send success → true.
import { describe, it, expect, vi } from 'vitest'
import { sendAndLog, whatsappAdapter } from './auto-reply'

function stubDb(calls) {
  return {
    from(table) {
      return {
        insert: async (row) => { calls.push({ op: 'insert', table, row }); return {} },
        update: (patch) => ({
          eq: async () => { calls.push({ op: 'update', table, patch }); return {} },
        }),
      }
    },
  }
}

const baseArgs = {
  conversationId: 'conv-1',
  locationId: 'loc-1',
  recipient: '353870000000',
  contactId: 'contact-1',
  connection: null,
  text: 'Hi there!',
}

describe('sendAndLog', () => {
  it('returns false and records nothing when the provider send throws', async () => {
    const calls = []
    const adapter = { ...whatsappAdapter, send: vi.fn().mockRejectedValue(new Error('(#190) token expired')) }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = await sendAndLog(stubDb(calls), adapter, baseArgs)
    errSpy.mockRestore()
    expect(ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('returns true and records the message + conversation update on success', async () => {
    const calls = []
    const adapter = { ...whatsappAdapter, send: vi.fn().mockResolvedValue({ messageId: 'wamid.1' }) }
    const ok = await sendAndLog(stubDb(calls), adapter, baseArgs)
    expect(ok).toBe(true)
    const insert = calls.find(c => c.op === 'insert')
    expect(insert?.table).toBe('whatsapp_messages')
    expect(insert?.row?.source).toBe('agent')
    const update = calls.find(c => c.op === 'update')
    expect(update?.patch?.agent_last_reply_at).toBeTruthy()
  })
})
