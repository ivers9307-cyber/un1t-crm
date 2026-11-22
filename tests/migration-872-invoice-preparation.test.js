// INVOICEPREP.3 — migration 872 text checks: preparation columns, the
// not_invoice status, supplier tax memory and the claim function.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const sql = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/872_invoice_preparation.sql'), 'utf8')

describe('migration 872', () => {
  it('adds the queue columns and the supplier column with if not exists', () => {
    expect(sql).toMatch(/review_reasons text\[\] not null default '\{\}'/)
    expect(sql).toMatch(/add column if not exists prepared_at timestamptz/)
    expect(sql).toMatch(/duplicate_of_id uuid references public\.invoices_queue\(id\) on delete set null/)
    expect(sql).toMatch(/add column if not exists default_tax_type text/)
    expect((sql.match(/add column /g) || []).length).toBe((sql.match(/add column if not exists/g) || []).length)
  })

  it('drops nothing but the old function and the old check', () => {
    expect(sql).not.toMatch(/drop column/i)
    expect(sql).not.toMatch(/drop table/i)
  })

  it('documents the new columns', () => {
    for (const c of ['invoices_queue.review_reasons', 'invoices_queue.prepared_at',
      'invoices_queue.duplicate_of_id', 'xero_supplier_defaults.default_tax_type']) {
      expect(sql).toContain(`comment on column public.${c} is`)
    }
  })

  it('lists all seven statuses in the check', () => {
    const m = sql.match(/invoices_queue_status_check\s+check \(status in \(([^)]*)\)\)/)
    expect(m).not.toBeNull()
    const list = m[1].split(',').map((s) => s.trim().replace(/'/g, ''))
    expect(list).toEqual(['received', 'quality_approved', 'extracted', 'data_approved', 'forwarded', 'rejected', 'not_invoice'])
  })

  it('drops the six-argument supplier function and creates the seven-argument one', () => {
    expect(sql).toContain('drop function if exists public.upsert_supplier_default(uuid, text, text, text, text, text);')
    expect(sql).toMatch(/p_tax_type text default null/)
    expect(sql).toMatch(/default_tax_type\s+= coalesce\(excluded\.default_tax_type, public\.xero_supplier_defaults\.default_tax_type\)/)
    expect(sql).toMatch(/use_count\s+= public\.xero_supplier_defaults\.use_count \+ 1/)
  })

  it('closes the new function to clients and grants service_role', () => {
    const sig = 'public.upsert_supplier_default(uuid, text, text, text, text, text, text)'
    expect(sql).toContain(`revoke execute on function ${sig} from public, anon, authenticated;`)
    expect(sql).toContain(`grant execute on function ${sig} to service_role;`)
  })

  it('claims received and quality_approved rows, still service_role only', () => {
    const body = sql.slice(sql.indexOf('function public.claim_invoice_analysis_batch'))
    expect(body).toMatch(/status in \('received', 'quality_approved'\)/)
    expect(body).toContain('revoke execute on function public.claim_invoice_analysis_batch(int) from public, anon, authenticated;')
    expect(body).toContain('grant execute on function public.claim_invoice_analysis_batch(int) to service_role;')
  })
})
