// WATPLRESUBMEDIA.1 (C109) — resubmitting a template with a NEW header image
// sent Meta the new handle but kept the OLD header_media_url (and handle) on
// the row, and every send attaches header_media_url, so customers kept getting
// the old picture. The resubmit now stores the new media, validated the way
// the header upload route validates it: a path the sign route minted, in the
// template's own studio folder of the 'whatsapp-templates' bucket, of the
// header's type, with the URL that bucket serves for it. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'prof-1' })),
  assertLocationAccessOr404: vi.fn(() => null),
  hasRoleAtLocation: vi.fn(() => true),
}))
vi.mock('@/lib/whatsapp', () => ({ editTemplate: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { editTemplate } from '@/lib/whatsapp'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const OTHER_LOC = 'a0000000-0000-4000-8000-000000000002'
const NUMBER = { source: 'db', id: 'n1', phoneNumberId: 'PNI-SYNTH', token: 'tok-synth', businessAccountId: 'WABA-SYNTH' }
const BUCKET_BASE = 'https://synthetic.supabase.test/storage/v1/object/public/whatsapp-templates'
const OLD_PATH = `${LOC}/11111111-1111-4111-8111-111111111111.jpg`
const NEW_PATH = `${LOC}/22222222-2222-4222-8222-222222222222.png`
const TMPL = {
  id: 't1', location_id: LOC, status: 'REJECTED', meta_template_id: 'meta-1',
  header_media_url: `${BUCKET_BASE}/${OLD_PATH}`, header_media_path: OLD_PATH, header_media_handle: 'h-old',
}
const IMAGE_COMPONENTS = [
  { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h-new'] } },
  { type: 'BODY', text: 'Hi again' },
]

function makeDb({ readError = null } = {}) {
  const updates = []
  const buckets = []
  return {
    updates,
    buckets,
    storage: {
      from: (bucket) => {
        buckets.push(bucket)
        return { getPublicUrl: (p) => ({ data: { publicUrl: `${BUCKET_BASE.replace('whatsapp-templates', bucket)}/${p}` } }) }
      },
    },
    from: () => {
      let mode = 'read'
      const b = {
        select: () => b, eq: () => b,
        update: (patch) => { mode = 'update'; updates.push(patch); return b },
        single: async () => {
          if (mode === 'update') return { data: { ...TMPL, ...updates.at(-1) }, error: null }
          return readError ? { data: null, error: readError } : { data: TMPL, error: null }
        },
      }
      return b
    },
  }
}

const call = (body) => POST(new Request('https://crm.test/api/whatsapp/templates/t1/resubmit', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}), { params: Promise.resolve({ id: 't1' }) })

const newMedia = (over = {}) => ({
  header_media_handle: 'h-new',
  header_media_url: `${BUCKET_BASE}/${NEW_PATH}`,
  header_media_path: NEW_PATH,
  ...over,
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getLocationWhatsAppNumberConfig.mockResolvedValue(NUMBER)
  editTemplate.mockResolvedValue({ success: true })
})

describe('POST resubmit — a new header image (WATPLRESUBMEDIA.1)', () => {
  it('stores the new header media url, path and handle with the resubmitted components', async () => {
    const res = await call({ components: IMAGE_COMPONENTS, ...newMedia() })
    expect(res.status).toBe(200)
    expect(editTemplate).toHaveBeenCalledTimes(1)
    expect(db.updates[0]).toMatchObject({
      status: 'PENDING',
      components: IMAGE_COMPONENTS,
      header_media_url: `${BUCKET_BASE}/${NEW_PATH}`,
      header_media_path: NEW_PATH,
      header_media_handle: 'h-new',
    })
    expect(db.buckets).toContain('whatsapp-templates')
  })

  it('without media fields the stored media is left alone (a body-only resubmit)', async () => {
    const res = await call({ components: [{ type: 'BODY', text: 'Hi again' }] })
    expect(res.status).toBe(200)
    expect(db.updates[0]).not.toHaveProperty('header_media_url')
    expect(db.updates[0]).not.toHaveProperty('header_media_path')
    expect(db.updates[0]).not.toHaveProperty('header_media_handle')
  })

  it.each([
    ['a path the sign route never minted', { header_media_path: `${LOC}/my-picture.png`, header_media_url: `${BUCKET_BASE}/${LOC}/my-picture.png` }],
    ['another studio’s folder', { header_media_path: `${OTHER_LOC}/22222222-2222-4222-8222-222222222222.png`, header_media_url: `${BUCKET_BASE}/${OTHER_LOC}/22222222-2222-4222-8222-222222222222.png` }],
    ['a URL that is not the bucket’s URL for that path', { header_media_url: 'https://elsewhere.test/cat.png' }],
    ['a video file on an IMAGE header', { header_media_path: `${LOC}/22222222-2222-4222-8222-222222222222.mp4`, header_media_url: `${BUCKET_BASE}/${LOC}/22222222-2222-4222-8222-222222222222.mp4` }],
    ['a URL with no path', { header_media_path: null }],
  ])('refuses %s: 400, Meta never called, row untouched', async (_label, over) => {
    const res = await call({ components: IMAGE_COMPONENTS, ...newMedia(over) })
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(editTemplate).not.toHaveBeenCalled()
    expect(db.updates).toEqual([])
  })

  it('refuses header media on a template whose header is not an image, video or document', async () => {
    const res = await call({ components: [{ type: 'HEADER', format: 'TEXT', text: 'Hello' }, { type: 'BODY', text: 'Hi' }], ...newMedia() })
    expect(res.status).toBe(400)
    expect(editTemplate).not.toHaveBeenCalled()
  })

  it('re-sending the media the row already has is not re-judged (a legacy path keeps working)', async () => {
    const legacy = { ...TMPL, header_media_path: 'old-scheme/cat.png', header_media_url: 'https://legacy.test/cat.png' }
    db.from = () => {
      let mode = 'read'
      const b = {
        select: () => b, eq: () => b,
        update: (patch) => { mode = 'update'; db.updates.push(patch); return b },
        single: async () => (mode === 'update' ? { data: { ...legacy, ...db.updates.at(-1) }, error: null } : { data: legacy, error: null }),
      }
      return b
    }
    const res = await call({ components: IMAGE_COMPONENTS, header_media_path: legacy.header_media_path, header_media_url: legacy.header_media_url, header_media_handle: 'h-new' })
    expect(res.status).toBe(200)
    expect(db.updates[0]).toMatchObject({ header_media_handle: 'h-new' })
    expect(db.updates[0]).not.toHaveProperty('header_media_url')
  })

  it('a failed template read is a 500, not "Template not found"', async () => {
    createServerClient.mockReturnValue(makeDb({ readError: { message: 'read refused', code: 'XX000' } }))
    const res = await call({ components: IMAGE_COMPONENTS, ...newMedia() })
    expect(res.status).toBe(500)
    expect(editTemplate).not.toHaveBeenCalled()
  })
})
