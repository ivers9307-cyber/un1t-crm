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
  SEND_MARKER_KEY,
  SEND_MARKER_VALUE,
  SEND_ROW_NOT_YET_COMMITTED,
} from './postmark-send-marker.js'

describe('withSendMarker', () => {
  it('adds the marker to an empty metadata object', () => {
    expect(withSendMarker()).toEqual({ [SEND_MARKER_KEY]: SEND_MARKER_VALUE })
  })

  it('preserves the caller’s existing metadata', () => {
    expect(withSendMarker({ campaign_id: 'camp1', contact_id: 'c1' })).toEqual({
      campaign_id: 'camp1',
      contact_id: 'c1',
      [SEND_MARKER_KEY]: SEND_MARKER_VALUE,
    })
  })

  it('never mutates the object it was handed', () => {
    const original = { campaign_id: 'camp1' }
    withSendMarker(original)
    expect(original).toEqual({ campaign_id: 'camp1' })
  })

  it('stays inside Postmark’s metadata limits (20-char key, 80-char value)', () => {
    expect(SEND_MARKER_KEY.length).toBeLessThanOrEqual(20)
    expect(SEND_MARKER_VALUE.length).toBeLessThanOrEqual(80)
    expect(typeof SEND_MARKER_VALUE).toBe('string')
  })

  it('tolerates null/undefined metadata rather than throwing on a send path', () => {
    expect(withSendMarker(null)).toEqual({ [SEND_MARKER_KEY]: SEND_MARKER_VALUE })
    expect(withSendMarker(undefined)).toEqual({ [SEND_MARKER_KEY]: SEND_MARKER_VALUE })
  })
})

describe('expectsEmailSendRow — round trip', () => {
  it('recognises a payload whose Metadata came from withSendMarker', () => {
    expect(expectsEmailSendRow({ Metadata: withSendMarker({ campaign_id: 'camp1' }) })).toBe(true)
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
    ['a marker with the wrong value', { Metadata: { [SEND_MARKER_KEY]: '0' } }],
    ['a marker set to an empty string', { Metadata: { [SEND_MARKER_KEY]: '' } }],
    ['no payload at all', null],
    ['undefined', undefined],
  ])('%s is NOT ours', (_label, body) => {
    expect(expectsEmailSendRow(body)).toBe(false)
  })

  it('accepts a numeric 1 — Postmark stringifies metadata, but a caller might not', () => {
    expect(expectsEmailSendRow({ Metadata: { [SEND_MARKER_KEY]: 1 } })).toBe(true)
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
