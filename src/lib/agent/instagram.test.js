// RADAR-AGENT — unit tests for the Instagram pure helper.
import { describe, it, expect } from 'vitest'
import { parseInstagramEvents } from './instagram'

const baseEntry = (messaging) => ({ object: 'instagram', entry: [{ id: 'IGBIZ1', messaging }] })

describe('parseInstagramEvents', () => {
  it('returns [] for non-instagram payloads', () => {
    expect(parseInstagramEvents({ object: 'page', entry: [] })).toEqual([])
    expect(parseInstagramEvents(null)).toEqual([])
    expect(parseInstagramEvents({})).toEqual([])
  })

  it('extracts a text DM with sender, recipient, mid', () => {
    const body = baseEntry([{
      sender: { id: 'CUST1' },
      recipient: { id: 'IGBIZ1' },
      timestamp: 1717200000000,
      message: { mid: 'm1', text: 'how much is membership?' },
    }])
    const out = parseInstagramEvents(body)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      recipientAccountId: 'IGBIZ1',
      senderId: 'CUST1',
      messageId: 'm1',
      text: 'how much is membership?',
      type: 'text',
      isEcho: false,
    })
  })

  it('falls back to entry.id when recipient is absent', () => {
    const body = baseEntry([{ sender: { id: 'C' }, message: { mid: 'm', text: 'hi' } }])
    expect(parseInstagramEvents(body)[0].recipientAccountId).toBe('IGBIZ1')
  })

  it('flags echoes (our own outbound) so they can be skipped', () => {
    const body = baseEntry([{
      sender: { id: 'IGBIZ1' }, recipient: { id: 'CUST1' },
      message: { mid: 'm2', text: 'our reply', is_echo: true },
    }])
    expect(parseInstagramEvents(body)[0].isEcho).toBe(true)
  })

  it('ignores delivery/read/reaction events (no message)', () => {
    const body = baseEntry([
      { sender: { id: 'C' }, recipient: { id: 'IGBIZ1' }, read: { mid: 'x' } },
      { sender: { id: 'C' }, recipient: { id: 'IGBIZ1' }, delivery: { mids: ['y'] } },
    ])
    expect(parseInstagramEvents(body)).toEqual([])
  })

  it('marks attachment-only messages as type attachment', () => {
    const body = baseEntry([{
      sender: { id: 'C' }, recipient: { id: 'IGBIZ1' },
      message: { mid: 'm3', attachments: [{ type: 'image', payload: { url: 'x' } }] },
    }])
    const out = parseInstagramEvents(body)
    expect(out[0].type).toBe('attachment')
    expect(out[0].text).toBe('')
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
    expect(out.map(e => e.recipientAccountId)).toEqual(['A', 'B'])
  })
})
