// WATPLPUT.1 — the field policy for PUT /api/whatsapp/templates/[id].
import { describe, it, expect } from 'vitest'
import {
  META_OWNED_FIELDS, CONTENT_FIELDS, LOCAL_FIELDS, isTemplateSubmitted, lockedFieldsIn,
} from './whatsapp-template-fields.js'

describe('isTemplateSubmitted', () => {
  it.each([
    ['no row', null, false],
    ['a draft', { status: 'draft', meta_template_id: null }, false],
    ['no status and no Meta id (the column default never ran)', { status: null, meta_template_id: null }, false],
    ['PENDING', { status: 'PENDING', meta_template_id: 'm1' }, true],
    ['APPROVED', { status: 'APPROVED', meta_template_id: 'm1' }, true],
    ['REJECTED', { status: 'REJECTED', meta_template_id: 'm1' }, true],
    ['PAUSED', { status: 'PAUSED', meta_template_id: 'm1' }, true],
    ['a status Meta added later (DISABLED)', { status: 'DISABLED', meta_template_id: 'm1' }, true],
    ['a Meta id on a row still reading draft', { status: 'draft', meta_template_id: 'm1' }, true],
  ])('%s → %s', (_label, row, expected) => {
    expect(isTemplateSubmitted(row)).toBe(expected)
  })
})

describe('lockedFieldsIn', () => {
  const APPROVED = { status: 'APPROVED', meta_template_id: 'm1' }
  const PENDING = { status: 'PENDING', meta_template_id: 'm1' }
  const DRAFT = { status: 'draft', meta_template_id: null }

  it('a draft: nothing is locked', () => {
    const all = Object.fromEntries(CONTENT_FIELDS.map((k) => [k, 'x']))
    expect(lockedFieldsIn({ ...all, display_group: 'Offers' }, DRAFT)).toEqual([])
  })

  it('a submitted template: every content field is locked, in a fixed order', () => {
    expect(lockedFieldsIn({ header_media_url: 'u', components: [], name: 'n' }, PENDING))
      .toEqual(['name', 'components', 'header_media_url'])
  })

  it('an APPROVED template: the header media is locked like the rest of the content', () => {
    expect(lockedFieldsIn({ header_media_url: 'u', header_media_path: 'p', header_media_handle: 'h', components: [], name: 'n' }, APPROVED))
      .toEqual(['name', 'components', 'header_media_handle', 'header_media_url', 'header_media_path'])
    expect(lockedFieldsIn({ header_media_url: null }, APPROVED)).toEqual(['header_media_url'])
  })

  it('a submitted template: display_group alone is not locked', () => {
    expect(lockedFieldsIn({ display_group: 'Offers' }, APPROVED)).toEqual([])
  })

  it('a key present with null still counts (clearing the header image is a change)', () => {
    expect(lockedFieldsIn({ header_media_url: null }, PENDING)).toEqual(['header_media_url'])
  })

  it('the three lists do not overlap, status is Meta-owned, and header media is content', () => {
    const all = [...META_OWNED_FIELDS, ...CONTENT_FIELDS, ...LOCAL_FIELDS]
    expect(new Set(all).size).toBe(all.length)
    expect(META_OWNED_FIELDS).toContain('status')
    for (const k of ['header_media_handle', 'header_media_url', 'header_media_path']) expect(CONTENT_FIELDS).toContain(k)
  })
})
