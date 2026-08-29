// RADAR-AGENT — unit tests for the Instagram pure helpers.
import { describe, it, expect } from 'vitest'
import { parseInstagramEvents, isLowSignalInstagramEvent } from './instagram'
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

  // IG-MEDIA.2 — a story mention keeps its raw type (so the thread can say
  // what it was) but it IS media: the payload is the story frame itself, and
  // every gate on the media path asks mediaRenderKind, so it must not answer
  // null or the file never reaches our bucket and the IG CDN drops it within
  // about a day. This test previously asserted the opposite.
  it('story_mention keeps its raw type and stays on the media path', () => {
    const body = baseEntry([{
      sender: { id: 'C' }, recipient: { id: 'IGBIZ1' },
      message: { mid: 'm6', attachments: [{ type: 'story_mention', payload: { url: 'sm' } }] },
    }])
    const out = parseInstagramEvents(body)
    expect(out[0]).toMatchObject({ type: 'story_mention', mediaUrl: 'sm' })
    expect(mediaRenderKind(out[0].type)).toBe('file')            // before the mime is known
    expect(mediaRenderKind(out[0].type, 'image/jpeg')).toBe('image')  // after re-hosting
  })

  it('a share genuinely has no renderer and stays a placeholder', () => {
    const body = baseEntry([{
      sender: { id: 'C' }, recipient: { id: 'IGBIZ1' },
      message: { mid: 'm6b', attachments: [{ type: 'share', payload: { url: 'sh' } }] },
    }])
    const out = parseInstagramEvents(body)
    expect(out[0].type).toBe('share')
    expect(mediaRenderKind(out[0].type)).toBeNull()
  })

  it('text messages carry no media', () => {
    const body = baseEntry([{ sender: { id: 'C' }, recipient: { id: 'IGBIZ1' }, message: { mid: 'm7', text: 'hi' } }])
    expect(parseInstagramEvents(body)[0]).toMatchObject({ type: 'text', mediaUrl: null })
  })

  // IG-LOWSIG.1 — a reply to (or quick-reaction on) one of our stories
  // carries the story under message.reply_to; the low-signal predicate needs
  // the flag to tell an emoji-only story reaction from a real emoji answer.
  it('flags a story reply via message.reply_to.story', () => {
    const body = baseEntry([{
      sender: { id: 'C' }, recipient: { id: 'IGBIZ1' },
      message: { mid: 'm8', text: '🔥', reply_to: { story: { id: 's1', url: 'https://cdn.ig/story.jpg' } } },
    }])
    expect(parseInstagramEvents(body)[0]).toMatchObject({ type: 'text', text: '🔥', isStoryReply: true })
  })

  it('ordinary messages are not story replies', () => {
    const body = baseEntry([{ sender: { id: 'C' }, recipient: { id: 'IGBIZ1' }, message: { mid: 'm9', text: 'hi' } }])
    expect(parseInstagramEvents(body)[0].isStoryReply).toBe(false)
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

// IG-LOWSIG.1 — what counts as ambient social noise (recorded, never
// escalated) vs a genuine message. The load-bearing edge: any real words make
// it a genuine message again, because "saw your post, is this class on
// tonight?" arrives as a share + caption.
describe('isLowSignalInstagramEvent', () => {
  const ev = (over) => ({ accountId: 'A', customerId: 'C', messageId: 'm', text: '', type: 'text', mediaUrl: null, isEcho: false, isStoryReply: false, ...over })

  it('story mention with no text → low-signal', () => {
    expect(isLowSignalInstagramEvent(ev({ type: 'story_mention', mediaUrl: 'sm' }))).toBe(true)
  })

  it('shared post / reel with no caption → low-signal', () => {
    expect(isLowSignalInstagramEvent(ev({ type: 'share', mediaUrl: 'sh' }))).toBe(true)
    expect(isLowSignalInstagramEvent(ev({ type: 'reel', mediaUrl: 'r' }))).toBe(true)
    expect(isLowSignalInstagramEvent(ev({ type: 'ig_reel', mediaUrl: 'r' }))).toBe(true)
  })

  it('a share with real words attached is a genuine message', () => {
    expect(isLowSignalInstagramEvent(ev({ type: 'share', text: 'is this class still on tonight?' }))).toBe(false)
  })

  it('an emoji-only caption on a share stays low-signal', () => {
    expect(isLowSignalInstagramEvent(ev({ type: 'share', text: '🔥🔥' }))).toBe(true)
  })

  it('emoji-only story reply (quick reaction) → low-signal', () => {
    expect(isLowSignalInstagramEvent(ev({ isStoryReply: true, text: '❤️' }))).toBe(true)
  })

  it('story reply with typed words is a genuine message', () => {
    expect(isLowSignalInstagramEvent(ev({ isStoryReply: true, text: 'love this! when is the next one?' }))).toBe(false)
  })

  it('an emoji-only DM outside a story reply is NOT low-signal (can be a real answer)', () => {
    expect(isLowSignalInstagramEvent(ev({ text: '👍' }))).toBe(false)
  })

  it('plain text messages and echoes are never low-signal', () => {
    expect(isLowSignalInstagramEvent(ev({ text: 'how much is membership?' }))).toBe(false)
    expect(isLowSignalInstagramEvent(ev({ type: 'story_mention', isEcho: true }))).toBe(false)
    expect(isLowSignalInstagramEvent(null)).toBe(false)
  })

  it('non-Latin words count as words (digits too)', () => {
    expect(isLowSignalInstagramEvent(ev({ type: 'share', text: 'об этом' }))).toBe(false)
    expect(isLowSignalInstagramEvent(ev({ isStoryReply: true, text: '10' }))).toBe(false)
  })
})
