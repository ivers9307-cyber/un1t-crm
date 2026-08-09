// COMMSFIX.C.2 — the webhook dedup key was too wide.
//
// `${RecordType}:${MessageID}` is stable for the LIFETIME of a message, and
// Postmark's MessageID is per-message, not per-event. So the idempotency layer
// (mig 107, shipped 2026-05-08) did not just swallow Postmark's retries — it
// swallowed every genuine repeat. Prod data: May 2026 had 927 sends with more
// than one open; June, July and August have ZERO across ~6,200 opened sends.
// Every second click (including a click on a DIFFERENT link) and every second
// bounce for a message went the same way.
//
// The fix keeps retries deduped — Postmark redelivers the identical payload,
// ReceivedAt and the bounce ID included — while letting real repeats through.
// Idempotency of the counters themselves is the processor's job and already
// holds: FirstOpen gates total_opened, the status transitions guard the rest,
// and COMMSFIX.C.1 put total_delivered on the delivered_at transition.
//
// Pure predicate pulled out of the route, mirroring postmark-webhook-auth.test.js.

import { describe, it, expect } from 'vitest'
import { buildWebhookEventId } from '../app/api/webhooks/postmark/route.js'

const MSG = 'a1b2c3d4-0000-4000-8000-000000000abc'
const ZERO_GUID = '00000000-0000-0000-0000-000000000000'

describe('buildWebhookEventId — repeatable engagement events (COMMSFIX.C.2)', () => {
  it('keys Open on ReceivedAt so a genuine re-open is a distinct event', () => {
    const first = buildWebhookEventId({ RecordType: 'Open', MessageID: MSG, ReceivedAt: '2026-08-09T10:00:00Z' })
    const second = buildWebhookEventId({ RecordType: 'Open', MessageID: MSG, ReceivedAt: '2026-08-09T14:31:02Z' })
    expect(first).toBe(`Open:${MSG}:2026-08-09T10:00:00Z`)
    expect(second).not.toBe(first)
  })

  it('keys Click on ReceivedAt so a click on a second link is not swallowed', () => {
    const linkA = buildWebhookEventId({ RecordType: 'Click', MessageID: MSG, ReceivedAt: '2026-08-09T10:00:00Z', OriginalLink: 'https://a' })
    const linkB = buildWebhookEventId({ RecordType: 'Click', MessageID: MSG, ReceivedAt: '2026-08-09T10:00:09Z', OriginalLink: 'https://b' })
    expect(linkA).toBe(`Click:${MSG}:2026-08-09T10:00:00Z`)
    expect(linkB).not.toBe(linkA)
  })

  it.each(['Open', 'Click'])('%s: a Postmark RETRY of the same event still dedups (identical payload, identical ReceivedAt)', (RecordType) => {
    const payload = { RecordType, MessageID: MSG, ReceivedAt: '2026-08-09T10:00:00Z' }
    expect(buildWebhookEventId(payload)).toBe(buildWebhookEventId({ ...payload }))
  })

  it('keys Bounce on Postmark per-bounce ID so a soft bounce then a hard bounce both land', () => {
    const soft = buildWebhookEventId({ RecordType: 'Bounce', MessageID: MSG, ID: 111 })
    const hard = buildWebhookEventId({ RecordType: 'Bounce', MessageID: MSG, ID: 222 })
    expect(soft).toBe(`Bounce:${MSG}:111`)
    expect(hard).not.toBe(soft)
  })

  it('leaves Delivery keyed on the message alone — one message delivers once', () => {
    expect(buildWebhookEventId({ RecordType: 'Delivery', MessageID: MSG, DeliveredAt: '2026-08-09T10:00:00Z' }))
      .toBe(`Delivery:${MSG}`)
  })

  it('leaves a message-bound SubscriptionChange keyed on the message alone', () => {
    expect(buildWebhookEventId({ RecordType: 'SubscriptionChange', MessageID: MSG, Recipient: 'a@x.ie' }))
      .toBe(`SubscriptionChange:${MSG}`)
  })

  it('discriminates zero-GUID SubscriptionChange by recipient — every Postmark-side suppression carries the same MessageID', () => {
    const a = buildWebhookEventId({ RecordType: 'SubscriptionChange', MessageID: ZERO_GUID, Recipient: 'a@x.ie' })
    const b = buildWebhookEventId({ RecordType: 'SubscriptionChange', MessageID: ZERO_GUID, Recipient: 'b@x.ie' })
    expect(a).toBe(`SubscriptionChange:${ZERO_GUID}:a@x.ie`)
    expect(b).not.toBe(a)
  })

  it('falls back to the message-scoped key for an unknown RecordType', () => {
    expect(buildWebhookEventId({ RecordType: 'SomethingNew', MessageID: MSG })).toBe(`SomethingNew:${MSG}`)
    expect(buildWebhookEventId({ MessageID: MSG })).toBe(`unknown:${MSG}`)
  })
})
