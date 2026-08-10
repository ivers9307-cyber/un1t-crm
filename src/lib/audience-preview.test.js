// FILTER-B.5 — the preview returns customer PII, so it returns as little of
// it as will still let an operator recognise the people they are about to
// message. Name in full (recognition is the whole point); the identifier
// masked (this is a check, not an export — an export is a different feature
// with different consent implications and is deliberately not built here).

import { describe, it, expect } from 'vitest'
import { maskEmail, maskPhone, toPreviewRow, PREVIEW_PAGE_SIZE, PREVIEW_MAX_PAGE_SIZE } from './audience-preview'

describe('maskEmail', () => {
  it('keeps enough to recognise a known contact and no more', () => {
    expect(maskEmail('richard@example.com')).toBe('ri•••@example.com')
  })

  it('never leaks a short local part in full', () => {
    expect(maskEmail('a@example.com')).toBe('•••@example.com')
    expect(maskEmail('ab@example.com')).toBe('a•••@example.com')
  })

  it('keeps the domain, which is what makes a wrong audience obvious', () => {
    expect(maskEmail('someone@un1tdublin.com')).toBe('so•••@un1tdublin.com')
  })

  it('returns null for anything that is not an email', () => {
    expect(maskEmail(null)).toBeNull()
    expect(maskEmail('')).toBeNull()
    expect(maskEmail('not-an-email')).toBeNull()
  })
})

describe('maskPhone', () => {
  it('keeps only the last four digits', () => {
    expect(maskPhone('+353871234567')).toBe('•••• 4567')
    expect(maskPhone('0871234567')).toBe('•••• 4567')
  })

  it('does not pretend to mask a number too short to mask', () => {
    expect(maskPhone('123')).toBe('••••')
  })

  it('returns null for a missing number', () => {
    expect(maskPhone(null)).toBeNull()
    expect(maskPhone('')).toBeNull()
  })
})

describe('toPreviewRow picks the identifier the CHANNEL would actually use', () => {
  const ROW = {
    id: 'c1', name: 'Richard Ivers', first_name: 'Richard', last_name: 'Ivers',
    email: 'richard@example.com', phone: '+353871234567', wa_phone: '+353879999111',
    pipeline_stage_slug: 'member',
  }

  it('email -> the masked email address', () => {
    expect(toPreviewRow(ROW, 'email')).toEqual({
      id: 'c1', name: 'Richard Ivers', stage: 'member',
      identifier: 'ri•••@example.com', identifier_kind: 'email',
    })
  })

  it('sms -> the masked phone', () => {
    expect(toPreviewRow(ROW, 'sms').identifier).toBe('•••• 4567')
    expect(toPreviewRow(ROW, 'sms').identifier_kind).toBe('phone')
  })

  it('whatsapp -> the masked wa_phone, NOT the ordinary phone column', () => {
    // wa_phone !== phone for a real slice of the base (WA-BROADCAST
    // reachability); showing `phone` here would preview a different audience
    // than the one WhatsApp will message.
    expect(toPreviewRow(ROW, 'whatsapp').identifier).toBe('•••• 9111')
    expect(toPreviewRow(ROW, 'whatsapp').identifier_kind).toBe('wa_phone')
  })

  it('no channel (a sequence match set) -> the masked email as the human handle', () => {
    expect(toPreviewRow(ROW, null).identifier_kind).toBe('email')
  })

  it('falls back to first/last name when the denormalised name is blank', () => {
    expect(toPreviewRow({ ...ROW, name: null }, 'email').name).toBe('Richard Ivers')
    expect(toPreviewRow({ ...ROW, name: null, first_name: null, last_name: null }, 'email').name)
      .toBe('(no name)')
  })

  it('emits NOTHING beyond id, name, stage and the one masked identifier', () => {
    const keys = Object.keys(toPreviewRow(ROW, 'email')).sort()
    expect(keys).toEqual(['id', 'identifier', 'identifier_kind', 'name', 'stage'])
  })
})

describe('page size', () => {
  it('defaults to the ~50 the spec asks for and refuses to go higher', () => {
    expect(PREVIEW_PAGE_SIZE).toBe(50)
    expect(PREVIEW_MAX_PAGE_SIZE).toBe(50)
  })
})
