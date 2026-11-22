import { describe, it, expect, vi } from 'vitest'
import { createFakeDb } from '../../../tests/helpers/fake-db.js'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { recordInboundStray } = await import('./strays.js')

const stray = (extra = {}) => ({
  messageId: 'm1', to: 'nowhere-invoices@mail.un1tdublin.com', from: 'a@example.com',
  subject: 'Invoice', reason: 'unknown_slug', slug: 'nowhere', ...extra,
})

describe('recordInboundStray', () => {
  it('stores the email and reports success', async () => {
    const db = createFakeDb()
    expect(await recordInboundStray(db, stray())).toEqual({ ok: true })
    expect(db.tables.invoice_inbound_strays).toEqual([expect.objectContaining({
      email_message_id: 'm1', reason: 'unknown_slug', slug: 'nowhere', from_address: 'a@example.com',
    })])
  })

  it('treats a unique violation (same email retried) as success', async () => {
    const db = createFakeDb({ errors: { invoice_inbound_strays: { insert: { code: '23505', message: 'duplicate key' } } } })
    expect(await recordInboundStray(db, stray())).toEqual({ ok: true })
  })

  it('reports failure on any other error', async () => {
    const db = createFakeDb({ errors: { invoice_inbound_strays: { insert: { code: '08006', message: 'down' } } } })
    expect(await recordInboundStray(db, stray())).toEqual({ ok: false })
  })

  it('drops the slug for an unparseable recipient and caps long text', async () => {
    const db = createFakeDb()
    await recordInboundStray(db, stray({ reason: 'unparseable_recipient', slug: 'x', subject: 's'.repeat(900) }))
    const [row] = db.tables.invoice_inbound_strays
    expect(row.slug).toBeNull()
    expect(row.subject).toHaveLength(500)
  })
})
