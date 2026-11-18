// ROLETESTS.1 — a real Postgres (PGlite) with the live access rules, for asking
// "what can this signed-in person actually read and write?".
//
// Tables come from supabase/schema/snapshot.json; policies, grants and helper
// functions from supabase/schema/access.json, captured from the live database.
// Columns are created without NOT NULL or defaults, so a test seeds only the
// columns the rule under test reads.
//
//   const db = await createRoleDb()
//   await db.seed('contacts', [{ id: C1, location_id: A }])
//   await db.as(USER_ID, (q) => q(`select id from public.contacts`))
//   await db.asAnon((q) => q(`select id from public.contacts`))
//
// A query that is refused rejects with Postgres's error (42501).
// Every `as` runs in a transaction that is rolled back.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const SCHEMA = path.resolve(import.meta.dirname, '../../supabase/schema')
export const snapshot = JSON.parse(readFileSync(path.join(SCHEMA, 'snapshot.json'), 'utf8'))
export const access = JSON.parse(readFileSync(path.join(SCHEMA, 'access.json'), 'utf8'))

const quote = (n) => `"${String(n).replaceAll('"', '""')}"`
const CMD = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' }

/** 'p_a uuid, p_b text' → 'uuid, text', for naming a function in a GRANT. */
function argTypes(args) {
  return args.split(',').map((a) => a.trim()).filter(Boolean)
    .map((a) => a.replace(/^(?:IN|INOUT|VARIADIC)\s+/i, '').replace(/^"?[a-z_][a-z0-9_]*"?\s+/i, ''))
    .join(', ')
}

export function buildSchemaSql() {
  const out = [`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA private; CREATE SCHEMA extensions;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA private TO authenticated, service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_user::text $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('sub', auth.uid()) $$;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
    SET check_function_bodies = off;
    CREATE TABLE private.mobile_permission_defaults (role text, key text, allowed boolean);
    CREATE TABLE private.permission_key_bundles (key text, bundle text);
  `]
  for (const [name, r] of Object.entries(snapshot.relations)) {
    if (r.kind !== 'table') continue
    out.push(`CREATE TABLE public.${quote(name)} (${r.columns.map(([c, t]) => `${quote(c)} ${t}`).join(', ')});`)
    if (r.rls) out.push(`ALTER TABLE public.${quote(name)} ENABLE ROW LEVEL SECURITY;`)
  }
  for (const [, , , def] of access.functions) out.push(`${def.trimEnd()};`)
  for (const [schema, name, args, , grantees] of access.functions) {
    const fn = `${schema}.${quote(name)}(${argTypes(args)})`
    out.push(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`)
    for (const g of grantees) out.push(`GRANT EXECUTE ON FUNCTION ${fn} TO ${g};`)
  }
  for (const [table, name, permissive, roles, cmd, qual, check] of access.policies) {
    if (snapshot.relations[table]?.kind !== 'table') continue
    out.push(`CREATE POLICY ${quote(name)} ON public.${quote(table)} AS ${permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR ${CMD[cmd]} TO ${roles.join(', ')}${qual ? ` USING (${qual})` : ''}${check ? ` WITH CHECK (${check})` : ''};`)
  }
  for (const [table, grantee, priv] of access.table_grants) {
    if (snapshot.relations[table]?.kind === 'table') out.push(`GRANT ${priv} ON public.${quote(table)} TO ${grantee};`)
  }
  for (const [table, col, grantee, priv] of access.column_grants) {
    if (snapshot.relations[table]?.kind === 'table') out.push(`GRANT ${priv} (${quote(col)}) ON public.${quote(table)} TO ${grantee};`)
  }
  return out.join('\n')
}

class Rollback extends Error {}

export async function createRoleDb() {
  const pg = new PGlite()
  await pg['exec'](buildSchemaSql())
  const insert = async (qualified, rows) => {
    for (const row of rows) {
      const cols = Object.keys(row)
      const vals = cols.map((c) => {
        const v = row[c]
        return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v
      })
      await pg.query(`INSERT INTO ${qualified} (${cols.map(quote).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals)
    }
  }
  await insert('private.mobile_permission_defaults', access.mobile_permission_defaults)
  await insert('private.permission_key_bundles', access.permission_key_bundles)
  const inRole = async (role, uid, fn) => {
    let value
    try {
      await pg.transaction(async (tx) => {
        await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid || ''])
        await tx.query(`SET LOCAL ROLE ${role}`)
        value = await fn(async (text, params) => (await tx.query(text, params)).rows)
        throw new Rollback()
      })
    } catch (e) {
      if (!(e instanceof Rollback)) throw e
    }
    return value
  }
  return {
    pg,
    seed: (table, rows) => insert(`public.${quote(table)}`, rows),
    as: (uid, fn) => inRole('authenticated', uid, fn),
    asAnon: (fn) => inRole('anon', null, fn),
    close: () => pg.close(),
  }
}
