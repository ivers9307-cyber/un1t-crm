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
import { ACTIVE_SET_LIMIT, ACTIVE_SET_OR } from 'shared/inbox-active-set'
import { listConversations, listTemplates, sendTemplate, getInboxConfig, snoozeConversation } from './whatsapp-api'

const LOC = '11111111-1111-1111-1111-111111111111'
const CONV = '22222222-2222-2222-2222-222222222222'

// A thenable query builder that records every link, like supabase-js.
function builder(result) {
  const calls = []
  const b = {
    calls,
    select: (...a) => { calls.push(['select', ...a]); return b },
    eq: (...a) => { calls.push(['eq', ...a]); return b },
    is: (...a) => { calls.push(['is', ...a]); return b },
    or: (...a) => { calls.push(['or', ...a]); return b },
    order: (...a) => { calls.push(['order', ...a]); return b },
    limit: (...a) => { calls.push(['limit', ...a]); return b },
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  }
  return b
}

beforeEach(() => { vi.clearAllMocks() })

// INBOXFOLLOW.1 — the phone's list read feeds the shared queue rules, so its
// select names every column they read. needsMiaHelp reads handoff_requested_at
// (not agent_handed_off_at): a select without it leaves "Mia needs help" empty.
describe('listConversations', () => {
  const RULE_COLUMNS = [
    'customer_waiting_since', 'staff_owned_since', 'staff_waiting_since', 'staff_nudged_at',
    'staff_nudge_outcome', 'handoff_requested_at', 'snoozed_until', 'snooze_note',
  ]
  const row = (id, at, extra = {}) => ({ id, last_message_at: at, ...extra })

  // supabase.from is called twice, newest-100 first, then the active set.
  function mockReads(latest, active) {
    const latestQ = builder(latest)
    const activeQ = builder(active)
    supabase.from.mockReturnValueOnce(latestQ).mockReturnValueOnce(activeQ)
    return { latestQ, activeQ }
  }

  it('selects the follow-up columns the queue rules read, and never snoozed_by or a profiles embed', async () => {
    const { latestQ, activeQ } = mockReads({ data: [], error: null }, { data: [], error: null })
    await listConversations(LOC)
    expect(supabase.from).toHaveBeenCalledTimes(2)
    for (const q of [latestQ, activeQ]) {
      const cols = q.calls[0][1].split(',').map((c) => c.trim())
      for (const col of RULE_COLUMNS) expect(cols).toContain(col)
      expect(q.calls[0][1]).not.toMatch(/snoozed_by|profiles/)
    }
    expect(activeQ.calls[0][1]).toBe(latestQ.calls[0][1])
  })

  it('reads the newest 100 and, beside it, the active set oldest first with the shared filter', async () => {
    const { latestQ, activeQ } = mockReads({ data: [], error: null }, { data: [], error: null })
    await listConversations(LOC)
    expect(latestQ.calls.slice(1)).toEqual([
      ['order', 'last_message_at', { ascending: false, nullsFirst: false }],
      ['limit', 100],
      ['eq', 'location_id', LOC],
    ])
    expect(activeQ.calls.slice(1)).toEqual([
      ['is', 'resolved_at', null],
      ['or', ACTIVE_SET_OR],
      ['order', 'last_message_at', { ascending: true, nullsFirst: false }],
      ['limit', ACTIVE_SET_LIMIT],
      ['eq', 'location_id', LOC],
    ])
    expect(ACTIVE_SET_LIMIT).toBe(300)
  })

  it('merges the two reads by id, newest message first', async () => {
    mockReads(
      { data: [row('a', '2026-11-25T10:00:00Z'), row('b', '2026-11-24T10:00:00Z')], error: null },
      { data: [row('old', '2026-10-01T10:00:00Z', { last_message_direction: 'inbound' }), row('b', '2026-11-24T10:00:00Z')], error: null },
    )
    const res = await listConversations(LOC)
    expect(res.success).toBe(true)
    expect(res.data.map((c) => c.id)).toEqual(['a', 'b', 'old'])
  })

  it('shows the newest 100 when the active-set read fails, and says so in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const latest = [row('a', '2026-11-25T10:00:00Z')]
    mockReads({ data: latest, error: null }, { data: null, error: { message: 'boom' } })
    expect(await listConversations(LOC)).toEqual({ success: true, data: latest })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('a failed newest-100 read is a failure, whatever the active set says', async () => {
    mockReads({ data: null, error: { message: 'down' } }, { data: [row('x', '2026-11-25T10:00:00Z')], error: null })
    expect(await listConversations(LOC)).toEqual({ success: false, error: 'down' })
  })
})

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

describe('getInboxConfig', () => {
  it("asks the studio's inbox-config route through api()", async () => {
    api.mockResolvedValue({ success: true, data: { quietHours: 72, nudgeEnabled: true } })
    expect(await getInboxConfig(LOC)).toEqual({ quietHours: 72, nudgeEnabled: true })
    expect(api).toHaveBeenCalledWith(`/api/whatsapp/inbox-config?location_id=${LOC}`, { locationId: LOC })
  })

  it('falls back to the shared default when the call fails or answers an odd shape', async () => {
    api.mockResolvedValue({ success: false, error: 'Network error' })
    expect(await getInboxConfig(LOC)).toEqual({ quietHours: 48, nudgeEnabled: false })
    api.mockResolvedValue({ success: true, data: { quietHours: 'soon' } })
    expect(await getInboxConfig(LOC)).toEqual({ quietHours: 48, nudgeEnabled: false })
    api.mockResolvedValue(undefined)
    expect(await getInboxConfig(LOC)).toEqual({ quietHours: 48, nudgeEnabled: false })
  })

  it('makes no call without a studio', async () => {
    expect(await getInboxConfig(null)).toEqual({ quietHours: 48, nudgeEnabled: false })
    expect(api).not.toHaveBeenCalled()
  })
})

describe('snoozeConversation', () => {
  it('POSTs the body to the WhatsApp snooze route unchanged', async () => {
    api.mockResolvedValue({ success: true })
    const body = { until: '2026-11-26T09:00:00.000Z', seen_last_message_at: null }
    await snoozeConversation(CONV, body, LOC)
    expect(api).toHaveBeenCalledWith(`/api/whatsapp/conversations/${CONV}/snooze`, { method: 'POST', locationId: LOC, body })
  })
})
