// MIAORG.1 — migration 729 adds org_settings.customer_agent (organisation-level
// Mia defaults). Fictional ids only.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const ORG = 'b0000000-0000-0000-0000-000000000001'
const ORG2 = 'b0000000-0000-0000-0000-000000000002'
const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/729_org_settings_customer_agent.sql'), 'utf8')
const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA private;
  CREATE TABLE public.org_settings (
    organization_id uuid PRIMARY KEY,
    company_name text,
    short_name text,
    updated_at timestamptz NOT NULL DEFAULT '2000-01-01T00:00:00Z'
  );
  -- mig 317's updated_at trigger, as live.
  CREATE FUNCTION private.touch_org_settings_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
  BEGIN NEW.updated_at := NOW(); RETURN NEW; END; $$;
  CREATE TRIGGER org_settings_touch_updated_at BEFORE UPDATE ON public.org_settings
    FOR EACH ROW EXECUTE FUNCTION private.touch_org_settings_updated_at();
  -- As live: table-level writes for authenticated (mig 317/320 owner policies
  -- decide WHICH rows; RLS is not modelled here, the fence is per column).
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_settings TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_settings TO service_role;
  INSERT INTO public.org_settings (organization_id, company_name) VALUES ('${ORG}', 'Example Group');
`
async function boot() { const db = new PGlite(); await db.exec(SCHEMA); return db }

// Run `sql` as `role` (SET ROLE, as PostgREST does for a request), always
// returning the session to the superuser afterwards.
async function asRole(db, role, sql) {
  try {
    await db.exec(`SET ROLE ${role}`)
    return await db.query(sql)
  } finally {
    await db.exec('RESET ROLE')
  }
}

describe('729', () => {
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

  describe('write fence: customer_agent is written only by the server', () => {
    it('an authenticated UPDATE of customer_agent is refused (42501), and nothing changes', async () => {
      const db = await boot()
      await db.exec(MIG)
      await expect(asRole(db, 'authenticated', `UPDATE public.org_settings SET customer_agent = '{"handoff_after_verify_failures":0}'::jsonb`))
        .rejects.toThrow(/org_settings_customer_agent_fence/)
      // NULL -> {} and {} -> NULL are changes too.
      await db.query(`UPDATE public.org_settings SET customer_agent = '{"tone":"warm"}'::jsonb`)
      await expect(asRole(db, 'authenticated', `UPDATE public.org_settings SET customer_agent = NULL`))
        .rejects.toThrow(/written only by the server/)
      const r = (await db.query(`SELECT customer_agent FROM public.org_settings`)).rows[0]
      expect(r.customer_agent).toEqual({ tone: 'warm' })
    })

    it('the refusal is SQLSTATE 42501 (insufficient privilege)', async () => {
      const db = await boot()
      await db.exec(MIG)
      let code = null
      try { await asRole(db, 'authenticated', `UPDATE public.org_settings SET customer_agent = '{}'::jsonb`) } catch (e) { code = e.code }
      expect(code).toBe('42501')
    })

    it('an authenticated INSERT with customer_agent is refused; one without it still works', async () => {
      const db = await boot()
      await db.exec(MIG)
      await expect(asRole(db, 'authenticated', `INSERT INTO public.org_settings (organization_id, customer_agent) VALUES ('${ORG2}', '{"tone":"x"}'::jsonb)`))
        .rejects.toThrow(/org_settings_customer_agent_fence/)
      await asRole(db, 'authenticated', `INSERT INTO public.org_settings (organization_id, company_name) VALUES ('${ORG2}', 'Second')`)
      const r = (await db.query(`SELECT company_name, customer_agent FROM public.org_settings WHERE organization_id = '${ORG2}'`)).rows[0]
      expect(r).toEqual({ company_name: 'Second', customer_agent: null })
    })

    it('an authenticated UPDATE of another column (branding) still works, and leaves the org layer as it was', async () => {
      const db = await boot()
      await db.exec(MIG)
      await db.query(`UPDATE public.org_settings SET customer_agent = '{"tone":"warm"}'::jsonb`)
      await asRole(db, 'authenticated', `UPDATE public.org_settings SET company_name = 'Renamed', short_name = 'RN'`)
      const r = (await db.query(`SELECT company_name, short_name, customer_agent FROM public.org_settings`)).rows[0]
      expect(r).toEqual({ company_name: 'Renamed', short_name: 'RN', customer_agent: { tone: 'warm' } })
    })

    it('an authenticated branding upsert (ON CONFLICT DO UPDATE) carries the org layer through', async () => {
      const db = await boot()
      await db.exec(MIG)
      await db.query(`UPDATE public.org_settings SET customer_agent = '{"tone":"warm"}'::jsonb`)
      await asRole(db, 'authenticated', `INSERT INTO public.org_settings (organization_id, company_name) VALUES ('${ORG}', 'Upserted')
        ON CONFLICT (organization_id) DO UPDATE SET company_name = EXCLUDED.company_name`)
      const r = (await db.query(`SELECT company_name, customer_agent FROM public.org_settings`)).rows[0]
      expect(r).toEqual({ company_name: 'Upserted', customer_agent: { tone: 'warm' } })
    })

    it('a service_role write (insert, update, upsert) passes', async () => {
      const db = await boot()
      await db.exec(MIG)
      await asRole(db, 'service_role', `UPDATE public.org_settings SET customer_agent = '{"tone":"warm"}'::jsonb`)
      await asRole(db, 'service_role', `INSERT INTO public.org_settings (organization_id, customer_agent) VALUES ('${ORG2}', '{"tone":"x"}'::jsonb)
        ON CONFLICT (organization_id) DO UPDATE SET customer_agent = EXCLUDED.customer_agent`)
      await asRole(db, 'service_role', `INSERT INTO public.org_settings (organization_id, customer_agent) VALUES ('${ORG2}', '{"tone":"y"}'::jsonb)
        ON CONFLICT (organization_id) DO UPDATE SET customer_agent = EXCLUDED.customer_agent`)
      const rows = (await db.query(`SELECT organization_id, customer_agent FROM public.org_settings ORDER BY organization_id`)).rows
      expect(rows.map((r) => r.customer_agent)).toEqual([{ tone: 'warm' }, { tone: 'y' }])
    })

    it('anon is refused too (any role but the server roles)', async () => {
      const db = await boot()
      await db.exec(MIG)
      await db.exec(`GRANT UPDATE ON public.org_settings TO anon`)
      await expect(asRole(db, 'anon', `UPDATE public.org_settings SET customer_agent = '{}'::jsonb`)).rejects.toThrow(/org_settings_customer_agent_fence/)
    })

    it('the updated_at trigger keeps working beside the fence', async () => {
      const db = await boot()
      await db.exec(MIG)
      await asRole(db, 'service_role', `UPDATE public.org_settings SET customer_agent = '{"tone":"warm"}'::jsonb`)
      const a = (await db.query(`SELECT updated_at FROM public.org_settings`)).rows[0].updated_at
      expect(new Date(a).getUTCFullYear()).toBeGreaterThan(2000)
      await db.query(`UPDATE public.org_settings SET updated_at = '2000-01-01T00:00:00Z'`) // reset (the trigger touches it again)
      await asRole(db, 'authenticated', `UPDATE public.org_settings SET company_name = 'X'`)
      const b = (await db.query(`SELECT updated_at FROM public.org_settings`)).rows[0].updated_at
      expect(new Date(b).getUTCFullYear()).toBeGreaterThan(2000)
    })

    it('the fence function: SECURITY INVOKER, search_path pinned, EXECUTE closed to PUBLIC/anon/authenticated; one trigger after a re-run', async () => {
      const db = await boot()
      await db.exec(MIG)
      await db.exec(MIG)
      const fn = (await db.query(`SELECT p.prosecdef, p.proconfig,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'private' AND p.proname = 'org_settings_customer_agent_fence'`)).rows[0]
      expect(fn.prosecdef).toBe(false)
      expect(fn.proconfig).toEqual(['search_path=""'])
      expect(fn.anon_x).toBe(false)
      expect(fn.auth_x).toBe(false)
      const triggers = (await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.org_settings'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows.map((r) => r.tgname)
      expect(triggers).toEqual(['org_settings_customer_agent_fence', 'org_settings_touch_updated_at'])
    })
  })
})
