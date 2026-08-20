// POSTMARK-RACE.1 — the correlation marker, and the two populations it exists
// to separate.
//
// Prod, 21 days, Delivery events only:
//   • 3,231 processed BEFORE their email_sends row committed → ALL 3,231 lost
//     their delivery (delivered_at NULL on every one)
//   •   655 for mail that never gets an email_sends row at all → correctly
//     ignored, and must STAY ignored: 378 of them are ops-alert crons and 277
//     are host campaigns / campaign test sends, all of which carry Metadata.
//
// That last number is the whole reason this module exists rather than a
// `body.Metadata` truthiness check: "has metadata" is wrong in both
// directions (277 false positives, and 72 genuinely-ours events with none).

import { describe, it, expect } from 'vitest'
import {
  withSendMarker,
  expectsEmailSendRow,
  readSendMarker,
  sendMarkerAgeMs,
  SEND_MARKER_KEY,
  SEND_MARKER_RACE_WINDOW_MS,
  SEND_ROW_NOT_YET_COMMITTED,
} from './postmark-send-marker.js'

const T0 = Date.UTC(2026, 7, 19, 12, 0, 0)

describe('withSendMarker', () => {
  it('adds the send instant to an empty metadata object', () => {
    expect(withSendMarker({}, T0)).toEqual({ [SEND_MARKER_KEY]: String(T0) })
  })

  it('preserves the caller’s existing metadata', () => {
    expect(withSendMarker({ campaign_id: 'camp1', contact_id: 'c1' }, T0)).toEqual({
      campaign_id: 'camp1',
      contact_id: 'c1',
      [SEND_MARKER_KEY]: String(T0),
    })
  })

  it('never mutates the object it was handed', () => {
    const original = { campaign_id: 'camp1' }
    withSendMarker(original)
    expect(original).toEqual({ campaign_id: 'camp1' })
  })

  it('stays inside Postmark’s metadata limits (20-char key, 80-char value)', () => {
    const value = withSendMarker({}, T0)[SEND_MARKER_KEY]
    expect(SEND_MARKER_KEY.length).toBeLessThanOrEqual(20)
    expect(value.length).toBeLessThanOrEqual(80)
    expect(typeof value).toBe('string')
  })

  it('tolerates null/undefined metadata rather than throwing on a send path', () => {
    expect(withSendMarker(null, T0)).toEqual({ [SEND_MARKER_KEY]: String(T0) })
    expect(withSendMarker(undefined, T0)).toEqual({ [SEND_MARKER_KEY]: String(T0) })
  })
})

describe('expectsEmailSendRow — round trip', () => {
  it('recognises a payload whose Metadata came from withSendMarker', () => {
    expect(expectsEmailSendRow({ Metadata: withSendMarker({ campaign_id: 'camp1' }) })).toBe(true)
  })
})

// ── POSTMARK-RACE.2 — the marker says WHEN, so "coming" and "gone" separate ──
//
// email_sends.contact_id is ON DELETE CASCADE (verified on prod), and deleting
// a contact is the estate's routine GDPR-erasure action. Open/Click webhooks
// arrive p50 1.9h, p95 6.8 days and max 44.4 days after the send (n=5,189 over
// 60 days). So "marked send → contact erased → a late Open lands" is reachable,
// and a timeless marker made it indistinguishable from a 13-second race: five
// retries and a dead-letter row saying `send_row_not_yet_committed`, which is
// false about an event that is correctly unrecordable.
describe('expectsEmailSendRow — the race window', () => {
  const marked = (at) => ({ Metadata: withSendMarker({}, at) })

  it('defers a marker stamped one second ago', () => {
    expect(expectsEmailSendRow(marked(T0 - 1_000), T0)).toBe(true)
  })

  it('defers at the worst commit lag ever measured on prod (13.2s)', () => {
    expect(expectsEmailSendRow(marked(T0 - 13_200), T0)).toBe(true)
  })

  it('stops deferring once the marker is older than the window', () => {
    expect(expectsEmailSendRow(marked(T0 - SEND_MARKER_RACE_WINDOW_MS - 1), T0)).toBe(false)
  })

  it('does NOT defer a 44-day-old Open for an erased contact', () => {
    expect(expectsEmailSendRow(marked(T0 - 44 * 24 * 3600_000), T0)).toBe(false)
  })

  it('defers a marker stamped in the future — clock skew lands on the safe side', () => {
    expect(expectsEmailSendRow(marked(T0 + 30_000), T0)).toBe(true)
  })

  // The rule may only ever get STRICTER than the timeless behaviour it
  // replaced. An unreadable marker therefore still defers: '1' is what the
  // first cut of this module stamped, so an in-flight message from the previous
  // deploy must not start being dropped.
  it.each([
    ['the legacy constant marker', '1'],
    ['a non-numeric value', 'yes'],
    ['a value that is not a plausible instant', '0'],
  ])('%s has no readable instant and still defers', (_label, value) => {
    expect(expectsEmailSendRow({ Metadata: { [SEND_MARKER_KEY]: value } }, T0)).toBe(true)
    expect(sendMarkerAgeMs({ Metadata: { [SEND_MARKER_KEY]: value } }, T0)).toBeNull()
  })

  it('reports the age of a readable marker for the drop log', () => {
    expect(sendMarkerAgeMs(marked(T0 - 90_000), T0)).toBe(90_000)
  })

  it('separates "no marker" from "marker with no readable instant"', () => {
    expect(readSendMarker({ Metadata: {} })).toEqual({ present: false, sentAt: null })
    expect(readSendMarker({ Metadata: { [SEND_MARKER_KEY]: 'yes' } })).toEqual({ present: true, sentAt: null })
    expect(readSendMarker(marked(T0))).toEqual({ present: true, sentAt: T0 })
  })
})

describe('expectsEmailSendRow — the (b) population must stay unmarked', () => {
  // These are the real shapes measured in postmark_webhook_queue. Each one is
  // mail this system deliberately never writes an email_sends row for; a true
  // here would put it on the retry path and eventually in the dead-letter
  // table, manufacturing junk out of legitimate noise.
  it.each([
    ['an ops alert cron with no metadata at all', { Tag: 'cron.health-check', Metadata: {} }],
    ['a fleet-health alert', { Tag: 'fleet-health', Metadata: {} }],
    ['a host campaign, which keeps its own host_campaign_sends ledger', {
      Tag: 'host-campaign',
      Metadata: { host_id: 'h1', host_campaign_id: 'hc1', contact_id: 'c1' },
    }],
    ['a campaign TEST send', { Tag: 'campaign-test-abc', Metadata: { campaign_id: 'abc' } }],
    ['a payload with no Metadata key whatsoever', { Tag: 'morning-briefing' }],
    ['a payload whose Metadata is null', { Metadata: null }],
    ['a payload whose Metadata is an array', { Metadata: ['crm_send'] }],
    ['a payload whose Metadata is a string', { Metadata: 'crm_send' }],
    ['a marker set to an empty string', { Metadata: { [SEND_MARKER_KEY]: '' } }],
    ['a marker set to whitespace', { Metadata: { [SEND_MARKER_KEY]: '  ' } }],
    ['no payload at all', null],
    ['undefined', undefined],
  ])('%s is NOT ours', (_label, body) => {
    expect(expectsEmailSendRow(body)).toBe(false)
  })

  it('accepts a numeric instant — Postmark stringifies metadata, but a caller might not', () => {
    expect(expectsEmailSendRow({ Metadata: { [SEND_MARKER_KEY]: T0 - 5_000 } }, T0)).toBe(true)
  })
})

describe('SEND_ROW_NOT_YET_COMMITTED', () => {
  it('is a stable string the queue layer can compare against', () => {
    // postmark-queue.js keys the deferred/failed split off this exact value;
    // renaming it without updating that comparison would silently restore the
    // 500-response behaviour, so the constant is pinned here.
    expect(SEND_ROW_NOT_YET_COMMITTED).toBe('send_row_not_yet_committed')
  })
})
