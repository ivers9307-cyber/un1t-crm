// EMAIL-DELIVERY.1 — the transition rules, the correlation, and the two
// failure modes that would make this feature worse than nothing:
//
//   1. A Delivery repainting a Bounce as fine. Webhooks arrive out of order
//      and get redelivered; if the last writer won, a bounced reply would show
//      as delivered and staff would stop chasing someone who never got an
//      answer. That is the exact bug this whole ticket exists to prevent, so
//      the lattice is pinned from both directions.
//   2. An event for a message we do not have — a campaign send, an invoice
//      email, a booking confirmation — erroring, or worse, attaching itself to
//      a ticket message. Those events share this webhook firehose and are the
//      MAJORITY of its traffic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log.js', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}))

import {
  DELIVERY_STATUS_RANK,
  DETAIL_MAX_CHARS,
  deliveryStatusForRecordType,
  shouldApplyDeliveryEvent,
  overwritableStatuses,
  overwritableFilter,
  normalizeBounceType,
  bounceDetail,
  deliveryEventFromPayload,
  recordTicketMessageDelivery,
} from './email-delivery-status.js'
import { logError } from './log.js'

// ── A fake that RECORDS THE FILTERS, because the filters ARE the feature ──
//
// The lattice is enforced in the UPDATE's own WHERE clause (a read-then-write
// would race the two queue consumers), so a fake that ignored `.or()` would
// pass every out-of-order test with the rule deleted. `rows` are matched for
// real against eq/or so "zero rows changed" is a property the fake can prove.
function splitTopLevel(expr) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of expr) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}

function orMatches(row, expr) {
  return splitTopLevel(expr).some(part => {
    const m = part.trim().match(/^([a-z_]+)\.(in|is|eq)\.(.*)$/)
    if (!m) return false
    const [, col, op, rawVal] = m
    const value = row[col] ?? null
    if (op === 'is') return rawVal === 'null' ? value === null : String(value) === rawVal
    if (op === 'eq') return String(value) === rawVal
    const list = rawVal.replace(/^\(/, '').replace(/\)$/, '')
      .split(',').map(v => v.trim().replace(/^"|"$/g, ''))
    return list.includes(value)
  })
}

function makeDb({ rows = [], error = null } = {}) {
  const calls = []
  const db = {
    rows,
    calls,
    from(table) {
      const state = { table, payload: null, eq: [], or: null }
      const b = {
        update(payload) { state.payload = payload; return b },
        eq(col, val) { state.eq.push([col, val]); return b },
        or(expr) { state.or = expr; return b },
        select() {
          calls.push(state)
          if (error) return Promise.resolve({ data: null, error })
          const hit = rows.filter(r =>
            state.eq.every(([c, v]) => (r[c] ?? null) === v)
            && (state.or === null || orMatches(r, state.or))
          )
          for (const r of hit) Object.assign(r, state.payload)
          return Promise.resolve({ data: hit.map(r => ({ id: r.id })), error: null })
        },
      }
      return b
    },
  }
  return db
}

const TICKET_MSG = () => ({
  id: 'm1',
  postmark_message_id: 'pm-ticket-1',
  direction: 'outbound',
  delivery_status: null,
  delivery_status_at: null,
  delivery_detail: null,
  delivery_bounce_type: null,
})

beforeEach(() => vi.clearAllMocks())

// ── Pure rules ───────────────────────────────────────────────────────
describe('record type → stored status', () => {
  it('maps exactly the three outbound-outcome record types', () => {
    expect(deliveryStatusForRecordType('Delivery')).toBe('delivered')
    expect(deliveryStatusForRecordType('Bounce')).toBe('bounced')
    expect(deliveryStatusForRecordType('SpamComplaint')).toBe('complained')
  })

  it('maps every other record type to null — Open and Click included', () => {
    // Open/Click are OUT OF SCOPE by decision, not by omission: this feature
    // must never grow behavioural tracking of an individual member.
    for (const t of ['Open', 'Click', 'SubscriptionChange', 'Inbound', '', null, undefined, 'Nonsense']) {
      expect(deliveryStatusForRecordType(t)).toBeNull()
    }
  })
})

describe('the severity lattice', () => {
  it('ranks NULL < delivered < complained < bounced', () => {
    expect(DELIVERY_STATUS_RANK.delivered).toBeLessThan(DELIVERY_STATUS_RANK.complained)
    expect(DELIVERY_STATUS_RANK.complained).toBeLessThan(DELIVERY_STATUS_RANK.bounced)
  })

  it('applies any outcome over "no event yet"', () => {
    for (const next of ['delivered', 'complained', 'bounced']) {
      expect(shouldApplyDeliveryEvent(null, next)).toBe(true)
      expect(shouldApplyDeliveryEvent(undefined, next)).toBe(true)
    }
  })

  it('NEVER lets a Delivery overwrite a Bounce or a complaint', () => {
    expect(shouldApplyDeliveryEvent('bounced', 'delivered')).toBe(false)
    expect(shouldApplyDeliveryEvent('complained', 'delivered')).toBe(false)
  })

  it('lets a Bounce overwrite a Delivery — an async bounce is the later truth', () => {
    expect(shouldApplyDeliveryEvent('delivered', 'bounced')).toBe(true)
    expect(shouldApplyDeliveryEvent('delivered', 'complained')).toBe(true)
    expect(shouldApplyDeliveryEvent('complained', 'bounced')).toBe(true)
  })

  it('is a no-op on a repeat of the same event (idempotent redelivery)', () => {
    for (const s of ['delivered', 'complained', 'bounced']) {
      expect(shouldApplyDeliveryEvent(s, s)).toBe(false)
    }
  })

  it('refuses anything that is not one of the three statuses', () => {
    expect(shouldApplyDeliveryEvent(null, 'opened')).toBe(false)
    expect(shouldApplyDeliveryEvent(null, null)).toBe(false)
  })
})

describe('overwritableStatuses / overwritableFilter — the same rule as a WHERE clause', () => {
  it('delivered may only land on an empty slot', () => {
    expect(overwritableStatuses('delivered')).toEqual([])
    expect(overwritableFilter('delivered')).toBe('delivery_status.is.null')
  })

  it('complained may land on empty or delivered', () => {
    expect(overwritableStatuses('complained')).toEqual(['delivered'])
    expect(overwritableFilter('complained'))
      .toBe('delivery_status.is.null,delivery_status.in.("delivered")')
  })

  it('bounced may land on anything below it', () => {
    expect(overwritableStatuses('bounced')).toEqual(['complained', 'delivered'])
    expect(overwritableFilter('bounced'))
      .toBe('delivery_status.is.null,delivery_status.in.("complained","delivered")')
  })

  it('agrees with shouldApplyDeliveryEvent for every ordered pair', () => {
    const values = [null, 'delivered', 'complained', 'bounced']
    for (const current of values) {
      for (const next of ['delivered', 'complained', 'bounced']) {
        const viaFilter = current === null
          ? true
          : overwritableStatuses(next).includes(current)
        expect(viaFilter).toBe(shouldApplyDeliveryEvent(current, next))
      }
    }
  })
})

describe('bounce classification + reason', () => {
  it('uses the same hard/soft/transient mapping as email_sends.bounce_type', () => {
    expect(normalizeBounceType('HardBounce')).toBe('hard')
    expect(normalizeBounceType('SoftBounce')).toBe('soft')
    expect(normalizeBounceType('DnsError')).toBe('transient')
    expect(normalizeBounceType(undefined)).toBe('transient')
  })

  it('joins Description and Details so "mailbox full" and "no such address" survive', () => {
    expect(bounceDetail({
      Description: 'The server was unable to deliver your message (ex: unknown user, mailbox not found).',
      Details: 'smtp;550 5.1.1 <nope@example.com> User unknown',
    })).toBe(
      'The server was unable to deliver your message (ex: unknown user, mailbox not found). '
      + 'smtp;550 5.1.1 <nope@example.com> User unknown'
    )

    expect(bounceDetail({
      Description: 'The server could not temporarily deliver your message.',
      Details: 'smtp;552 5.2.2 Mailbox full',
    })).toContain('Mailbox full')
  })

  it('falls back to Name, then to null', () => {
    expect(bounceDetail({ Name: 'Blocked' })).toBe('Blocked')
    expect(bounceDetail({ Description: '   ', Details: '' })).toBeNull()
    expect(bounceDetail({})).toBeNull()
    expect(bounceDetail(null)).toBeNull()
  })

  it('caps the stored reason', () => {
    const detail = bounceDetail({ Description: 'x'.repeat(2000) })
    expect(detail).toHaveLength(DETAIL_MAX_CHARS)
  })
})

describe('deliveryEventFromPayload', () => {
  const NOW = new Date('2026-08-07T10:00:00.000Z')

  it('prefers the provider\'s own stamp over processing time', () => {
    expect(deliveryEventFromPayload({
      RecordType: 'Delivery', MessageID: 'pm-1', DeliveredAt: '2026-08-07T09:15:00Z',
    }, NOW).occurredAt).toBe('2026-08-07T09:15:00.000Z')

    expect(deliveryEventFromPayload({
      RecordType: 'Bounce', MessageID: 'pm-1', BouncedAt: '2026-08-07T09:20:00Z',
    }, NOW).occurredAt).toBe('2026-08-07T09:20:00.000Z')
  })

  it('falls back to now for a missing or unparseable stamp', () => {
    expect(deliveryEventFromPayload({ RecordType: 'Delivery', MessageID: 'pm-1' }, NOW).occurredAt)
      .toBe(NOW.toISOString())
    expect(deliveryEventFromPayload(
      { RecordType: 'Delivery', MessageID: 'pm-1', DeliveredAt: 'not-a-date' }, NOW
    ).occurredAt).toBe(NOW.toISOString())
  })

  it('carries no reason and no bounce type on a plain delivery', () => {
    const e = deliveryEventFromPayload({
      RecordType: 'Delivery', MessageID: 'pm-1', Description: 'ignored', Type: 'HardBounce',
    }, NOW)
    expect(e).toMatchObject({ status: 'delivered', detail: null, bounceType: null })
  })

  it('carries the reason on a complaint but no bounce type — they DID receive it', () => {
    const e = deliveryEventFromPayload({
      RecordType: 'SpamComplaint', MessageID: 'pm-1', Description: 'Spam complaint', Type: 'SpamComplaint',
    }, NOW)
    expect(e).toMatchObject({ status: 'complained', detail: 'Spam complaint', bounceType: null })
  })

  it('returns null for anything that is not an outbound outcome, or has no MessageID', () => {
    expect(deliveryEventFromPayload({ RecordType: 'Open', MessageID: 'pm-1' }, NOW)).toBeNull()
    expect(deliveryEventFromPayload({ RecordType: 'Click', MessageID: 'pm-1' }, NOW)).toBeNull()
    expect(deliveryEventFromPayload({ RecordType: 'Delivery' }, NOW)).toBeNull()
    expect(deliveryEventFromPayload(null, NOW)).toBeNull()
  })
})

// ── The write ────────────────────────────────────────────────────────
describe('recordTicketMessageDelivery — correlation', () => {
  it('stamps the outbound ticket message that carries the MessageID', async () => {
    const row = TICKET_MSG()
    const db = makeDb({ rows: [row] })

    const r = await recordTicketMessageDelivery(db, {
      RecordType: 'Delivery', MessageID: 'pm-ticket-1', DeliveredAt: '2026-08-07T09:15:00Z',
    })

    expect(r).toEqual({ ok: true, applied: true })
    expect(row.delivery_status).toBe('delivered')
    expect(row.delivery_status_at).toBe('2026-08-07T09:15:00.000Z')
    // Only ever email_inbox_messages — never email_sends, never
    // campaign_recipients. Suppression is not this module's business.
    expect(db.calls.map(c => c.table)).toEqual(['email_inbox_messages'])
  })

  it('filters on direction=outbound, so an inbound row sharing an id is untouchable', async () => {
    const inbound = { ...TICKET_MSG(), id: 'in1', direction: 'inbound' }
    const db = makeDb({ rows: [inbound] })

    const r = await recordTicketMessageDelivery(db, { RecordType: 'Delivery', MessageID: 'pm-ticket-1' })

    expect(r).toEqual({ ok: true, applied: false })
    expect(inbound.delivery_status).toBeNull()
    expect(db.calls[0].eq).toContainEqual(['direction', 'outbound'])
  })

  it('a CAMPAIGN event matches nothing and is a clean no-op, not an error', async () => {
    // The majority of this webhook's traffic. A campaign MessageID was never
    // written onto an email_inbox_messages row, so there is nothing to match.
    const row = TICKET_MSG()
    const db = makeDb({ rows: [row] })

    const r = await recordTicketMessageDelivery(db, {
      RecordType: 'Bounce', MessageID: 'pm-campaign-999', Type: 'HardBounce',
    })

    expect(r).toEqual({ ok: true, applied: false })
    expect(row.delivery_status).toBeNull()
  })

  it('an event for a message row that does not exist at all is a clean no-op', async () => {
    const db = makeDb({ rows: [] })
    const r = await recordTicketMessageDelivery(db, { RecordType: 'Delivery', MessageID: 'pm-gone' })
    expect(r).toEqual({ ok: true, applied: false })
  })

  it('ignores record types it has no opinion about, without touching the DB', async () => {
    const db = makeDb({ rows: [TICKET_MSG()] })
    for (const RecordType of ['Open', 'Click', 'SubscriptionChange']) {
      const r = await recordTicketMessageDelivery(db, { RecordType, MessageID: 'pm-ticket-1' })
      expect(r).toEqual({ ok: true, applied: false, reason: 'not_a_delivery_event' })
    }
    expect(db.calls).toEqual([])
  })
})

describe('recordTicketMessageDelivery — out-of-order and duplicate events', () => {
  it('a Delivery arriving AFTER a Bounce leaves the bounce standing', async () => {
    const row = { ...TICKET_MSG(), delivery_status: 'bounced', delivery_bounce_type: 'hard', delivery_detail: 'User unknown' }
    const db = makeDb({ rows: [row] })

    const r = await recordTicketMessageDelivery(db, {
      RecordType: 'Delivery', MessageID: 'pm-ticket-1', DeliveredAt: '2026-08-07T09:30:00Z',
    })

    expect(r).toEqual({ ok: true, applied: false })
    expect(row.delivery_status).toBe('bounced')
    expect(row.delivery_bounce_type).toBe('hard')
    expect(row.delivery_detail).toBe('User unknown')
  })

  it('a Bounce arriving AFTER a Delivery wins — the message came back later', async () => {
    const row = { ...TICKET_MSG(), delivery_status: 'delivered', delivery_status_at: '2026-08-07T09:00:00.000Z' }
    const db = makeDb({ rows: [row] })

    const r = await recordTicketMessageDelivery(db, {
      RecordType: 'Bounce',
      MessageID: 'pm-ticket-1',
      BouncedAt: '2026-08-07T09:40:00Z',
      Type: 'SoftBounce',
      Description: 'The server could not temporarily deliver your message.',
      Details: 'smtp;552 5.2.2 Mailbox full',
    })

    expect(r).toEqual({ ok: true, applied: true })
    expect(row.delivery_status).toBe('bounced')
    expect(row.delivery_bounce_type).toBe('soft')
    expect(row.delivery_detail).toContain('Mailbox full')
    expect(row.delivery_status_at).toBe('2026-08-07T09:40:00.000Z')
  })

  it('a duplicate Delivery keeps the FIRST timestamp', async () => {
    const row = TICKET_MSG()
    const db = makeDb({ rows: [row] })
    const send = (at) => recordTicketMessageDelivery(db, {
      RecordType: 'Delivery', MessageID: 'pm-ticket-1', DeliveredAt: at,
    })

    expect(await send('2026-08-07T09:15:00Z')).toEqual({ ok: true, applied: true })
    expect(await send('2026-08-07T11:00:00Z')).toEqual({ ok: true, applied: false })
    expect(row.delivery_status_at).toBe('2026-08-07T09:15:00.000Z')
  })

  it('a duplicate Bounce does not re-stamp, and a complaint cannot demote it', async () => {
    const row = TICKET_MSG()
    const db = makeDb({ rows: [row] })
    const bounce = {
      RecordType: 'Bounce', MessageID: 'pm-ticket-1', Type: 'HardBounce',
      BouncedAt: '2026-08-07T09:00:00Z', Description: 'No such user',
    }

    expect(await recordTicketMessageDelivery(db, bounce)).toEqual({ ok: true, applied: true })
    expect(await recordTicketMessageDelivery(db, { ...bounce, BouncedAt: '2026-08-07T12:00:00Z' }))
      .toEqual({ ok: true, applied: false })
    expect(await recordTicketMessageDelivery(db, {
      RecordType: 'SpamComplaint', MessageID: 'pm-ticket-1', BouncedAt: '2026-08-07T13:00:00Z',
    })).toEqual({ ok: true, applied: false })

    expect(row.delivery_status).toBe('bounced')
    expect(row.delivery_status_at).toBe('2026-08-07T09:00:00.000Z')
  })

  it('a complaint upgrades a delivery, and a later delivery cannot undo it', async () => {
    const row = { ...TICKET_MSG(), delivery_status: 'delivered' }
    const db = makeDb({ rows: [row] })

    expect(await recordTicketMessageDelivery(db, {
      RecordType: 'SpamComplaint', MessageID: 'pm-ticket-1',
    })).toEqual({ ok: true, applied: true })
    expect(row.delivery_status).toBe('complained')

    expect(await recordTicketMessageDelivery(db, {
      RecordType: 'Delivery', MessageID: 'pm-ticket-1',
    })).toEqual({ ok: true, applied: false })
    expect(row.delivery_status).toBe('complained')
  })
})

describe('recordTicketMessageDelivery — failure is loud but never fatal', () => {
  it('reports a query error and logs it, rather than throwing', async () => {
    // POSTMARK-DLQ.1: failing the EVENT here would dead-letter a real bounce
    // over a display column. The caller ignores the verdict by design; the log
    // is what makes it discoverable.
    const db = makeDb({ rows: [TICKET_MSG()], error: { message: 'column "delivery_status" does not exist' } })

    const r = await recordTicketMessageDelivery(db, { RecordType: 'Bounce', MessageID: 'pm-ticket-1' })

    expect(r.ok).toBe(false)
    expect(r.applied).toBe(false)
    expect(logError).toHaveBeenCalledWith('email-delivery-status', 'delivery stamp failed', expect.objectContaining({
      messageId: 'pm-ticket-1',
      status: 'bounced',
    }))
  })

  it('swallows a thrown client error', async () => {
    const db = { from() { throw new Error('client exploded') } }
    const r = await recordTicketMessageDelivery(db, { RecordType: 'Delivery', MessageID: 'pm-ticket-1' })
    expect(r.ok).toBe(false)
    expect(logError).toHaveBeenCalledWith('email-delivery-status', 'delivery stamp threw', expect.anything())
  })
})
