// RADAR-AGENT — unit tests for the Instagram pure helper.
import { describe, it, expect } from 'vitest'
import { parseInstagramEvents } from './instagram'
import { mediaRenderKind } from '@shared/whatsapp-media'

const baseEntry = (messaging) => ({ object: 'instagram', entry: [{ id: 'IGBIZ1', messaging }] })

describe('parseInstagramEvents', () => {
  it('returns [] for non-instagram payloads', () => {
    expect(parseInstagramEvents({ object: 'page', entry: [] })).toEqual([])
    expect(parseInstagramEvents(null)).toEqual([])
    expect(parseInstagramEvents({})).toEqual([])
  })

  it('extracts an inbound DM: account = our biz id, customer = sender', () => {
    const body = baseEntry([{
      sender: { id: 'CUST1' },
      recipient: { id: 'IGBIZ1' },
      timestamp: 1717200000000,
      message: { mid: 'm1', text: 'how much is membership?' },
    }])
    const out = parseInstagramEvents(body)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      accountId: 'IGBIZ1',
      customerId: 'CUST1',
      messageId: 'm1',
      text: 'how much is membership?',
      type: 'text',
      isEcho: false,
    })
  })

  it('uses entry.id as the account anchor (webhook owner is always our biz)', () => {
    const body = baseEntry([{ sender: { id: 'C' }, message: { mid: 'm', text: 'hi' } }])
    expect(parseInstagramEvents(body)[0].accountId).toBe('IGBIZ1')
  })

  it('echo: mirror-imaged — account = our biz id (entry.id), customer = recipient', () => {
    // A message WE sent (native IG app or CRM), echoed back by Meta.
    const body = baseEntry([{
      sender: { id: 'IGBIZ1' }, recipient: { id: 'CUST1' },
      message: { mid: 'm2', text: 'our reply', is_echo: true },
    }])
    expect(parseInstagramEvents(body)[0]).toMatchObject({
      accountId: 'IGBIZ1',
      customerId: 'CUST1',
      messageId: 'm2',
      isEcho: true,
    })
  })

  it('ignores delivery/read/reaction events (no message)', () => {
    const body = baseEntry([
      { sender: { id: 'C' }, recipient: { id: 'IGBIZ1' }, read: { mid: 'x' } },
      { sender: { id: 'C' }, recipient: { id: 'IGBIZ1' }, delivery: { mids: ['y'] } },
    ])
    expect(parseInstagramEvents(body)).toEqual([])
  })

  it('captures an image attachment: type = image + mediaUrl from payload', () => {
    const body = baseEntry([{
      sender: { id: 'C' }, recipient: { id: 'IGBIZ1' },
      message: { mid: 'm3', attachments: [{ type: 'image', payload: { url: 'https://lookaside.fbsbx.com/a.jpg' } }] },
    }])
    const out = parseInstagramEvents(body)
    expect(out[0]).toMatchObject({ type: 'image', mediaUrl: 'https://lookaside.fbsbx.com/a.jpg', text: '' })
  })

  it('maps video / audio / file attachment types to render kinds', () => {
    const kinds = [
      ['video', 'video'],
      ['audio', 'audio'],
      ['file', 'document'], // IG "file" → document so mediaRenderKind → file
    ]
    for (const [igType, expected] of kinds) {
      const body = baseEntry([{
        sender: { id: 'C' }, recipient: { id: 'IGBIZ1' },
        message: { mid: `m-${igType}`, attachments: [{ type: igType, payload: { url: `u-${igType}` } }] },
      }])
      const out = parseInstagramEvents(body)
      expect(out[0]).toMatchObject({ type: expected, mediaUrl: `u-${igType}` })
    }
  })

  it('keeps the caption text when an attachment also carries text', () => {
    const body = baseEntry([{
      sender: { id: 'C' }, recipient: { id: 'IGBIZ1' },
      message: { mid: 'm4', text: 'check this out', attachments: [{ type: 'image', payload: { url: 'x' } }] },
    }])
    const out = parseInstagramEvents(body)
    expect(out[0]).toMatchObject({ type: 'image', mediaUrl: 'x', text: 'check this out' })
  })

  it('takes the first attachment when several are present (one media per message)', () => {
    const body = baseEntry([{
      sender: { id: 'C' }, recipient: { id: 'IGBIZ1' },
      message: { mid: 'm5', attachments: [
        { type: 'image', payload: { url: 'first' } },
        { type: 'image', payload: { url: 'second' } },
      ] },
    }])
    expect(parseInstagramEvents(body)[0].mediaUrl).toBe('first')
  })

  it('non-media attachment (story_mention/share) keeps its raw type and does not render as media', () => {
    const body = baseEntry([{
      sender: { id: 'C' }, recipient: { id: 'IGBIZ1' },
      message: { mid: 'm6', attachments: [{ type: 'story_mention', payload: { url: 'sm' } }] },
    }])
    const out = parseInstagramEvents(body)
    expect(out[0].type).toBe('story_mention')
    expect(mediaRenderKind(out[0].type)).toBeNull()
  })

  it('text messages carry no media', () => {
    const body = baseEntry([{ sender: { id: 'C' }, recipient: { id: 'IGBIZ1' }, message: { mid: 'm7', text: 'hi' } }])
    expect(parseInstagramEvents(body)[0]).toMatchObject({ type: 'text', mediaUrl: null })
  })

  it('handles multiple entries and events in order', () => {
    const body = {
      object: 'instagram',
      entry: [
        { id: 'A', messaging: [{ sender: { id: 'c1' }, recipient: { id: 'A' }, message: { mid: '1', text: 'one' } }] },
        { id: 'B', messaging: [{ sender: { id: 'c2' }, recipient: { id: 'B' }, message: { mid: '2', text: 'two' } }] },
      ],
    }
    const out = parseInstagramEvents(body)
    expect(out.map(e => e.text)).toEqual(['one', 'two'])
    expect(out.map(e => e.accountId)).toEqual(['A', 'B'])
  })
})
