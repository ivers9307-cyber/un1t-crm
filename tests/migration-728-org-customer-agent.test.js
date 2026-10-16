// MIAORG.1 — migration 728 adds org_settings.customer_agent (organisation-level
// Mia defaults). Fictional ids only.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/728_org_settings_customer_agent.sql'), 'utf8')
const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.org_settings (
    organization_id uuid PRIMARY KEY,
    company_name text,
    short_name text
  );
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_settings TO authenticated;
  INSERT INTO public.org_settings (organization_id, company_name) VALUES ('b0000000-0000-0000-0000-000000000001', 'Example Group');
`
async function boot() { const db = new PGlite(); await db.exec(SCHEMA); return db }

describe('728', () => {
  it('adds a nullable jsonb column with no default, existing rows NULL; a second run passes', async () => {
    const db = await boot()
    await db.exec(MIG)
    await db.exec(MIG)
    const col = (await db.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='org_settings' AND column_name='customer_agent'`)).rows[0]
    expect(col).toEqual({ data_type: 'jsonb', is_nullable: 'YES', column_default: null })
    const rows = (await db.query(`SELECT customer_agent FROM org_settings`)).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].customer_agent).toBeNull()
  })

  it('the column comment records the decision: members can read it, so copy and tuning only, no secrets', async () => {
    const db = await boot()
    await db.exec(MIG)
    const c = (await db.query(`SELECT col_description('public.org_settings'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid='public.org_settings'::regclass AND attname='customer_agent')) AS c`)).rows[0].c
    expect(c).toMatch(/org_settings_select/)
    expect(c).toMatch(/no secrets/i)
  })

  it('changes no privilege: authenticated keeps exactly what it held', async () => {
    const db = await boot()
    const before = (await db.query(`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) p FROM information_schema.table_privileges WHERE table_name='org_settings' AND grantee='authenticated'`)).rows[0].p
    await db.exec(MIG)
    const after = (await db.query(`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) p FROM information_schema.table_privileges WHERE table_name='org_settings' AND grantee='authenticated'`)).rows[0].p
    expect(after).toBe(before)
  })

  it('stores and returns a jsonb blob', async () => {
    const db = await boot()
    await db.exec(MIG)
    await db.query(`UPDATE org_settings SET customer_agent = '{"tone":"warm","limits":{"max_replies_per_location_per_day":300}}'::jsonb`)
    const r = (await db.query(`SELECT customer_agent FROM org_settings`)).rows[0].customer_agent
    expect(r.tone).toBe('warm')
    expect(r.limits.max_replies_per_location_per_day).toBe(300)
  })
})
