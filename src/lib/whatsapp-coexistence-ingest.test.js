// src/lib/whatsapp-coexistence-ingest.test.js
import { describe, it, expect } from 'vitest'
import { syncContactMatchOnly, ingestCoexistenceMessage } from './whatsapp-coexistence-ingest.js'

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
})
