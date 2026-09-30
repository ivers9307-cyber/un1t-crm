// Tests for POST /api/whatsapp/conversations/[id]/send.
//
// sent_by attribution — whatsapp_messages.sent_by is UUID REFERENCES
// profiles(id) (mig 007). The operator's id must be taken from the SESSION
// (user.id), never from the request body:
//   - web-style send (body includes sent_by): the client value is IGNORED;
//   - mobile-style send (body omits sent_by): still attributed to user.id.
//
// WATPLSEND.1 (C45) — template sends:
//   - a FLOW-button template gets the flow_token minted server-side
//     (flowTokenFor: <contactId>.<locationId>); a client-supplied button
//     component is dropped; no linked contact → 400, nothing sent;
//   - a template the pickers grey out (a dynamic URL button, e.g.
//     outstanding_payment_link_) → 400 with the reason, nothing sent;
//   - the template is read by studio + name + LANGUAGE; a failed read → 500,
//     nothing sent; not found → 400, nothing sent.
// WATPLLOG.1 (C51) — the logged thread text is filled by variable NUMBER.
// Bookkeeping after Meta accepted — a failed insert/update is logged and
// returned as success + warnings, never as a failed send.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  // Real-shaped stand-in: caller must be assigned to the row's location,
  // else a 404 (IDOR guard). Mirrors the broadcast-send route test.
  assertLocationAccessOr404: (user, locationId) => {
    if (user?.role === 'master') return null
    const ids = (user?.locations || []).map((l) => l.id)
    if (ids.includes(locationId)) return null
    return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
  },
  // Inbox channel gate (INBOX-PERM.1): 403 when the channel permission is
  // explicitly off, null otherwise (real resolver pinned in auth.test.js).
  requireWhatsAppInboxAnywhere: (user) => {
    if (user?.permissions?.whatsapp === false) {
      return new Response(JSON.stringify({ success: false, error: 'forbidden' }), { status: 403 })
    }
    return null
  },
  // INBOXLOC.1 — the decision at the conversation's studio; its real
  // behaviour is pinned in src/lib/auth.test.js and inbox-location.test.js.
  requireWhatsAppInboxAt: () => null,
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

// Meta-facing helpers are stubbed. The pure template rules are NOT:
// @shared/wa-template-send, @/lib/whatsapp-template-buttons and
// @/lib/whatsapp-flow/config run for real, because they ARE the behaviour.
vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  isWindowOpen: vi.fn(),
  headerComponentFor: vi.fn(() => null),
}))

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

// NOTE: @/lib/validate (real Zod SendMessageSchema) and @/lib/agent/core
// (pure manualTakeoverPatch) are deliberately NOT mocked.

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { sendTextMessage, sendTemplateMessage, isWindowOpen, headerComponentFor } from '@/lib/whatsapp'
import { logError } from '@/lib/log'
import { SEND_BLOCK_TEXT } from '@shared/wa-template-send'

// ─── IDs ─────────────────────────────────────────────────────────────────────

const CONV_ID    = 'a0000000-0000-0000-0000-000000000001'
const CONTACT_ID = 'b0000000-0000-0000-0000-000000000002'
const USER_ID    = 'c0000000-0000-0000-0000-000000000003'
const LOC_ID     = 'd0000000-0000-0000-0000-000000000004'
// A client-supplied sent_by that must NOT be trusted (≠ USER_ID).
const SPOOFED_ID = 'e0000000-0000-0000-0000-000000000005'

const USER = { id: USER_ID, role: 'staff', full_name: 'Test Staff', locations: [{ id: LOC_ID }] }

// Synthetic number (the 555 range) and name: this repo is public.
const CONVERSATION = {
  id: CONV_ID,
  location_id: LOC_ID,
  wa_phone: '15555550100',
  agent_handed_off_at: null,
  window_expires_at: '2999-01-01T00:00:00.000Z',
  contacts: { id: CONTACT_ID, name: 'Test Contact', wa_phone: '15555550100', location_id: LOC_ID },
}

// Template rows: the live SHAPES (components as Meta defines them), with
// synthetic text. Never paste real template copy into this public repo.
const body = (text) => ({ type: 'BODY', text })
const TPL_PLAIN = { name: 'reopen_message_', language: 'en', components: [body('Hi {{1}}, still interested?')], header_media_url: null }
const TPL_FLOW = {
  name: 'book_first_visit',
  language: 'en',
  components: [body('Hi {{1}}, book below.'), { type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'Book', flow_id: 'F1', navigate_screen: 'PATH' }] }],
  header_media_url: null,
}
const TPL_PAYLINK = {
  name: 'outstanding_payment_link_',
  language: 'en',
  components: [body('Hi {{1}}, {{2}} is due.'), { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: 'https://pay.example.test/{{1}}' }] }],
  header_media_url: null,
}
const TPL_REORDERED = { name: 'order_test_', language: 'en', components: [body('{{2}} then {{1}} and {{2}} again')], header_media_url: null }

const bodyParams = (...texts) => ({ type: 'body', parameters: texts.map((text) => ({ type: 'text', text })) })

// ─── DB mock ──────────────────────────────────────────────────────────────────

// insert spy — the route awaits `db.from('whatsapp_messages').insert(row)` and
// reads `{ error }`. Pass an Error to make the insert THROW (network failure).
function captureInsert(result = { error: null }) {
  let captured = null
  const spy = vi.fn((payload) => {
    captured = payload
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  })
  spy.captured = () => captured
  return spy
}

function makeDb({
  conversation = CONVERSATION,
  insertSpy = captureInsert(),
  template = { data: null, error: null },
  // Rows for a PostgREST-shaped simulation of the template read: .eq filters,
  // .order, .limit, and .maybeSingle erroring on more than one row, the way
  // PostgREST does. When absent, `template` is returned as-is.
  templateRows = null,
  templateEq = [],
  updateResult = { error: null },
} = {}) {
  return {
    from: vi.fn((table) => {
      if (table === 'whatsapp_conversations') {
        return {
          // 1) load the conversation
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: conversation, error: null })),
            })),
          })),
          // 2) last-message + manual-takeover patch
          update: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve(updateResult)),
          })),
        }
      }
      if (table === 'whatsapp_templates') {
        let orderBy = null
        let cap = null
        const chain = {
          eq: vi.fn((col, val) => { templateEq.push([col, val]); return chain }),
          order: vi.fn((col, { ascending = true } = {}) => { orderBy = { col, ascending }; return chain }),
          limit: vi.fn((n) => { cap = n; return chain }),
          maybeSingle: vi.fn(() => {
            if (!templateRows) return Promise.resolve(template)
            let rows = templateRows.filter((r) => templateEq.every(([col, val]) => r[col] === val))
            if (orderBy) {
              const { col, ascending } = orderBy
              rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1))
            }
            if (cap != null) rows = rows.slice(0, cap)
            if (rows.length > 1) return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'multiple rows' } })
            return Promise.resolve({ data: rows[0] || null, error: null })
          }),
        }
        return { select: vi.fn(() => chain) }
      }
      if (table === 'whatsapp_messages') {
        return { insert: insertSpy }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

// ─── Request helpers ──────────────────────────────────────────────────────────

const BASE_URL = `http://localhost/api/whatsapp/conversations/${CONV_ID}/send`

function postReq(body = {}) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const props = { params: { id: CONV_ID } }

const templateReq = (tpl, components, over = {}) => postReq({
  type: 'template',
  template_name: tpl.name,
  template_language: tpl.language,
  template_components: components,
  ...over,
})

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(USER)
  isWindowOpen.mockReturnValue(true)
  sendTextMessage.mockResolvedValue({ messageId: 'wamid.TEST' })
  sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.TPL' })
})

// ─── sent_by (unchanged) ─────────────────────────────────────────────────────

describe('POST /api/whatsapp/conversations/[id]/send — sent_by is server-derived', () => {
  it('logs sent_by = session user.id for a web-style send, ignoring the body value', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({ insertSpy }))

    const res = await POST(postReq({ type: 'text', text: 'hello', sent_by: SPOOFED_ID }), props)
    expect(res.status).toBe(200)

    expect(insertSpy).toHaveBeenCalledTimes(1)
    const payload = insertSpy.captured()
    expect(payload.sent_by).toBe(USER_ID)
    expect(payload.sent_by).not.toBe(SPOOFED_ID)
  })

  it('logs sent_by = session user.id for a mobile-style send that omits sent_by', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({ insertSpy }))

    const res = await POST(postReq({ type: 'text', text: 'hello' }), props)
    expect(res.status).toBe(200)

    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy.captured().sent_by).toBe(USER_ID)
  })
})

// ─── WATPLSEND.1 ─────────────────────────────────────────────────────────────

describe('template sends (WATPLSEND.1)', () => {
  it('attaches the booking Flow token, minted server-side; a client button component is dropped', async () => {
    createServerClient.mockReturnValue(makeDb({ template: { data: TPL_FLOW, error: null } }))
    const forged = { type: 'button', sub_type: 'flow', index: '0', parameters: [{ type: 'action', action: { flow_token: 'forged.token' } }] }

    const res = await POST(templateReq(TPL_FLOW, [bodyParams('ALPHA'), forged]), props)
    expect(res.status).toBe(200)

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    const [, name, language, components, opts] = sendTemplateMessage.mock.calls[0]
    expect(name).toBe('book_first_visit')
    expect(language).toBe('en')
    expect(opts).toEqual({ locationId: LOC_ID })
    expect(components).toEqual([
      bodyParams('ALPHA'),
      { type: 'button', sub_type: 'flow', index: '0', parameters: [{ type: 'action', action: { flow_token: `${CONTACT_ID}.${LOC_ID}` } }] },
    ])
    expect(JSON.stringify(components)).not.toContain('forged.token')
  })

  it('logs the components the route honoured, not the forged button it dropped', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({ template: { data: TPL_FLOW, error: null }, insertSpy }))
    const forged = { type: 'button', sub_type: 'flow', index: '0', parameters: [{ type: 'action', action: { flow_token: 'forged.token' } }] }

    const res = await POST(templateReq(TPL_FLOW, [bodyParams('ALPHA'), forged]), props)
    expect(res.status).toBe(200)
    expect(insertSpy.captured().template_variables).toEqual([bodyParams('ALPHA')])
    expect(JSON.stringify(insertSpy.captured())).not.toContain('forged.token')
  })

  it('refuses a Flow template on a thread with no linked contact: 400, nothing sent or logged', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({
      conversation: { ...CONVERSATION, contacts: null },
      template: { data: TPL_FLOW, error: null },
      insertSpy,
    }))

    const res = await POST(templateReq(TPL_FLOW, [bodyParams('ALPHA')]), props)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/add the sender as a contact/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('refuses a template whose button link needs a per-message value, with a clear 400', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({ template: { data: TPL_PAYLINK, error: null }, insertSpy }))

    const res = await POST(templateReq(TPL_PAYLINK, [bodyParams('ALPHA', 'BETA')]), props)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.blocked).toBe('button_value')
    expect(json.error).toContain(SEND_BLOCK_TEXT.button_value)
    expect(json.error).not.toMatch(/—/)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('reads the template by studio, name AND language, and sends that language', async () => {
    const templateEq = []
    const enUs = { ...TPL_PLAIN, name: 'hello_world', language: 'en_US', components: [body('Hello World')] }
    createServerClient.mockReturnValue(makeDb({ template: { data: enUs, error: null }, templateEq }))

    const res = await POST(templateReq(enUs, []), props)
    expect(res.status).toBe(200)
    expect(templateEq).toEqual(expect.arrayContaining([
      ['location_id', LOC_ID], ['name', 'hello_world'], ['language', 'en_US'],
    ]))
    expect(sendTemplateMessage.mock.calls[0][2]).toBe('en_US')
  })

  it('a failed template read sends nothing: 500, logged', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({ template: { data: null, error: { message: 'read failed' } }, insertSpy }))

    const res = await POST(templateReq(TPL_PLAIN, [bodyParams('ALPHA')]), props)
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('wa-conv-send', expect.stringContaining('template read failed'), expect.objectContaining({ conversationId: CONV_ID }))
  })

  it("a template not in this studio's list sends nothing: 400", async () => {
    createServerClient.mockReturnValue(makeDb({ template: { data: null, error: null } }))

    const res = await POST(templateReq(TPL_PLAIN, [bodyParams('ALPHA')]), props)
    expect(res.status).toBe(400)
    const { error } = await res.json()
    expect(error).toMatch(/not in this studio's approved list/)
    // The phone shows this too: no web-only instruction.
    expect(error).not.toMatch(/page/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('reads APPROVED rows only: a template Meta paused is refused with a 400, nothing sent', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({
      templateRows: [{ ...TPL_PLAIN, location_id: LOC_ID, status: 'PAUSED', created_at: '2026-09-01T00:00:00Z' }],
      insertSpy,
    }))

    const res = await POST(templateReq(TPL_PLAIN, [bodyParams('ALPHA')]), props)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not in this studio's approved list/)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('two approved rows for one name + language (a template re-created at Meta): the newest is sent, not a permanent 500', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({
      templateRows: [
        { ...TPL_PLAIN, location_id: LOC_ID, status: 'APPROVED', created_at: '2026-01-01T00:00:00Z', components: [body('OLD {{1}}')] },
        { ...TPL_PLAIN, location_id: LOC_ID, status: 'APPROVED', created_at: '2026-09-01T00:00:00Z', components: [body('NEW {{1}}')] },
        { ...TPL_PLAIN, location_id: LOC_ID, status: 'REJECTED', created_at: '2026-09-20T00:00:00Z', components: [body('REJECTED {{1}}')] },
      ],
      insertSpy,
    }))

    const res = await POST(templateReq(TPL_PLAIN, [bodyParams('ALPHA')]), props)
    expect(res.status).toBe(200)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(insertSpy.captured().body).toBe('NEW ALPHA')
  })

  it('attaches the media header stored at upload when the client sends none (WA-TMPL-SEND.1)', async () => {
    const tpl = {
      name: 'video_intro_',
      language: 'en',
      components: [{ type: 'HEADER', format: 'VIDEO' }, body('Hi {{1}}')],
      header_media_url: 'https://example.test/v.mp4',
    }
    const header = { type: 'header', parameters: [{ type: 'video', video: { link: 'https://example.test/v.mp4' } }] }
    headerComponentFor.mockReturnValueOnce(header)
    createServerClient.mockReturnValue(makeDb({ template: { data: tpl, error: null } }))

    const res = await POST(templateReq(tpl, [bodyParams('ALPHA')]), props)
    expect(res.status).toBe(200)
    expect(headerComponentFor).toHaveBeenCalledWith(tpl.components, 'https://example.test/v.mp4')
    expect(sendTemplateMessage.mock.calls[0][3]).toEqual([header, bodyParams('ALPHA')])
  })

  it('a client-supplied header excuses only the header: a template ALSO blocked for its button is still refused', async () => {
    const insertSpy = captureInsert()
    // A media header with no stored file (header_media) AND a dynamic URL
    // button (button_value). templateSendBlock names the header first.
    const tpl = {
      name: 'video_pay_',
      language: 'en',
      components: [
        { type: 'HEADER', format: 'VIDEO' },
        body('Hi {{1}}'),
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: 'https://pay.example.test/{{1}}' }] },
      ],
      header_media_url: null,
    }
    const clientHeader = { type: 'header', parameters: [{ type: 'video', video: { link: 'https://example.test/v.mp4' } }] }
    createServerClient.mockReturnValue(makeDb({ template: { data: tpl, error: null }, insertSpy }))

    const res = await POST(templateReq(tpl, [clientHeader, bodyParams('ALPHA')]), props)
    expect(res.status).toBe(400)
    expect((await res.json()).blocked).toBe('button_value')
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('a Meta refusal is still a 400 and logs nothing (the customer got nothing)', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({ template: { data: TPL_PLAIN, error: null }, insertSpy }))
    sendTemplateMessage.mockRejectedValue(new Error('Template refused (Meta code 132000)'))

    const res = await POST(templateReq(TPL_PLAIN, [bodyParams('ALPHA')]), props)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('132000')
    expect(insertSpy).not.toHaveBeenCalled()
  })
})

// ─── WATPLLOG.1 ──────────────────────────────────────────────────────────────

describe('logged thread text is filled by variable number (WATPLLOG.1)', () => {
  it('"{{2}} then {{1}} and {{2}} again": Meta gets one value per slot, the thread logs what the customer read', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({ template: { data: TPL_REORDERED, error: null }, insertSpy }))

    const res = await POST(templateReq(TPL_REORDERED, [bodyParams('ALPHA', 'BETA')]), props)
    expect(res.status).toBe(200)

    // What Meta got: slot 1 = ALPHA, slot 2 = BETA, exactly as the picker built it.
    expect(sendTemplateMessage.mock.calls[0][3]).toEqual([bodyParams('ALPHA', 'BETA')])
    // What the thread shows: filled by number, not by order of appearance.
    expect(insertSpy.captured().body).toBe('BETA then ALPHA and BETA again')
    expect(insertSpy.captured().template_name).toBe('order_test_')
  })
})

// ─── Bookkeeping after Meta accepted ─────────────────────────────────────────

describe('after Meta accepted, a bookkeeping failure never reports the send as failed', () => {
  it('insert returns an error: 200 success + warning, logged with the wamid', async () => {
    createServerClient.mockReturnValue(makeDb({ insertSpy: captureInsert({ error: { message: 'insert failed' } }) }))

    const res = await POST(postReq({ type: 'text', text: 'hello' }), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.messageId).toBe('wamid.TEST')
    expect(json.warnings).toEqual([expect.stringMatching(/could not be saved to this thread/)])
    expect(logError).toHaveBeenCalledWith('wa-conv-send', expect.stringContaining('insert failed'), expect.objectContaining({ conversationId: CONV_ID, waMessageId: 'wamid.TEST' }))
  })

  it('insert THROWS: still 200 success + warning (it used to fall into the catch and answer 400)', async () => {
    createServerClient.mockReturnValue(makeDb({ insertSpy: captureInsert(new Error('network down')) }))

    const res = await POST(postReq({ type: 'text', text: 'hello' }), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.warnings).toHaveLength(1)
  })

  it('conversation update fails: 200 success + a warning that Mia may still reply', async () => {
    createServerClient.mockReturnValue(makeDb({ updateResult: { error: { message: 'update failed' } } }))

    const res = await POST(postReq({ type: 'text', text: 'hello' }), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.warnings).toEqual([expect.stringMatching(/could not be updated.*Mia may still reply/)])
    expect(logError).toHaveBeenCalledWith('wa-conv-send', expect.stringContaining('conversation update failed'), expect.objectContaining({ conversationId: CONV_ID }))
  })

  it('a clean send carries no warnings field', async () => {
    createServerClient.mockReturnValue(makeDb({}))
    const json = await (await POST(postReq({ type: 'text', text: 'hello' }), props)).json()
    expect(json).toEqual({ success: true, messageId: 'wamid.TEST' })
  })
})

// ─── WACONFIGFALLBACK.1 ──────────────────────────────────────────────────────

// The conversation's location has no WhatsApp number of its own (e.g. the
// number was removed after the thread existed). The reply used to go out on
// the global env number (another studio's, so the customer's answer landed in
// THAT studio's inbox and Mia). Now the resolver refuses: 409, nothing logged.
describe('no WhatsApp number at the conversation location (WACONFIGFALLBACK.1)', () => {
  it('a text reply → 409 with the resolver message, nothing logged', async () => {
    const { WhatsAppNumberMissingError } = await import('@/lib/whatsapp-number-missing')
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({ insertSpy }))
    sendTextMessage.mockRejectedValue(new WhatsAppNumberMissingError(LOC_ID))

    const res = await POST(postReq({ type: 'text', text: 'hello' }), props)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'No WhatsApp number is connected at this location.' })
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
