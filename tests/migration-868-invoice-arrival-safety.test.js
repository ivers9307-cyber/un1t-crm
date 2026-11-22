// INVOICEPREP.1 — migration 868 text checks: arrival columns on the invoice
// queue and a closed table for inbound emails that match no studio.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const sql = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/868_invoice_arrival_safety.sql'), 'utf8')

describe('migration 868', () => {
  it('closes the strays table to every client session', () => {
    expect(sql).toMatch(/alter table public\.invoice_inbound_strays enable row level security/)
    expect(sql).toMatch(/revoke all on public\.invoice_inbound_strays from anon, authenticated, public/)
    expect(sql).not.toMatch(/create policy/i)
  })

  it('adds the three queue columns without dropping anything', () => {
    for (const c of ['email_body_text', 'skipped_attachment_count', 'not_invoice_reason']) expect(sql).toContain(c)
    expect(sql).toMatch(/skipped_attachment_count integer not null default 0/)
    expect(sql).not.toMatch(/drop (column|table)/i)
  })

  it('limits stray reasons and keeps the email id unique', () => {
    expect(sql).toMatch(/email_message_id text not null unique/)
    expect(sql).toMatch(/reason in \('unparseable_recipient', ?'unknown_slug'\)/)
  })

  it('indexes the per-studio content hash lookup', () => {
    expect(sql).toMatch(/create index if not exists invoices_queue_location_content_hash_idx/)
    expect(sql).toMatch(/\(location_id, content_hash\) where content_hash is not null/)
  })
})
