// webhook-events helper — locks the dedup contract that every
// webhook route depends on. Three things matter:
//   1. Fresh insert returns seen=false so the caller proceeds.
//   2. PG 23505 (unique_violation) → seen=true so the caller
//      short-circuits.
//   3. Anything else (transient DB errors, invalid input) returns
//      seen=false so we don't silently drop a real webhook.

import { describe, it, expect, vi } from 'vitest'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from './webhook-events.js'

function mockDb({ insertResolves }) {
  const insertSpy = vi.fn(() => Promise.resolve(insertResolves))
  return {
    db: { from: vi.fn(() => ({ insert: insertSpy })) },
    insertSpy,
  }
}

describe('recordWebhookEvent', () => {
  it('seen=false on a fresh insert', async () => {
    const { db, insertSpy } = mockDb({ insertResolves: { error: null } })
    const r = await recordWebhookEvent({
      db, provider: WEBHOOK_PROVIDERS.POSTMARK, eventId: 'Delivery:abc',
    })
    expect(r).toEqual({ seen: false })
    expect(insertSpy).toHaveBeenCalledWith({
      provider: 'postmark', event_id: 'Delivery:abc',
    })
  })

  it('seen=true on a unique_violation (Postgres 23505)', async () => {
    const { db } = mockDb({
      insertResolves: { error: { code: '23505', message: 'duplicate key' } },
    })
    const r = await recordWebhookEvent({
      db, provider: WEBHOOK_PROVIDERS.REVOLUT, eventId: 'ORDER_COMPLETED:order-1',
    })
    expect(r).toEqual({ seen: true })
  })

  it('seen=false on an unexpected DB error (caller still processes)', async () => {
    // The thinking: we'd rather double-process than drop a real
    // webhook. The per-feature idempotency layer (status guards in
    // the cars / race-payment paths) catches it on the second pass.
    const { db } = mockDb({
      insertResolves: { error: { code: '40001', message: 'serialization failure' } },
    })
    const r = await recordWebhookEvent({
      db, provider: WEBHOOK_PROVIDERS.TWILIO, eventId: 'SM123:delivered',
    })
    expect(r.seen).toBe(false)
    expect(r.error).toBe('serialization failure')
  })

  it('rejects invalid provider names without touching the DB', async () => {
    const { db, insertSpy } = mockDb({ insertResolves: { error: null } })
    const r = await recordWebhookEvent({
      db, provider: 'made_up', eventId: 'x',
    })
    expect(r).toEqual({ seen: false, error: 'invalid_input' })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('rejects empty / oversized event_id', async () => {
    const { db } = mockDb({ insertResolves: { error: null } })
    expect(await recordWebhookEvent({
      db, provider: WEBHOOK_PROVIDERS.WHATSAPP, eventId: '',
    })).toEqual({ seen: false, error: 'invalid_input' })
    expect(await recordWebhookEvent({
      db, provider: WEBHOOK_PROVIDERS.WHATSAPP, eventId: 'a'.repeat(513),
    })).toEqual({ seen: false, error: 'invalid_input' })
    expect(await recordWebhookEvent({
      db, provider: WEBHOOK_PROVIDERS.WHATSAPP, eventId: null,
    })).toEqual({ seen: false, error: 'invalid_input' })
  })

  it('rejects when db is missing', async () => {
    const r = await recordWebhookEvent({
      db: null, provider: WEBHOOK_PROVIDERS.POSTMARK, eventId: 'x',
    })
    expect(r).toEqual({ seen: false, error: 'invalid_input' })
  })

  it('hits the webhook_events table specifically', async () => {
    const { db } = mockDb({ insertResolves: { error: null } })
    await recordWebhookEvent({
      db, provider: WEBHOOK_PROVIDERS.XERO, eventId: 'evt-1',
    })
    expect(db.from).toHaveBeenCalledWith('webhook_events')
  })
})
