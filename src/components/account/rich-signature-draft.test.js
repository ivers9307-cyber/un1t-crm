// MAIL-SIG.1 — the branchable decisions behind the rich-signature editor,
// pinned as a pure lib so the component stays presentational.
//
// The contract on the other side is /api/me/preferences' zod schema
// (email_signature_rich, strict) and renderRichSignature() — the caps and
// the payload shape here MUST match those, so the server 400 is the rare
// path, not the validation.

import { describe, it, expect } from 'vitest'
import { MAX_SIGNATURE_LINKS, renderRichSignature } from '@/lib/email-signature'
import {
  RICH_FIELD_CAPS,
  PHOTO_ACCEPT,
  PHOTO_MAX_BYTES,
  emptyRichDraft,
  richDraftFromSaved,
  isEmptyLinkRow,
  linkRowError,
  canAddLink,
  richDraftErrors,
  buildRichPayload,
  payloadsEqual,
  photoFileError,
  richPreviewSrcDoc,
} from './rich-signature-draft'

describe('richDraftFromSaved', () => {
  it('null/undefined → a disabled empty draft', () => {
    for (const v of [null, undefined]) {
      const d = richDraftFromSaved(v)
      expect(d).toEqual(emptyRichDraft())
      expect(d.enabled).toBe(false)
      expect(d.links).toEqual([])
    }
  })

  it('fills missing fields with defaults and keeps saved values', () => {
    const d = richDraftFromSaved({ enabled: true, name: 'Sarah', links: [{ label: 'IG', url: 'https://x.com' }] })
    expect(d.enabled).toBe(true)
    expect(d.name).toBe('Sarah')
    expect(d.title).toBe('')
    expect(d.phone).toBe('')
    expect(d.note).toBe('')
    expect(d.photo_url).toBe(null)
    expect(d.links).toEqual([{ label: 'IG', url: 'https://x.com' }])
  })

  it('never aliases the saved links array (editing the draft must not mutate saved state)', () => {
    const saved = { enabled: true, links: [{ label: 'a', url: 'https://a.com' }] }
    const d = richDraftFromSaved(saved)
    d.links[0].label = 'changed'
    expect(saved.links[0].label).toBe('a')
  })
})

describe('link rows', () => {
  it('a row with neither label nor url is empty (dropped, never an error)', () => {
    expect(isEmptyLinkRow({ label: '', url: '' })).toBe(true)
    expect(isEmptyLinkRow({ label: '  ', url: ' ' })).toBe(true)
    expect(isEmptyLinkRow({ label: 'x', url: '' })).toBe(false)
    expect(isEmptyLinkRow({ label: '', url: 'https://x.com' })).toBe(false)
    expect(linkRowError({ label: '', url: '' })).toBe(null)
  })

  it('label without a url is an error — the server would 400 it', () => {
    expect(linkRowError({ label: 'Instagram', url: '' })).toMatch(/url/i)
  })

  it('non-http(s) and unparseable urls are errors; valid http(s) is not', () => {
    expect(linkRowError({ label: '', url: 'ftp://x.com' })).toMatch(/http/i)
    expect(linkRowError({ label: '', url: 'javascript:alert(1)' })).toMatch(/http/i)
    expect(linkRowError({ label: '', url: 'not a url' })).toMatch(/http/i)
    expect(linkRowError({ label: '', url: 'https://' })).toMatch(/http/i)
    expect(linkRowError({ label: '', url: 'https://instagram.com/un1t' })).toBe(null)
    expect(linkRowError({ label: '', url: 'HTTP://X.COM' })).toBe(null)
    expect(linkRowError({ label: '', url: '  https://x.com  ' })).toBe(null)
  })

  it('caps at MAX_SIGNATURE_LINKS rows', () => {
    const row = { label: '', url: 'https://x.com' }
    expect(canAddLink(Array(MAX_SIGNATURE_LINKS - 1).fill(row))).toBe(true)
    expect(canAddLink(Array(MAX_SIGNATURE_LINKS).fill(row))).toBe(false)
  })

  it('caps mirror the server zod caps exactly', () => {
    // /api/me/preferences: name 120, title 120, phone 60, note 200,
    // link label 40, link url 300. A drifted cap = avoidable 400s.
    expect(RICH_FIELD_CAPS).toEqual({
      name: 120, title: 120, phone: 60, note: 200, link_label: 40, link_url: 300,
    })
  })
})

describe('richDraftErrors', () => {
  it('flags only the broken rows, by index', () => {
    const draft = {
      ...emptyRichDraft(),
      enabled: true,
      links: [
        { label: '', url: 'https://ok.com' },
        { label: 'broken', url: 'ftp://no' },
        { label: '', url: '' }, // empty — dropped, not an error
      ],
    }
    const { valid, links } = richDraftErrors(draft)
    expect(valid).toBe(false)
    expect(links[0]).toBeUndefined()
    expect(links[1]).toMatch(/http/i)
    expect(links[2]).toBeUndefined()
  })

  it('a clean draft is valid', () => {
    expect(richDraftErrors(emptyRichDraft()).valid).toBe(true)
  })
})

describe('buildRichPayload', () => {
  it('trims every string, drops empty link rows, and nulls an unset photo', () => {
    const payload = buildRichPayload({
      enabled: true,
      name: '  Sarah Doyle ',
      title: ' Head Coach ',
      phone: ' 01 234 5678 ',
      note: '  Stillorgan  ',
      photo_url: '',
      links: [
        { label: ' IG ', url: ' https://instagram.com/un1t ' },
        { label: '', url: '' },
      ],
    })
    expect(payload).toEqual({
      enabled: true,
      name: 'Sarah Doyle',
      title: 'Head Coach',
      phone: '01 234 5678',
      note: 'Stillorgan',
      photo_url: null,
      links: [{ label: 'IG', url: 'https://instagram.com/un1t' }],
    })
  })

  it('enabled is a strict boolean and a set photo_url survives', () => {
    const url = 'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/signatures/u1/photo.jpg?t=1'
    expect(buildRichPayload({ ...emptyRichDraft(), enabled: 'yes', photo_url: url }))
      .toMatchObject({ enabled: false, photo_url: url })
  })

  it('never sends more than MAX_SIGNATURE_LINKS rows even if the draft holds more', () => {
    const links = Array(MAX_SIGNATURE_LINKS + 2).fill({ label: '', url: 'https://x.com' })
    expect(buildRichPayload({ ...emptyRichDraft(), links }).links).toHaveLength(MAX_SIGNATURE_LINKS)
  })
})

describe('payloadsEqual (dirty check)', () => {
  it('whitespace-only edits are not dirty; real edits are', () => {
    const a = buildRichPayload({ ...emptyRichDraft(), enabled: true, name: 'Sarah' })
    const b = buildRichPayload({ ...emptyRichDraft(), enabled: true, name: '  Sarah  ' })
    const c = buildRichPayload({ ...emptyRichDraft(), enabled: true, name: 'Sara' })
    expect(payloadsEqual(a, b)).toBe(true)
    expect(payloadsEqual(a, c)).toBe(false)
  })

  it('flipping the toggle alone is dirty', () => {
    const off = buildRichPayload(emptyRichDraft())
    const on = buildRichPayload({ ...emptyRichDraft(), enabled: true })
    expect(payloadsEqual(off, on)).toBe(false)
  })
})

describe('photoFileError', () => {
  const f = (type, size) => ({ type, size })
  it('mirrors the upload route: JPEG/PNG/WebP only, 2MB max', () => {
    expect(photoFileError(f('image/jpeg', 100))).toBe(null)
    expect(photoFileError(f('image/png', PHOTO_MAX_BYTES))).toBe(null)
    expect(photoFileError(f('image/webp', 100))).toBe(null)
    expect(photoFileError(f('image/gif', 100))).toMatch(/JPEG, PNG or WebP/)
    expect(photoFileError(f('application/pdf', 100))).toMatch(/JPEG, PNG or WebP/)
    expect(photoFileError(f('image/jpeg', PHOTO_MAX_BYTES + 1))).toMatch(/2MB/)
  })
  it('accept attr covers exactly the allowed types', () => {
    expect(PHOTO_ACCEPT.split(',').sort()).toEqual(['image/jpeg', 'image/png', 'image/webp'])
  })
})

describe('richPreviewSrcDoc', () => {
  it('embeds the SHARED renderer output — never its own markup', () => {
    const payload = buildRichPayload({
      ...emptyRichDraft(), enabled: true, name: 'Sarah <Doyle>',
      links: [{ label: 'IG', url: 'https://instagram.com/un1t' }],
    })
    const rendered = renderRichSignature(payload)
    const doc = richPreviewSrcDoc(payload)
    expect(doc).toContain(rendered.html)
    // Escaping is the renderer's — the angle brackets never appear raw.
    expect(doc).not.toContain('Sarah <Doyle>')
    expect(doc).toContain('Sarah &lt;Doyle&gt;')
  })

  it('nothing to render → null (the component shows a hint instead of an empty frame)', () => {
    expect(richPreviewSrcDoc(buildRichPayload({ ...emptyRichDraft(), enabled: true }))).toBe(null)
    expect(richPreviewSrcDoc(buildRichPayload(emptyRichDraft()))).toBe(null)
  })

  it('previews even while the toggle is off, so drafting shows what WOULD send', () => {
    const doc = richPreviewSrcDoc({ ...buildRichPayload(emptyRichDraft()), name: 'Sarah', enabled: false })
    expect(doc).toContain('Sarah')
  })
})
