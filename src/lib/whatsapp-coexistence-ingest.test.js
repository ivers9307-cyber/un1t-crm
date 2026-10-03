// src/lib/whatsapp-coexistence-ingest.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
const { logError } = await import('@/lib/log')
const { syncContactMatchOnly, ingestCoexistenceMessage } = await import('./whatsapp-coexistence-ingest.js')

// Minimal chainable mock db. Each .from() returns a builder whose terminal
// awaited call resolves to the queued result for that table+op.
function makeDb(handlers) {
  return {
    from(table) {
      const ctx = { table, filters: [] }
      const builder = {
        select() { return builder }, insert(v) { ctx.op = 'insert'; ctx.values = v; return builder },
        update(v) { ctx.op = 'update'; ctx.values = v; return builder },
        eq() { return builder }, is() { return builder }, or() { return builder },
        limit() { return builder }, order() { return builder },
        maybeSingle() { return Promise.resolve(handlers(ctx)) },
        single() { return Promise.resolve(handlers(ctx)) },
        then(res) { return Promise.resolve(handlers(ctx)).then(res) },
      }
      return builder
    },
  }
}

describe('syncContactMatchOnly', () => {
  it('updates wa_phone on an EXISTING contact and never creates', async () => {
    const updates = []
    const db = makeDb((ctx) => {
      if (ctx.table === 'contacts' && ctx.op === 'update') { updates.push(ctx.values); return { data: null, error: null } }
      if (ctx.table === 'contacts') return { data: { id: 'c1', wa_phone: null }, error: null } // match found
      return { data: null, error: null }
    })
    const r = await syncContactMatchOnly(db, { phone: '+353861234567' })
    expect(r).toEqual({ matched: true, contactId: 'c1' })
    expect(updates).toEqual([{ wa_phone: '353861234567' }])
  })
  it('creates NOTHING when the contact is not already in the CRM', async () => {
    const inserts = []
    const db = makeDb((ctx) => {
      if (ctx.op === 'insert') { inserts.push(ctx); return { data: { id: 'X' }, error: null } }
      if (ctx.table === 'contacts') return { data: null, error: null } // no match
      return { data: null, error: null }
    })
    const r = await syncContactMatchOnly(db, { phone: '+353860000000' })
    expect(r).toEqual({ matched: false, contactId: null })
    expect(inserts).toEqual([]) // never inserts a contact
  })
})

describe('ingestCoexistenceMessage', () => {
  it('dedups on wa_message_id — a message we already have is skipped', async () => {
    const inserts = []
    const db = makeDb((ctx) => {
      if (ctx.table === 'whatsapp_messages' && ctx.op !== 'insert') return { data: { id: 'existing' }, error: null } // dupe found
      if (ctx.op === 'insert') { inserts.push(ctx.table); return { data: { id: 'n' }, error: null } }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, {
      locationId: 'L1', descriptor: { waMessageId: 'wamid.DUP', peerPhone: '353222', direction: 'outbound', messageType: 'text', body: 'x', tsSeconds: 1700000000 },
    })
    expect(r).toEqual({ inserted: false, reason: 'duplicate' })
    expect(inserts).toEqual([]) // no conversation, no message
  })

  it('recovers from a conversation-insert unique-race and still stores the message', async () => {
    const inserts = []
    let convSelects = 0
    const db = makeDb((ctx) => {
      if (ctx.table === 'whatsapp_messages') {
        if (ctx.op === 'insert') { inserts.push('msg'); return { data: { id: 'm1' }, error: null } }
        return { data: null, error: null } // dedup: not a dupe
      }
      if (ctx.table === 'contacts') return { data: null, error: null } // unknown peer
      if (ctx.table === 'whatsapp_conversations') {
        if (ctx.op === 'insert') return { data: null, error: { message: 'duplicate key' } } // lost the race
        convSelects += 1
        // 1st select = existing-conv lookup (none); 2nd = re-read the winner
        return convSelects === 1 ? { data: null, error: null } : { data: { id: 'raced1' }, error: null }
      }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, {
      locationId: 'L1', descriptor: { waMessageId: 'wamid.RACE', peerPhone: '353999', direction: 'inbound', messageType: 'text', body: 'hi', tsSeconds: 1700000000 },
    })
    expect(r).toEqual({ inserted: true, conversationId: 'raced1', contactId: null })
    expect(inserts).toEqual(['msg']) // still inserted despite losing the conversation race
  })

  it('reports failure when the final message insert errors', async () => {
    const db = makeDb((ctx) => {
      if (ctx.table === 'whatsapp_messages') {
        if (ctx.op === 'insert') return { data: null, error: { message: 'boom' } }
        return { data: null, error: null } // dedup: not a dupe
      }
      if (ctx.table === 'contacts') return { data: null, error: null } // unknown peer
      if (ctx.table === 'whatsapp_conversations') {
        if (ctx.op === 'insert') return { data: { id: 'conv1' }, error: null }
        return { data: null, error: null } // no existing conv
      }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, {
      locationId: 'L1', descriptor: { waMessageId: 'wamid.BOOM', peerPhone: '353888', direction: 'outbound', messageType: 'text', body: 'x', tsSeconds: 1700000000 },
    })
    expect(r).toEqual({ inserted: false, reason: 'boom' })
  })

  it('rejects a malformed descriptor with no valid direction before touching the db', async () => {
    const inserts = []
    const db = makeDb((ctx) => {
      if (ctx.op === 'insert') { inserts.push(ctx.table); return { data: { id: 'n' }, error: null } }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, {
      locationId: 'L1', descriptor: { waMessageId: 'wamid.BAD', peerPhone: '353777', direction: undefined, messageType: 'text', body: 'x', tsSeconds: 1700000000 },
    })
    expect(r).toEqual({ inserted: false, reason: 'bad_direction' })
    expect(inserts).toEqual([]) // guarded before any write
  })
})

// C106 CHECKINRISKS.1 (d) — a reply typed in the studio's linked WhatsApp
// Business phone app reaches us as an smb_message_echoes webhook. It is a
// STAFF message: stored as source 'app_echo' (the CHECK has allowed it since
// mig 259; nothing wrote it), and it takes the thread over from Mia exactly
// like an inbox send (manualTakeoverPatch). History-sync rows stay as they
// were: the column default, and no take-over (they are weeks old).
describe('ingestCoexistenceMessage — phone-app echoes are staff (C106 d)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  // A new peer thread: no dupe, no contact, the conversation insert wins.
  function echoDb({ convUpdateError = null } = {}) {
    const writes = []
    const db = makeDb((ctx) => {
      if (ctx.op) writes.push({ table: ctx.table, op: ctx.op, values: ctx.values })
      if (ctx.table === 'whatsapp_messages') return { data: ctx.op === 'insert' ? { id: 'm1' } : null, error: null }
      if (ctx.table === 'contacts') return { data: null, error: null }
      if (ctx.table === 'whatsapp_conversations') {
        if (ctx.op === 'insert') return { data: { id: 'conv1' }, error: null }
        if (ctx.op === 'update') return { data: null, error: convUpdateError }
        return { data: null, error: null }
      }
      return { data: null, error: null }
    })
    return { db, writes }
  }
  const echo = { waMessageId: 'wamid.E1', peerPhone: '353000', direction: 'outbound', messageType: 'text', body: 'x', tsSeconds: 1700000000, origin: 'echo' }
  const history = { ...echo, waMessageId: 'wamid.H1', origin: 'history' }

  it("stores an echo with source 'app_echo' and no sent_by", async () => {
    const { db, writes } = echoDb()
    const r = await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: echo })
    expect(r).toMatchObject({ inserted: true, conversationId: 'conv1' })
    const msg = writes.find(w => w.table === 'whatsapp_messages' && w.op === 'insert')
    expect(msg.values.source).toBe('app_echo')
    expect(msg.values).not.toHaveProperty('sent_by')
  })

  it('an echo takes the thread over from Mia, like an inbox send', async () => {
    const { db, writes } = echoDb()
    await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: echo })
    const upd = writes.find(w => w.table === 'whatsapp_conversations' && w.op === 'update')
    expect(upd).toBeTruthy()
    expect(upd.values.agent_active).toBe(false)
    expect(typeof upd.values.agent_handed_off_at).toBe('string')
  })

  it('a history-sync row keeps the column default and takes nothing over', async () => {
    const { db, writes } = echoDb()
    const r = await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: history })
    expect(r).toEqual({ inserted: true, conversationId: 'conv1', contactId: null })
    const msg = writes.find(w => w.table === 'whatsapp_messages' && w.op === 'insert')
    expect(msg.values).not.toHaveProperty('source')
    expect(writes.some(w => w.table === 'whatsapp_conversations' && w.op === 'update')).toBe(false)
  })

  it('a descriptor with no origin is treated as history (never staff by accident)', async () => {
    const { db, writes } = echoDb()
    const { origin, ...bare } = echo
    expect(origin).toBe('echo')
    await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: bare })
    const msg = writes.find(w => w.table === 'whatsapp_messages' && w.op === 'insert')
    expect(msg.values).not.toHaveProperty('source')
    expect(writes.some(w => w.op === 'update')).toBe(false)
  })

  it('a failed take-over write is logged and reported; the message is still stored', async () => {
    const { db } = echoDb({ convUpdateError: { message: 'update refused' } })
    const r = await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: echo })
    expect(r).toMatchObject({ inserted: true, conversationId: 'conv1', takeoverFailed: true })
    expect(logError).toHaveBeenCalledWith('wa-coexistence', expect.stringMatching(/take-over/i),
      expect.objectContaining({ conversationId: 'conv1', locationId: 'L1', err: 'update refused' }))
  })

  it('a failed message insert takes nothing over', async () => {
    const writes = []
    const db = makeDb((ctx) => {
      if (ctx.op) writes.push({ table: ctx.table, op: ctx.op })
      if (ctx.table === 'whatsapp_messages') return ctx.op === 'insert' ? { data: null, error: { message: 'boom' } } : { data: null, error: null }
      if (ctx.table === 'whatsapp_conversations') return ctx.op === 'insert' ? { data: { id: 'conv1' }, error: null } : { data: null, error: null }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: echo })
    expect(r).toEqual({ inserted: false, reason: 'boom' })
    expect(writes.some(w => w.op === 'update')).toBe(false)
  })
})
