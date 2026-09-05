// Pins the send-time component shapes for media-header templates —
// specifically the (#132012) regression: a media-header template MUST
// ship a matching header parameter, falling back to the URL persisted
// on the template row when the caller has no per-send override.
import { describe, it, expect } from 'vitest'
import { buildTemplateComponents, resolveTemplateVariableValues } from './whatsapp.js'

const VIDEO_TEMPLATE = {
  name: 'consultation_booking',
  header_media_url: 'https://example.supabase.co/storage/v1/object/public/whatsapp-templates/loc/file.mp4',
  components: [
    { type: 'HEADER', format: 'VIDEO', example: { header_handle: ['4::abc'] } },
    { type: 'BODY', text: 'Hey {{1}}, welcome!' },
  ],
}

const contact = { first_name: 'Richard', name: 'Richard Ivers', wa_phone: '353870000000' }

describe('buildTemplateComponents — media headers', () => {
  it('falls back to template.header_media_url when no override is passed (the #132012 regression)', () => {
    const comps = buildTemplateComponents(VIDEO_TEMPLATE, contact, { 1: 'first_name' }, null)
    const header = comps.find(c => c.type === 'header')
    expect(header).toBeTruthy()
    expect(header.parameters).toEqual([
      { type: 'video', video: { link: VIDEO_TEMPLATE.header_media_url } },
    ])
  })

  it('a per-send override still wins over the template URL', () => {
    const override = 'https://example.com/other.mp4'
    const comps = buildTemplateComponents(VIDEO_TEMPLATE, contact, {}, override)
    const header = comps.find(c => c.type === 'header')
    expect(header.parameters[0].video.link).toBe(override)
  })

  it('emits no header component when neither override nor template URL exists', () => {
    const bare = { ...VIDEO_TEMPLATE, header_media_url: null }
    const comps = buildTemplateComponents(bare, contact, {}, null)
    expect(comps.find(c => c.type === 'header')).toBeUndefined()
  })

  it('TEXT headers never get a media parameter', () => {
    const textTpl = {
      header_media_url: 'https://example.com/ignored.mp4',
      components: [{ type: 'HEADER', format: 'TEXT', text: 'Hello' }],
    }
    const comps = buildTemplateComponents(textTpl, contact, {}, null)
    expect(comps.find(c => c.type === 'header')).toBeUndefined()
  })

  it('body variables resolve alongside the header fallback', () => {
    const comps = buildTemplateComponents(VIDEO_TEMPLATE, contact, { 1: 'first_name' }, null)
    const body = comps.find(c => c.type === 'body')
    expect(body.parameters).toEqual([{ type: 'text', text: 'Richard' }])
  })

  it('IMAGE headers use the image parameter type', () => {
    const imgTpl = {
      header_media_url: 'https://example.com/pic.jpg',
      components: [{ type: 'HEADER', format: 'IMAGE' }],
    }
    const comps = buildTemplateComponents(imgTpl, contact, {}, null)
    expect(comps[0].parameters[0]).toEqual({ type: 'image', image: { link: 'https://example.com/pic.jpg' } })
  })
})

import { renderTemplateBody, substituteTemplateBody, parseConsentKeyword } from './whatsapp.js'

describe('renderTemplateBody / substituteTemplateBody', () => {
  it('renders the body text a contact actually receives', () => {
    expect(renderTemplateBody(VIDEO_TEMPLATE, contact, { 1: 'first_name' }))
      .toBe('Hey Richard, welcome!')
  })

  it('uses unmapped variables as literals and missing maps as blanks', () => {
    const tpl = { components: [{ type: 'BODY', text: 'Hi {{1}}, code {{2}}' }] }
    expect(renderTemplateBody(tpl, contact, { 1: 'first_name', 2: 'GYM20' }))
      .toBe('Hi Richard, code GYM20')
    expect(renderTemplateBody(tpl, contact, {})).toBe('Hi , code ')
  })

  it('returns null when the template has no BODY text', () => {
    expect(renderTemplateBody({ components: [] }, contact, {})).toBeNull()
    expect(substituteTemplateBody(null, ['x'])).toBeNull()
  })

  it('substitutes positionally and tolerates short value arrays', () => {
    expect(substituteTemplateBody('A {{1}} B {{2}}', ['one'])).toBe('A one B ')
  })
})

describe('parseConsentKeyword', () => {
  it('matches stop keywords case/whitespace-insensitively', () => {
    for (const t of ['STOP', ' stop ', 'Unsubscribe', 'stopall', 'STOP ALL', 'cancel', 'end', 'quit']) {
      expect(parseConsentKeyword(t)).toBe('stop')
    }
  })
  it('matches start keywords', () => {
    for (const t of ['START', ' start', 'unstop', 'Subscribe']) {
      expect(parseConsentKeyword(t)).toBe('start')
    }
  })
  it('ignores conversational mentions and non-text', () => {
    for (const t of ['please stop texting me', 'stop it', 'can I unsubscribe?', '', null, undefined]) {
      expect(parseConsentKeyword(t)).toBeNull()
    }
  })
})

describe('resolveTemplateVariableValues — location_name branding', () => {
  const tpl = { components: [{ type: 'BODY', text: 'Hi {{1}}, from {{2}}' }] }
  const contact = { first_name: 'Sam', name: 'Sam Lee' }

  it('resolves location_name from opts.companyName', () => {
    const vals = resolveTemplateVariableValues(tpl, contact, { 1: 'first_name', 2: 'location_name' }, { companyName: 'CCF Autos' })
    expect(vals[1]).toBe('CCF Autos')
  })

  it('falls back to UN1T when no companyName is passed', () => {
    const vals = resolveTemplateVariableValues(tpl, contact, { 1: 'first_name', 2: 'location_name' })
    expect(vals[1]).toBe('UN1T')
  })
})

// WA-TMPL-SEND.1 — the shared media-header builder. Extracted from
// buildTemplateComponents so the conversation send route can attach
// the header server-side (the inbox picker only collects body vars;
// a media-header template sent without its header param fails at
// Meta with the useless generic "unexpected error" — bit Richard
// live on 2026-06-12, same class as the 2026-06-11 broadcast bug).
import { headerComponentFor } from './whatsapp'

describe('headerComponentFor', () => {
  const videoTpl = [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'Hi {{1}}' }]

  it('builds the lowercase header parameter for media formats', () => {
    expect(headerComponentFor(videoTpl, 'https://x.test/v.mp4')).toEqual({
      type: 'header',
      parameters: [{ type: 'video', video: { link: 'https://x.test/v.mp4' } }],
    })
    expect(headerComponentFor([{ type: 'HEADER', format: 'IMAGE' }], 'https://x.test/i.jpg'))
      .toEqual({ type: 'header', parameters: [{ type: 'image', image: { link: 'https://x.test/i.jpg' } }] })
  })

  it('returns null without a media header or without a url', () => {
    expect(headerComponentFor(videoTpl, null)).toBe(null)
    expect(headerComponentFor([{ type: 'HEADER', format: 'TEXT', text: 'Hello' }], 'https://x.test/v.mp4')).toBe(null)
    expect(headerComponentFor([{ type: 'BODY', text: 'Hi' }], 'https://x.test/v.mp4')).toBe(null)
    expect(headerComponentFor(null, 'https://x.test/v.mp4')).toBe(null)
  })
})
