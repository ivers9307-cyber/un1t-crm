// MIA-REVIEW.2 — persistence guards on the Instagram inbound path.
//
// Two silent-loss classes: the first-message conversation-create race (the
// loser used to bail, and the route had already recorded msg:<mid> in
// webhook_events so Meta's retry was deduped — the customer's first message
// was gone for good), and an unchecked inbound-message insert (the agent then
// answers history that is missing the message it is answering).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./channels', () => ({
  resolveLocationByExternalAccount: vi.fn(),
  isAgentEnabledForConnection: vi.fn(() => true),
  IG_GRAPH_URL: 'https://graph.instagram.com/v21.0',
}))
vi.mock('./auto-reply', () => ({ runChannelAgent: vi.fn(async () => ({ handled: true, action: 'reply' })) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(), sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/connection-health', () => ({
  stampConnectionOk: vi.fn(), stampConnectionError: vi.fn(), isMetaAuthError: vi.fn(() => false),
}))
vi.mock('@/lib/instagram-media-server', () => ({ ensureInstagramMediaRehosted: vi.fn() }))

import { handleInstagramInbound } from './instagram'
import { resolveLocationByExternalAccount } from './channels'
import { runChannelAgent } from './auto-reply'

// Chainable stub. `conv` decides what the find-or-create lookups return (an
// array consumed in order, so a test can say "miss, then the winner's row"),
// `convInsert` / `msgInsert` decide the insert outcomes.
function igDb({ convLookups = [null], convInsert = { data: { id: 'conv-new' }, error: null }, msgInsert = { data: { id: 'msg-1' }, error: null } }) {
  const lookups = [...convLookups]
  const inserts = []
  const mk = (table) => {
    const state = { op: 'select' }
    const finish = () => {
      if (state.op === 'insert') {
        inserts.push({ table, row: state.row })
        return table === 'instagram_conversations' ? convInsert : msgInsert
      }
      if (state.op === 'update') return { data: null, error: null }
      if (table === 'instagram_conversations') {
        return { data: lookups.length ? lookups.shift() : null, error: null }
      }
      return { data: null, error: null }
    }
    const b = {
      select: () => b,
      insert: (row) => { state.op = 'insert'; state.row = row; return b },
      update: () => { state.op = 'update'; return b },
      eq: () => b, limit: () => b, order: () => b,
      single: () => b, maybeSingle: () => b,
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return b
  }
  return { from: mk, rpc: vi.fn(async () => ({ data: null, error: null })), inserts }
}

const EVENT = { accountId: 'IGBIZ1', customerId: 'CUST1', messageId: 'mid-1', text: 'how much is membership?', type: 'text', isEcho: false }

let errSpy
beforeEach(() => {
  vi.clearAllMocks()
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  resolveLocationByExternalAccount.mockResolvedValue({ locationId: 'loc-1', connection: { id: 'conn-1' } })
  // fetchInstagramProfile is an internal fetch — keep it cheap and silent.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => '' }))
})
afterEach(() => {
  errSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('handleInstagramInbound — first-message conversation-create race', () => {
  it('re-reads the winner\'s conversation and still persists + answers the message', async () => {
    const db = igDb({
      // miss (find-or-create), then the winner's row on the post-conflict re-read
      convLookups: [null, { id: 'conv-winner' }],
      convInsert: { data: null, error: { code: '23505', message: 'duplicate key' } },
    })

    const result = await handleInstagramInbound(db, EVENT)

    expect(result).toMatchObject({ handled: true, conversationId: 'conv-winner' })
    const msgInsert = db.inserts.find((i) => i.table === 'instagram_messages')
    expect(msgInsert.row).toMatchObject({ conversation_id: 'conv-winner', direction: 'inbound', ig_message_id: 'mid-1' })
    expect(runChannelAgent).toHaveBeenCalled()
  })

  it('gives up loudly only when the re-read finds nothing either', async () => {
    const db = igDb({
      convLookups: [null, null],
      convInsert: { data: null, error: { code: '42501', message: 'permission denied' } },
    })

    const result = await handleInstagramInbound(db, EVENT)

    expect(result).toMatchObject({ handled: false, reason: 'no_conversation' })
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('conversation create failed'), 'permission denied')
  })
})

describe('handleInstagramInbound — unchecked inbound insert', () => {
  it('skips the agent turn when the message failed to persist', async () => {
    const db = igDb({
      convLookups: [{ id: 'conv-1' }],
      msgInsert: { data: null, error: { message: 'violates check constraint' } },
    })

    await handleInstagramInbound(db, EVENT)

    expect(runChannelAgent).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('message insert failed'),
      'violates check constraint',
    )
  })
})
