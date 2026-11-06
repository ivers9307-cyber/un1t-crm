import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({ createTemplate: vi.fn() }))
vi.mock('@/lib/whatsapp-own-number', () => ({ ownNumberOrRefusal: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { createTemplate } from '@/lib/whatsapp'
import { ownNumberOrRefusal } from '@/lib/whatsapp-own-number'
import { submitWhatsappTemplate } from '@/lib/whatsapp-template-submit'

const LOC = 'loc-1'

// Minimal fake: the clash read resolves `clashes`, the insert resolves `insertResult`.
function fakeDb({ clashes = [], clashErr = null, insertResult = null } = {}) {
  const inserted = []
  return {
    inserted,
    from: vi.fn(() => ({
      select: vi.fn(function () {
        const q = {
          eq: vi.fn(() => q),
          then: (res) => res({ data: clashes, error: clashErr }),
        }
        return q
      }),
      insert: vi.fn((row) => {
        inserted.push(row)
        return {
          select: () => ({
            single: async () => insertResult || { data: { id: 't1', ...row }, error: null },
          }),
        }
      }),
    })),
  }
}

const base = { locationId: LOC, name: 'welcome', components: [{ type: 'BODY', text: 'Hi' }], createdBy: 'u1' }

beforeEach(() => {
  vi.clearAllMocks()
  ownNumberOrRefusal.mockResolvedValue({ ok: true, config: { businessAccountId: 'waba-1' } })
  createTemplate.mockResolvedValue({ id: 'meta-1', status: 'PENDING' })
})

describe('submitWhatsappTemplate', () => {
  it('buttonsErrorIs400', async () => {
    const r = await submitWhatsappTemplate(fakeDb(), {
      ...base,
      components: [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: '' }] }],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
    expect(ownNumberOrRefusal).not.toHaveBeenCalled()
    expect(createTemplate).not.toHaveBeenCalled()
  })

  it('noNumberPassesStatusThrough', async () => {
    ownNumberOrRefusal.mockResolvedValue({ ok: false, status: 409, error: 'No number' })
    const r = await submitWhatsappTemplate(fakeDb(), base)
    expect(r).toMatchObject({ ok: false, status: 409, error: 'No number' })
    expect(createTemplate).not.toHaveBeenCalled()
  })

  it('nameClashIs409WithExisting', async () => {
    const other = await submitWhatsappTemplate(
      fakeDb({ clashes: [{ id: 'x', location_id: 'loc-2', language: 'en', locations: { name: 'Hatch' } }] }),
      base,
    )
    expect(other).toMatchObject({
      ok: false, status: 409, code: 'name_clash',
      error: 'That name is already used by Hatch on this WhatsApp account. Pick another name.',
    })
    expect(other.existing).toBeUndefined()

    const mine = await submitWhatsappTemplate(
      fakeDb({ clashes: [{ id: 'row-9', location_id: LOC, language: 'en', locations: { name: 'Stillorgan' } }] }),
      base,
    )
    expect(mine).toMatchObject({ ok: false, status: 409, code: 'name_clash', existing: { id: 'row-9' } })
    expect(createTemplate).not.toHaveBeenCalled()
  })

  it('metaErrorIs400', async () => {
    createTemplate.mockRejectedValue(new Error('Meta says no'))
    const db = fakeDb()
    const r = await submitWhatsappTemplate(db, base)
    expect(r).toMatchObject({ ok: false, status: 400, error: 'Meta says no' })
    expect(r.code).toBeUndefined()
    expect(db.inserted).toHaveLength(0)
  })

  it('insertFailureAfterMetaReportsOrphan', async () => {
    const db = fakeDb({ insertResult: { data: null, error: { message: 'boom' } } })
    const r = await submitWhatsappTemplate(db, base)
    expect(r).toMatchObject({ ok: false, status: 400, code: 'orphan_at_meta' })
    expect(r.error).toMatch(/exists at Meta/)
    expect(r.error).toMatch(/re-sync/)
    expect(r.error).toMatch(/boom/)
  })

  it('successReturnsTemplate', async () => {
    const db = fakeDb()
    const r = await submitWhatsappTemplate(db, { ...base, displayGroup: '  Promo ', headerMediaUrl: 'https://x/y.png' })
    expect(r.ok).toBe(true)
    expect(r.template).toMatchObject({ id: 't1', meta_template_id: 'meta-1', status: 'PENDING' })
    expect(db.inserted[0]).toMatchObject({
      name: 'welcome', language: 'en', category: 'MARKETING', location_id: LOC,
      business_account_id: 'waba-1', created_by: 'u1', example_values: {},
      header_media_handle: null, header_media_url: 'https://x/y.png', header_media_path: null,
      display_group: 'Promo',
    })
    expect(createTemplate).toHaveBeenCalledWith(
      { name: 'welcome', category: 'MARKETING', language: 'en', components: base.components, parameterFormat: undefined },
      { config: { businessAccountId: 'waba-1' } },
    )
  })
})
