// WASTUDIOPICK.1 — migration 725 adds whatsapp_conversations.studio_resolution.
// Fictional ids only.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/725_wa_conversation_studio_resolution.sql'), 'utf8')
const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.whatsapp_conversations (id uuid PRIMARY KEY, location_id uuid NOT NULL, wa_phone text);
  GRANT SELECT ON public.whatsapp_conversations TO authenticated;
  INSERT INTO public.whatsapp_conversations VALUES ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '15555550100');
`
async function boot() { const db = new PGlite(); await db.exec(SCHEMA); return db }

describe('725', () => {
  it('adds a nullable jsonb column, existing rows NULL; a second run passes', async () => {
    const db = await boot()
    await db.exec(MIG)
    await db.exec(MIG)
    const col = (await db.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name='whatsapp_conversations' AND column_name='studio_resolution'`)).rows[0]
    expect(col).toEqual({ data_type: 'jsonb', is_nullable: 'YES' })
    expect((await db.query(`SELECT studio_resolution FROM whatsapp_conversations`)).rows[0].studio_resolution).toBeNull()
  })
  it('authenticated can read it (table-level SELECT unchanged) and write nothing', async () => {
    const db = await boot()
    await db.exec(MIG)
    const priv = (await db.query(`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) p FROM information_schema.table_privileges WHERE table_name='whatsapp_conversations' AND grantee='authenticated'`)).rows[0].p
    expect(priv).toBe('SELECT')
  })
})
