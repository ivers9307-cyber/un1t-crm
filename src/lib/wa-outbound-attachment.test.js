// WAATTACH.1 — the rules for a photo or PDF sent from the WhatsApp inbox.
import { describe, it, expect } from 'vitest'
import {
  WA_ATTACHMENT_RULES, WA_ATTACHMENT_ACCEPT, WA_ATTACHMENT_TEXT,
  judgeWaAttachment, buildWaAttachmentPath, parseWaAttachmentPath, waAttachmentFileName,
} from './wa-outbound-attachment.js'

const MB = 1024 * 1024
const LOC = 'a0000000-0000-0000-0000-000000000001'
const CONV = '11111111-1111-4111-8111-111111111111'
const OTHER_CONV = '22222222-2222-4222-8222-222222222222'
const ID = '33333333-3333-4333-8333-333333333333'

describe('judgeWaAttachment', () => {
  it('accepts JPEG and PNG photos up to 5 MB and PDFs up to 16 MB', () => {
    expect(judgeWaAttachment({ mime: 'image/jpeg', size: 5 * MB })).toEqual({ ok: true, contentType: 'image/jpeg', kind: 'image', ext: 'jpg' })
    expect(judgeWaAttachment({ mime: 'image/png', size: 1 })).toMatchObject({ ok: true, kind: 'image', ext: 'png' })
    expect(judgeWaAttachment({ mime: 'application/pdf', size: 16 * MB })).toMatchObject({ ok: true, kind: 'document', ext: 'pdf' })
  })

  it('reads a type with parameters and any case', () => {
    expect(judgeWaAttachment({ mime: 'Image/JPEG; charset=binary', size: 10 })).toMatchObject({ ok: true, contentType: 'image/jpeg' })
  })

  it('refuses a photo over 5 MB and a PDF over 16 MB', () => {
    expect(judgeWaAttachment({ mime: 'image/jpeg', size: 5 * MB + 1 })).toEqual({ ok: false, error: WA_ATTACHMENT_TEXT.imageTooBig })
    expect(judgeWaAttachment({ mime: 'application/pdf', size: 16 * MB + 1 })).toEqual({ ok: false, error: WA_ATTACHMENT_TEXT.documentTooBig })
  })

  it('refuses other types, an empty file and a size that is not a number', () => {
    for (const mime of ['image/gif', 'image/webp', 'image/heic', 'video/mp4', 'text/html', '', 'application/msword']) {
      expect(judgeWaAttachment({ mime, size: 10 })).toEqual({ ok: false, error: WA_ATTACHMENT_TEXT.type })
    }
    expect(judgeWaAttachment({ mime: 'image/png', size: 0 })).toEqual({ ok: false, error: WA_ATTACHMENT_TEXT.empty })
    expect(judgeWaAttachment({ mime: 'image/png', size: 'big' })).toEqual({ ok: false, error: WA_ATTACHMENT_TEXT.empty })
  })

  it('offers exactly the accepted types to the file picker', () => {
    expect(WA_ATTACHMENT_ACCEPT.split(',').sort()).toEqual(Object.keys(WA_ATTACHMENT_RULES).sort())
  })
})

describe('attachment slots', () => {
  it('lives under the studio, then outbound, then the conversation', () => {
    expect(buildWaAttachmentPath({ locationId: LOC, conversationId: CONV, id: ID, ext: 'pdf' }))
      .toBe(`${LOC}/outbound/${CONV}/${ID}.pdf`)
    expect(() => buildWaAttachmentPath({ locationId: LOC, conversationId: CONV, id: ID })).toThrow()
  })

  it('parses a slot of this conversation at this studio, with the type its extension names', () => {
    const path = buildWaAttachmentPath({ locationId: LOC, conversationId: CONV, id: ID, ext: 'jpg' })
    expect(parseWaAttachmentPath(path, { locationId: LOC, conversationId: CONV }))
      .toEqual({ ext: 'jpg', contentType: 'image/jpeg', kind: 'image' })
  })

  it('refuses another thread, another studio, traversal, a chosen name and another extension', () => {
    const scope = { locationId: LOC, conversationId: CONV }
    expect(parseWaAttachmentPath(`${LOC}/outbound/${OTHER_CONV}/${ID}.pdf`, scope)).toBeNull()
    expect(parseWaAttachmentPath(`b0000000-0000-0000-0000-000000000002/outbound/${CONV}/${ID}.pdf`, scope)).toBeNull()
    expect(parseWaAttachmentPath(`${LOC}/outbound/${CONV}/../${ID}.pdf`, scope)).toBeNull()
    expect(parseWaAttachmentPath(`${LOC}/outbound/${CONV}/invoice.pdf`, scope)).toBeNull()
    expect(parseWaAttachmentPath(`${LOC}/outbound/${CONV}/${ID}.gif`, scope)).toBeNull()
    expect(parseWaAttachmentPath(`${LOC}/${ID}.pdf`, scope)).toBeNull()
    expect(parseWaAttachmentPath(null, scope)).toBeNull()
    expect(parseWaAttachmentPath(`${LOC}/outbound/${CONV}/${ID}.pdf`, { locationId: LOC })).toBeNull()
  })
})

describe('waAttachmentFileName', () => {
  it('keeps the picked name, drops folders and control characters, and ends in .pdf', () => {
    expect(waAttachmentFileName('Timetable Nov.pdf')).toBe('Timetable Nov.pdf')
    expect(waAttachmentFileName('C:\\Users\\x\\Price list')).toBe('Price list.pdf')
    expect(waAttachmentFileName('a\u0000b.PDF')).toBe('ab.PDF')
    expect(waAttachmentFileName('')).toBe('document.pdf')
    expect(waAttachmentFileName(undefined)).toBe('document.pdf')
  })
})
