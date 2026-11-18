// SCHEMACATCHUP.1 — migrations 851 and 852 record objects that exist on the live
// database with no migration file. On a database without them it builds exactly
// what the live snapshot describes; run again (the live case) it changes
// nothing and keeps the data.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const ROOT = path.resolve(import.meta.dirname, '..')
const mig = ['851_schema_catch_up.sql', '852_schema_catch_up_whatsapp_numbers.sql']
  .map((f) => readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8')).join('\n')
const snapshot = JSON.parse(readFileSync(path.join(ROOT, 'supabase/schema/snapshot.json'), 'utf8'))
const NEW_COLUMNS = {
  app_claim_tokens: null,
  claim_link_requests: null,
  whatsapp_conversations: ['agent_activity_notified_at'],
  instagram_conversations: ['agent_activity_notified_at'],
  whatsapp_numbers: ['is_on_biz_app', 'platform_type', 'history_sync_status', 'history_sync_started_at', 'history_sync_completed_at', 'history_sync_error', 'embedded_signup_session_id'],
}
const BASE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE public.locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.whatsapp_conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.instagram_conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.whatsapp_numbers (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
`
let db
const runSql = (text) => db['exec'](text)
const rows = async (text) => (await db.query(text)).rows
const columnsOf = async (table) => (await rows(`
  SELECT a.attname n, format_type(a.atttypid, a.atttypmod) t, NOT a.attnotnull nul, a.atthasdef d
  FROM pg_attribute a WHERE a.attrelid = 'public.${table}'::regclass AND a.attnum > 0 AND NOT a.attisdropped`))
  .map((r) => [r.n, r.t, r.nul, r.d])
const catalog = async () => JSON.stringify({
  columns: await rows(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2`),
  constraints: await rows(`SELECT conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2`),
  indexes: await rows(`SELECT indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1`),
})

beforeEach(async () => { db = new PGlite(); await runSql(BASE) })
afterEach(async () => { await db.close() })

describe('migrations 851 and 852 (SCHEMACATCHUP.1)', () => {
  it('builds every object as the live snapshot describes it', async () => {
    await runSql(mig)
    for (const [table, only] of Object.entries(NEW_COLUMNS)) {
      const built = await columnsOf(table)
      const live = snapshot.relations[table].columns.filter((c) => !only || only.includes(c[0]))
      const wanted = only ? built.filter((c) => only.includes(c[0])) : built
      expect(wanted.sort(), table).toEqual([...live].sort())
    }
  })
  it('has the live constraints and indexes', async () => {
    await runSql(mig)
    const names = (await rows(`SELECT conname FROM pg_constraint WHERE connamespace='public'::regnamespace`)).map((r) => r.conname)
    expect(names).toEqual(expect.arrayContaining([
      'app_claim_tokens_channel_check', 'app_claim_tokens_contact_id_fkey', 'app_claim_tokens_location_id_fkey',
      'claim_link_requests_outcome_check', 'claim_link_requests_location_id_fkey', 'claim_link_requests_matched_contact_id_fkey',
      'whatsapp_numbers_platform_type_check', 'whatsapp_numbers_history_sync_status_check',
    ]))
    const idx = (await rows(`SELECT indexname FROM pg_indexes WHERE schemaname='public'`)).map((r) => r.indexname)
    expect(idx).toEqual(expect.arrayContaining(['app_claim_tokens_hash_key', 'app_claim_tokens_live_per_contact', 'claim_link_requests_outcome_idx', 'whatsapp_numbers_pending_history_idx']))
  })
  it('run again it changes nothing and keeps the data', async () => {
    await runSql(mig)
    await runSql(`INSERT INTO whatsapp_numbers (history_sync_status, platform_type) VALUES ('completed', 'CLOUD_API')`)
    const before = await catalog()
    await runSql(mig)
    expect(await catalog()).toBe(before)
    expect((await rows(`SELECT history_sync_status s FROM whatsapp_numbers`))[0].s).toBe('completed')
  })
  it('leaves the claim tables closed to client sessions, RLS on', async () => {
    // The live state: the tables exist and authenticated still holds the old grants.
    await runSql(mig)
    await runSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_claim_tokens, public.claim_link_requests TO authenticated;`)
    await runSql(mig)
    const r = await rows(`SELECT relname, relrowsecurity rls, has_table_privilege('authenticated', oid, 'SELECT') sel, has_table_privilege('anon', oid, 'SELECT') anon FROM pg_class WHERE relname IN ('app_claim_tokens','claim_link_requests')`)
    expect(r).toHaveLength(2)
    for (const t of r) expect(t).toMatchObject({ rls: true, sel: false, anon: false })
  })
})
