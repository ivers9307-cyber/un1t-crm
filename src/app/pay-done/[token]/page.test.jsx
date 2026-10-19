// MIAHATCH.6 (Task 22) — the /pay-done/<token> return page.
//
// The page is a CHECK TRIGGER, never proof of payment: it renders the same
// text whatever the settle says, and settles only a known, live, un-cancelled
// intent whose 30 s rate slot is free. Everything stateful is faked at its
// module boundary (the DB read, settle, the rate limit, branding, settings);
// the real copy renderer and token hash run.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createHash } from 'node:crypto'

const INTENT_ID = '11111111-1111-4111-8111-111111111111'
const LOCATION_ID = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'dG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4tdG9' // 43 base64url chars, fictional
const hashOf = (t) => createHash('sha256').update(t).digest('hex')

const state = {
  intents: [],          // rows { success_token_hash, id, location_id, status }
  intentError: null,
  selects: [],          // every .select() column list asked of the intents table
  eqs: [],
}
function fakeDb() {
  return {
    from: (table) => {
      const q = { table, filters: {} }
      const b = {
        select: (cols) => { state.selects.push({ table, cols }); return b },
        eq: (col, val) => { q.filters[col] = val; state.eqs.push({ table, col, val }); return b },
        maybeSingle: async () => {
          if (state.intentError) return { data: null, error: state.intentError }
          const row = state.intents.find((r) => r.success_token_hash === q.filters.success_token_hash)
          return { data: row ? { id: row.id, location_id: row.location_id, status: row.status } : null, error: null }
        },
      }
      return b
    },
  }
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb() }))

const settle = vi.fn()
vi.mock('@/lib/agent/purchase-settle', () => ({ settlePurchaseIntent: (...a) => settle(...a) }))

const rate = vi.fn()
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: (...a) => rate(...a) }))

const branding = vi.fn()
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: (...a) => branding(...a) }))

let resolved = { ok: true, settings: {} }
vi.mock('@/lib/agent/settings-resolve', () => ({ resolveAgentSettings: async () => resolved }))

const logWarn = vi.fn()
vi.mock('@/lib/log', () => ({ logWarn: (...a) => logWarn(...a), logError: vi.fn(), logInfo: vi.fn() }))

import Page, { metadata } from './page.js'
import { DEFAULT_PAY_DONE_PAGE_TEXT, DEFAULT_PAY_CANCEL_PAGE_TEXT } from '@/lib/agent/default-copy'

async function render(token = TOKEN, search = {}) {
  const el = await Page({ params: Promise.resolve({ token }), searchParams: Promise.resolve(search) })
  return renderToStaticMarkup(el)
}

beforeEach(() => {
  state.intents = [{ success_token_hash: hashOf(TOKEN), id: INTENT_ID, location_id: LOCATION_ID, status: 'link_sent' }]
  state.intentError = null
  state.selects = []
  state.eqs = []
  settle.mockReset().mockResolvedValue({ outcome: 'not_paid', sent: false })
  rate.mockReset().mockResolvedValue({ allowed: true })
  branding.mockReset().mockResolvedValue({ companyName: 'Hatch Street', logoUrl: 'https://cdn.example.test/logo.png' })
  logWarn.mockReset()
  resolved = { ok: true, settings: {} }
})

describe('/pay-done/<token>', () => {
  it('is noindex', () => {
    expect(metadata.robots.index).toBe(false)
  })

  it('a known live intent settles once as pay_done/live and shows the studio branding and the done text', async () => {
    const html = await render()
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls[0][1]).toBe(INTENT_ID)
    expect(settle.mock.calls[0][2]).toEqual({ detectedBy: 'pay_done', source: 'live' })
    expect(rate).toHaveBeenCalledWith(expect.anything(), `mia-pay-done:${INTENT_ID}`, { max: 1, windowMs: 30_000 })
    expect(html).toContain(DEFAULT_PAY_DONE_PAGE_TEXT)
    expect(html).toContain('Hatch Street')
    expect(html).toContain('https://cdn.example.test/logo.png')
  })

  it('loading never marks paid on its own: the page renders identically whatever settle says, and writes nothing itself', async () => {
    settle.mockResolvedValue({ outcome: 'not_paid', sent: false })
    const notPaid = await render()
    settle.mockResolvedValue({ outcome: 'paid_booked', sent: true, text: 'You are booked in for Saturday' })
    const paid = await render()
    expect(paid).toBe(notPaid)
    expect(paid).not.toContain('booked')
    // the only table it touches is the intent read (select), never a write
    expect(state.eqs.every((e) => e.table === 'mia_purchase_intents')).toBe(true)
  })

  it('a second load inside the 30 s slot does not call settle', async () => {
    rate.mockResolvedValue({ allowed: false })
    const html = await render()
    expect(settle).not.toHaveBeenCalled()
    expect(html).toContain(DEFAULT_PAY_DONE_PAGE_TEXT)
  })

  it('a settle that throws or errors never breaks the page and logs ids and codes only', async () => {
    settle.mockRejectedValue(Object.assign(new Error('boom https://checkout.example.test/secret'), { name: 'TypeError' }))
    const html = await render()
    expect(html).toContain(DEFAULT_PAY_DONE_PAGE_TEXT)
    expect(logWarn).toHaveBeenCalledTimes(1)
    const [mod, , meta] = logWarn.mock.calls[0]
    expect(mod).toBe('mia-un1t')
    expect(JSON.stringify(meta)).not.toContain('checkout.example.test')
    expect(JSON.stringify(meta)).not.toContain(TOKEN)
    expect(meta.intentId).toBe(INTENT_ID)
  })

  it('the cancel variant shows pay_cancel_page_text and never settles or spends the rate slot', async () => {
    const html = await render(TOKEN, { c: '1' })
    expect(html).toContain(DEFAULT_PAY_CANCEL_PAGE_TEXT)
    expect(html).not.toContain(DEFAULT_PAY_DONE_PAGE_TEXT)
    expect(settle).not.toHaveBeenCalled()
    expect(rate).not.toHaveBeenCalled()
  })

  it('uses the studio operator copy from its resolved Mia settings', async () => {
    resolved = { ok: true, settings: { pay_done_page_text: 'All sorted, back to WhatsApp.' } }
    expect(await render()).toContain('All sorted, back to WhatsApp.')
  })

  it('falls back to the default copy when the studio settings are unreadable', async () => {
    resolved = { ok: false, reason: 'read_failed' }
    expect(await render()).toContain(DEFAULT_PAY_DONE_PAGE_TEXT)
  })

  it('does not settle an intent that is not link_sent (paid, expired, refused ...)', async () => {
    for (const status of ['paid', 'booked', 'book_failed', 'no_class', 'expired', 'refused']) {
      state.intents[0].status = status
      await render()
    }
    expect(settle).not.toHaveBeenCalled()
    expect(rate).not.toHaveBeenCalled()
  })

  it('an unknown token renders the generic default copy with no branding, no settle, no 404', async () => {
    const html = await render('A'.repeat(43))
    expect(html).toContain(DEFAULT_PAY_DONE_PAGE_TEXT)
    expect(html).not.toContain('Hatch Street')
    expect(html).not.toContain('<img')
    expect(settle).not.toHaveBeenCalled()
    expect(rate).not.toHaveBeenCalled()
    expect(branding).not.toHaveBeenCalled()
  })

  it('an unknown token on the cancel variant shows the DEFAULT cancel copy (so ?c=1 cannot tell known from unknown)', async () => {
    const html = await render('A'.repeat(43), { c: '1' })
    expect(html).toContain(DEFAULT_PAY_CANCEL_PAGE_TEXT)
  })

  it('a malformed token (wrong length or alphabet) is generic and costs no database read', async () => {
    for (const t of ['x', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, '../etc/passwd', ' '.repeat(43)]) {
      const html = await render(t)
      expect(html).toContain(DEFAULT_PAY_DONE_PAGE_TEXT)
    }
    expect(state.selects).toHaveLength(0)
    expect(settle).not.toHaveBeenCalled()
  })

  it('an unreadable intent row renders the generic page and settles nothing', async () => {
    state.intentError = { code: 'XX000', message: 'db down' }
    const html = await render()
    expect(html).toContain(DEFAULT_PAY_DONE_PAGE_TEXT)
    expect(html).not.toContain('Hatch Street')
    expect(settle).not.toHaveBeenCalled()
  })

  it('looks the intent up by token hash selecting only id, location_id and status; the raw token never reaches the query', async () => {
    await render()
    expect(state.selects).toEqual([{ table: 'mia_purchase_intents', cols: 'id, location_id, status' }])
    expect(state.eqs).toEqual([{ table: 'mia_purchase_intents', col: 'success_token_hash', val: hashOf(TOKEN) }])
  })

  it('renders no name, phone, email, product, price or URL (only the studio logo/name and the text)', async () => {
    const html = await render()
    const text = html.replace(/<img[^>]*>/g, '').replace(/<[^>]+>/g, ' ')
    expect(text).not.toMatch(/@/)
    expect(text).not.toMatch(/https?:\/\//)
    expect(text).not.toMatch(/€|\d{6,}/)
    expect(html).not.toContain(TOKEN)
    expect(html).not.toContain(INTENT_ID)
    expect(html).not.toContain(LOCATION_ID)
    // the only link-ish attribute is the logo src (React 19 also hoists a <link rel=preload> for that same image)
    const anchors = html.replace(/<link[^>]*>/g, '')
    expect(anchors.match(/(?:href|src)="[^"]*"/g) || []).toEqual(['src="https://cdn.example.test/logo.png"'])
  })
})
