import { describe, it, expect } from 'vitest'
import {
  extFromMime,
  looksLikeMetaMediaId,
  mediaRenderKind,
  resolveMediaExternalId,
  isServableMedia,
  buildMediaObjectPath,
  mediaProxyPath,
  WHATSAPP_MEDIA_BUCKET,
} from './whatsapp-media.js'

describe('extFromMime', () => {
  it('maps known mimes', () => {
    expect(extFromMime('image/jpeg')).toBe('jpg')
    expect(extFromMime('image/png')).toBe('png')
    expect(extFromMime('application/pdf')).toBe('pdf')
    expect(extFromMime('audio/ogg')).toBe('ogg')
  })
  it('strips parameters and is case-insensitive', () => {
    expect(extFromMime('image/jpeg; codecs=foo')).toBe('jpg')
    expect(extFromMime('IMAGE/PNG')).toBe('png')
  })
  it('derives a sane ext from unknown mimes and falls back to bin', () => {
    expect(extFromMime('image/heic')).toBe('heic')
    expect(extFromMime('')).toBe('bin')
    expect(extFromMime(null)).toBe('bin')
    expect(extFromMime('garbage')).toBe('bin')
  })
})

describe('looksLikeMetaMediaId', () => {
  it('accepts all-digit ids in range', () => {
    expect(looksLikeMetaMediaId('1554871089537157')).toBe(true)
    expect(looksLikeMetaMediaId(' 1554871089537157 ')).toBe(true)
  })
  it('rejects urls, paths, empties and short strings', () => {
    expect(looksLikeMetaMediaId('https://x/y.jpg')).toBe(false)
    expect(looksLikeMetaMediaId('a0000000-0000/123.jpg')).toBe(false)
    expect(looksLikeMetaMediaId('')).toBe(false)
    expect(looksLikeMetaMediaId(null)).toBe(false)
    expect(looksLikeMetaMediaId('123')).toBe(false)
  })
})

describe('mediaRenderKind', () => {
  it('classifies by message type', () => {
    expect(mediaRenderKind('image')).toBe('image')
    expect(mediaRenderKind('sticker')).toBe('image')
    expect(mediaRenderKind('video')).toBe('video')
    expect(mediaRenderKind('audio')).toBe('audio')
    expect(mediaRenderKind('voice')).toBe('audio')
  })
  it('classifies documents by mime', () => {
    expect(mediaRenderKind('document', 'image/png')).toBe('image')
    expect(mediaRenderKind('document', 'video/mp4')).toBe('video')
    expect(mediaRenderKind('document', 'application/pdf')).toBe('file')
    expect(mediaRenderKind('document', null)).toBe('file')
  })
  // IG-MEDIA.2 — an Instagram story mention carries the story frame, which can
  // be a photo or a video and the webhook doesn't say which, so it resolves by
  // MIME once re-hosting has recorded one. Null beforehand is deliberate: the
  // re-host is allowed through by type, not by this function.
  it('classifies an instagram story mention by mime', () => {
    expect(mediaRenderKind('story_mention', 'image/jpeg')).toBe('image')
    expect(mediaRenderKind('story_mention', 'video/mp4')).toBe('video')
    expect(mediaRenderKind('story_mention')).toBe(null)
    expect(mediaRenderKind('story_mention', 'application/octet-stream')).toBe(null)
  })
  it('returns null for non-media types', () => {
    expect(mediaRenderKind('text')).toBeNull()
    expect(mediaRenderKind('location')).toBeNull()
    expect(mediaRenderKind('interactive')).toBeNull()
    expect(mediaRenderKind(null)).toBeNull()
  })
})

describe('resolveMediaExternalId', () => {
  it('prefers the dedicated column', () => {
    expect(resolveMediaExternalId({ media_external_id: '1554871089537157' })).toBe('1554871089537157')
  })
  it('falls back to a legacy numeric media_url', () => {
    expect(resolveMediaExternalId({ media_url: '1554871089537157' })).toBe('1554871089537157')
  })
  it('ignores a media_url that is a storage path or url', () => {
    expect(resolveMediaExternalId({ media_url: 'a0000000/abc.jpg' })).toBeNull()
    expect(resolveMediaExternalId({ media_url: 'https://x/y.jpg' })).toBeNull()
  })
  it('returns null when nothing usable', () => {
    expect(resolveMediaExternalId({})).toBeNull()
    expect(resolveMediaExternalId(null)).toBeNull()
  })
})

describe('isServableMedia', () => {
  it('true when renderable and has storage path', () => {
    expect(isServableMedia({ message_type: 'image', media_storage_path: 'a0/x.jpg' })).toBe(true)
  })
  it('true when renderable and has a fetchable external id', () => {
    expect(isServableMedia({ message_type: 'image', media_url: '1554871089537157' })).toBe(true)
    expect(isServableMedia({ message_type: 'document', media_mime_type: 'image/png', media_external_id: '1554871089537157' })).toBe(true)
  })
  it('false for non-media even with an id', () => {
    expect(isServableMedia({ message_type: 'text', media_url: '1554871089537157' })).toBe(false)
  })
  it('false when renderable but nothing to fetch or serve', () => {
    expect(isServableMedia({ message_type: 'image' })).toBe(false)
  })
})

describe('buildMediaObjectPath', () => {
  it('namespaces by location and keys by message id + ext', () => {
    expect(buildMediaObjectPath({ locationId: 'a0000000', messageId: 'msg1', mime: 'image/jpeg' })).toBe('a0000000/msg1.jpg')
  })
  it('throws without the required parts', () => {
    expect(() => buildMediaObjectPath({ messageId: 'm' })).toThrow()
    expect(() => buildMediaObjectPath({ locationId: 'l' })).toThrow()
  })
})

describe('mediaProxyPath', () => {
  it('builds the api path', () => {
    expect(mediaProxyPath('abc')).toBe('/api/whatsapp/media/abc')
  })
})

describe('constants', () => {
  it('exposes the bucket name', () => {
    expect(WHATSAPP_MEDIA_BUCKET).toBe('whatsapp-media')
  })
})
