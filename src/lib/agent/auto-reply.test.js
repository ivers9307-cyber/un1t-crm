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

  // The 2026-06-12 amnesia incident: whatsapp_messages had a CHECK
  // constraint (source IN api/app_echo/history_sync) that rejected the
  // agent's source='agent' rows, so every reply INSERT failed SILENTLY
  // (supabase-js returns { error }, it doesn't throw). The agent sent
  // fine but never saw its own replies in history — repeated questions,
  // restarted conversations, dead cost caps. Mig 259 widens the
  // constraint; this pins that a rejected insert is at least loud.
  it('logs an error when the message insert is rejected', async () => {
    const db = {
      from() {
        return {
          insert: async () => ({ error: { message: 'violates check constraint "whatsapp_messages_source_check"' } }),
          update: () => ({ eq: async () => ({}) }),
        }
      },
    }
    const adapter = { ...whatsappAdapter, send: vi.fn().mockResolvedValue({ messageId: 'wamid.2' }) }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = await sendAndLog(db, adapter, baseArgs)
    expect(ok).toBe(true) // the customer DID get the message — still a delivered reply
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to record reply'),
      expect.stringContaining('whatsapp_messages_source_check')
    )
    errSpy.mockRestore()
  })

  // AGENT-UX.1 — tap-choice options ride sendAndLog. WhatsApp has
  // adapter.sendOptions (interactive buttons); adapters without it
  // (Instagram) fall back to the options appended as plain text so the
  // customer still sees every choice.
  it('sends interactive options via adapter.sendOptions and records what was offered', async () => {
    const calls = []
    const sendOptions = vi.fn().mockResolvedValue({ messageId: 'wamid.3' })
    const adapter = { ...whatsappAdapter, send: vi.fn(), sendOptions }
    const ok = await sendAndLog(stubDb(calls), adapter, { ...baseArgs, text: 'Pick a time:', options: ['7am', '8am'] })
    expect(ok).toBe(true)
    expect(sendOptions).toHaveBeenCalledWith('353870000000', 'Pick a time:', ['7am', '8am'], expect.anything())
    expect(adapter.send).not.toHaveBeenCalled()
    const insert = calls.find(c => c.op === 'insert')
    expect(insert.row.body).toContain('Pick a time:')
    expect(insert.row.body).toContain('7am | 8am')
  })
  it('falls back to plain text with the options listed when the adapter has no sendOptions', async () => {
    const calls = []
    const send = vi.fn().mockResolvedValue({ messageId: 'ig.1' })
    const adapter = { ...whatsappAdapter, send, sendOptions: undefined }
    const ok = await sendAndLog(stubDb(calls), adapter, { ...baseArgs, text: 'Pick a time:', options: ['7am', '8am'] })
    expect(ok).toBe(true)
    const sentText = send.mock.calls[0][1]
    expect(sentText).toContain('7am')
    expect(sentText).toContain('8am')
    const insert = calls.find(c => c.op === 'insert')
    expect(insert.row.body).toBe(sentText)
  })
})
