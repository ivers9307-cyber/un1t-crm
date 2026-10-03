// WATPLPICKER.1 — the phone's WhatsApp template picker: the read that fills it
// and the request that sends a pick.
//
// listTemplates selected `body_text, header_text`, two columns that never
// existed on whatsapp_templates. PostgREST refuses the whole select (42703), so
// from 2026-04-30 every tap on the template button ended in "Couldn't load
// templates", and a closed 24h window could not be reopened from the phone.
// The mocked supabase client below accepts any column string, which is exactly
// why no test noticed: the exact select string is pinned here, and
// check:select-columns (which now scans mobile/) checks it against the schema.
//
// ./api and ./supabase are mocked BEFORE import: they pull the React Native
// runtime, which never loads under vitest (see vitest.config.js).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { from: vi.fn() } }))

import { api } from './api'
import { supabase } from './supabase'
import { listTemplates, sendTemplate } from './whatsapp-api'

const LOC = '11111111-1111-1111-1111-111111111111'
const CONV = '22222222-2222-2222-2222-222222222222'

// A thenable query builder that records every link, like supabase-js.
function builder(result) {
  const calls = []
  const b = {
    calls,
    select: (...a) => { calls.push(['select', ...a]); return b },
    eq: (...a) => { calls.push(['eq', ...a]); return b },
    order: (...a) => { calls.push(['order', ...a]); return b },
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  }
  return b
}

beforeEach(() => { vi.clearAllMocks() })

describe('listTemplates', () => {
  it('selects components (the template text), never the phantom body_text/header_text', async () => {
    const q = builder({ data: [], error: null })
    supabase.from.mockReturnValue(q)
    await listTemplates(LOC)
    expect(supabase.from).toHaveBeenCalledWith('whatsapp_templates')
    expect(q.calls[0]).toEqual(['select', 'id, name, status, category, language, components, header_media_url, display_group'])
    expect(q.calls[0][1]).not.toMatch(/body_text|header_text/)
  })

  it('reads approved templates at the given location, by name', async () => {
    const q = builder({ data: [], error: null })
    supabase.from.mockReturnValue(q)
    await listTemplates(LOC)
    expect(q.calls.slice(1)).toEqual([
      ['eq', 'status', 'APPROVED'],
      ['order', 'name', { ascending: true }],
      ['eq', 'location_id', LOC],
    ])
  })

  it('returns the rows on success', async () => {
    const rows = [{ id: 't1', name: 'reopen_message_', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }]
    supabase.from.mockReturnValue(builder({ data: rows, error: null }))
    expect(await listTemplates(LOC)).toEqual({ success: true, data: rows })
  })

  it('returns a failed read as a failure, never as an empty list', async () => {
    supabase.from.mockReturnValue(builder({ data: null, error: { message: 'column whatsapp_templates.body_text does not exist' } }))
    expect(await listTemplates(LOC)).toEqual({ success: false, error: 'column whatsapp_templates.body_text does not exist' })
  })
})

describe('sendTemplate', () => {
  it('POSTs the built payload to the conversation send route unchanged', async () => {
    api.mockResolvedValue({ success: true, messageId: 'wamid.1' })
    const payload = {
      type: 'template',
      template_name: 'hello_world',
      template_language: 'en_US',
      template_components: [{ type: 'body', parameters: [{ type: 'text', text: 'Sam' }] }],
    }
    const res = await sendTemplate(CONV, payload, LOC)
    expect(api).toHaveBeenCalledTimes(1)
    expect(api).toHaveBeenCalledWith(`/api/whatsapp/conversations/${CONV}/send`, {
      method: 'POST',
      locationId: LOC,
      body: payload,
    })
    expect(res).toEqual({ success: true, messageId: 'wamid.1' })
  })

  it('never writes through the supabase client (the route owns the Meta call and the log row)', async () => {
    api.mockResolvedValue({ success: true })
    await sendTemplate(CONV, { type: 'template', template_name: 'x', template_language: 'en', template_components: [] }, LOC)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
