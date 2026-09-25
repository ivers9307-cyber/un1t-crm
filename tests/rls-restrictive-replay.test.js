// RLSACTIVE.1 (review B1) — netPolicyState must follow what Postgres follows.
//
// Mig 185 renamed inbound_invoices → invoices_queue and mig 204 rewrote the
// policy with ALTER POLICY … USING. The replay followed neither, so the net
// state still showed `public.inbound_invoices :: inbound_invoices_read` with
// its mig 184 text — and mig 626 was written against a table prod does not
// have. A policy moves with its table; ALTER POLICY replaces the clause it
// names and keeps the rest.

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { netPolicyState } from '../scripts/check-rls-restrictive.mjs'

const dirs = []
function replay (files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rls-replay-'))
  dirs.push(dir)
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql)
  return netPolicyState(dir)
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const find = (state, table, name) => state.find((p) => p.table === table && p.name === name)

describe('netPolicyState — renames and ALTER POLICY', () => {
  it('a policy moves with its table on ALTER TABLE … RENAME TO', () => {
    const state = replay({
      '001_a.sql': `CREATE TABLE public.inbound_invoices (id int);
        CREATE POLICY inbound_invoices_read ON public.inbound_invoices FOR SELECT TO authenticated USING (true);`,
      '002_b.sql': 'alter table public.inbound_invoices rename to invoices_queue;',
    })
    expect(find(state, 'public.inbound_invoices', 'inbound_invoices_read')).toBeUndefined()
    const p = find(state, 'public.invoices_queue', 'inbound_invoices_read')
    expect(p).toMatchObject({ cmd: 'SELECT', roles: ['authenticated'], permissive: 'PERMISSIVE' })
  })

  it('RENAME COLUMN / RENAME CONSTRAINT do not move policies', () => {
    const state = replay({
      '001_a.sql': 'CREATE POLICY p ON public.t FOR SELECT USING (true);',
      '002_b.sql': 'ALTER TABLE public.t RENAME COLUMN a TO b; ALTER TABLE public.t RENAME CONSTRAINT c TO d;',
    })
    expect(find(state, 'public.t', 'p')).toBeDefined()
  })

  it('ALTER POLICY … USING replaces USING and keeps command, roles and WITH CHECK', () => {
    const state = replay({
      '001_a.sql': `CREATE POLICY p ON public.t FOR UPDATE TO authenticated
        USING (EXISTS (SELECT 1 FROM x WHERE x.id = auth.uid())) WITH CHECK (owner_id = auth.uid());`,
      '002_b.sql': `alter policy "p" on public.t
        using (exists (select 1 from x where x.id = (select auth.uid())));`,
    })
    const p = find(state, 'public.t', 'p')
    expect(p.using).toBe('exists (select 1 from x where x.id = (select auth.uid()))')
    expect(p.check).toBe('owner_id = auth.uid()')
    expect(p).toMatchObject({ cmd: 'UPDATE', roles: ['authenticated'] })
    expect(p.body).toMatch(/\(select auth\.uid\(\)\)/)
    expect(p.body).not.toMatch(/x\.id = auth\.uid\(\)/)
    expect(p.file).toBe('002_b.sql')
  })

  it('ALTER POLICY … TO / WITH CHECK / RENAME TO', () => {
    const state = replay({
      '001_a.sql': 'CREATE POLICY p ON public.t FOR INSERT WITH CHECK (a = 1);',
      '002_b.sql': 'ALTER POLICY p ON public.t TO authenticated;',
      '003_c.sql': 'ALTER POLICY p ON public.t WITH CHECK (a = 2);',
      '004_d.sql': 'ALTER POLICY p ON public.t RENAME TO q;',
    })
    expect(find(state, 'public.t', 'p')).toBeUndefined()
    expect(find(state, 'public.t', 'q')).toMatchObject({ cmd: 'INSERT', roles: ['authenticated'], check: 'a = 2', using: null })
  })

  it('a USING nested inside an expression is not mistaken for the clause', () => {
    const state = replay({
      '001_a.sql': 'CREATE POLICY p ON public.t FOR SELECT USING (EXISTS (SELECT 1 FROM a JOIN b USING (id)));',
    })
    expect(find(state, 'public.t', 'p').using).toBe('EXISTS (SELECT 1 FROM a JOIN b USING (id))')
  })

  it('the real migrations: inbound_invoices_read lives on invoices_queue with mig 204\'s text', () => {
    const state = netPolicyState(path.resolve(import.meta.dirname, '../supabase/migrations'), { before: 626 })
    expect(state.filter((p) => p.table === 'public.inbound_invoices')).toEqual([])
    const p = find(state, 'public.invoices_queue', 'inbound_invoices_read')
    expect(p.file).toMatch(/^204_/)
    expect(p.using).toMatch(/invoices_queue\.location_id/)
    expect(p.using).toMatch(/\(select auth\.uid\(\)\)/)
  })
})
