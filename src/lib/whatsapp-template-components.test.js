// Pins the send-time component shapes for media-header templates —
// specifically the (#132012) regression: a media-header template MUST
// ship a matching header parameter, falling back to the URL persisted
// on the template row when the caller has no per-send override.
import { describe, it, expect } from 'vitest'
import { buildTemplateComponents } from './whatsapp.js'

const VIDEO_TEMPLATE = {
  name: 'consultation_booking',
  header_media_url: 'https://example.supabase.co/storage/v1/object/public/whatsapp-templates/loc/file.mp4',
  components: [
    { type: 'HEADER', format: 'VIDEO', example: { header_handle: ['4::abc'] } },
    { type: 'BODY', text: 'Hey {{1}}, welcome!' },
  ],
}

const contact = { first_name: 'Richard', name: 'Richard Ivers', wa_phone: '353873147675' }

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
