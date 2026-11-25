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
import { sendPush, sendPushToRolesAtLocation } from '@/lib/push'
import { ensureInstagramMediaRehosted } from '@/lib/instagram-media-server'

// Chainable stub. `conv` decides what the find-or-create lookups return (an
// array consumed in order, so a test can say "miss, then the winner's row"),
// `convInsert` / `msgInsert` decide the insert outcomes.
function igDb({ convLookups = [null], convInsert = { data: { id: 'conv-new' }, error: null }, msgInsert = { data: { id: 'msg-1' }, error: null } }) {
  const lookups = [...convLookups]
  const inserts = []
  const updates = []
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
      update: (row) => { state.op = 'update'; state.row = row; updates.push({ table, row }); return b },
      eq: () => b, limit: () => b, order: () => b,
      single: () => b, maybeSingle: () => b,
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return b
  }
  return { from: mk, rpc: vi.fn(async () => ({ data: null, error: null })), inserts, updates }
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

// IG-LOWSIG.1 — story mentions / shared posts / emoji-only story reactions are
// recorded as thread history but never escalated: no needs-action flip, no
// unread bump, no agent turn, no staff push.
describe('handleInstagramInbound — low-signal events (story mention / share)', () => {
  const STORY_MENTION = {
    accountId: 'IGBIZ1', customerId: 'CUST1', messageId: 'mid-sm',
    text: '', type: 'story_mention', mediaUrl: 'https://cdn.ig/story.jpg',
    isEcho: false, isStoryReply: false,
  }

  it('persists + re-hosts the story frame, but neither notifies nor escalates', async () => {
    const db = igDb({ convLookups: [{ id: 'conv-1' }] })

    const result = await handleInstagramInbound(db, STORY_MENTION)

    expect(result).toMatchObject({ handled: true, conversationId: 'conv-1', lowSignal: true })
    // Recorded in the thread, media saved before the IG CDN url expires…
    const row = db.inserts.find((i) => i.table === 'instagram_messages').row
    expect(row).toMatchObject({ direction: 'inbound', message_type: 'story_mention' })
    expect(ensureInstagramMediaRehosted).toHaveBeenCalled()
    // …but nothing that demands a human: no unread bump, no agent, no push.
    expect(db.rpc).not.toHaveBeenCalled()
    expect(runChannelAgent).not.toHaveBeenCalled()
    expect(sendPush).not.toHaveBeenCalled()
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
    // The thread list stays truthful (timestamp + preview) without flipping
    // the conversation into the needs-action queues: an answered thread keeps
    // its resolved_at and its outbound last_message_direction.
    const convUpdate = db.updates.find((u) => u.table === 'instagram_conversations')
    expect(convUpdate.row).toHaveProperty('last_message_at')
    expect(convUpdate.row).toHaveProperty('last_message_preview')
    expect(convUpdate.row).not.toHaveProperty('resolved_at')
    expect(convUpdate.row).not.toHaveProperty('last_message_direction')
  })

  it('a share WITH a typed caption escalates like any other message', async () => {
    const db = igDb({ convLookups: [{ id: 'conv-1' }] })

    const result = await handleInstagramInbound(db, {
      ...STORY_MENTION, messageId: 'mid-share', type: 'share',
      mediaUrl: 'https://cdn.ig/post.jpg', text: 'is this class still on tonight?',
    })

    expect(result).toMatchObject({ handled: true, lowSignal: false })
    expect(db.rpc).toHaveBeenCalled()
    expect(runChannelAgent).toHaveBeenCalled()
    const convUpdate = db.updates.find((u) => u.table === 'instagram_conversations')
    expect(convUpdate.row).toMatchObject({ last_message_direction: 'inbound', resolved_at: null })
  })
})

// IG-MEDIA.2 / IG-ECHO — the echo branch records a reply a staff member typed
// in the native Instagram app. It had no coverage at all, despite carrying a
// load-bearing guard: an echo of Mia's OWN send must not be mistaken for a
// human taking over, or she goes silent on a thread she was handling.
describe('handleInstagramInbound — echo (staff replied from the Instagram app)', () => {
  const ECHO = {
    accountId: 'IGBIZ1', customerId: 'CUST1', messageId: 'mid-echo',
    text: '', type: 'story_mention', mediaUrl: 'https://cdn.ig/story.jpg', isEcho: true,
  }

  it('persists the media instead of dropping it, and re-hosts before the CDN url expires', async () => {
    const db = igDb({ convLookups: [{ id: 'conv-1' }] })

    const result = await handleInstagramInbound(db, ECHO)

    expect(result).toMatchObject({ handled: true, echo: true })
    const row = db.inserts.find((i) => i.table === 'instagram_messages').row
    expect(row).toMatchObject({
      direction: 'outbound',
      source: 'instagram_app',
      message_type: 'story_mention',
      media_url: 'https://cdn.ig/story.jpg',
    })
    expect(ensureInstagramMediaRehosted).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 'msg-1', message_type: 'story_mention', media_url: 'https://cdn.ig/story.jpg' }),
      expect.anything(),
    )
  })

  it('hands the thread to the human: answered, and Mia stands down', async () => {
    const db = igDb({ convLookups: [{ id: 'conv-1' }] })

    await handleInstagramInbound(db, ECHO)

    const convUpdate = db.updates.find((u) => u.table === 'instagram_conversations')
    expect(convUpdate.row).toMatchObject({ last_message_direction: 'outbound', agent_active: false })
    expect(runChannelAgent).not.toHaveBeenCalled()
  })

  it('an echo of our OWN send is skipped and never stands Mia down (23505 race)', async () => {
    // The send route inserted its row between the dedup lookup and this insert.
    const db = igDb({
      convLookups: [{ id: 'conv-1' }],
      msgInsert: { data: null, error: { code: '23505', message: 'duplicate key' } },
    })

    const result = await handleInstagramInbound(db, ECHO)

    expect(result).toMatchObject({ handled: false, reason: 'echo_own_send' })
    expect(db.updates.find((u) => u.table === 'instagram_conversations')).toBeUndefined()
  })
})

// W0.14 — the location lookup's throw must PROPAGATE out of the handler so the
// webhook can release the dedup claim and answer 500 for a Meta retry. If
// someone later wraps the resolver call in a try/catch this fails.
describe('handleInstagramInbound — lookup failure propagates', () => {
  it('rejects when the resolver rejects (never reads as unmatched_account)', async () => {
    resolveLocationByExternalAccount.mockRejectedValueOnce(new Error('channel_connections lookup failed: boom'))
    const db = igDb({})
    await expect(handleInstagramInbound(db, EVENT)).rejects.toThrow(/lookup failed/)
    expect(db.inserts).toHaveLength(0)
  })
})

// INBOXFOLLOW.1 — follow-up queue stamps on the Instagram write points.
describe('handleInstagramInbound — inbox follow-up stamps', () => {
  const NOW_ISH = 1790000000000 // far in the future of any fixture timestamp
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW_ISH) })
  afterEach(() => { vi.useRealTimers() })

  it('a real inbound keeps customer_waiting_since, nulls the staff wait and the snooze, and keeps resolved_at null', async () => {
    const db = igDb({ convLookups: [{ id: 'conv-1', customer_waiting_since: '2026-11-24T09:00:00.000Z' }] })
    await handleInstagramInbound(db, EVENT)
    const row = db.updates.find((u) => u.table === 'instagram_conversations').row
    expect(row).toMatchObject({
      resolved_at: null, last_message_direction: 'inbound',
      customer_waiting_since: '2026-11-24T09:00:00.000Z',
      staff_waiting_since: null, staff_nudged_at: null, staff_nudge_outcome: null,
      snoozed_until: null, snoozed_by: null, snooze_note: null,
    })
  })

  it('a first inbound starts the customer wait now', async () => {
    const db = igDb({ convLookups: [{ id: 'conv-1' }] })
    await handleInstagramInbound(db, EVENT)
    const row = db.updates.find((u) => u.table === 'instagram_conversations').row
    expect(row.customer_waiting_since).toBe(new Date(NOW_ISH).toISOString())
  })

  it("a first inbound starts the customer wait at the message's own time, not webhook time", async () => {
    const db = igDb({ convLookups: [{ id: 'conv-1' }] })
    const sentAt = NOW_ISH - 600_000
    await handleInstagramInbound(db, { ...EVENT, timestamp: sentAt })
    const row = db.updates.find((u) => u.table === 'instagram_conversations').row
    expect(row.customer_waiting_since).toBe(new Date(sentAt).toISOString())
    expect(row.last_message_at).toBe(new Date(sentAt).toISOString())
  })

  it('a low-signal inbound carries no follow-up stamp', async () => {
    const db = igDb({ convLookups: [{ id: 'conv-1' }] })
    await handleInstagramInbound(db, { accountId: 'IGBIZ1', customerId: 'CUST1', messageId: 'mid-sm2', text: '', type: 'story_mention', mediaUrl: 'https://cdn.ig/s.jpg', isEcho: false, isStoryReply: false })
    const row = db.updates.find((u) => u.table === 'instagram_conversations').row
    for (const k of ['customer_waiting_since', 'staff_waiting_since', 'snoozed_until', 'staff_nudged_at']) expect(row).not.toHaveProperty(k)
  })

  it('an echo reply from the Instagram app starts staff ownership and the wait on the customer', async () => {
    const db = igDb({ convLookups: [{ id: 'conv-1', customer_waiting_since: '2026-11-24T09:00:00.000Z', last_message_at: '2020-01-01T00:00:00.000Z' }] })
    await handleInstagramInbound(db, { accountId: 'IGBIZ1', customerId: 'CUST1', messageId: 'mid-e2', text: 'hello', type: 'text', isEcho: true })
    const row = db.updates.find((u) => u.table === 'instagram_conversations').row
    expect(row.customer_waiting_since).toBeNull()
    expect(typeof row.staff_owned_since).toBe('string')
    expect(row.staff_waiting_since).toBe(row.staff_owned_since)
    expect(row).toMatchObject({ handoff_requested_at: null, snoozed_until: null })
  })

  it('an echo older than the thread\'s last message leaves the waits alone', async () => {
    const db = igDb({ convLookups: [{ id: 'conv-1', customer_waiting_since: '2026-11-24T09:00:00.000Z', last_message_at: '2999-01-01T00:00:00.000Z' }] })
    await handleInstagramInbound(db, { accountId: 'IGBIZ1', customerId: 'CUST1', messageId: 'mid-e3', text: 'late', type: 'text', isEcho: true })
    const row = db.updates.find((u) => u.table === 'instagram_conversations').row
    expect(row).not.toHaveProperty('customer_waiting_since')
    expect(row).not.toHaveProperty('staff_waiting_since')
  })
})
