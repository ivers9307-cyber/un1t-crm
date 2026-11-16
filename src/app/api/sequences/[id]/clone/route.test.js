// SEQCLONE.1 — a clone copies every step column the runner reads (the WhatsApp
// header image used to be dropped) and keeps each step's step_order, so branch
// and jump targets in config.next_step_order still name the right steps.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let inserted
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1' })),
  assertLocationAccessOr404: () => null,
}))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: () => true,
  hasPermissionForLocation: () => true,
}))

const SRC = 'a0000000-0000-4000-8000-000000000001'
const SOURCE = {
  id: SRC, name: 'Trial', location_id: 'loc-1', trigger_type: 'manual', trigger_config: {},
  sequence_steps: [
    { step_order: 5, step_type: 'email', subject: 'Later', html_content: '<p>5</p>', config: { next_step_order: 'end' } },
    { step_order: 1, step_type: 'branch', config: { then_step_order: 5, else_step_order: 3 } },
    { step_order: 3, step_type: 'whatsapp', whatsapp_template_id: 'wt-1', whatsapp_variables: { 1: 'first_name' },
      whatsapp_header_media_url: 'https://cdn.example.test/header.jpg', delay_type: 'after_previous', config: { next_step_order: 5 } },
  ],
}
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from(table) {
      const b = {}
      for (const m of ['select', 'eq']) b[m] = () => b
      b.insert = (rows) => { inserted[table] = rows; return b }
      b.delete = () => b
      b.single = async () => (table === 'email_sequences' && !inserted.email_sequences
        ? { data: SOURCE, error: null }
        : { data: { id: 'new-1', name: 'Copy of Trial' }, error: null })
      b.then = (res) => Promise.resolve({ error: null }).then(res)
      return b
    },
  }),
}))

const { POST } = await import('./route.js')
const call = () => POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: SRC }) })

beforeEach(() => { inserted = {} })

describe('POST /api/sequences/[id]/clone', () => {
  it('copies the WhatsApp header image and keeps step_order', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    const rows = inserted.sequence_steps
    expect(rows.map((r) => r.step_order)).toEqual([1, 3, 5])
    const wa = rows.find((r) => r.step_type === 'whatsapp')
    expect(wa.whatsapp_header_media_url).toBe('https://cdn.example.test/header.jpg')
    expect(wa.whatsapp_variables).toEqual({ 1: 'first_name' })
    expect(rows.find((r) => r.step_type === 'branch').config).toEqual({ then_step_order: 5, else_step_order: 3 })
    expect(rows.every((r) => r.sequence_id === 'new-1')).toBe(true)
  })

  it('a clone is a draft named "Copy of …"', async () => {
    await call()
    expect(inserted.email_sequences).toMatchObject({ name: 'Copy of Trial', status: 'draft', location_id: 'loc-1' })
  })
})
